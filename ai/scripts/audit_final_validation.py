#!/usr/bin/env python3
"""Audit development validation and prepare a complete, pending review handoff.

No model, network, tokenizer or source mutation. Public outputs contain only
counts and hashes. Private review payloads require an ignored repository path.
This tool never authenticates a human or promotes development data to a test.
"""
import argparse
from collections import Counter
from difflib import SequenceMatcher
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unicodedata

import staged_dataset as staged


SCHEMA = "malssi-final-validation-audit-v1"
REVIEW_SCHEMA = "malssi-final-pending-review-v1"
SERVICE_PHASE = "02b_service_wire"
THRESHOLD = 200
REVIEW_FILES = ("blind_inputs.jsonl", "target_packets.jsonl", "review_requests.jsonl", "REVIEW_GUIDE.md")
CHECKS = ("task_alignment", "speaker_and_perspective", "source_grounding",
          "uncertainty_and_corrections", "no_future_information", "label_consistency",
          "autonomy_and_boundaries", "privacy_and_use_scope")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(value):
    return hashlib.sha256(value).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n").encode()


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate JSON key")
        result[key] = value
    return result


def parse(content):
    return json.loads(content.decode("utf-8"), object_pairs_hook=unique_pairs)


def rows(content, compressed=False):
    if compressed:
        content = gzip.decompress(content)
    # LF record boundaries preserve legal U+2028/U+2029 inside JSON strings.
    for line in content.decode("utf-8").split("\n"):
        if line in ("", "\r"):
            continue
        value = json.loads(line, object_pairs_hook=unique_pairs)
        require(isinstance(value, dict), "JSONL row must be an object")
        yield value


def stamp(info):
    return info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def capture(path, keep=False):
    require(path.is_file() and not path.is_symlink(), "Input is missing or symlinked")
    initial = stamp(path.stat())
    digest, chunks = hashlib.sha256(), []
    with path.open("rb") as handle:
        require(stamp(os.fstat(handle.fileno())) == initial, "Input changed before read")
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
            if keep:
                chunks.append(chunk)
        require(stamp(os.fstat(handle.fileno())) == initial == stamp(path.stat()), "Input changed during read")
    return {"bytes": initial[3], "sha256": digest.hexdigest()}, b"".join(chunks), initial


def load_source(root):
    root = Path(root).resolve(strict=True)
    manifest_path = staged._safe_path(root, "DATASET_MANIFEST.json")
    manifest_info, content, manifest_stamp = capture(manifest_path, keep=True)
    manifest = parse(content)
    require(isinstance(manifest, dict) and manifest.get("schema") == "malssi-two-stage-data-manifest-v1", "Unsupported source manifest")
    require(manifest.get("clinical_or_human_approval") is False
            and manifest.get("independent_test_eligible") is False, "Source is not the declared pending development bundle")
    files = manifest.get("files")
    require(isinstance(files, dict) and "COURSE.json" in files, "Source inventory missing")
    snapshots, contents = {}, {}
    for name, expected in sorted(files.items()):
        path = staged._safe_path(root, name)
        keep = name == "COURSE.json" or name.endswith(".index.jsonl") or (
            name.endswith(".messages.jsonl.gz") and not name.startswith("data/01_original/"))
        info, data, state = capture(path, keep)
        require(info == expected, "Source manifest checksum mismatch")
        snapshots[name] = state
        if keep:
            contents[name] = data
    course = parse(contents["COURSE.json"])
    require(isinstance(course, dict), "Course must be an object")
    phases = staged._course_phases(course)
    require(set(manifest.get("phase_counts", {})) == {p["id"] for p in phases}, "Phase inventory mismatch")
    source_rows, counts = {}, {}
    lineage = {split: {"groups": set(), "roots": set()} for split in staged.SPLITS}
    used_paths = set()
    for phase in phases:
        phase_id = phase["id"]
        counts[phase_id] = {}
        phase_ids = set()
        require(isinstance(manifest["phase_counts"][phase_id], dict)
                and set(manifest["phase_counts"][phase_id]) == set(staged.SPLITS), "Split inventory mismatch")
        for split in staged.SPLITS:
            config = phase["data"][split]
            for kind in ("messages", "index", "tokens"):
                name = config.get(kind)
                require(name in files and name not in used_paths, "Missing or reused partition path")
                used_paths.add(name)
            index = list(rows(contents[config["index"]]))
            expected = manifest["phase_counts"][phase_id][split]
            require(type(expected) is int and len(index) == expected == config["rows"], "Partition count mismatch")
            counts[phase_id][split] = len(index)
            for entry in index:
                identity = staged._text(entry.get("row_id"), "row_id")
                require(identity not in phase_ids, "Duplicate row identity")
                phase_ids.add(identity)
                require(entry.get("task") == phase["task"] and entry.get("split") == split, "Index partition mismatch")
                lineage[split]["groups"].update(staged._source_ids(entry.get("source_group_ids"), "groups"))
                lineage[split]["roots"].update(staged._source_ids(entry.get("source_root_ids"), "roots"))
            if phase_id == "01_original":
                continue
            messages = list(rows(contents[config["messages"]], compressed=True))
            require(len(messages) == len(index), "Message/index inventory mismatch")
            for row, entry in zip(messages, index):
                for key in ("row_id", "task", "split", "weight", "source_group_ids", "source_root_ids", "source_row_sha256", "target_sha256"):
                    require(row.get(key) == entry.get(key), "Message/index metadata mismatch")
                staged._check_messages(row, entry)
            source_rows[phase_id, split] = messages
    require(not (lineage["train"]["groups"] & lineage["validation"]["groups"]), "Source groups cross splits")
    require(not (lineage["train"]["roots"] & lineage["validation"]["roots"]), "Source roots cross splits")
    source = {"root": root, "manifest_sha256": manifest_info["sha256"], "manifest_stamp": manifest_stamp,
              "snapshots": snapshots, "file_inventory": files, "rows": source_rows, "counts": counts,
              "partition_count": sum(len(x) for x in counts.values())}
    assert_unchanged(source)
    return source


def assert_unchanged(source):
    root = source["root"]
    require(stamp((root / "DATASET_MANIFEST.json").stat()) == source["manifest_stamp"], "Source manifest changed")
    for name, expected in source["snapshots"].items():
        require(stamp(staged._safe_path(root, name).stat()) == expected, "Source changed after capture")


def normalize(value):
    # Match the existing partial_exposure/source_selection_audit contract.
    return " ".join(unicodedata.normalize("NFKC", value).split())


def string_leaves(value, path=""):
    if isinstance(value, str):
        yield path, normalize(value)
    elif isinstance(value, list):
        for child in value:
            yield from string_leaves(child, path + "[]")
    elif isinstance(value, dict):
        for key, child in value.items():
            yield from string_leaves(child, path + ("." if path else "") + key)


def audit(source):
    train = source["rows"][SERVICE_PHASE, "train"]
    validation = source["rows"][SERVICE_PHASE, "validation"]
    normalized_train = [normalize(row["messages"][-1]["content"]) for row in train]
    train_values = set()
    for row in train:
        train_values.update(text for _, text in string_leaves(parse(row["messages"][-1]["content"].encode())) if len(text) >= 20)
    results, leaf_fields = [], Counter()
    for row in validation:
        target = normalize(row["messages"][-1]["content"])
        # Any >=200-character overlap contains one aligned 100-character seed.
        seeds = [target[i:i + 100] for i in range(0, len(target) - 99, 100)]
        longest = 0
        for other in normalized_train:
            if any(seed in other for seed in seeds):
                longest = max(longest, SequenceMatcher(None, target, other, autojunk=False).find_longest_match().size)
        leaves = [(field, text) for field, text in string_leaves(parse(row["messages"][-1]["content"].encode()))
                  if len(text) >= 20 and text in train_values]
        leaf_fields.update(field for field, _ in leaves)
        results.append({"row_id_sha256": sha(row["row_id"].encode()), "target_sha256": row["target_sha256"],
                        "normalized_target_characters": len(target), "long_match_detected": longest >= THRESHOLD,
                        "max_matching_characters": longest if longest >= THRESHOLD else None,
                        "matched_target_fraction": longest / len(target) if longest >= THRESHOLD else None,
                        "full_target_identical": target in normalized_train,
                        "shared_string_leaves_ge20": len(leaves),
                        "max_shared_leaf_characters": max((len(text) for _, text in leaves), default=0),
                        "independent_test_eligible": False,
                        "usage": "development_regression_only"})
    held = [r for r in results if r["long_match_detected"]]
    clear = [r for r in results if not r["long_match_detected"]]
    return {"schema": SCHEMA, "source_manifest_sha256": source["manifest_sha256"],
            "source_files_checked": len(source["file_inventory"]), "source_partition_count": source["partition_count"],
            "source_rows": sum(sum(c.values()) for c in source["counts"].values()),
            "source_phase_counts": source["counts"],
            "normalization": "Unicode NFKC and collapse whitespace, case-sensitive",
            "overlap_scope": "Service validation final assistant targets against service train final assistant targets",
            "threshold_characters": THRESHOLD, "train_rows": len(train), "validation_rows": len(validation),
            "validation_source_groups": len({g for r in validation for g in r["source_group_ids"]}),
            "source_group_cross_split_count": 0, "source_root_cross_split_count": 0,
            "long_match_rows": len(held), "no_long_match_detected_rows": len(clear),
            "independent_test_excluded_rows": len(validation), "source_split_modified": False,
            "segments": {
                "long_match_pending_semantic_review": {
                    "rows": len(held), "row_id_sha256": [r["row_id_sha256"] for r in held],
                    "allowed_use": "development_regression_only", "independent_test_eligible": False},
                "no_long_match_detected_development_exposed": {
                    "rows": len(clear), "row_id_sha256": [r["row_id_sha256"] for r in clear],
                    "allowed_use": "development_regression_only", "independent_test_eligible": False}},
            "identical_target_rows": sum(r["full_target_identical"] for r in results),
            "rows_with_shared_string_leaves_ge20": sum(r["shared_string_leaves_ge20"] > 0 for r in results),
            "shared_string_leaf_occurrences": sum(r["shared_string_leaves_ge20"] for r in results),
            "max_shared_string_leaf_characters": max((r["max_shared_leaf_characters"] for r in results), default=0),
            "shared_leaf_fields": dict(leaf_fields), "rows": results,
            "clinical_or_human_approval": False, "independent_test_eligible": False,
            "allowed_uses": ["schema_regression", "development_comparison", "pending_human_review"],
            "denied_uses": ["independent_test", "human_approved", "clinical_validation"],
            "limitations": ["No semantic/discontinuous/train-user overlap audit; no same-person or privacy-leak conclusion.",
                            "Shared serialization and natural-language string values are counted separately.",
                            "No-match rows are development-exposed and are not a clean independent test.",
                            "This audit does not alter the source split or create human approval.",
                            "Original numeric re-encoding is not repeated by this audit."]}


def usage_gate(report, purpose, subset="all_validation"):
    require(subset in ("all_validation", "long_match", "no_long_match_detected"), "Unknown subset")
    keys = {"all_validation": "validation_rows", "long_match": "long_match_rows",
            "no_long_match_detected": "no_long_match_detected_rows"}
    allowed = purpose in ("schema_regression", "development_comparison", "pending_human_review")
    return {"schema": SCHEMA, "source_manifest_sha256": report["source_manifest_sha256"],
            "purpose": purpose, "subset": subset, "rows": report[keys[subset]], "allowed": allowed,
            "independent_test_eligible": False, "clinical_or_human_approval": False,
            "reason": "development_use_only" if allowed else "development_exposure_and_no_authenticated_human_approval"}


def review_payloads(source):
    blind, targets, requests = [], [], []
    counts = {}
    for (phase, split), source_rows in sorted(source["rows"].items()):
        counts.setdefault(phase, {})[split] = len(source_rows)
        for row in source_rows:
            unit = sha(encoded({"phase": phase, "row_id": row["row_id"], "source_manifest": source["manifest_sha256"]}))
            binding = {"unit_id": unit, "phase": phase, "source_split": split,
                       "source_row_sha256": row["source_row_sha256"], "messages_sha256": staged.messages_digest(row["messages"])}
            blind.append({**binding, "prefix": row["messages"][:-1], "review_split": "review_only"})
            targets.append({**binding, "row_id": row["row_id"], "source_group_ids": row["source_group_ids"],
                            "source_root_ids": row["source_root_ids"], "target": row["messages"][-1]["content"],
                            "target_sha256": row["target_sha256"]})
            requests.append({**binding, "status": "pending_human_review", "review_split": "review_only",
                             "reviewer_id": None, "reviewed_at": None, "blind_judgment": None,
                             "decision": None, "rationale": None, "proposed_correction": None,
                             "second_reviewer_id": None, "second_decision": None, "adjudication": None,
                             "checks": {key: None for key in CHECKS}, "human_approved": False,
                             "training_authorized": False, "independent_test_eligible": False})
    guide = ("# 최신 보정·보조 정답의 사람 검토 준비\n\n"
             "이 묶음은 전체 원상담을 포함하지 않는다. 아래 과업별 행은 파생 정답이며 독립 사람·사례 수가 아니다.\n"
             "서비스 JSON, 주변인 응답, 문장 기능, 근거 span, 앱 관찰, 관계 기억의 모든 현재 정답을 포함한다.\n"
             "기존 전문 보류 사례 4건은 이 묶음에 합산하지 않으며 기존 전문 검토 경로를 유지한다.\n\n"
             "1. blind_inputs.jsonl의 접두부만 보고 판단을 별도 파일에 먼저 기록한다.\n"
             "2. target_packets.jsonl에서 같은 unit_id의 정답을 열고 원문 근거·화자·불확실성·과업 및 라벨을 대조한다.\n"
             "3. review_requests.jsonl을 복사한 별도 기록에 검토자·시각·승인/수정/보류·이유를 남긴다. 적용 불가 체크에는 이유를 적는다.\n"
             "4. 다른 검토자가 독립 판단하고 불일치와 조정 근거를 기록한다. 원본 pending 양식은 변경하지 않는다.\n"
             "5. 일부 표본의 완료를 전체 완료로 보고하지 않는다. 수정한 정답에는 이전 내용 해시의 승인을 재사용하지 않는다.\n\n"
             "이 도구는 준비 묶음의 완전성과 원본 결속만 검사한다. 사람 신원·의미 타당성·권리·임상 승인·학습 승격을 인증하지 않는다.\n"
             "모든 validation은 개발 노출 자료다. 중복 미검출 행이나 사람 검토 완료만으로 독립 test가 되지 않는다.\n\n"
             "과업별 train/validation 행 수: " + json.dumps(counts, ensure_ascii=False, sort_keys=True) + "\n")
    payloads = {"blind_inputs.jsonl": b"".join(encoded(r) for r in blind),
                "target_packets.jsonl": b"".join(encoded(r) for r in targets),
                "review_requests.jsonl": b"".join(encoded(r) for r in requests),
                "REVIEW_GUIDE.md": guide.encode()}
    manifest = {"schema": REVIEW_SCHEMA, "status": "pending_human_review",
                "source_manifest_sha256": source["manifest_sha256"], "preparer_sha256": staged.digest(Path(__file__)),
                "phase_counts": counts, "review_units": len(requests), "actual_human_decisions": 0,
                "clinical_or_human_approval": False, "training_authorized": False, "independent_test_eligible": False,
                "excluded_original_rows": sum(source["counts"]["01_original"].values()),
                "files": {name: {"sha256": sha(data), "bytes": len(data)} for name, data in payloads.items()}}
    return payloads, manifest


def private_destination(path):
    repo = Path(__file__).resolve().parents[2]
    raw = os.fspath(path)
    # Validate before Path normalizes away '.' components. Never resolve '..'
    # into an apparently valid destination and then walk its lexical parents.
    require(isinstance(raw, str) and not any(part in (".", "..") for part in raw.split(os.sep)),
            "Private output must not contain dot path components")
    path = Path(raw).absolute()
    require(path.is_relative_to(repo), "Private output path must be inside the repository")
    require(path.resolve().is_relative_to(repo), "Private output must remain inside the repository")
    current = path
    while current != repo:
        require(current.parent != current, "Private output path did not reach the repository")
        require(not current.is_symlink(), "Private output may not traverse symlinks")
        current = current.parent
    relative = path.relative_to(repo)
    result = subprocess.run(["git", "check-ignore", "--quiet", "--", str(relative) + "/"], cwd=repo, capture_output=True)
    require(result.returncode == 0, "Private review output must be Git-ignored")
    return path


def write_review(source, destination):
    destination = private_destination(destination)
    require(not destination.exists(), "Review destination already exists")
    require(not destination.resolve().is_relative_to(source["root"]), "Do not write inside the source bundle")
    payloads, manifest = review_payloads(source)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".pending-review-", dir=destination.parent))
    try:
        for name, content in {**payloads, "manifest.json": encoded(manifest)}.items():
            target = temporary / name
            target.write_bytes(content)
            target.chmod(0o600)
        assert_unchanged(source)
        temporary.rename(destination)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {"status": "prepared_pending_review", "manifest_sha256": sha(encoded(manifest)),
            "review_units": manifest["review_units"], "phase_counts": manifest["phase_counts"],
            "actual_human_decisions": 0, "independent_test_eligible": False}


def verify_review(source, destination, expected_sha256):
    destination = private_destination(destination)
    require(destination.is_dir() and not destination.is_symlink(), "Review bundle missing")
    require({p.name for p in destination.iterdir()} == set(REVIEW_FILES) | {"manifest.json"}, "Review file inventory mismatch")
    manifest_path = staged._safe_path(destination.resolve(), "manifest.json")
    _, content, _ = capture(manifest_path, keep=True)
    require(sha(content) == expected_sha256, "Review manifest pin mismatch")
    payloads, expected = review_payloads(source)
    require(parse(content) == expected, "Pending manifest differs from reconstructed source")
    for name, data in payloads.items():
        _, actual, _ = capture(staged._safe_path(destination.resolve(), name), keep=True)
        require(actual == data, "Review payload differs from complete pending source")
    assert_unchanged(source)
    return {"status": "verified_pending_review", "manifest_sha256": expected_sha256,
            "review_units": expected["review_units"], "actual_human_decisions": 0,
            "clinical_or_human_approval": False, "independent_test_eligible": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("audit", "gate", "prepare-review", "verify-review"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    # Keep the lexical spelling until private_destination validates it.
    parser.add_argument("--review")
    parser.add_argument("--expected-review-sha256")
    parser.add_argument("--purpose", default="schema_regression")
    parser.add_argument("--subset", default="all_validation")
    args = parser.parse_args(argv)
    try:
        if args.command in ("prepare-review", "verify-review"):
            require(args.review is not None, "--review is required")
            private_destination(args.review)
        source = load_source(args.root)
        if args.command in ("audit", "gate"):
            report = audit(source)
            if args.command == "gate":
                report = usage_gate(report, args.purpose, args.subset)
        elif args.command == "prepare-review":
            require(args.review is not None, "--review is required")
            report = write_review(source, args.review)
        else:
            require(args.review is not None and args.expected_review_sha256, "--review and external manifest pin are required")
            report = verify_review(source, args.review, args.expected_review_sha256)
        assert_unchanged(source)
        if args.output:
            require(not args.output.resolve().is_relative_to(source["root"]), "Do not write inside the source bundle")
            args.output.parent.mkdir(parents=True, exist_ok=True)
            with args.output.open("xb") as handle:
                handle.write(encoded(report))
        print(json.dumps(report if args.command != "audit" else {k: v for k, v in report.items() if k not in ("rows", "segments")}, ensure_ascii=False))
        return 2 if report.get("allowed") is False else 0
    except (ValueError, OSError, KeyError, TypeError, json.JSONDecodeError):
        # Do not echo parser/source contents or user-supplied private metadata.
        print(json.dumps({"status": "rejected", "error": "invalid_or_changed_source_or_review_contract"}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

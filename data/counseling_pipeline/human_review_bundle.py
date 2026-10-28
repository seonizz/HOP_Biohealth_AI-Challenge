"""Create immutable pending handoffs, never human approvals or training exports.

The verifier reconstructs each unit from explicit original inputs. A manifest
hash kept outside the bundle can additionally pin a handoff across transfers;
local hashes alone cannot authenticate a reviewer or a wholesale source rewrite.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
import os
from pathlib import Path
import stat
import tempfile
from types import MappingProxyType

from . import agent_dataset as draft, agent_training as training, annotations
from . import source_sft as source, source_selection_audit

SCHEMA = "malssi-pending-human-review-bundle-v1"
STATUS = "pending_human_review"
LEGACY_FILES = frozenset(("source_review_queue.jsonl", "annotation_batch.jsonl",
    "agent_authoring_requests.jsonl", "summary.json", "evaluation_history.json",
    "evaluation_history_events.jsonl"))
require = source.require


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key")
        result[key] = value
    return result


def _read(path, *, read_bytes=None):
    path = Path(path)
    require(path.is_file() and not path.is_symlink(), "missing or symlinked input file")
    return _parse(path, path.read_bytes() if read_bytes is None else read_bytes(path))


def _parse(path, content):
    text = content.decode("utf-8")
    if path.suffix == ".jsonl":
        # JSONL records end at LF, not Unicode separators inside JSON strings.
        return _object_rows([json.loads(line, object_pairs_hook=_pairs)
                             for line in text.split("\n") if line not in ("", "\r")])
    value = json.loads(text, object_pairs_hook=_pairs)
    require(isinstance(value, dict), "JSON document must be an object")
    return value


def _file_snapshot(path, message="review input changed while reading"):
    def stamp(info):
        return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                info.st_mtime_ns, info.st_ctime_ns)

    initial = path.lstat()
    require(stat.S_ISREG(initial.st_mode), "missing or symlinked input file")
    with path.open("rb") as stream:
        opened = os.fstat(stream.fileno())
        content = stream.read()
        require(stamp(initial) == stamp(opened) == stamp(os.fstat(stream.fileno())) == stamp(path.lstat()),
                message)
    return content, stamp(opened)


def _manifest_snapshot(path):
    return _file_snapshot(path, "bundle manifest changed during verification")


def _object_rows(value):
    require(isinstance(value, list) and all(isinstance(row, dict) for row in value),
            "review records must be a list of objects")
    return value


def _prefix_shape(prefix):
    require(isinstance(prefix, dict), "review prefix must be an object")
    _object_rows(prefix.get("messages"))


def _encoded(value):
    return (annotations.canonical(value) + "\n").encode("utf-8")


def _jsonl(rows):
    return b"".join(_encoded(row) for row in rows)


def _capture(paths):
    return MappingProxyType({str(path.resolve()): _file_snapshot(path) for path in paths})


def _input_manifest(captured):
    return {name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
            for name, (content, _) in captured.items()}


def _unique(rows, key):
    _object_rows(rows)
    values = [row.get(key) for row in rows]
    require(all(isinstance(value, str) and value for value in values)
            and len(values) == len(set(values)), "missing or duplicate source identity")


def _legacy(directory, *, read_bytes):
    manifest_content = read_bytes(directory / "manifest.json")
    manifest = _parse(directory / "manifest.json", manifest_content)
    require(manifest.get("status") == "prepared_pending_review"
            and manifest.get("training_allowed") is False
            and type(manifest.get("actual_human_decisions")) is int
            and manifest["actual_human_decisions"] == 0, "legacy review is not pending")
    require(isinstance(manifest.get("files"), dict) and set(manifest["files"]) == LEGACY_FILES,
            "legacy file inventory mismatch")
    payloads = {}
    for name, item in manifest["files"].items():
        require(isinstance(item, dict), "legacy file metadata must be an object")
        path = directory / name
        content = read_bytes(path)
        payloads[name] = _parse(path, content)
        require(item.get("sha256") == hashlib.sha256(content).hexdigest()
                and type(item.get("bytes")) is int and item["bytes"] == len(content),
                "legacy file hash mismatch")
    queue = payloads["source_review_queue.jsonl"]
    requests = payloads["agent_authoring_requests.jsonl"]
    _unique(queue, "id")
    _unique(requests, "request_id")
    require(type(manifest.get("queue_rows")) is int and manifest["queue_rows"] == len(queue),
            "legacy queue count mismatch")
    for row in queue:
        _prefix_shape(row.get("prefix"))
        require(isinstance(row.get("target_response"), str), "legacy target must be text")
        require(row.get("status") == "review_pending" and row.get("human_verified") is False
                and row.get("training_allowed") is False and row.get("review") is None,
                "legacy source queue is not pending")
        require(row.get("prefix_sha256") == annotations.digest(row["prefix"])
                and row.get("target_sha256") == source.sha_text(row["target_response"]),
                "legacy source content hash mismatch")
    for row in requests:
        require(row.get("status") == "authoring_pending" and row.get("human_verified") is False
                and row.get("training_allowed") is False
                and all(row.get(key) is None for key in ("prefix", "target_response", "author_id", "review")),
                "legacy authoring request is not pending")
    return {"manifest_path": str((directory / "manifest.json").resolve()),
        "manifest_sha256": hashlib.sha256(manifest_content).hexdigest(),
        "files": manifest["files"], "source_review_requests": len(queue),
        "authoring_requests": len(requests), "human_approved": 0,
        "training_authorized": False,
        "annotation_context_use": "offline_only_may_include_future; not a next-response review prefix"}


def prepare(*, release, pending_cases, legacy_review, contract):
    release, pending_cases, legacy_review, contract = map(Path, (release, pending_cases, legacy_review, contract))
    require(contract.is_file() and not contract.is_symlink(), "review contract missing")
    release_names = {"manifest.json", "episodes.jsonl", "reviews.jsonl"} | {
        f"{unit}/{split}.jsonl" for unit in draft.UNITS for split in draft.SPLITS}
    paths = [release / name for name in sorted(release_names)] + [pending_cases, contract]
    paths += [legacy_review / name for name in sorted(LEGACY_FILES | {"manifest.json"})]
    # Include transitive duplicate checks, package initialization and the resource
    # read by question-bank detection even when no current case matches a phrase.
    paths += [Path(module.__file__) for module in (draft, training, annotations, source, source_selection_audit)]
    paths += [Path(__file__), Path(__file__).with_name("__init__.py"), training.QUESTION_BANK_PATH]
    captured = _capture(paths)
    before = _input_manifest(captured)

    def read_bytes(path):
        # Never fall back to a live file: every consumed input must be declared.
        return captured[str(Path(path).resolve())][0]

    # Strict input parsing complements, rather than bypasses, the existing gate.
    for name in release_names:
        _read(release / name, read_bytes=read_bytes)
    bank_bytes = read_bytes(training.QUESTION_BANK_PATH)
    bank = _parse(training.QUESTION_BANK_PATH, bank_bytes)
    require(training.nonempty(bank.get("version")), "question bank version must be nonempty text")
    for question in _object_rows(bank.get("questions")):
        require(all(isinstance(question.get(key, ""), str) for key in ("canonical_question", "supporting_text")),
                "question bank detection fields must be text")
    _, release_manifest = draft.audit_release(release, allow_ai_draft=True,
        read_bytes=read_bytes, question_bank_bytes=bank_bytes)
    episodes = _read(release / "episodes.jsonl", read_bytes=read_bytes)
    ai_reviews = _read(release / "reviews.jsonl", read_bytes=read_bytes)
    review_by_episode = {review["episode_id"]: review for review in ai_reviews}
    pending = _read(pending_cases, read_bytes=read_bytes)
    _unique(pending, "case_id")
    for case in pending:
        _prefix_shape(case.get("prefix"))
        require(isinstance(case.get("annotation_provenance"), dict)
                and isinstance(case.get("decision"), dict), "case provenance and decision must be objects")
        for claim in _object_rows(case.get("claims")):
            _object_rows(claim.get("evidence"))
        training.validate_case(case, question_bank_bytes=bank_bytes)
        require(case["split"] == "development" and case["training_allowed"] is False
                and case["decision"]["primary_action"] in {"ASK_CFI", "SAFETY_SUPPORT"},
                "specialist cases must remain separate development holds")
    legacy = _legacy(legacy_review, read_bytes=read_bytes)
    blind, targets, requests = [], [], []

    def append(kind, identity, prefix, target, binding, requirements):
        unit_id = kind + ":" + identity
        prefix_hash = annotations.digest(prefix)
        unit_hash = annotations.digest({"source_binding": binding, "prefix": prefix, "target": target})
        common = {"review_unit_id": unit_id, "review_unit_sha256": unit_hash,
                  "prefix_sha256": prefix_hash, "source_binding": binding}
        blind.append({**common, "prefix": prefix})
        targets.append({**common, "target": target})
        requests.append({**common, "schema_version": SCHEMA, "status": STATUS,
            "review_split": "review_only", "development_exposed": True,
            "training_authorized": False, "human_approved": False,
            "requirements": requirements, "reviewer_id": None, "reviewer_type": None,
            "qualification_ref": None, "reviewed_at": None, "independent_prefix_judgment": None,
            "decision": None, "rationale": None, "rubric_version": None,
            "checks": {key: None for key in sorted(training.REVIEW_CHECKS)},
            "source_use_evidence": None, "safety_policy_version": None})

    for episode in episodes:
        annotations_by_message = {a["message_id"]: a for a in episode["annotations"]}
        for index in range(1, len(episode["messages"]), 2):
            message = episode["messages"][index]
            prefix = training.prepare_prefix(episode["messages"][:index], episode["messages"][index - 1]["message_id"])
            binding = {"source_kind": "experimental_ai_draft_response", "episode_id": episode["episode_id"],
                "episode_sha256": annotations.digest(episode), "assistant_message_id": message["message_id"],
                "source_split": episode["split"], "source_root_ids": episode["source_root_ids"],
                "source_group_ids": episode["source_group_ids"], "origin_type": episode["origin_type"],
                "ai_review_record_sha256": annotations.digest(review_by_episode[episode["episode_id"]])}
            append("response", annotations.digest([episode["episode_id"], message["message_id"]]), prefix,
                {"response": message["content"], "annotation": annotations_by_message[message["message_id"]]},
                binding, ["independent_human", "source_use_permission"])
    for case in pending:
        binding = {"source_kind": "specialist_development_hold", "case_id": case["case_id"],
            "case_sha256": training.case_hash(case), "source_split": case["split"],
            "source_root_ids": case["source_root_ids"], "origin_type": case["origin_type"]}
        append("specialist", annotations.digest(case["case_id"]),
            training.annotation_view(case, question_bank_bytes=bank_bytes)["prefix"], case,
            binding, ["independent_human", "domain_expert", "source_use_permission", "resource_version_permission"])
    _unique(requests, "review_unit_id")
    files = {"blind_inputs.jsonl": _jsonl(blind), "target_packets.jsonl": _jsonl(targets),
             "review_requests.jsonl": _jsonl(requests), "legacy_references.json": _encoded(legacy),
             "review_contract.md": read_bytes(contract)}
    summary = {"schema_version": SCHEMA, "status": STATUS, "supporter_episodes": len(episodes),
        "supporter_response_units": sum(release_manifest["counts"]["conversation"].values()),
        "specialist_hold_units": len(pending), "pending_review_units": len(requests),
        "existing_source_review_requests": legacy["source_review_requests"],
        "existing_authoring_requests": legacy["authoring_requests"],
        "ai_review_records": len(ai_reviews),
        "distinct_declared_ai_reviewers": len({r["reviewer_id"] for r in ai_reviews}),
        "specialist_actions": dict(sorted(Counter(c["decision"]["primary_action"] for c in pending).items())),
        "human_approved": 0, "training_authorized": False, "production_ready": False,
        "independent_test_eligible": False}
    manifest = {**summary, "inputs": before, "files": {
        name: {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
        for name, content in sorted(files.items())}}
    require(captured == _capture(paths), "review inputs changed during preparation")
    return {"files": files, "manifest": manifest, "summary": summary, "captured_inputs": captured}


def _verify(output, plan, expected_manifest_sha256=None):
    output = Path(output)
    require(output.is_dir() and not output.is_symlink(), "invalid bundle directory")
    names = set(plan["files"]) | {"manifest.json"}
    require({p.name for p in output.iterdir()} == names
            and all(p.is_file() and not p.is_symlink() for p in output.iterdir()), "bundle file inventory mismatch")
    manifest_path = output / "manifest.json"
    manifest_bytes, manifest_stamp = _manifest_snapshot(manifest_path)
    manifest_sha256 = hashlib.sha256(manifest_bytes).hexdigest()
    if expected_manifest_sha256 is not None:
        require(manifest_sha256 == expected_manifest_sha256, "pinned manifest hash mismatch")
    manifest = _parse(manifest_path, manifest_bytes)
    require(_encoded(manifest) == _encoded(plan["manifest"]), "bundle manifest, original input or pending state mismatch")
    for name, content in plan["files"].items():
        payload, _ = _file_snapshot(output / name, "bundle payload changed during verification")
        if name.endswith((".json", ".jsonl")):
            _parse(output / name, payload)
        require(payload == content, "bundle content differs from original review units")
    require(_manifest_snapshot(manifest_path) == (manifest_bytes, manifest_stamp),
            "bundle manifest changed during verification")
    return {**plan["summary"], "verified": True, "manifest_sha256": manifest_sha256}


def verify(output, *, expected_manifest_sha256=None, **inputs):
    plan = prepare(**inputs)
    result = _verify(output, plan, expected_manifest_sha256)
    require(plan["captured_inputs"] == _capture([Path(p) for p in plan["captured_inputs"]]),
            "review inputs changed during verification")
    return result


def build(output, **inputs):
    output = Path(output)
    require(not output.exists() and not output.is_symlink(), "output exists; preserve previous review bundles")
    for key, path in inputs.items():
        source_path = Path(path).resolve()
        require(output.resolve() != source_path and not output.resolve().is_relative_to(source_path)
                and not source_path.is_relative_to(output.resolve()), "output overlaps review inputs")
    plan = prepare(**inputs)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".human-review-stage-", dir=output.parent) as temporary:
        staging = Path(temporary) / "bundle"
        staging.mkdir()
        for name, content in plan["files"].items():
            (staging / name).write_bytes(content)
        (staging / "manifest.json").write_bytes(_encoded(plan["manifest"]))
        result = _verify(staging, plan)
        require(plan["captured_inputs"] == _capture([Path(p) for p in plan["captured_inputs"]]),
                "review inputs changed before publication")
        output.mkdir(exist_ok=False)
        claimed = output.stat()
        try:
            os.replace(staging, output)
        except BaseException:
            if output.is_dir() and not output.is_symlink() and output.stat().st_ino == claimed.st_ino:
                try:
                    output.rmdir()
                except OSError:
                    pass
            raise
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("release", "pending-cases", "legacy-review", "contract", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--expected-manifest-sha256")
    args = vars(parser.parse_args())
    output, checking, expected = args.pop("output"), args.pop("verify"), args.pop("expected_manifest_sha256")
    try:
        require(checking or expected is None, "manifest pin is only valid with --verify")
        result = verify(output, expected_manifest_sha256=expected, **args) if checking else build(output, **args)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except (ValueError, KeyError, TypeError, OSError):
        # Neither parser messages nor private paths/values are printed on failure.
        print(json.dumps({"status": "invalid", "human_approved": 0, "training_authorized": False,
                          "message": "Pending review handoff failed validation."}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

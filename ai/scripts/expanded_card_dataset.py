#!/usr/bin/env python3
"""Build/verify the local 31B counseling-warmup and expanded-card curriculum.

This prepares data, not model weights. All inference used for admission is
recorded separately; verification itself is offline and uses the standard library.
"""
import argparse
from array import array
from collections import Counter
from copy import deepcopy
from fractions import Fraction
from itertools import zip_longest
import json
import os
from pathlib import Path
import re
import shutil
import sys

import card_expansion as expansion
import native_card_review
import role_dataset as data

SCHEMA = "malssi-expanded-cards-31b-v2"
PHASES = ("00_original_warmup", "01_card_repair", "02_card_generation")
PINS = {
    "tokenizer.json": "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
    "tokenizer_config.json": "239e1a284bd1e75f2d968b11ea148aab984f753fcb437c4deef8c7ee9e5e6a6a",
    "chat_template.jinja": "845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b",
}
META = ("row_id", "task", "split", "weight", "source_group_ids", "source_root_ids", "target_sha256")
LENGTHS = ("prefix_length", "target_length", "sequence_length", "target_boundary_whitespace_trimmed")


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def typed_avoid_schema():
    item = {"type": "object", "properties": {k: {"type": "string", "minLength": 1, "maxLength": 1000}
            for k in ("avoid_phrase", "reason", "alternative")},
            "required": ["avoid_phrase", "reason", "alternative"], "additionalProperties": False}
    return {"type": "object", "properties": {"avoid": {"type": "array", "items": item, "minItems": 1, "maxItems": 4}},
            "required": ["avoid"], "additionalProperties": False}


def project_case(case, review):
    """Only source facts enter inputs; five targets retain one shared lineage."""
    answers = {subject: [] for subject in ("patient", "supporter", "user_goal")}
    for fact in case["facts"]:
        answer = {"origin": "answer_snapshot", "fields": ["text"],
                  "question": "이용자가 제공한 상황", "text": fact["text"]}
        answers[fact["subject"]].append({"subject": fact["subject"], "question_id": fact["question_id"],
                                        "status": "answered", "answers": [answer]})
    identity = "synthetic:cards-expansion-20261025:" + case["case_id"]
    rows = []
    for field in expansion.FIELDS:
        payload = {"stage": "final_card_" + field,
                   "data": {"answers": answers, "retrieval": data.source_only_retrieval(answers)},
                   "output_schema": typed_avoid_schema() if field == "avoid" else data.field_schema(field)}
        target = data.canonical({field: case["cards"][field]})
        rows.append({"row_id": "expanded-" + case["case_id"] + "-" + field,
                     "task": "final_card_" + field, "split": case["split"],
                     "messages": [{"role": "system", "content": data.CARD_PROMPT},
                                  {"role": "user", "content": data.canonical(payload)},
                                  {"role": "assistant", "content": target}],
                     "loss_message_mask": [0, 0, 1], "weight": {"numerator": 1, "denominator": 1},
                     "source_group_ids": [identity], "source_root_ids": [identity],
                     "target_sha256": data.digest(target), "origin_type": case["origin_type"],
                     "provenance": [{"case_id": case["case_id"], "case_sha256": expansion.case_hash(case),
                                     "review_sha256": data.digest(data.canonical(review)),
                                     "transformation": "source_only_five_field_projection_v2"}],
                     "approval_scope": "independent_ai_experiment_only_not_human_clinical_review"})
    return rows


def verify_review(root, case, record):
    """Replay stored review evidence, including the planted error, without inference."""
    if record.get("reviewer_id") == native_card_review.REVIEWER:
        return native_card_review.verify_record(root, case, record)
    data.require(record["case_id"] == case["case_id"] and record["case_sha256"] == expansion.case_hash(case),
                 "Stale review or mismatched case")
    data.require(record["reviewer_id"] == "local-ollama-gemma4:12b"
                 and record["review_version"] == expansion.REVIEW_VERSION
                 and record["review_prompt_sha256"] == data.digest(expansion.REVIEW_PROMPT), "Unexpected reviewer contract")
    data.require(record.get("approval_scope") == "independent_ai_experiment_only_not_human_clinical_review",
                 "Synthetic review must not claim human/clinical approval")
    path = data.safe_path(root / "reviews", record["batch_evidence"])
    data.require(data.file_hash(path) == record["batch_sha256"], "Review evidence hash changed")
    batch = read_json(path)
    data.require(batch["version"] == expansion.REVIEW_VERSION, "Review batch version mismatch")
    request = batch["request"]
    data.require(request["model"] == "gemma4:12b" and request["messages"][0] ==
                 {"role": "system", "content": expansion.REVIEW_PROMPT}, "Review prompt/model changed")
    sources = json.loads(request["messages"][1]["content"])["cases"]
    ids = [s["id"] for s in sources]
    data.require(len(ids) == len(set(ids)) and len(ids) >= 2, "Invalid anonymous review inventory")
    hashes = batch["case_hashes"]
    data.require(set(hashes) == set(ids[:-1]), "Anonymous review binding mismatch")
    matches = [i for i, value in hashes.items() if value == expansion.case_hash(case)]
    data.require(len(matches) == 1, "Case missing/duplicated in review evidence")
    identity = matches[0]
    data.require(next(s for s in sources if s["id"] == identity) ==
                 {"id": identity, "facts": case["facts"], "cards": case["cards"]}, "Reviewer saw a different case")
    control_field = batch["control_field"]
    fields = ("script", "doList", "care", "next", "avoid")
    data.require(control_field in fields, "Invalid negative control field")
    planted, _ = expansion.control_case(sources[0], fields.index(control_field))
    planted["id"] = ids[-1]
    data.require(sources[-1] == planted, "Negative control differs from recorded corruption")
    response = batch["response"]
    data.require(response.get("done") is True and response.get("done_reason") != "length", "Incomplete stored review")
    content = response["message"]["content"].strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content)
    verdicts = expansion.parse_review(json.loads(content), ids)
    control_passed = verdicts[ids[-1]]["field_verdicts"][control_field] != "pass"
    data.require(control_passed and batch["control_passed"] is True and record["control_passed"] is True,
                 "Reviewer accepted negative control")
    verdict = verdicts[identity]
    data.require(record["field_verdicts"] == verdict["field_verdicts"] and record["issues"] == verdict["issues"],
                 "Ledger verdict differs from raw review")
    accepted = all(v == "pass" for v in verdict["field_verdicts"].values()) and not verdict["issues"]
    data.require(type(record["accepted"]) is bool and record["accepted"] == accepted, "False admission flag")
    return accepted


def admission(root):
    cases = expansion.load_cases(root)
    data.require(set(cases) == set(expansion.assignments(root)), "Authoring inventory is incomplete")
    records = native_card_review.review_records(root)
    reviews_by_hash = {}
    for record in records:
        reviews_by_hash.setdefault(record["case_sha256"], []).append(record)
    accepted, rejected = {}, {}
    for identity, case in cases.items():
        reviews = reviews_by_hash.get(expansion.case_hash(case))
        data.require(reviews is not None, "Missing review: " + identity)
        decisions = [verify_review(root, case, record) for record in reviews]
        if all(decisions):
            accepted[identity] = (case, reviews[-1])
        else:
            rejected[identity] = [issue for record in reviews for issue in record["issues"]]
    counts = Counter(case["split"] for case, _ in accepted.values())
    current_hashes = {expansion.case_hash(case) for case in cases.values()}
    current_reviews = [r for r in records if r["case_sha256"] in current_hashes]
    data.require(counts["train"] >= 100 and counts["validation"] >= 25,
                 "Expansion needs at least 100 train / 25 validation accepted fictional families")
    return accepted, {"authored_families": len(cases), "accepted_families": dict(counts),
                      "rejected_families": rejected, "independent_human_or_clinical_review": False,
                      "negative_controls_in_training": False,
                      "admission_reviewer_counts": dict(Counter(r["reviewer_id"] for _, r in accepted.values())),
                      "all_current_review_records_by_reviewer": dict(Counter(r["reviewer_id"] for r in current_reviews)),
                      "stale_review_records_not_used": len(records) - len(current_reviews),
                      "author_topics": dict(Counter(c["topic"] for c, _ in accepted.values())),
                      "relationships": dict(Counter(c["relationship"] for c, _ in accepted.values()))}


def shingles(text):
    normalized = re.sub(r"\s+|[^\w가-힣]", "", text).lower()
    return {normalized[i:i + 4] for i in range(max(1, len(normalized) - 3))}


def novelty_report(accepted, historical):
    """Conservative lexical screen; never claims semantic/test independence."""
    entries = [(identity, c["split"], shingles(" ".join(f["text"] for f in c["facts"])), True)
               for identity, (c, _) in accepted.items()]
    seen = set()
    for row in historical:
        payload = json.loads(row["messages"][-2]["content"])
        facts = data.source_only_retrieval(payload["data"]["answers"])["documents"]
        text = " ".join(f["text"] for f in facts)
        key = data.digest(text)
        if key not in seen:
            entries.append((row["source_root_ids"][0], row["split"], shingles(text), False))
            seen.add(key)
    flagged, maximum, cross_maximum = [], 0, 0
    for index, (left, split, grams, is_new) in enumerate(entries):
        if not is_new:
            continue
        for right, other_split, other, _ in entries[index + 1:]:
            similarity = len(grams & other) / max(1, len(grams | other))
            maximum = max(maximum, similarity)
            if split != other_split:
                cross_maximum = max(cross_maximum, similarity)
            if similarity >= 0.75:
                flagged.append({"left": left, "right": right, "jaccard": similarity})
    data.require(not flagged, "Highly similar source facts require manual quarantine: " + data.canonical(flagged))
    return {"method": "normalized_character_4gram_jaccard", "hold_threshold": 0.75,
            "flagged_pairs": flagged, "max_similarity": maximum, "max_cross_split_similarity": cross_maximum,
            "semantic_independence_proven": False, "comparison": "new_new_and_new_historical_card_facts"}


def index_entry(row, encoded, offset, raw):
    return {**{key: row[key] for key in META}, **{key: encoded[key] for key in LENGTHS},
            "messages_sha256": data.digest(data.canonical(row["messages"])), "offset_tokens": offset,
            "token_sha256": data.digest(raw)}


def token_paths(root, phase, split):
    folder = root / "encoded" / phase
    folder.mkdir(parents=True, exist_ok=True)
    return folder / (split + ".index.jsonl"), folder / (split + ".tokens.bin")


def bind_tokens(root, part, index, binary, mode):
    entries = list(data.read_rows(index))
    part.update(token_index=str(index.relative_to(root)), token_binary=str(binary.relative_to(root)))
    return {"rows": len(entries), "sequence_tokens": sum(x["sequence_length"] for x in entries),
            "target_tokens": sum(x["target_length"] for x in entries),
            "max_sequence_length": max(x["sequence_length"] for x in entries), "method": mode}


def warmup(root, source, prior, course):
    phase = read_json(source / "COURSE.json")["phases"][0]
    prior_phase = read_json(prior / "chat_12b/COURSE.json")["phases"][0]
    stats = {}
    for split in data.SPLITS:
        source_part = phase["data"][split]
        source_indexes = list(data.read_rows(source / source_part["index"]))
        metadata = {r["row_id"]: r for r in source_indexes}
        selected_path = prior / "chat_12b" / prior_phase["data"][split]["path"]
        selected = list(data.read_rows(selected_path))
        selected_ids = {r["row_id"] for r in selected}
        held = list(data.read_rows(prior / "chat_12b/data/hold_shared_openers" / (split + ".jsonl.gz")))
        data.require(selected_ids.isdisjoint(r["row_id"] for r in held)
                     and selected_ids | {r["row_id"] for r in held} == set(metadata), "Original admission selection changed")
        part = data.write_partition(root, PHASES[0], split, selected)
        data.require(data.file_hash(root / part["path"]) == data.file_hash(selected_path), "Selected source rows changed")
        course["phases"][0]["data"][split] = part
        shutil.copyfile(source / source_part["index"], root / "provenance" / ("original_" + split + ".index.jsonl"))
        data.save(root / "provenance" / ("original_" + split + ".selection.json"),
                  {"held_ids": [r["row_id"] for r in held], "selected_messages_file_sha256": data.file_hash(selected_path),
                   "source_index_sha256": data.file_hash(source / source_part["index"]),
                   "source_31b_tokens_sha256": data.file_hash(source / source_part["tokens"]),
                   "selection": "same_frozen_eligible_rows_as_12b_but_tokens_from_original_31b_export"})
        index, binary = token_paths(root, PHASES[0], split)
        offset = 0
        with (source / source_part["tokens"]).open("rb") as inp, binary.open("xb") as out, index.open("x") as ids:
            for row in selected:
                src = metadata[row["row_id"]]
                for key in META:
                    if key != "weight":
                        data.require(row[key] == src[key], "Original source identity mismatch: " + key)
                data.require(data.digest(data.canonical(row["messages"])) == src["messages_sha256"], "Original text changed")
                inp.seek(4 * src["offset_tokens"])
                raw = inp.read(4 * src["sequence_length"])
                data.require(len(raw) == 4 * src["sequence_length"], "Short source token read")
                entry = index_entry(row, src, offset, raw)
                entry["source_31b_offset_tokens"] = src["offset_tokens"]
                ids.write(data.canonical(entry) + "\n")
                out.write(raw)
                offset += src["sequence_length"]
        stats[PHASES[0] + "/" + split] = bind_tokens(root, part, index, binary, "verified_original_31b_tokens_exact_byte_selection")
    return stats


def encode_cards(root, course):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", TOKENIZERS_PARALLELISM="false")
    from transformers import AutoTokenizer
    sys.path.insert(0, str(root / "scripts"))
    from gemma4_token_validation import encode_example, serialize_example
    tokenizer = AutoTokenizer.from_pretrained(str(root / "tokenizer"), local_files_only=True, trust_remote_code=False)
    stats = {}
    for phase in course["phases"][1:]:
        for split in data.SPLITS:
            part = phase["data"][split]
            index, binary = token_paths(root, phase["id"], split)
            offset = 0
            with binary.open("xb") as out, index.open("x") as ids:
                for row in data.read_rows(root / part["path"]):
                    encoded = encode_example(row, tokenizer, 32768)
                    serialized = serialize_example(row, tokenizer)
                    prefix = encoded["prefix_length"]
                    data.require(tokenizer.decode(encoded["input_ids"], skip_special_tokens=False) == serialized["full_text"]
                                 and tokenizer.decode(encoded["input_ids"][prefix:], skip_special_tokens=False) == serialized["completion_text"],
                                 "Fresh card token/text or target-boundary roundtrip failed")
                    tokens = array("I", encoded["input_ids"])
                    data.require(tokens.itemsize == 4, "uint32 required")
                    if sys.byteorder != "little":
                        tokens.byteswap()
                    raw = tokens.tobytes()
                    ids.write(data.canonical(index_entry(row, encoded, offset, raw)) + "\n")
                    out.write(raw)
                    offset += encoded["sequence_length"]
            stats[phase["id"] + "/" + split] = bind_tokens(root, part, index, binary, "fresh_pinned_31b_encoding_and_full_roundtrip")
    return stats


def course_config():
    return {"schema": SCHEMA, "role": "cards_31b", "model": {"parameter_size": "31B", "family": "Gemma 4", "tokenizer_sha256": PINS},
            "phases": [{"id": name, "data": {}, "initial_adapter_from": PHASES[i - 1] if i else None,
                        "new_lora": i == 0, "fresh_optimizer_at_phase_start": True,
                        "checkpoint_binding": "preceding_phase_newly_produced_31b_adapter_sha256" if i else None}
                       for i, name in enumerate(PHASES)],
            "logical_stages": {"1_original_counseling": [PHASES[0]], "2_final_cards": list(PHASES[1:])},
            "loss": {"mask": "last_assistant_only", "reduction": "mean_target_token_CE_per_row",
                     "weighting": "equal_task_then_connected_source_family", "epoch_objective": "sum(weight_i * mean_target_CE_i) / N"},
            "token_storage": "little_endian_uint32_contiguous_no_padding", "label_rule": "[-100] * prefix_length + input_ids[prefix_length:]; no pre-shift",
            "max_sequence_length": 32768, "truncation": False, "packing": False, "sampling": False,
            "full_train_iteration_required_each_epoch": True, "split_reassignment": False,
            "validation_used_for_gradient": False, "independent_test": False,
            "cross_model_adapter_reuse": False, "training_started": False, "gpu_training_server_contacted": False,
            "quality_status": "expanded_experimental_corpus_not_human_or_clinically_validated"}


def check_course(course):
    expected = course_config()
    data.require(set(course) == set(expected), "Course fields changed")
    for key in expected:
        if key != "phases":
            data.require(course[key] == expected[key], "Unsafe/incompatible course: " + key)
    data.require(len(course["phases"]) == len(PHASES), "Wrong training phase count")
    for actual, wanted in zip(course["phases"], expected["phases"]):
        data.require({k: v for k, v in actual.items() if k != "data"} == {k: v for k, v in wanted.items() if k != "data"},
                     "31B adapter continuity or phase order changed")
        data.require(set(actual["data"]) == set(data.SPLITS), "Missing split")


def inventory(root):
    return {str(p.relative_to(root)): {"bytes": p.stat().st_size, "sha256": data.file_hash(p)}
            for p in sorted(root.rglob("*")) if p.is_file() and p.name not in ("MANIFEST.json", "VERIFICATION.json")}


def refresh_manifest(root):
    data.save(root / "MANIFEST.json", {"schema": SCHEMA, "files": inventory(root)})


def build(source, prior, cases, output):
    import staged_dataset
    source, prior, cases = (p.resolve(strict=True) for p in (source, prior, cases))
    output = output.absolute()
    data.require(output.parent.resolve().name == "training_data" and not output.exists(), "Use a new local training_data directory")
    accepted, report = admission(cases)
    historical = [r for s in data.SPLITS for r in data.read_rows(prior / "cards_31b/data/01_card_generation" / (s + ".jsonl.gz"))]
    report["novelty"] = novelty_report(accepted, historical)
    source_hash, prior_hash = data.file_hash(source / "DATASET_MANIFEST.json"), data.file_hash(prior / "MANIFEST.json")
    print("Verifying frozen original and role datasets", flush=True)
    source_report, prior_report = staged_dataset.verify(source), data.verify_bundle(prior)
    output.mkdir(mode=0o700)
    (output / "provenance").mkdir()
    (output / "scripts").mkdir()
    (output / "tokenizer").mkdir()
    for name, expected in PINS.items():
        data.require(data.file_hash(source / "tokenizer" / name) == expected, "Unexpected 31B tokenizer")
        shutil.copyfile(source / "tokenizer" / name, output / "tokenizer" / name)
    shutil.copytree(cases, output / "provenance/expansion")
    data.save(output / "provenance/SOURCE.json", {"staged_manifest_sha256": source_hash, "prior_role_manifest_sha256": prior_hash,
              "staged_verification": source_report, "prior_role_verification": prior_report,
              "original_path_at_build": str(source), "prior_path_at_build": str(prior),
              "original_admission_and_full_context_preserved": True, "evaluation_sources_used_for_new_authoring": False})
    shutil.copyfile(prior / "MANIFEST.json", output / "provenance/PRIOR_MANIFEST.json")
    prior_files = read_json(output / "provenance/PRIOR_MANIFEST.json")["files"]
    for name in ("expanded_card_dataset.py", "card_expansion.py", "role_dataset.py", "test_card_expansion.py",
                 "audit_expanded_card_numeric.py", "audit_staged_numeric.py", "staged_dataset.py", "native_card_review.py"):
        path = Path(__file__).with_name(name)
        if path.exists():
            shutil.copyfile(path, output / "scripts" / name)
    shutil.copyfile(Path(__file__).resolve().parents[2] / "data/counseling_pipeline/gemma4_token_validation.py",
                    output / "scripts/gemma4_token_validation.py")
    course = course_config()
    stats = warmup(output, source, prior, course)
    synthetic = [row for case, record in accepted.values() for row in project_case(case, record)]
    for name, old, rows in ((PHASES[1], "02_card_repair", None), (PHASES[2], "01_card_generation", historical + synthetic)):
        phase = next(p for p in course["phases"] if p["id"] == name)
        for split in data.SPLITS:
            origin = prior / "cards_31b/data" / old / (split + ".jsonl.gz")
            provenance = output / "provenance" / old
            provenance.mkdir(exist_ok=True)
            shutil.copyfile(origin, provenance / (split + ".jsonl.gz"))
            data.require(data.file_hash(provenance / (split + ".jsonl.gz")) ==
                         prior_files[str(origin.relative_to(prior))]["sha256"], "Historical cards changed during export")
            selected = list(data.read_rows(origin)) if rows is None else data.balance(data.deduplicate([r for r in rows if r["split"] == split]))
            phase["data"][split] = data.write_partition(output, name, split, selected)
    print("Encoding expanded cards with pinned 31B tokenizer", flush=True)
    stats.update(encode_cards(output, course))
    data.save(output / "COURSE.json", course)
    data.save(output / "ADMISSION.json", report)
    data.save(output / "TOKENIZATION.json", {"partitions": stats, "tokenizer_sha256": PINS, "truncated_rows": 0,
              "original_token_source": "verified_existing_31b_export_not_12b_token_relabeling",
              "last_assistant_only": True, "model_weights_loaded": False, "gpu_used": False})
    readme = Path(__file__).with_name("expanded_card_training_README.md")
    if readme.exists():
        table = "| 단계 | train | validation |\n|---|---:|---:|\n"
        for phase in course["phases"]:
            table += f"| {phase['id']} | {phase['data']['train']['rows']:,} | {phase['data']['validation']['rows']:,} |\n"
        total = {s: sum(p['data'][s]['rows'] for p in course['phases']) for s in data.SPLITS}
        table += f"| **합계** | **{total['train']:,}** | **{total['validation']:,}** |\n"
        table += f"\n신규 가상 사례: train {report['accepted_families']['train']}개, validation {report['accepted_families']['validation']}개. 사례당 다섯 필드이며 독립 사례 수와 학습 행 수는 다릅니다.\n"
        (output / "README.md").write_text(readme.read_text().replace("<!-- COUNTS -->", table), encoding="utf-8")
    data.require(data.file_hash(source / "DATASET_MANIFEST.json") == source_hash
                 and data.file_hash(prior / "MANIFEST.json") == prior_hash, "Source changed during build")
    refresh_manifest(output)
    print("Auditing every original token byte and independently re-encoding every card", flush=True)
    from audit_expanded_card_numeric import audit
    data.save(output / "NUMERIC_AUDIT.json", audit(output, source))
    refresh_manifest(output)
    verified = verify(output)
    data.save(output / "VERIFICATION.json", verified)
    return verified


def verify(root, require_numeric=True):
    root = root.resolve(strict=True)
    manifest = read_json(root / "MANIFEST.json")
    data.require(manifest["schema"] == SCHEMA and manifest["files"] == inventory(root), "Manifest file inventory/hash mismatch")
    for name in manifest["files"]:
        data.safe_path(root, name)
    course = read_json(root / "COURSE.json")
    check_course(course)
    source_binding = read_json(root / "provenance/SOURCE.json")
    data.require(data.file_hash(root / "provenance/PRIOR_MANIFEST.json") == source_binding["prior_role_manifest_sha256"],
                 "Frozen role manifest changed")
    prior_files = read_json(root / "provenance/PRIOR_MANIFEST.json")["files"]
    for old in ("01_card_generation", "02_card_repair"):
        for split in data.SPLITS:
            name = f"cards_31b/data/{old}/{split}.jsonl.gz"
            data.require(data.file_hash(root / "provenance" / old / (split + ".jsonl.gz")) == prior_files[name]["sha256"],
                         "Historical source is not bound to frozen role manifest")
    for name, expected in PINS.items():
        data.require(data.file_hash(root / "tokenizer" / name) == expected, "31B tokenizer mismatch")
    accepted, admission_report = admission(root / "provenance/expansion")
    historical = [r for s in data.SPLITS for r in data.read_rows(root / "provenance/01_card_generation" / (s + ".jsonl.gz"))]
    admission_report["novelty"] = novelty_report(accepted, historical)
    data.require(admission_report == read_json(root / "ADMISSION.json"), "Admission/novelty report changed")
    generated = historical + [r for c, review in accepted.values() for r in project_case(c, review)]
    expected_cards = {s: data.balance(data.deduplicate([r for r in generated if r["split"] == s])) for s in data.SPLITS}
    lineage, inputs = {s: set() for s in data.SPLITS}, {s: set() for s in data.SPLITS}
    counts, tokens, seen_ids = {}, {}, set()
    for phase in course["phases"]:
        counts[phase["id"]] = {}
        for split, part in phase["data"].items():
            path = data.safe_path(root, part["path"])
            loader = data.IndexedTokens(data.safe_path(root, part["token_index"]), data.safe_path(root, part["token_binary"]))
            if phase["id"] == PHASES[0]:
                source = {r["row_id"]: r for r in data.read_rows(root / "provenance" / ("original_" + split + ".index.jsonl"))}
                selection = read_json(root / "provenance" / ("original_" + split + ".selection.json"))
                data.require(len(selection["held_ids"]) == len(set(selection["held_ids"]))
                             and set(selection["held_ids"]) <= set(source), "Invalid original held inventory")
                data.require(data.file_hash(path) == selection["selected_messages_file_sha256"], "Original row file changed")
                data.require(data.file_hash(root / "provenance" / ("original_" + split + ".index.jsonl")) == selection["source_index_sha256"], "Original index changed")
                wanted_ids = set(source) - set(selection["held_ids"])
                expected_weights = {r["row_id"]: r["weight"] for r in data.balance([r for k, r in source.items() if k in wanted_ids])}
                expected = None
            else:
                rows = (list(data.read_rows(root / "provenance/02_card_repair" / (split + ".jsonl.gz")))
                        if phase["id"] == PHASES[1] else expected_cards[split])
                expected = {r["row_id"]: r for r in rows}
                wanted_ids = set(expected)
            actual_ids, mass, tasks = set(), Fraction(), Counter()
            with loader.binary.open("rb") as binary:
                for row, index in zip_longest(data.read_rows(path), loader.entries):
                    data.require(row is not None and index is not None, "Message/token index inventory differs")
                    data.check_row(row)
                    identity = row["row_id"]
                    data.require(identity not in seen_ids and identity in wanted_ids and row["split"] == split, "Unexpected/duplicate row")
                    seen_ids.add(identity)
                    actual_ids.add(identity)
                    for key in META:
                        data.require(row[key] == index[key], "Index metadata mismatch: " + key)
                    data.require(index["messages_sha256"] == data.digest(data.canonical(row["messages"])), "Index text hash mismatch")
                    raw = binary.read(4 * index["sequence_length"])
                    data.require(data.digest(raw) == index["token_sha256"], "Token byte hash mismatch")
                    values = array("I")
                    values.frombytes(raw)
                    if sys.byteorder != "little":
                        values.byteswap()
                    data.require(len(values) == index["sequence_length"] and max(values) < 262144
                                 and index["sequence_length"] <= course["max_sequence_length"], "Invalid/out-of-capacity token IDs")
                    if expected is not None:
                        data.require(row == expected[identity], "Card row differs from reviewed source-only projection")
                    else:
                        src = source[identity]
                        for key in (*LENGTHS, "messages_sha256", "source_group_ids", "source_root_ids", "target_sha256", "task", "split"):
                            data.require(index[key] == src[key], "Original source binding mismatch: " + key)
                        data.require(index["source_31b_offset_tokens"] == src["offset_tokens"] and row["weight"] == expected_weights[identity], "Original selection/weight changed")
                    lineage[split].update(row["source_group_ids"] + row["source_root_ids"])
                    inputs[split].add(data.digest(data.canonical(row["messages"][:-1])))
                    mass += Fraction(**row["weight"])
                    tasks[row["task"]] += 1
            data.require(actual_ids == wanted_ids and len(actual_ids) == part["rows"] == len(loader)
                         and mass == len(actual_ids) and str(mass) == part["weight_sum"]
                         and dict(tasks) == part["tasks"] and part["id_set_sha256"] == data.digest("\n".join(sorted(actual_ids))),
                         "Partition inventory, task count or normalized weight mismatch")
            counts[phase["id"]][split] = len(actual_ids)
            tokens[phase["id"] + "/" + split] = sum(i["sequence_length"] for i in loader.entries)
    data.require(not lineage["train"] & lineage["validation"], "Cross-split source-family leakage")
    data.require(not inputs["train"] & inputs["validation"], "Cross-split exact input leakage")
    if require_numeric:
        check_numeric_report(root, course, counts, tokens)
    return {"status": "passed" if require_numeric else "integrity_passed_numeric_audit_pending", "phases": counts, "sequence_tokens": tokens,
            "new_fictional_families": admission_report["accepted_families"], "cross_split_lineage_overlap": 0,
            "cross_split_exact_input_overlap": 0, "all_row_and_token_hashes_checked": True,
            "new_cards_bound_to_independent_ai_review": True, "numeric_audit_bound_to_current_files": require_numeric,
            "original_31b_byte_comparison_and_card_reencoding_completed": require_numeric,
            "independent_test": False, "human_or_clinically_validated": False, "training_started": False, "gpu_used": False}


def check_numeric_report(root, course, counts, tokens):
    from audit_expanded_card_numeric import numeric_inputs
    path = root / "NUMERIC_AUDIT.json"
    data.require(path.is_file(), "Required numerical audit is missing")
    proof = read_json(path)
    data.require(proof.get("status") == "passed" and proof.get("mismatches") == 0
                 and proof.get("audited_files") == numeric_inputs(root, course), "Numerical audit is stale or incomplete")
    expected = {"original_rows": sum(counts[PHASES[0]].values()),
                "card_rows": sum(n for phase in PHASES[1:] for n in counts[phase].values()),
                "original_tokens": sum(v for k, v in tokens.items() if k.startswith(PHASES[0] + "/")),
                "card_tokens": sum(v for k, v in tokens.items() if not k.startswith(PHASES[0] + "/"))}
    data.require(proof.get("counts") == expected and all(v > 0 for v in expected.values()), "Incomplete numerical audit coverage")
    data.require(proof["source_manifest_sha256"] == read_json(root / "provenance/SOURCE.json")["staged_manifest_sha256"],
                 "Numerical audit used a different original source")
    data.require(proof["audit_script_sha256"] == data.file_hash(root / "scripts/audit_expanded_card_numeric.py"),
                 "Numerical audit implementation changed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("build", "verify"))
    parser.add_argument("--root", type=Path)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--prior", type=Path)
    parser.add_argument("--cases", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        if any(getattr(args, k) is None for k in ("source", "prior", "cases", "output")):
            parser.error("build requires --source --prior --cases --output")
        result = build(args.source, args.prior, args.cases, args.output)
    else:
        if args.root is None:
            parser.error("verify requires --root")
        result = verify(args.root)
    print(json.dumps(result, ensure_ascii=False))

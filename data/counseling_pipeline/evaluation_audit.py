"""Read-only split novelty diagnostics, without participant or label guarantees."""
from __future__ import annotations

from collections import Counter, defaultdict
import hashlib
from itertools import zip_longest
import json
import os
from pathlib import Path
import sqlite3
import unicodedata

import numpy as np

from .ingest import PARAGRAPH_METADATA
from .numeric import fingerprint


NORMALIZATION = "NFKC followed by Unicode whitespace collapse and outer trim; case preserved"
LONG_SENTENCE_CHARACTERS = 30
GROUP_METADATA_FIELDS = ("class", "gender", "age")


def normalize_sentence(text: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", text).split())


def _encoded(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _type(value) -> str:
    return {type(None): "null", bool: "boolean", int: "integer", float: "number",
            str: "string", list: "array", dict: "object"}[type(value)]


def _hash(text: str) -> bytes:
    return hashlib.sha256(text.encode("utf-8")).digest()


def _ratio(numerator: int, denominator: int):
    return numerator / denominator if denominator else None


def _conversation_audit(db):
    split_conversations = Counter()
    groups_by_split, group_metadata = defaultdict(set), defaultdict(lambda: defaultdict(set))
    missing_group_by_split = Counter()
    typed_labels, present_labels = defaultdict(Counter), Counter()
    total_utterances = dictionary_utterances = numeric_cells = numeric_zero_cells = 0
    for split, gid, raw in db.execute("SELECT split,group_id,raw_json FROM conversations"):
        payload = json.loads(raw)
        split_conversations[split] += 1
        if gid is None or gid == "":
            missing_group_by_split[split] += 1
        else:
            groups_by_split[split].add(gid)
            for field in GROUP_METADATA_FIELDS:
                # Missing and explicitly null metadata are distinct observations.
                observed = (_type(payload[field]), _encoded(payload[field])) if field in payload else ("missing", "")
                group_metadata[gid][field].add(observed)
        for paragraph in payload["paragraph"]:
            total_utterances += 1
            if not isinstance(paragraph, dict):
                continue
            dictionary_utterances += 1
            for key, value in paragraph.items():
                if key in PARAGRAPH_METADATA:
                    continue
                value_type = _type(value)
                typed_labels[key][(value_type, _encoded(value))] += 1
                present_labels[key] += 1
                if type(value) in (int, float):
                    numeric_cells += 1
                    numeric_zero_cells += value == 0
    by_field = {field: sum(len(values[field]) > 1 for values in group_metadata.values())
                for field in GROUP_METADATA_FIELDS}
    inconsistent = sum(any(len(values[field]) > 1 for field in GROUP_METADATA_FIELDS)
                       for values in group_metadata.values())
    label_rows = []
    for key in sorted(typed_labels):
        values, zero_count, numeric_count = [], 0, 0
        for (value_type, encoded), count in sorted(typed_labels[key].items()):
            item = {"type": value_type, "count": count}
            if value_type in {"integer", "number", "boolean", "null"}:
                value = json.loads(encoded)
                item["value"] = value
                if value_type in {"integer", "number"}:
                    numeric_count += count
                    if value == 0:
                        zero_count += count
            else:
                # Unknown annotation fields may contain free text or personal
                # information. Only their typed equality counts are exported.
                item.update(value_sha256=_hash(encoded).hex(), raw_value_omitted=True)
            values.append(item)
        label_rows.append({"key": key, "observed_cells": present_labels[key],
            "missing_utterance_count": total_utterances - present_labels[key],
            "numeric_cells": numeric_count, "numeric_zero_cells": zero_count,
            "numeric_zero_ratio_among_all_cells": _ratio(zero_count, present_labels[key]),
            "numeric_zero_ratio_among_numeric_cells": _ratio(zero_count, numeric_count),
            "typed_values": values})
    all_cells = sum(present_labels.values())
    label_report = {"scope": "all unique stored conversations; original utterance label cells only",
        "utterances": total_utterances, "dictionary_utterances": dictionary_utterances,
        "all_label_cells": all_cells, "numeric_cells": numeric_cells,
        "numeric_zero_cells": numeric_zero_cells,
        "numeric_zero_ratio_among_all_label_cells": _ratio(numeric_zero_cells, all_cells),
        "numeric_zero_ratio_among_numeric_label_cells": _ratio(numeric_zero_cells, numeric_cells),
        "constant_observed_label_keys": [key for key in sorted(typed_labels) if len(typed_labels[key]) == 1],
        "labels": label_rows,
        "interpretation": "Numeric zero is an observed source value, not verified absence or intensity. Boolean false and null are separate types. Missing cells are not zero.",
        "nonnumeric_value_policy": "String/array/object source values are hashed; original values remain in the read-only corpus."}
    group_split_membership = defaultdict(set)
    for split, groups in groups_by_split.items():
        for gid in groups:
            group_split_membership[gid].add(split)
    return {"split_conversations": split_conversations, "groups_by_split": groups_by_split,
        "missing_groups": missing_group_by_split, "inconsistent": inconsistent,
        "inconsistent_by_field": by_field,
        "groups_in_multiple_splits": sum(len(splits) > 1 for splits in group_split_membership.values()),
        "labels": label_report}


def _sentence_counts(db):
    by_split, lengths = defaultdict(Counter), {}
    for text, split in db.execute("SELECT text,split FROM sentences"):
        normalized = normalize_sentence(text)
        key = _hash(normalized)
        by_split[split][key] += 1
        lengths[key] = len(normalized)
    return by_split, lengths


def _sentence_report(by_split, lengths):
    train = by_split.get("train", Counter())
    validation = by_split.get("validation", Counter())
    combined = Counter()
    split_report = {}
    for split, counts in sorted(by_split.items()):
        combined.update(counts)
        occurrences = sum(counts.values())
        seen = sum(n for key, n in counts.items() if key in train)
        long_total = sum(n for key, n in counts.items() if lengths[key] >= LONG_SENTENCE_CHARACTERS)
        long_seen = sum(n for key, n in counts.items() if key in train and lengths[key] >= LONG_SENTENCE_CHARACTERS)
        split_report[split] = {"occurrences": occurrences, "unique_normalized": len(counts),
            "duplicate_normalized_values": sum(n > 1 for n in counts.values()),
            "occurrences_beyond_first": occurrences - len(counts),
            "occurrences_seen_in_train": seen,
            "occurrences_seen_in_train_ratio": _ratio(seen, occurrences),
            "length_ge_30_occurrences": long_total,
            "length_ge_30_occurrences_seen_in_train": long_seen,
            "length_ge_30_occurrences_seen_in_train_ratio": _ratio(long_seen, long_total)}
    intersection = train.keys() & validation.keys()
    return {"normalization": NORMALIZATION, "comparison": "SHA-256 equality of normalized UTF-8 text",
        "length_unit": "Unicode code points after normalization", "length_threshold": LONG_SENTENCE_CHARACTERS,
        "total_occurrences": sum(combined.values()), "unique_normalized_all_splits": len(combined),
        "duplicate_normalized_values_all_splits": sum(n > 1 for n in combined.values()),
        "occurrences_beyond_first_all_splits": sum(combined.values()) - len(combined),
        "splits": split_report,
        "train_validation_shared_unique_normalized": len(intersection),
        "validation_occurrences_seen_in_train": sum(validation[key] for key in intersection),
        "validation_length_ge_30_occurrences_seen_in_train": sum(validation[key] for key in intersection if lengths[key] >= LONG_SENTENCE_CHARACTERS),
        "train_membership_policy": "Each training sentence sees itself; this is set membership, not leave-one-out duplication.",
        "split_policy": "Only exact split='validation' participates in validation counts and masks. Quarantine, unknown, and other splits stay separate."}


def _save_array(root, name, matrix, columns, row_mapping):
    path = root / name
    temporary = path.with_suffix(path.suffix + ".tmp")
    with temporary.open("wb") as handle:
        np.save(handle, matrix, allow_pickle=False)
    temporary.replace(path)
    return {"path": name, "shape": list(matrix.shape), "dtype": str(matrix.dtype),
        "row_mapping": row_mapping, "columns": columns,
        "method": "normalized_sentence_train_membership", "fit_partition": "none; diagnostic only",
        "sha256": fingerprint(path)}


def build_evaluation_audit(db, root, numeric_root) -> dict:
    """Write diagnostic arrays aligned exactly to the existing sentence mapping.

    Accept a sqlite3 connection (including sqlite3.Row results) or a database
    path. All SQL is SELECT. No source rows, splits, or input artifacts change.
    """
    owned = not isinstance(db, sqlite3.Connection)
    if owned:
        db = sqlite3.connect(Path(db).resolve().as_uri() + "?mode=ro", uri=True)
    root, numeric_root = Path(root), Path(numeric_root)
    try:
        groups = _conversation_audit(db)
        by_split, lengths = _sentence_counts(db)
        report = _sentence_report(by_split, lengths)
        n = report["total_occurrences"]
        masks = np.zeros((n, 2), dtype=np.uint8)
        seen = np.zeros((n, 1), dtype=np.uint8)
        train = by_split.get("train", Counter())
        query = "SELECT rowid,sentence_id,split,text FROM sentences ORDER BY sentence_id"
        with (numeric_root / "sentence_rows.jsonl").open(encoding="utf-8") as mapping:
            for i, (line, record) in enumerate(zip_longest(mapping, db.execute(query))):
                if line is None or record is None or i >= n:
                    raise ValueError("sentence row mapping count mismatch")
                mapped = json.loads(line)
                rowid, sid, split, text = record
                if type(mapped.get("row")) is not int or mapped["row"] != i or mapped.get("id") != sid:
                    raise ValueError(f"sentence row mapping identity mismatch at row {i}")
                if mapped.get("split") != split:
                    raise ValueError(f"sentence row mapping split mismatch at row {i}")
                if "rowid" in mapped and (type(mapped["rowid"]) is not int or mapped["rowid"] != rowid):
                    raise ValueError(f"sentence row mapping SQLite rowid mismatch at row {i}")
                normalized = normalize_sentence(text)
                exists = _hash(normalized) in train
                seen[i, 0] = exists
                masks[i, 0] = split == "validation" and not exists
                masks[i, 1] = split == "validation" and not exists and len(normalized) >= LONG_SENTENCE_CHARACTERS
        root.mkdir(parents=True, exist_ok=True)
        row_mapping = Path(os.path.relpath((numeric_root / "sentence_rows.jsonl").resolve(),
                                          root.resolve())).as_posix()
        artifacts = [
            _save_array(root, "sentence_evaluation_masks.npy", masks,
                ["validation_unseen_in_train", "validation_length_ge_30_unseen_in_train"], row_mapping),
            _save_array(root, "sentence_seen_in_train.npy", seen, ["normalized_sentence_seen_in_train"], row_mapping),
        ]
        splits = sorted(set(groups["split_conversations"]) | set(by_split))
        return {"version": 1, "method": "read-only normalized sentence novelty and provisional group/source-label audit",
            "provisional_group_identity_verified": False,
            "validation_split_group_count": len(groups["groups_by_split"].get("validation", set())),
            "split_counts": {split: {"conversations": groups["split_conversations"][split],
                "provisional_groups": len(groups["groups_by_split"].get(split, set())),
                "conversations_missing_group_id": groups["missing_groups"][split],
                "sentences": sum(by_split.get(split, {}).values())} for split in splits},
            "provisional_groups_in_multiple_splits": groups["groups_in_multiple_splits"],
            "group_metadata_inconsistency": groups["inconsistent"],
            "group_metadata_inconsistency_by_field": groups["inconsistent_by_field"],
            "group_metadata_inconsistency_definition": "A provisional group has differing typed values or missingness in class, gender, or age; this does not establish participant identity.",
            "sentence_duplicates": report,
            "validation_unseen_in_train_occurrences": int(masks[:, 0].sum()),
            "validation_length_ge_30_unseen_in_train_occurrences": int(masks[:, 1].sum()),
            "raw_utterance_labels": groups["labels"], "artifacts": artifacts,
            "interpretation": "Novelty diagnostics only. Shared normalized wording is not proof of participant leakage; unseen wording is not proof of independent participants or reliable target labels. Source splits are unchanged."}
    finally:
        if owned:
            db.close()

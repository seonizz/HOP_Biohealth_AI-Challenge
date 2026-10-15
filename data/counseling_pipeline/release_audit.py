"""Read-only release checks and a fail-closed loader for the three-unit release.

Passing classification integrity is deliberately separate from proving R7 across
all auxiliary/generation/evaluation paths. No source text is included in reports.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
import sys
import unicodedata

import numpy as np

from .numeric import dump, fingerprint

LABELS = ["우울", "중독", "불안", "기타"]
UNITS = ("conversation", "sentence", "word")
SPLITS = ("train", "validation")
CLASS_MAP = dict(zip(("DEPRESSION", "ADDICTION", "ANXIETY", "NORMAL"), LABELS))


def _require(condition, message):
    # Assertions can disappear under python -O; these are admission checks.
    if not condition:
        raise ValueError(message)


def _json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _rows(path):
    with Path(path).open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def _inside(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    _require(path.is_relative_to(root) and path != root, "Manifest path escapes release")
    return path


def verify_hashes(root, required=None):
    """Require coverage as well as matching hashes; the index is not a signature."""
    root = Path(root)
    declared = _json(root / "FILES.sha256.json")
    _require(isinstance(declared, dict) and declared, "Empty hash index")
    names = list(declared) if required is None else list(required)
    for name in names:
        _require(name in declared, "Required artifact missing from hash index: " + name)
        path = _inside(root, name)
        _require(path.is_file(), "Missing artifact: " + name)
        _require(fingerprint(path) == declared[name], "Artifact hash mismatch: " + name)
    return {"checked_files": len(names), "passed": True,
            "index_sha256": fingerprint(root / "FILES.sha256.json"),
            "authenticity_guarantee": False}


def _identity(row):
    return row.get("id", row.get("record_id"))


def _label_counts(rows):
    return {label: sum(label in row["labels"] for row in rows) for label in LABELS}


def _check_declared_counts(declared, actual, context):
    # JSON comparison preserves integer/boolean types as well as nested counts.
    _require(json.dumps(declared, sort_keys=True) == json.dumps(actual, sort_keys=True),
             "Declared count mismatch: " + context)


def _check_conversation_counts(manifest, rows):
    origins = [row.get("conversation_id") for split in SPLITS for row in rows[split]]
    _require(all(isinstance(cid, str) and cid for cid in origins), "Missing source conversation identity")
    _require(len(origins) == len(set(origins)), "Duplicate source conversation")
    _check_declared_counts(manifest.get("exported_conversations"), len(origins), "exported_conversations")
    _check_declared_counts(manifest.get("output_counts"),
                           {split: _label_counts(rows[split]) for split in SPLITS}, "conversation output_counts")


def audit_declared_counts(root, rows):
    """Check delivered-row declarations, not pre-sampling candidate totals."""
    root = Path(root)
    checked = []
    for unit, filename in (("conversation", "manifest.json"), ("sentence", "manifest.json"),
                           ("word", "build_summary.json")):
        relative = f"{unit}/{filename}"
        if unit not in rows or (unit != "conversation" and not (root / relative).exists()):
            continue
        verify_hashes(root, [relative])
        manifest = _json(root / relative)
        if unit == "conversation":
            _check_conversation_counts(manifest, rows[unit])
        else:
            key, labels_key = ("counts", "labels") if unit == "sentence" else ("splits", "label_counts")
            _require(set(manifest.get(key, {})) == set(SPLITS), "Declared split mismatch: " + relative)
            for split in SPLITS:
                declared = manifest[key][split]
                _check_declared_counts(declared.get("rows"), len(rows[unit][split]), relative + "/" + split)
                _check_declared_counts(declared.get(labels_key), _label_counts(rows[unit][split]), relative + "/" + split + " labels")
            if unit == "word":
                _check_declared_counts(manifest.get("active_families"), sum(map(len, rows[unit].values())), relative + " active_families")
        checked.append(relative)
    if (root / "summary.json").exists():
        verify_hashes(root, ["summary.json"])
        declared = _json(root / "summary.json").get("units")
        actual = {unit: {**{split: len(rs[split]) for split in SPLITS},
                         "total": sum(map(len, rs.values())),
                         "label_counts": _label_counts(rs["train"] + rs["validation"])}
                  for unit, rs in rows.items()}
        _check_declared_counts(declared, actual, "summary.json units")
        checked.append("summary.json")
    return {"passed": True, "manifests_checked": checked}


def _check_rows(rows, unit, split):
    ids = [_identity(row) for row in rows]
    _require(rows and all(isinstance(i, str) and i for i in ids), "Missing row identity")
    _require(len(set(ids)) == len(ids), "Duplicate row identity")
    if unit == "conversation":
        origins = [row.get("conversation_id") for row in rows]
        _require(all(isinstance(cid, str) and cid for cid in origins), "Missing source conversation identity")
        _require(len(set(origins)) == len(origins), "Duplicate source conversation")
    for row in rows:
        labels = row.get("labels")
        _require(isinstance(labels, list) and labels and len(set(labels)) == len(labels)
                 and set(labels) <= set(LABELS), "Invalid labels")
        _require(labels == sorted(labels, key=LABELS.index), "Noncanonical label order")
        _require("기타" not in labels or labels == ["기타"], "Other must be exclusive")
        expected = [int(label in labels) for label in LABELS]
        _require(row.get("labels_multihot") == expected, "Row multihot mismatch")
        _require(row.get("label_ids") == [LABELS.index(label) for label in labels], "Label ID mismatch")
        _require(row.get("label_id") == (LABELS.index(labels[0]) if len(labels) == 1 else None), "Scalar label mismatch")
        _require(row.get("split") == split, "Row split mismatch")
        _require(isinstance(row.get("text"), str) and row["text"].strip(), "Empty input text")
        if unit != "word":
            _require(row.get("original_split") == split, "Original split changed")
        if unit == "conversation":
            _require(CLASS_MAP.get(row.get("source_class")) == labels[0] and len(labels) == 1,
                     "Conversation source class mismatch")
            _require([row.get("y_" + name) for name in ("depression", "addiction", "anxiety", "other")] == expected,
                     "Conversation y columns mismatch")
    return ids


def load_checked_unit(root, unit, split="train"):
    """Load only hash-covered, aligned, structurally valid classifier artifacts.

    This is the replacement admission boundary; the frozen release is not edited.
    Use audit_release before combining these units with other training paths.
    """
    _require(unit in UNITS and split in SPLITS, "Unknown unit or split")
    root = Path(root)
    names = [f"{unit}/{split}.jsonl", f"{unit}/numeric/{split}_X.npz",
             f"{unit}/numeric/{split}_y.npy", f"{unit}/numeric/{split}_rows.json",
             f"{unit}/numeric/vocabulary.json", f"{unit}/numeric/manifest.json",
             f"{unit}/numeric/idf.npy", f"{unit}/numeric/document_frequency.json"]
    if split == "train":
        names.append(f"{unit}/numeric/train_sample_weight.npy")
    verify_hashes(root, names)
    folder = root / unit
    rows = _rows(folder / f"{split}.jsonl")
    ids = _check_rows(rows, unit, split)
    numeric = folder / "numeric"
    _require(_json(numeric / f"{split}_rows.json") == ids, "Numeric row identity/order mismatch")
    vocabulary = _json(numeric / "vocabulary.json")
    _require(list(vocabulary.values()) == list(range(len(vocabulary))), "Vocabulary index mismatch")
    manifest = _json(numeric / "manifest.json")
    _require(manifest["label_order"] == LABELS, "Manifest label order mismatch")
    _require(set(manifest.get("counts", {})) == set(SPLITS), "Numeric declared split mismatch")
    _check_declared_counts(manifest["counts"][split], {
        "rows": len(rows), "labels": _label_counts(rows),
        "multi_label_rows": sum(len(row["labels"]) > 1 for row in rows),
        "matrix_shape": [len(rows), len(vocabulary)], "zero_feature_rows": 0},
        f"{unit}/numeric/{split}")
    if split == "train":
        _check_declared_counts(manifest.get("training_positive_class_counts"),
                               list(_label_counts(rows).values()), f"{unit}/numeric training_positive_class_counts")
    with np.load(numeric / f"{split}_X.npz", allow_pickle=False) as archive:
        _require(archive["format"].item() == b"csr", "Not CSR")
        X = {key: archive[key].copy() for key in ("data", "indices", "indptr", "shape")}
    data, indices, indptr, shape = (X[key] for key in ("data", "indices", "indptr", "shape"))
    _require(shape.dtype.kind in "iu" and shape.shape == (2,)
             and shape.tolist() == [len(rows), len(vocabulary)], "CSR shape mismatch")
    _require(indices.dtype.kind in "iu" and indptr.dtype.kind in "iu"
             and indices.ndim == indptr.ndim == data.ndim == 1, "Invalid CSR array types")
    _require(len(indptr) == len(rows) + 1 and indptr[0] == 0
             and indptr[-1] == len(indices) == len(data)
             and (indptr[1:] > indptr[:-1]).all(), "Invalid/empty CSR rows")
    _require(np.isfinite(data).all() and (data > 0).all()
             and (indices >= 0).all() and (indices < len(vocabulary)).all(), "Invalid CSR values/indices")
    for start, end in zip(indptr[:-1], indptr[1:]):
        _require((indices[start+1:end] > indices[start:end-1]).all(), "CSR duplicate/unsorted columns")
        _require(np.isclose(np.linalg.norm(data[start:end]), 1, atol=1e-5), "CSR row not L2 normalized")
    y = np.load(numeric / f"{split}_y.npy", allow_pickle=False)
    expected = np.asarray([row["labels_multihot"] for row in rows], dtype=np.uint8)
    _require(y.dtype == np.uint8 and y.shape == (len(rows), 4)
             and np.array_equal(y, expected), "Numeric target mismatch")
    weights = None
    if split == "train":
        weights = np.load(numeric / "train_sample_weight.npy", allow_pickle=False)
        _require(weights.shape == (len(rows),) and np.isfinite(weights).all()
                 and (weights > 0).all(), "Invalid sample weights")
        counts = y.sum(axis=0)
        _require((counts > 0).all(), "Training class missing")
        expected_weights = (y * (len(rows) / (4 * counts))).sum(axis=1) / y.sum(axis=1)
        expected_weights = (expected_weights / expected_weights.mean()).astype(np.float32)
        _require(np.array_equal(weights, expected_weights), "Sample weight fit mismatch")
    return X, y, weights, rows


def _terms(text):
    text = unicodedata.normalize("NFD", text).casefold()
    return Counter(text[i:i+n] for n in (1, 2, 3) for i in range(len(text)-n+1))


def audit_features(root, unit, loaded):
    """Independently bind every feature row to text and refit train DF/IDF."""
    numeric = Path(root) / unit / "numeric"
    vocabulary = _json(numeric / "vocabulary.json")
    manifest = _json(numeric / "manifest.json")
    _require(manifest.get("input_columns") == ["text"] and manifest.get("target_columns") == ["labels_multihot"],
             "Feature/target column contract mismatch")
    _require(manifest.get("feature_fit_split") == "train"
             and manifest.get("validation_used_for_vocabulary_or_idf") is False, "Non-train feature fit declaration")
    df = Counter()
    for row in loaded["train"][3]:
        df.update(_terms(row["text"]).keys())
    limit = {"conversation": 20000, "sentence": 12000, "word": 4000}[unit]
    terms = sorted(df, key=lambda term: (-df[term], term))[:limit]
    _require(list(vocabulary) == terms, "Vocabulary not fitted on train text only")
    _require(_json(numeric / "document_frequency.json") == [df[term] for term in terms], "Train DF mismatch")
    n = len(loaded["train"][3])
    idf = np.asarray([math.log((n + 1) / (df[term] + 1)) + 1 for term in terms], dtype=np.float32)
    _require(np.array_equal(np.load(numeric / "idf.npy", allow_pickle=False), idf), "Train IDF mismatch")
    checked = 0
    for split in SPLITS:
        X, _, _, rows = loaded[split]
        for i, row in enumerate(rows):
            counts = {vocabulary[t]: count for t, count in _terms(row["text"]).items() if t in vocabulary}
            columns = np.asarray(sorted(counts), dtype=np.int32)
            values = np.asarray([counts[column] for column in columns], dtype=np.float32)
            values = (1 + np.log(values)) * idf[columns]
            _require(len(values) > 0, "Text produces no features")
            values /= np.linalg.norm(values)
            start, end = X["indptr"][i:i+2]
            _require(np.array_equal(columns, X["indices"][start:end])
                     and np.allclose(values, X["data"][start:end], rtol=1e-6, atol=1e-7),
                     f"Text/feature row mismatch: {unit}/{split} row {i}")
            checked += 1
    return {"passed": True, "train_df_idf_vocabulary_recomputed": True,
            "text_feature_rows_recomputed": checked, "input_columns": ["text"]}


def check_source_links(records, source_splits):
    """Check every declared origin, including multi-source and synthetic derivatives.

    Missing origins are unknown, never proof of independence. Each record needs
    unit, row_id, split, source_conversation_ids; all source IDs must be known.
    """
    conflicts, missing, seen = [], [], set()
    assignments = defaultdict(set)
    for row in records:
        key = (row["unit"], row["row_id"])
        _require(key not in seen, "Duplicate lineage row")
        seen.add(key)
        _require(row["split"] in SPLITS, "Unknown lineage split")
        origins = row.get("source_conversation_ids")
        if not isinstance(origins, list) or not origins:
            missing.append(key)
            continue
        for origin in origins:
            if origin not in source_splits:
                missing.append(key)
            else:
                assignments[origin].add(row["split"])
                if source_splits[origin] != row["split"]:
                    conflicts.append(key)
    shared = sum(len(splits) > 1 for splits in assignments.values())
    return {"passed": not conflicts and not missing and not shared,
            "rows": len(records), "unknown_origin_rows": len(set(missing)),
            "wrong_source_split_rows": len(set(conflicts)), "cross_split_shared_origins": shared,
            "problem_row_ids": [list(key) for key in sorted(set(missing + conflicts))[:20]]}


def audit_sources(root, database, rows):
    """Validate identities and text against a read-only corpus, including filter lineage."""
    root, database = Path(root), Path(database)
    verify_hashes(root, ["conversation/manifest.json", "conversation/input_filter_review.json"])
    manifest = _json(root / "conversation/manifest.json")
    _check_conversation_counts(manifest, rows["conversation"])
    _require(fingerprint(database) == manifest["source_database_sha256"], "Source database hash mismatch")
    audit = _json(root / "conversation/input_filter_review.json")["records"]
    removals = defaultdict(dict)
    for item in audit:
        cid, line = item["conversation_id"], item["turn_line"]
        _require(type(line) is int and line >= 0 and line not in removals[cid], "Duplicate/invalid input filter index")
        removals[cid][line] = item["original_turn"]
    db = sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    try:
        source = {cid: (split, group, subject, original) for cid, split, group, subject, original in db.execute(
            "SELECT conversation_id,split,group_id,subject_id,original_split FROM conversations")}
        source_splits = {cid: record[0] for cid, record in source.items()}
        source_ids = defaultdict(set)
        for sid, cid in db.execute("SELECT source_id,conversation_id FROM sources WHERE conversation_id IS NOT NULL"):
            source_ids[cid].add(sid)
        checked_sentences = checked_conversations = removed = 0
        groups, subjects = defaultdict(set), defaultdict(set)
        exported = set()
        for unit in ("conversation", "sentence"):
            for split in SPLITS:
                for row in rows[unit][split]:
                    cid = row["conversation_id"]
                    _require(cid in source, "Missing source conversation")
                    expected_split, group, subject, original = source[cid]
                    _require(split == expected_split == original and row["group_id"] == group,
                             "Source conversation split/group mismatch")
                    decoded_subject = json.loads(subject) if subject else None
                    _require(row.get("subject_id") == decoded_subject, "Source subject mismatch")
                    groups[group].add(split)
                    if decoded_subject is not None:
                        subjects[json.dumps(decoded_subject, sort_keys=True)].add(split)
                    if unit == "sentence":
                        record = db.execute("SELECT s.text,s.utterance_id,s.conversation_id,s.split,s.start_char,s.end_char,u.text "
                            "FROM sentences s JOIN utterances u USING(utterance_id) WHERE s.sentence_id=?", (row["id"],)).fetchone()
                        _require(record is not None and record[:6] == (row["text"], row["utterance_id"], cid,
                                 split, row["start_char"], row["end_char"]), "Source sentence identity/offset mismatch")
                        _require(record[6][row["start_char"]:row["end_char"]] == row["text"], "Source sentence span mismatch")
                        checked_sentences += 1
                    else:
                        payload = json.loads(db.execute("SELECT raw_json FROM conversations WHERE conversation_id=?", (cid,)).fetchone()[0])
                        _require(CLASS_MAP.get(payload["class"]) == row["labels"][0], "Source class target mismatch")
                        _require(set(row["source_ids"]) == source_ids[cid], "Conversation source IDs mismatch")
                        full = "\n".join(f"[{p.get('paragraph_speaker') or '화자 미상'}] {p['paragraph_text']}" for p in payload["paragraph"])
                        _require(hashlib.sha256(full.encode()).hexdigest() == row["source_full_text_sha256"], "Original dialogue hash mismatch")
                        lines, cuts = full.splitlines(), removals.get(cid, {})
                        _require(all(i < len(lines) and lines[i] == text for i, text in cuts.items()), "Filter source turn mismatch")
                        expected = "\n".join(text for i, text in enumerate(lines) if i not in cuts)
                        _require(expected == row["text"] and hashlib.sha256(expected.encode()).hexdigest() == row["text_sha256"], "Filtered dialogue mismatch")
                        _require(row["input_turn_count"] == len(lines) - len(cuts)
                                 and row["collection_disclosure_turns_removed"] == len(cuts), "Filtered dialogue count mismatch")
                        exported.add(cid); removed += len(cuts); checked_conversations += 1
        _require(set(removals) <= exported, "Filter audit references unexported conversation")
        _require(removed == len(audit) == manifest["collection_disclosure_filter"]["removed_turns"], "Filter audit total mismatch")
        _require(all(len(splits) == 1 for splits in groups.values()), "Cross-unit provisional group split conflict")
        _require(all(len(splits) == 1 for splits in subjects.values()), "Cross-unit observed subject split conflict")
        return {"passed": True, "read_only": True, "source_sha256_verified": True,
                "conversations_checked": checked_conversations, "sentences_checked": checked_sentences,
                "removed_source_turns_checked": removed,
                "cross_unit_provisional_group_conflicts": 0,
                "cross_unit_observed_subject_conflicts": 0}, source_splits
    finally:
        db.close()


def audit_release(root, database=None, lineage=None, require_joint_lineage=True):
    """Return evidence; no writes occur here. CLI writes only the requested report."""
    root = Path(root)
    report = {"version": 1, "created_at": datetime.now(timezone.utc).isoformat(),
              "release": str(root.resolve()), "checks": {}, "failures": [], "limitations": [],
              "requested_gate": "full_R7" if require_joint_lineage else "independent_classifier_integrity",
              "runtime": {"python": sys.version.split()[0], "numpy": np.__version__,
                          "executable": sys.executable, "auditor_sha256": fingerprint(__file__)}}
    rows = {}
    try:
        report["checks"]["hashes"] = verify_hashes(root)
        for unit in UNITS:
            loaded = {split: load_checked_unit(root, unit, split) for split in SPLITS}
            rows[unit] = {split: loaded[split][3] for split in SPLITS}
            report["checks"][unit] = audit_features(root, unit, loaded)
            group = "leakage_group" if unit == "word" else "group_id"
            train, validation = rows[unit]["train"], rows[unit]["validation"]
            _require(not ({r[group] for r in train} & {r[group] for r in validation}), "Within-unit group split conflict")
            if unit != "word":
                subjects = [{json.dumps(r["subject_id"], sort_keys=True) for r in rs
                             if r["subject_id"] is not None} for rs in (train, validation)]
                _require(not subjects[0] & subjects[1], "Observed subject ID split conflict")
            normalized = lambda text: "".join(unicodedata.normalize("NFKC", text).split())
            _require(not ({normalized(r["text"]) for r in train} & {normalized(r["text"]) for r in validation}), "Within-unit normalized text overlap")
            report["checks"][unit]["counts"] = {split: len(rows[unit][split]) for split in SPLITS}
        report["checks"]["declared_counts"] = audit_declared_counts(root, rows)
        source_splits = {}
        if database is not None:
            report["checks"]["source"] , source_splits = audit_sources(root, database, rows)
            exposure_units = defaultdict(set)
            for unit in ("conversation", "sentence"):
                for split in SPLITS:
                    for row in rows[unit][split]:
                        exposure_units[(row["conversation_id"], split)].add(unit)
            report["verified_source_exposures"] = [
                {"source_root_ids": [cid], "split": split, "units": sorted(units)}
                for (cid, split), units in sorted(exposure_units.items())]
            report["source_exposure_summary"] = {
                "root_namespace": "original corpus conversation_id",
                "records": len(exposure_units), "units": ["conversation", "sentence"],
                "word_included": False, "source_database": str(Path(database).resolve()),
                "source_database_sha256": _json(root / "conversation/manifest.json")["source_database_sha256"],
                "records_json_pointer": "/verified_source_exposures"}
        else:
            report["limitations"].append("Original corpus not supplied; source identities and text spans unverified.")
        supplements = {(r["unit"], r["row_id"]): r for r in (lineage or [])}
        _require(len(supplements) == len(lineage or []), "Duplicate supplemental lineage row")
        records = []
        for unit in UNITS:
            for split in SPLITS:
                for row in rows[unit][split]:
                    key = (unit, _identity(row))
                    item = supplements.pop(key, {})
                    _require(not item or item["split"] == split, "Supplemental lineage split mismatch")
                    origins = [row["conversation_id"]] if unit != "word" else item.get("source_conversation_ids", [])
                    if unit != "word" and item:
                        _require(item.get("source_conversation_ids") == origins, "Supplement replaces known origin")
                    records.append({"unit": unit, "row_id": key[1], "split": split, "source_conversation_ids": origins})
        records.extend(supplements.values())  # Optional generation/evaluation rows, including multiple origins.
        report["checks"]["cross_path_lineage"] = check_source_links(records, source_splits)
        report["classification_integrity_passed"] = True
    except (ValueError, KeyError, OSError, sqlite3.Error, TypeError, IndexError) as error:
        report["failures"].append(str(error))
        report["classification_integrity_passed"] = False
    joint = report["checks"].get("cross_path_lineage", {})
    report["joint_training_evaluation_gate"] = {
        "passed": False,
        "declared_source_links_passed": bool(joint.get("passed")),
        "supplemental_lineage_provided": lineage is not None,
        "all_paths_declared": False,
        "future_turn_generation_input_verified": False,
        "near_duplicate_review_verified": False,
        "scope": "Declared source-linked paths only; not base-model pretraining or verified person identity."}
    # This checker cannot certify generation cutoffs or a near-duplicate review;
    # those must be evidenced by the generation-specific admission boundary.
    report["limitations"] += ["Word lexical groups are not source-conversation lineage.",
        "Generation/adaptation path completeness, causal input cutoffs and near-duplicate review are not evidenced by this classifier package.",
        "Source IDs are provisional; independent people and clinical validity are not established.",
        "Hashes establish consistency with the supplied index, not an authenticated publisher signature."]
    report["passed"] = report["classification_integrity_passed"] and (not require_joint_lineage or report["joint_training_evaluation_gate"]["passed"])
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release", type=Path)
    parser.add_argument("--database", type=Path)
    parser.add_argument("--lineage", type=Path, help="JSON list: unit, row_id, split, source_conversation_ids")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--independent-only", action="store_true", help="Gate classifier integrity only; never claim full R7")
    args = parser.parse_args()
    _require(not args.output.resolve().is_relative_to(args.release.resolve()), "Report must be outside frozen release")
    report = audit_release(args.release, args.database, _json(args.lineage) if args.lineage else None,
                           require_joint_lineage=not args.independent_only)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    dump(args.output, report)
    print(json.dumps({"passed": report["passed"], "classification_integrity_passed": report["classification_integrity_passed"],
                      "failure_count": len(report["failures"]), "report": str(args.output)}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

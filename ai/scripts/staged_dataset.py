#!/usr/bin/env python3
"""Verify and lazily load the offline full-data, then service-correction course.

Only the JSONL index is retained in memory. Token IDs are read on demand from
little-endian uint32 files; this module never loads a model or contacts a server.
"""
import argparse
from array import array
from fractions import Fraction
import gzip
import hashlib
from itertools import zip_longest
import json
import math
from pathlib import Path, PurePosixPath
import re
import sys


SCHEMA = "malssi-two-stage-training-v1"
PRIMARY_CHAIN = ("01_original", "02a_supporter", "02b_service_wire")
SPLITS = ("train", "validation")
MAX_PREFIX = 61440
MAX_TARGET = 8192
MAX_SEQUENCE = 69632
VOCAB_SIZE = 262144
SHA256 = re.compile(r"[0-9a-f]{64}\Z")
PROVENANCE_LEDGER = "provenance/full_pool_ledger.jsonl.gz"
PROVENANCE_ADMISSIONS = "provenance/admission_rows.jsonl.gz"


def digest(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def messages_digest(messages):
    return hashlib.sha256(json.dumps(messages, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def _integer(value, name, minimum=0):
    if type(value) is not int or value < minimum:
        raise ValueError("Invalid integer: " + name)
    return value


def _sha(value, name):
    if not isinstance(value, str) or not SHA256.fullmatch(value):
        raise ValueError("Invalid SHA-256: " + name)
    return value


def _text(value, name):
    if not isinstance(value, str) or not value:
        raise ValueError("Invalid identifier: " + name)
    return value


def _weight(value):
    if not isinstance(value, dict) or set(value) != {"numerator", "denominator"}:
        raise ValueError("Invalid weight fraction")
    numerator = _integer(value["numerator"], "weight numerator", 1)
    denominator = _integer(value["denominator"], "weight denominator", 1)
    if math.gcd(numerator, denominator) != 1:
        raise ValueError("Weight must be a reduced positive fraction")
    return Fraction(numerator, denominator)


def _source_ids(value, name):
    if (not isinstance(value, list) or not value
            or any(not isinstance(item, str) or not item for item in value)
            or len(set(value)) != len(value)):
        raise ValueError("Invalid source lineage: " + name)
    return set(value)


def _safe_path(root, name):
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError("Unsafe bundle path")
    relative = PurePosixPath(name)
    if relative.is_absolute() or any(part in (".", "..") for part in name.split("/")):
        raise ValueError("Unsafe bundle path")
    if str(relative) != name:
        raise ValueError("Non-canonical bundle path")
    current = root
    for part in relative.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError("Symlink in bundle path")
    if not current.resolve().is_relative_to(root) or not current.is_file():
        raise ValueError("Missing or unsafe bundle file: " + name)
    return current


def _json_lines(path, compressed=False):
    opener = gzip.open if compressed else Path.open
    with opener(path, "rt", encoding="utf-8") as handle:
        for number, line in enumerate(handle, 1):
            if not line.strip():
                raise ValueError(f"Blank JSONL row: {path.name}:{number}")
            value = json.loads(line)
            if not isinstance(value, dict):
                raise ValueError(f"Non-object JSONL row: {path.name}:{number}")
            yield value


def _index_lengths(row, expected_offset):
    offset = _integer(row.get("offset_tokens"), "offset_tokens")
    if offset != expected_offset:
        raise ValueError("Non-contiguous token offset")
    prefix = _integer(row.get("prefix_length"), "prefix_length", 1)
    target = _integer(row.get("target_length"), "target_length", 1)
    sequence = _integer(row.get("sequence_length"), "sequence_length", 1)
    if (prefix > MAX_PREFIX or target > MAX_TARGET or sequence > MAX_SEQUENCE
            or sequence != prefix + target):
        raise ValueError("Invalid token lengths or token budget exceeded")
    return prefix, target, sequence


def _read_tokens(handle, sequence):
    blob = handle.read(sequence * 4)
    if len(blob) != sequence * 4:
        raise ValueError("Truncated token binary")
    tokens = array("I")
    if tokens.itemsize != 4:
        raise RuntimeError("This platform does not support 32-bit unsigned int arrays")
    tokens.frombytes(blob)
    if sys.byteorder != "little":
        tokens.byteswap()
    if max(tokens, default=0) >= VOCAB_SIZE:
        raise ValueError("Token ID outside the tokenizer vocabulary")
    return tokens


class IndexedDataset:
    """A map-style dataset with no torch dependency and no resident token corpus.

    Call ``verify(root)`` before training. The constructor also checks the local
    index, byte inventory and partition, but does not replace bundle provenance
    and message checks. Opening the token file per item makes workers/forks safe.
    """

    def __init__(self, index, tokens):
        self.index_path = Path(index)
        self.tokens_path = Path(tokens)
        self._entries = list(_json_lines(self.index_path))
        offset, seen, partitions = 0, set(), set()
        for row in self._entries:
            identity = _text(row.get("row_id"), "row_id")
            if identity in seen:
                raise ValueError("Duplicate row ID in index")
            seen.add(identity)
            task = _text(row.get("task"), "task")
            if row.get("split") not in SPLITS:
                raise ValueError("Only train and validation partitions are supported")
            partitions.add((task, row["split"]))
            _, _, sequence = _index_lengths(row, offset)
            _weight(row.get("weight"))
            offset += sequence
        if not self._entries or len(partitions) != 1:
            raise ValueError("An index must contain one nonempty task/split partition")
        if self.tokens_path.stat().st_size != offset * 4:
            raise ValueError("Token binary byte count differs from index")

    def __len__(self):
        return len(self._entries)

    def __getitem__(self, index):
        if isinstance(index, slice):
            return [self[position] for position in range(*index.indices(len(self)))]
        row = self._entries[index]
        with self.tokens_path.open("rb") as handle:
            handle.seek(row["offset_tokens"] * 4)
            ids = _read_tokens(handle, row["sequence_length"]).tolist()
        prefix = row["prefix_length"]
        result = {"row_id": row["row_id"], "stream": row["task"], "split": row["split"],
                  "weight": dict(row["weight"]),
                  "encoded": {"input_ids": ids, "labels": [-100] * prefix + ids[prefix:],
                              "attention_mask": [1] * len(ids), "prefix_length": prefix,
                              "target_length": row["target_length"],
                              "sequence_length": row["sequence_length"]}}
        for name in ("source_group_ids", "source_root_ids", "source_row_sha256",
                     "target_sha256", "messages_sha256"):
            if name in row:
                result[name] = list(row[name]) if isinstance(row[name], list) else row[name]
        return result


def _course_phases(course):
    if course.get("schema") != SCHEMA:
        raise ValueError("Unsupported course schema")
    primary = course.get("phases")
    if (not isinstance(primary, list)
            or [phase.get("id") for phase in primary if isinstance(phase, dict)] != list(PRIMARY_CHAIN)
            or len(primary) != len(PRIMARY_CHAIN)):
        raise ValueError("Primary course must follow the exact three-phase chain")
    for position, phase in enumerate(primary):
        predecessor = None if position == 0 else PRIMARY_CHAIN[position - 1]
        if "initial_adapter_from" not in phase or phase["initial_adapter_from"] != predecessor:
            raise ValueError("Phase checkpoint predecessor skips or changes the course")
        if "new_lora" in phase and phase["new_lora"] is not (position == 0):
            raise ValueError("New LoRA initialization is allowed only for the first primary phase")
    auxiliary = course.get("optional_auxiliary", [])
    if not isinstance(auxiliary, list) or any(not isinstance(phase, dict) for phase in auxiliary):
        raise ValueError("Invalid auxiliary phase inventory")
    phases = primary + auxiliary
    identities = [_text(phase.get("id"), "phase ID") for phase in phases]
    if len(set(identities)) != len(identities):
        raise ValueError("Duplicate or overlapping primary/auxiliary phase ID")
    for phase in phases:
        _text(phase.get("task"), "phase task")
        if "weighting" not in phase:
            raise ValueError("Phase weighting policy is missing")
        if not isinstance(phase.get("data"), dict) or set(phase["data"]) != set(SPLITS):
            raise ValueError("Each phase requires exactly train and validation data")
        for split in SPLITS:
            partition = phase["data"][split]
            if not isinstance(partition, dict):
                raise ValueError("Invalid partition configuration")
            _integer(partition.get("rows"), "partition row count", 1)
    return phases


def _check_messages(row, index):
    messages = row.get("messages")
    if not isinstance(messages, list) or len(messages) < 2:
        raise ValueError("Messages require a user prompt and assistant target")
    if any(not isinstance(message, dict) or not isinstance(message.get("content"), str)
           for message in messages):
        raise ValueError("Invalid message structure")
    roles = [message.get("role") for message in messages]
    dialogue_roles = roles[1:] if roles[0] == "system" else roles
    # Some source windows begin with an earlier assistant turn. Preserve that
    # context without inventing a user turn, while still requiring alternation
    # and a final user prompt followed by the supervised assistant answer.
    if (dialogue_roles[-2:] != ["user", "assistant"]
            or any(role not in ("user", "assistant") for role in dialogue_roles)
            or any(left == right for left, right in zip(dialogue_roles, dialogue_roles[1:]))):
        raise ValueError("Invalid user/assistant message roles")
    if not messages[-1]["content"]:
        raise ValueError("Empty assistant target")
    mask = row.get("loss_message_mask")
    if (not isinstance(mask, list) or any(type(item) is not int for item in mask)
            or mask != [0] * (len(messages) - 1) + [1]):
        raise ValueError("Loss message mask must select only the final assistant answer")
    if _sha(index.get("messages_sha256"), "messages_sha256") != messages_digest(messages):
        raise ValueError("Messages hash differs from token index")
    target_hash = hashlib.sha256(messages[-1]["content"].encode("utf-8")).hexdigest()
    if _sha(row.get("target_sha256"), "target_sha256") != target_hash:
        raise ValueError("Assistant target hash mismatch")


def _reasons(value, name):
    if not isinstance(value, list) or any(not isinstance(reason, str) or not reason for reason in value):
        raise ValueError("Invalid provenance reasons: " + name)
    return value


def _load_original_provenance(root, files):
    """Retain eligible row metadata, never source conversation text.

    Older synthetic contract fixtures may omit both provenance ledgers. A real
    bundle that includes either must include both, and they must agree for every
    admitted and held source row. Historical sampling flags are not consulted.
    """
    present = {name for name in (PROVENANCE_LEDGER, PROVENANCE_ADMISSIONS) if name in files}
    if not present:
        return None
    if len(present) != 2:
        raise ValueError("Both original provenance ledgers must be manifest-bound")
    admissions = {}
    identity_fields = ("id", "split", "source_group_id", "source_conversation_id")
    for row in _json_lines(_safe_path(root, PROVENANCE_ADMISSIONS), compressed=True):
        identity = _text(row.get("id"), "admission row ID")
        if identity in admissions:
            raise ValueError("Duplicate admission provenance row ID")
        if row.get("split") not in SPLITS:
            raise ValueError("Invalid admission provenance split")
        for name in ("source_group_id", "source_conversation_id"):
            _text(row.get(name), "admission " + name)
        if type(row.get("admitted")) is not bool:
            raise ValueError("Admission provenance decision must be boolean")
        reasons = _reasons(row.get("reasons"), "admission")
        admissions[identity] = {name: row[name] for name in identity_fields}
        admissions[identity].update(admitted=row["admitted"], reasons=reasons)
    if not admissions:
        raise ValueError("Empty admission provenance ledger")
    eligible, expected, seen = {}, {split: set() for split in SPLITS}, set()
    for row in _json_lines(_safe_path(root, PROVENANCE_LEDGER), compressed=True):
        identity = _text(row.get("id"), "full-pool row ID")
        if identity in seen:
            raise ValueError("Duplicate full-pool provenance row ID")
        seen.add(identity)
        admission = admissions.pop(identity, None)
        if admission is None or any(row.get(name) != admission[name] for name in identity_fields):
            raise ValueError("Full-pool/admission provenance identity mismatch")
        if type(row.get("eligible")) is not bool or type(row.get("source_admitted")) is not bool:
            raise ValueError("Full-pool provenance decisions must be boolean")
        source_reasons = _reasons(row.get("source_reasons"), "full-pool source")
        holds = _reasons(row.get("hold_reasons"), "full-pool hold")
        if (row["source_admitted"] != admission["admitted"]
                or source_reasons != admission["reasons"]):
            raise ValueError("Full-pool/admission provenance decision mismatch")
        _sha(row.get("source_row_sha256"), "provenance source_row_sha256")
        _sha(row.get("target_sha256"), "provenance target_sha256")
        _index_lengths({**row, "offset_tokens": 0}, 0)
        if row["eligible"]:
            if row["source_admitted"] is not True or holds or source_reasons:
                raise ValueError("Eligible provenance row is not admitted or has hold reasons")
            eligible[identity] = {
                "row_id": identity, "split": row["split"],
                "source_group_ids": [row["source_group_id"]],
                "source_root_ids": [row["source_conversation_id"]],
                **{name: row[name] for name in ("source_row_sha256", "target_sha256",
                                               "prefix_length", "target_length", "sequence_length")}}
            expected[row["split"]].add(identity)
    if admissions:
        raise ValueError("Full-pool/admission provenance row inventory mismatch")
    return {"eligible": eligible, "expected": expected, "source_rows": len(seen)}


def _bind_original_provenance(row, index, provenance):
    expected = provenance["eligible"].get(row["row_id"])
    if expected is None:
        raise ValueError("Original row is absent or ineligible in pinned provenance")
    for name in ("row_id", "split", "source_group_ids", "source_root_ids",
                 "source_row_sha256", "target_sha256"):
        if row[name] != expected[name]:
            raise ValueError("Original row differs from pinned provenance: " + name)
    for name in ("prefix_length", "target_length", "sequence_length"):
        if index.get(name) != expected[name]:
            raise ValueError("Original token lengths differ from pinned provenance: " + name)


def verify(root):
    """Stream all file hashes, paired messages/indexes, token IDs and split lineage."""
    root = Path(root).resolve(strict=True)
    manifest_path = _safe_path(root, "DATASET_MANIFEST.json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    files = manifest.get("files")
    if not isinstance(files, dict) or "COURSE.json" not in files:
        raise ValueError("Manifest must bind COURSE.json and every data file")
    for name, info in files.items():
        path = _safe_path(root, name)
        if not isinstance(info, dict):
            raise ValueError("Invalid file manifest entry")
        size = _integer(info.get("bytes"), "manifest file size")
        expected_hash = _sha(info.get("sha256"), "manifest file hash")
        if path.stat().st_size != size or digest(path) != expected_hash:
            raise ValueError("File checksum mismatch: " + name)
    course = json.loads(_safe_path(root, "COURSE.json").read_text(encoding="utf-8"))
    phases = _course_phases(course)
    provenance = _load_original_provenance(root, files)
    counts = manifest.get("phase_counts")
    if not isinstance(counts, dict) or set(counts) != {phase["id"] for phase in phases}:
        raise ValueError("Manifest phase inventory differs from course")
    lineage = {split: set() for split in SPLITS}
    reports = {}
    used_files = set()
    for phase in phases:
        phase_id, task = phase["id"], phase["task"]
        if not isinstance(counts[phase_id], dict) or set(counts[phase_id]) != set(SPLITS):
            raise ValueError("Manifest split inventory differs from course")
        seen = set()
        report = {"task": task, "counts": {}, "splits": {}}
        for split in SPLITS:
            config = phase["data"][split]
            paths = {}
            for kind in ("messages", "index", "tokens"):
                name = config.get(kind)
                if not isinstance(name, str) or name not in files:
                    raise ValueError("Data path is not bound by the manifest")
                if name in used_files:
                    raise ValueError("Data file reused across course partitions")
                used_files.add(name)
                paths[kind] = _safe_path(root, name)
            expected_count = _integer(counts[phase_id][split], "manifest row count", 1)
            if expected_count != config["rows"]:
                raise ValueError("Course/manifest row count mismatch")
            offset, count, raw_mass, weighted_mass = 0, 0, 0, Fraction(0)
            split_seen = set()
            max_prefix, max_target, max_sequence = 0, 0, 0
            messages = _json_lines(paths["messages"], compressed=True)
            indexes = _json_lines(paths["index"])
            with paths["tokens"].open("rb") as tokens:
                for row, index in zip_longest(messages, indexes):
                    if row is None or index is None:
                        raise ValueError("Messages/index row count mismatch")
                    identity = _text(row.get("row_id"), "row_id")
                    if identity in seen:
                        raise ValueError("Duplicate row ID within phase")
                    seen.add(identity)
                    split_seen.add(identity)
                    if row.get("task") != task or row.get("split") != split:
                        raise ValueError("Message row task/split differs from course")
                    for name in ("row_id", "task", "split", "weight", "source_group_ids",
                                 "source_root_ids", "source_row_sha256", "target_sha256"):
                        if name not in row or index.get(name) != row[name]:
                            raise ValueError("Messages/index metadata mismatch: " + name)
                    _sha(row["source_row_sha256"], "source_row_sha256")
                    _check_messages(row, index)
                    if phase_id == "01_original" and provenance is not None:
                        _bind_original_provenance(row, index, provenance)
                    groups = _source_ids(row["source_group_ids"], "source_group_ids")
                    roots = _source_ids(row["source_root_ids"], "source_root_ids")
                    lineage[split].update(groups | roots)
                    prefix, target, sequence = _index_lengths(index, offset)
                    _read_tokens(tokens, sequence)
                    weight = _weight(row["weight"])
                    offset += sequence
                    count += 1
                    raw_mass += target
                    weighted_mass += weight * target
                    max_prefix = max(max_prefix, prefix)
                    max_target = max(max_target, target)
                    max_sequence = max(max_sequence, sequence)
                if tokens.read(1):
                    raise ValueError("Trailing bytes in token binary")
            if paths["tokens"].stat().st_size != offset * 4:
                raise ValueError("Token binary byte count differs from index")
            if count != expected_count:
                raise ValueError("Actual row count differs from course/manifest")
            if (phase_id == "01_original" and provenance is not None
                    and split_seen != provenance["expected"][split]):
                raise ValueError("Original output inventory differs from all eligible provenance rows")
            if weighted_mass != raw_mass:
                raise ValueError("Weighted target-token mass differs from raw target-token mass")
            report["counts"][split] = count
            report["splits"][split] = {
                "rows": count, "sequence_tokens": offset, "target_tokens": raw_mass,
                "weighted_target_tokens": {"numerator": weighted_mass.numerator,
                                           "denominator": weighted_mass.denominator},
                "max_prefix_length": max_prefix, "max_target_length": max_target,
                "max_sequence_length": max_sequence}
        reports[phase_id] = report
    if lineage["train"] & lineage["validation"]:
        raise ValueError("Source group/root overlaps train and validation across the course")
    return {"status": "passed", "checked_files": len(files), "phases": reports,
            "primary_chain": list(PRIMARY_CHAIN), "global_split_lineage_disjoint": True,
            "original_provenance_bound": provenance is not None,
            "original_provenance_source_rows": provenance["source_rows"] if provenance else None,
            "gpu_used": False, "model_loaded": False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("verify", "inspect"))
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--phase")
    parser.add_argument("--split", choices=SPLITS)
    args = parser.parse_args(argv)
    if args.command == "inspect" and (args.phase is None or args.split is None):
        parser.error("inspect requires --phase and --split")
    report = verify(args.root)
    if args.command == "inspect":
        if args.phase not in report["phases"]:
            parser.error("Unknown course phase")
        phase = report["phases"][args.phase]
        report = {"status": "passed", "phase": args.phase, "task": phase["task"],
                  "split": args.split, **phase["splits"][args.split],
                  "gpu_used": False, "model_loaded": False}
    print(json.dumps(report, ensure_ascii=False))
    return report


if __name__ == "__main__":
    main()

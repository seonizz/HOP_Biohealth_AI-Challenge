"""Audit index blobs without printing counseling text; never modifies the index.

Exact JSON values >=80 characters match the v7 audit. Plain text and embedded
document text receive the same exact-source-unit check. This does not prove the
absence of short/modified excerpts, image text, or content in historical commits.
"""
from __future__ import annotations

import argparse
from collections import Counter
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import zipfile
from xml.etree import ElementTree

MIN_CHARACTERS = 80
MAX_BYTES = 10 * 1024 * 1024
SOURCE_DEFAULT = "data/데이터셋/말씨_원본상담_SFT_v1_20261009"


class UnsupportedArchiveError(ValueError):
    pass


class DuplicateJSONKeyError(ValueError):
    pass


def unique_json_object(pairs):
    """Reject duplicate decoded keys before an earlier value can be discarded."""
    result = {}
    for key, value in pairs:
        if key in result:
            # Keys and values can contain private text; keep this error generic.
            raise DuplicateJSONKeyError("Duplicate JSON object key")
        result[key] = value
    return result


def git(root, *args, data=None):
    return subprocess.check_output(["git", "-C", str(root), *args], input=data)


def source_hashes(source):
    hashes, units = set(), 0
    for split in ("train", "validation"):
        with gzip.open(source / f"conversation/source_dialogues.{split}.jsonl.gz", "rt", encoding="utf-8") as stream:
            for line in stream:
                record = json.loads(line, object_pairs_hook=unique_json_object)
                groups = []
                for turn in record["utterances"]:
                    text, speaker = turn["text"], turn["speaker"]
                    if len(text) >= MIN_CHARACTERS:
                        hashes.add(hashlib.sha256(text.encode()).digest())
                        units += 1
                    if groups and groups[-1][0] == speaker:
                        groups[-1][1] += "\n" + text
                    else:
                        groups.append([speaker, text])
                for _, text in groups:
                    if len(text) >= MIN_CHARACTERS:
                        hashes.add(hashlib.sha256(text.encode()).digest())
                        units += 1
    if not hashes:
        raise ValueError("No source text units available; content audit cannot pass")
    return hashes, units


def strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from strings(item)


def text_units(path, content):
    """Return parsed units; invalid declared JSON is an audit error, not a skip."""
    suffix = Path(path).suffix.lower()
    office = suffix in {".pptx", ".docx", ".xlsx"}
    archive = (suffix in {".zip", ".tar", ".tgz", ".tbz", ".tbz2", ".txz", ".7z", ".rar", ".bz2", ".xz"}
               or content.startswith((b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08", b"7z\xbc\xaf\x27\x1c", b"Rar!", b"BZh", b"\xfd7zXZ\x00"))
               or content[257:262] == b"ustar")
    if archive and not office:
        raise UnsupportedArchiveError("General archives must remain local")
    if content.startswith(b"\x1f\x8b") and suffix != ".gz":
        raise UnsupportedArchiveError("Renamed gzip cannot be silently skipped")
    if suffix == ".gz":
        return text_units(path[:-3], gzip.decompress(content))
    if office:
        units = []
        with zipfile.ZipFile(io.BytesIO(content)) as archive:
            main = {".pptx": "ppt/presentation.xml", ".docx": "word/document.xml", ".xlsx": "xl/workbook.xml"}[suffix]
            names = archive.namelist()
            if not {"[Content_Types].xml", "_rels/.rels", main} <= set(names) or len(names) != len(set(names)):
                raise UnsupportedArchiveError("Not an unambiguous Office package")
            for entry in archive.infolist():
                if entry.is_dir():
                    continue
                if entry.file_size >= MAX_BYTES or entry.flag_bits & 1:
                    raise UnsupportedArchiveError("Opaque or oversized document attachment")
                name = entry.filename
                data = archive.read(entry)
                if name.endswith((".xml", ".rels")):
                    root = ElementTree.fromstring(data)
                    units.extend(node.text for node in root.iter() if node.text)
                else:
                    nested, kind = text_units(name, data)
                    # Ordinary document images cannot be OCR-audited here; keep
                    # that stated limitation, but never skip opaque attachments.
                    image = (data.startswith((b"\x89PNG\r\n\x1a\n", b"\xff\xd8\xff", b"GIF87a", b"GIF89a"))
                             or data.startswith(b"RIFF") and data[8:12] == b"WEBP")
                    if kind == "binary_not_scanned" and not image:
                        raise UnsupportedArchiveError("Uninspected binary document attachment")
                    units.extend(nested)
        return units, "document_xml"
    # Declared JSON must never fall through to the uninspected binary path.
    # Accept UTF-8 with an optional BOM; all other encodings fail closed.
    if suffix in {".json", ".jsonl", ".ndjson"}:
        text = content.decode("utf-8-sig")
        if suffix == ".json":
            return list(strings(json.loads(text, object_pairs_hook=unique_json_object))), "json"
        return [unit for line in text.splitlines() if line.strip()
                for unit in strings(json.loads(line, object_pairs_hook=unique_json_object))], "jsonl"
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return [], "binary_not_scanned"
    if "\0" in text:
        return [], "binary_not_scanned"
    return [text, *text.splitlines(), *text.split("\n\n")], "text"


def audit(root, source, scope="tracked"):
    hashes, source_units = source_hashes(source)
    entries = {}
    for raw in git(root, "ls-files", "--stage", "-z").split(b"\0"):
        if not raw:
            continue
        meta, path = raw.split(b"\t", 1)
        mode, oid, stage = meta.decode().split()
        if stage != "0":
            raise ValueError("Unmerged index cannot be audited")
        entries[path.decode()] = (mode, oid)
    ignore_entries = {path: value for path, value in entries.items() if Path(path).name == ".gitignore"}
    if scope == "staged":
        changed = set(git(root, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z").decode().split("\0"))
        entries = {path: value for path, value in entries.items() if path in changed}
    ignored_input = b"\0".join(p.encode() for p in entries) + (b"\0" if entries else b"")
    # check-ignore normally reads working files. Reconstruct only the indexed
    # ignore files so unstaged policy edits cannot hide a commit violation.
    with tempfile.TemporaryDirectory(prefix="malssi-git-policy-") as policy_root:
        for path, (mode, oid) in ignore_entries.items():
            if mode not in ("100644", "100755"):
                raise ValueError("Ignore policy must be an ordinary indexed file")
            target = Path(policy_root) / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(git(root, "cat-file", "blob", oid))
        ignored = subprocess.run(["git", "-C", str(root), "--work-tree", policy_root,
                                  "check-ignore", "--no-index", "--stdin", "-z"],
                                 input=ignored_input, capture_output=True)
    if ignored.returncode not in (0, 1):
        raise ValueError("Unable to check ignore policy")
    ignored_paths = set(ignored.stdout.decode().split("\0")) - {""}
    findings, errors, coverage = [], [], Counter()
    # Batch reads inspect the actual commit candidates, even with unstaged edits.
    objects = git(root, "cat-file", "--batch", data="".join(oid + "\n" for _, oid in entries.values()).encode())
    stream = io.BytesIO(objects)
    for path, (mode, _) in entries.items():
        header = stream.readline().decode().strip().split()
        if len(header) != 3 or header[1] != "blob":
            raise ValueError("Expected indexed file blob")
        content = stream.read(int(header[2])); stream.read(1)
        reasons = []
        if path in ignored_paths:
            reasons.append("tracked_but_ignored")
        if len(content) >= MAX_BYTES:
            reasons.append("file_ge_10MiB")
        count = 0
        try:
            units, kind = text_units(path, content)
            coverage[kind] += 1
            count = sum(len(t) >= MIN_CHARACTERS and hashlib.sha256(t.encode()).digest() in hashes for t in units)
            if count:
                reasons.append("exact_source_text")
        except (ValueError, OSError, zipfile.BadZipFile, ElementTree.ParseError, EOFError) as error:
            # Do not include exception messages: parser messages can include data.
            errors.append({"path": path, "error_type": type(error).__name__})
        if reasons:
            findings.append({"path": path, "bytes": len(content), "sha256": hashlib.sha256(content).hexdigest(),
                             "reasons": reasons, "exact_source_text_values": count})
    return {"schema": "malssi-git-privacy-v1", "scope": scope, "content": "git-index-blobs",
            "minimum_characters": MIN_CHARACTERS, "files_examined": len(entries), "coverage": dict(coverage),
            "source_text_units_examined": source_units, "unique_source_text_hashes": len(hashes),
            "exact_source_text_files": sum(bool(f["exact_source_text_values"]) for f in findings),
            "findings": findings, "errors": errors, "passed": not findings and not errors,
            "source_text_exported": False,
            "limitations": ["Exact whole JSON strings / text lines / paragraphs / XML text nodes >=80 characters only.",
                            "Short, modified and partial excerpts, image text and historical commits are not ruled out."]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--source-dir", type=Path)
    parser.add_argument("--scope", choices=("tracked", "staged"), default="tracked")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        report = audit(args.root, args.source_dir or args.root / SOURCE_DEFAULT, args.scope)
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        print(json.dumps({"passed": False, "audit_incomplete": True, "error_type": type(error).__name__}))
        return 2
    encoded = json.dumps(report, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(encoded)
    print(json.dumps({k: v for k, v in report.items() if k not in ("findings", "errors")} | {
        "finding_files": len(report["findings"]), "parse_errors": len(report["errors"])}, ensure_ascii=False))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())

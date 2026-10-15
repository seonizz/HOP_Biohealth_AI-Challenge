"""Read-only source inventory and lossless, reproducible SQLite ingestion."""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import sqlite3
import unicodedata
import zipfile

from .text import (
    NORMALIZATION_METHOD, SENTENCE_METHOD, WORD_METHOD, iter_sentences, iter_words,
)

INGEST_VERSION = "1"
PARAGRAPH_METADATA = {
    "start_point", "end_point", "character_count", "cps", "paragraph_speaker",
    "paragraph_text", "index",
}
TOP_METADATA = {"filename", "id", "age", "gender", "summary", "silence", "total_time", "paragraph"}

SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE sources (
 source_id TEXT PRIMARY KEY, path TEXT NOT NULL, member TEXT, sha256 TEXT,
 kind TEXT NOT NULL, split TEXT NOT NULL, status TEXT NOT NULL,
 conversation_id TEXT, error TEXT
);
CREATE TABLE source_payloads(source_id TEXT PRIMARY KEY REFERENCES sources, raw_json TEXT NOT NULL);
CREATE TABLE source_texts(source_id TEXT PRIMARY KEY REFERENCES sources, text TEXT NOT NULL);
CREATE TABLE source_error_bytes(source_id TEXT PRIMARY KEY REFERENCES sources, data BLOB NOT NULL);
CREATE TABLE conversations (
 conversation_id TEXT PRIMARY KEY, raw_json TEXT NOT NULL, text TEXT NOT NULL,
 source_id TEXT NOT NULL REFERENCES sources, original_split TEXT NOT NULL,
 split TEXT NOT NULL, group_id TEXT NOT NULL, subject_id TEXT
);
CREATE TABLE utterances (
 utterance_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations,
 ordinal INTEGER NOT NULL, speaker TEXT, text TEXT NOT NULL, raw_json TEXT NOT NULL,
 start_char INTEGER NOT NULL, end_char INTEGER NOT NULL
);
CREATE TABLE sentences (
 sentence_id TEXT PRIMARY KEY, utterance_id TEXT NOT NULL REFERENCES utterances,
 conversation_id TEXT NOT NULL REFERENCES conversations, ordinal INTEGER NOT NULL,
 speaker TEXT, text TEXT NOT NULL, start_char INTEGER NOT NULL,
 end_char INTEGER NOT NULL, split TEXT NOT NULL
);
CREATE TABLE words (
 word_occurrence_id TEXT PRIMARY KEY, sentence_id TEXT NOT NULL REFERENCES sentences,
 conversation_id TEXT NOT NULL REFERENCES conversations, ordinal INTEGER NOT NULL,
 surface TEXT NOT NULL, normalized TEXT NOT NULL, start_char INTEGER NOT NULL,
 end_char INTEGER NOT NULL, split TEXT NOT NULL
);
CREATE TABLE original_labels (
 entity_id TEXT NOT NULL, scope TEXT NOT NULL, label_key TEXT NOT NULL,
 value_json TEXT NOT NULL, value_type TEXT NOT NULL,
 PRIMARY KEY(entity_id, scope, label_key)
);
CREATE TABLE source_pairs (
 json_source_id TEXT NOT NULL REFERENCES sources,
 txt_source_id TEXT NOT NULL REFERENCES sources, comparison TEXT NOT NULL,
 PRIMARY KEY(json_source_id, txt_source_id)
);
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX source_conversation ON sources(conversation_id);
CREATE INDEX utterance_conversation ON utterances(conversation_id,ordinal);
CREATE INDEX sentence_conversation ON sentences(conversation_id,ordinal);
CREATE INDEX sentence_utterance ON sentences(utterance_id);
CREATE INDEX word_sentence ON words(sentence_id,ordinal);
CREATE INDEX word_conversation ON words(conversation_id);
CREATE INDEX conversation_split ON conversations(split);
"""


def canonical_json(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(data: bytes | str) -> str:
    return hashlib.sha256(data.encode("utf-8") if isinstance(data, str) else data).hexdigest()


def stable_id(prefix: str, *parts) -> str:
    return prefix + "_" + digest(canonical_json(parts))


def _type(value) -> str:
    return "null" if value is None else {bool: "boolean", int: "integer", float: "number", str: "string", list: "array", dict: "object"}[type(value)]


def _split(path: str) -> str:
    parts = {part.casefold() for part in path.replace("\\", "/").split("/")}
    if "training" in parts or "train" in parts:
        return "train"
    if "validation" in parts or "valid" in parts:
        return "validation"
    return "unknown"


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def inventory(source: Path) -> list[dict]:
    """Inventory all files and every ZIP entry without extracting any member."""
    result = []
    for path in sorted(source.rglob("*"), key=lambda p: p.as_posix()):
        if not path.is_file():
            continue
        relative = path.relative_to(source).as_posix()
        entry = {"source_id": stable_id("src", relative, None), "path": relative,
                 "member": None, "kind": path.suffix.casefold().lstrip(".") or "other",
                 "split": _split(relative), "size": path.stat().st_size}
        try:
            entry["sha256"] = _hash_file(path)
        except OSError as exc:
            entry.update(sha256=None, error=f"{type(exc).__name__}: {exc}")
        result.append(entry)
        if entry["kind"] != "zip" or "error" in entry:
            continue
        try:
            with zipfile.ZipFile(path) as archive:
                occurrences = Counter()
                for info in archive.infolist():
                    occurrence = occurrences[info.filename]
                    occurrences[info.filename] += 1
                    member = {"source_id": stable_id("src", relative, info.filename, occurrence),
                              "path": relative, "member": info.filename,
                              "member_occurrence": occurrence,
                              "kind": "directory" if info.is_dir() else PurePosixPath(info.filename).suffix.casefold().lstrip(".") or "other",
                              "split": _split(relative), "size": info.file_size,
                              "unsafe_extract_path": PurePosixPath(info.filename).is_absolute() or ".." in PurePosixPath(info.filename).parts}
                    try:
                        with archive.open(info) as handle:
                            h = hashlib.sha256()
                            for block in iter(lambda: handle.read(1024 * 1024), b""):
                                h.update(block)
                        member["sha256"] = h.hexdigest()
                    except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
                        member.update(sha256=None, error=f"{type(exc).__name__}: {exc}")
                    result.append(member)
        except (OSError, ValueError, RuntimeError, zipfile.BadZipFile) as exc:
            entry["error"] = f"{type(exc).__name__}: {exc}"
    return sorted(result, key=lambda row: row["source_id"])


def _read(source: Path, entry: dict) -> bytes:
    path = source / entry["path"]
    if entry["member"] is None:
        return path.read_bytes()
    with zipfile.ZipFile(path) as archive:
        infos = [i for i in archive.infolist() if i.filename == entry["member"]]
        return archive.read(infos[entry["member_occurrence"]])


def _write_json(path: Path, value) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def _schema_add(schema: dict, value, path: str = "$") -> None:
    record = schema.setdefault(path, {"types": Counter(), "observations": 0})
    record["types"][_type(value)] += 1
    record["observations"] += 1
    if isinstance(value, dict):
        for key, item in value.items():
            _schema_add(schema, item, path + "[" + json.dumps(key, ensure_ascii=False) + "]")
    elif isinstance(value, list):
        for item in value:
            _schema_add(schema, item, path + "[]")


def _labels_add(conn, dictionary: dict, entity_id: str, scope: str, data: dict, excluded: set) -> None:
    for key, value in data.items():
        if key in excluded:
            continue
        encoded = canonical_json(value)
        conn.execute("INSERT INTO original_labels VALUES(?,?,?,?,?)", (entity_id, scope, key, encoded, _type(value)))
        _label_observe(dictionary, scope, key, value)


def _label_observe(dictionary: dict, scope: str, key: str, value) -> None:
    encoded = canonical_json(value)
    entry = dictionary.setdefault((scope, key), {"scope": scope, "original_key": key,
        "types": Counter(), "value_counts": Counter(), "present_count": 0,
        "definition_status": "unresolved", "code_semantics": "unknown; no ordinal or clinical meaning inferred"})
    entry["types"][_type(value)] += 1
    entry["value_counts"][encoded] += 1
    entry["present_count"] += 1


def _pair_key(entry: dict) -> tuple[str, str]:
    filename = PurePosixPath(entry["member"] or entry["path"]).stem
    normalized = unicodedata.normalize("NFC", filename).casefold()
    for prefix in ("resource_", "label_"):
        if normalized.startswith(prefix):
            normalized = normalized[len(prefix):]
            break
    return entry["split"], normalized


def _comparison(json_text: str, txt: str) -> str:
    if json_text == txt:
        return "exact"
    if json_text.strip().replace("\r\n", "\n") == txt.strip().replace("\r\n", "\n"):
        return "line_endings_or_outer_whitespace"
    normalized_json = "".join(unicodedata.normalize("NFC", json_text).split())
    normalized_txt = "".join(unicodedata.normalize("NFC", txt).split())
    return "unicode_or_whitespace" if normalized_json == normalized_txt else "content_difference"


def _group_splits(conn) -> dict:
    rows = conn.execute("SELECT conversation_id,subject_id,text FROM conversations ORDER BY conversation_id").fetchall()
    parents = {row[0]: row[0] for row in rows}

    def root(value):
        while parents[value] != value:
            parents[value] = parents[parents[value]]
            value = parents[value]
        return value

    def union(a, b):
        a, b = root(a), root(b)
        parents[max(a, b)] = min(a, b)

    by_subject, by_text = {}, {}
    for cid, subject, text in rows:
        if subject is not None:
            if subject in by_subject:
                union(cid, by_subject[subject])
            else:
                by_subject[subject] = cid
        if text.strip():
            key = digest(unicodedata.normalize("NFC", text))
            if key in by_text:
                union(cid, by_text[key])
            else:
                by_text[key] = cid
    groups = defaultdict(list)
    for cid in parents:
        groups[root(cid)].append(cid)
    conflicts = []
    conn.execute("DROP TABLE IF EXISTS temp.effective_splits")
    conn.execute("CREATE TEMP TABLE effective_splits(conversation_id TEXT PRIMARY KEY, split TEXT NOT NULL) WITHOUT ROWID")
    original_splits = defaultdict(set)
    for cid, split in conn.execute("SELECT conversation_id,split FROM sources WHERE conversation_id IS NOT NULL"):
        original_splits[cid].add(split)
    for members in groups.values():
        splits = set().union(*(original_splits[cid] for cid in members))
        known = splits - {"unknown"}
        conflict = len(known) > 1
        effective = "quarantine" if conflict else next(iter(known)) if known else "unknown"
        gid = stable_id("grp", sorted(members))
        for cid in members:
            conn.execute("UPDATE conversations SET original_split=?,split=?,group_id=? WHERE conversation_id=?", ("|".join(sorted(original_splits[cid])), effective, gid, cid))
            conn.execute("INSERT INTO effective_splits VALUES(?,?)", (cid, effective))
        if conflict:
            conflicts.append({"group_id": gid, "conversation_ids": sorted(members), "original_splits": sorted(splits), "reason": "identical_payload_or_text_or_same_observed_id_across_splits"})
    for table in ("sentences", "words"):
        lookup = f"(SELECT split FROM effective_splits e WHERE e.conversation_id={table}.conversation_id)"
        conn.execute(f"UPDATE {table} SET split={lookup} WHERE split != {lookup}")
    return {"groups": len(groups), "conflicts": conflicts,
            "subject_identity_status": "unverified; raw id is only a provisional grouping signal, not verified participant identity",
            "identity_limit": "different source ids may still refer to one person; person-level isolation is not established"}


def _stored_grouping(conn) -> dict:
    groups, original_splits = defaultdict(list), defaultdict(set)
    for cid, gid in conn.execute("SELECT conversation_id,group_id FROM conversations"):
        groups[gid].append(cid)
    for cid, split in conn.execute("SELECT conversation_id,split FROM sources WHERE conversation_id IS NOT NULL"):
        original_splits[cid].add(split)
    conflicts = []
    for gid, members in groups.items():
        splits = set().union(*(original_splits[cid] for cid in members))
        if len(splits - {"unknown"}) > 1:
            conflicts.append({"group_id": gid, "conversation_ids": sorted(members),
                "original_splits": sorted(splits), "reason": "identical_payload_or_text_or_same_observed_id_across_splits"})
    return {"groups": len(groups), "conflicts": sorted(conflicts, key=lambda row: row["group_id"]),
            "subject_identity_status": "unverified; raw id is only a provisional grouping signal, not verified participant identity",
            "identity_limit": "different source ids may still refer to one person; person-level isolation is not established"}


def _restore_aggregates(conn, before):
    """Rebuild report-only state; never rewrite original rows or source status."""
    schema, dictionary, issues = {}, {}, []
    by_id = {entry["source_id"]: entry for entry in before}
    json_entries = [by_id[sid] for (sid,) in conn.execute("SELECT source_id FROM sources WHERE kind='json' AND conversation_id IS NOT NULL ORDER BY source_id")]
    txt_entries = [by_id[sid] for (sid,) in conn.execute("SELECT source_id FROM source_texts ORDER BY source_id")]
    for cid, raw, sid in conn.execute("SELECT conversation_id,raw_json,source_id FROM conversations"):
        payload = json.loads(raw)
        _schema_add(schema, payload)
        for key, value in payload.items():
            if key not in TOP_METADATA:
                _label_observe(dictionary, "conversation", key, value)
        for ordinal, paragraph in enumerate(payload["paragraph"]):
            if not isinstance(paragraph, dict) or not isinstance(paragraph.get("paragraph_text"), str):
                issues.append({"source_id": sid, "conversation_id": cid, "paragraph_ordinal": ordinal,
                    "reason": "non_object_paragraph_or_non_string_text_retained_in_raw_json"})
            if isinstance(paragraph, dict):
                for key, value in paragraph.items():
                    if key not in PARAGRAPH_METADATA:
                        _label_observe(dictionary, "utterance", key, value)
    return schema, dictionary, issues, json_entries, txt_entries


def _open_stage(stage: Path, before: list[dict], manifest_hash: str):
    """Resume only a fully committed stage matching the complete fresh inventory.

    SQLite must recover its own hot journal. Never unlink journal/WAL files.
    A valid but incomplete or incompatible database is preserved and rejected.
    """
    if stage.exists():
        with stage.open("rb") as handle:
            header = handle.read(16)
        if header != b"SQLite format 3\x00":
            preserved = stage.with_name(stage.name + ".unusable-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f"))
            for suffix in ("", "-journal", "-wal", "-shm"):
                item = Path(str(stage) + suffix)
                if item.exists():
                    os.replace(item, Path(str(preserved) + suffix))
        else:
            conn = sqlite3.connect(stage)
            try:
                # The first read rolls back a hot journal after a killed writer.
                metadata = dict(conn.execute("SELECT key,value FROM metadata"))
                if metadata.get("ingest_version") != INGEST_VERSION or metadata.get("source_manifest_sha256") != manifest_hash:
                    raise ValueError("Completed stage metadata does not match fresh inventory/version; stage preserved")
                stored = list(conn.execute("SELECT source_id,path,member,sha256,kind,split,status FROM sources ORDER BY source_id"))
                expected = [(e["source_id"], e["path"], e["member"], e["sha256"], e["kind"], e["split"]) for e in before]
                if [row[:6] for row in stored] != expected or any(row[6] not in {"success", "duplicate", "held", "error"} for row in stored):
                    raise ValueError("Completed stage source rows do not match fresh inventory/statuses; stage preserved")
                conn.execute("PRAGMA foreign_keys=ON")
                return conn, True
            except BaseException:
                conn.close()
                raise
    conn = sqlite3.connect(stage)
    conn.executescript(SCHEMA)
    return conn, False


def verify_ingest(database: Path | sqlite3.Connection) -> dict:
    owned = not isinstance(database, sqlite3.Connection)
    conn = sqlite3.connect(database) if owned else database
    errors = Counter()
    try:
        integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
        foreign = list(conn.execute("PRAGMA foreign_key_check"))
        canonical_ids, group_splits = {}, defaultdict(set)
        # Large raw_json/text fields put later conversation columns on overflow
        # pages. Read each conversation once, never through a per-word join.
        for cid, raw, parent, split, group_id in conn.execute("SELECT conversation_id,raw_json,text,split,group_id FROM conversations"):
            payload = json.loads(raw)
            canonical_ids[cid] = stable_id("conv", canonical_json(payload))
            if canonical_ids[cid] != cid:
                errors["lossless_json"] += 1
            paragraphs = payload["paragraph"]
            original_texts = [p["paragraph_text"] if isinstance(p, dict) and isinstance(p.get("paragraph_text"), str) else "" for p in paragraphs]
            if parent != "\n".join(original_texts):
                errors["conversation_text_from_source"] += 1
            offsets, cursor = [], 0
            for text in original_texts:
                offsets.append((cursor, cursor + len(text)))
                cursor += len(text) + 1
            if split in {"train", "validation"}:
                group_splits[group_id].add(split)
            utterances, ordinals = {}, set()
            for uid, text, start, end, ordinal, utterance_raw in conn.execute("SELECT utterance_id,text,start_char,end_char,ordinal,raw_json FROM utterances WHERE conversation_id=?", (cid,)):
                if not (0 <= start <= end <= len(parent)) or parent[start:end] != text:
                    errors["utterance_offset"] += 1
                if not (0 <= ordinal < len(paragraphs)) or ordinal in ordinals:
                    errors["utterance_ordinal"] += 1
                else:
                    if canonical_json(json.loads(utterance_raw)) != canonical_json(paragraphs[ordinal]):
                        errors["lossless_utterance_json"] += 1
                    if text != original_texts[ordinal] or (start, end) != offsets[ordinal]:
                        errors["utterance_text_from_source"] += 1
                ordinals.add(ordinal)
                utterances[uid] = text
            if ordinals != set(range(len(paragraphs))):
                errors["utterance_coverage"] += 1
            sentences = {}
            for sid, uid, text, start, end, derivative_split in conn.execute("SELECT sentence_id,utterance_id,text,start_char,end_char,split FROM sentences WHERE conversation_id=?", (cid,)):
                utterance_text = utterances.get(uid)
                if utterance_text is None:
                    errors["sentence_parent_conversation"] += 1
                elif not (0 <= start < end <= len(utterance_text)) or utterance_text[start:end] != text:
                    errors["sentence_offset"] += 1
                if derivative_split != split:
                    errors["sentences_split"] += 1
                sentences[sid] = (uid, start, end)
            for sid, surface, start, end, derivative_split in conn.execute("SELECT sentence_id,surface,start_char,end_char,split FROM words WHERE conversation_id=?", (cid,)):
                sentence = sentences.get(sid)
                if sentence is None:
                    errors["word_parent_conversation"] += 1
                    continue
                uid, sentence_start, sentence_end = sentence
                utterance_text = utterances.get(uid)
                if utterance_text is None or not (sentence_start <= start < end <= sentence_end) or utterance_text[start:end] != surface:
                    errors["word_offset"] += 1
                if derivative_split != split:
                    errors["words_split"] += 1
        for raw, cid in conn.execute("SELECT p.raw_json,s.conversation_id FROM source_payloads p JOIN sources s USING(source_id) WHERE s.conversation_id IS NOT NULL"):
            if cid not in canonical_ids or stable_id("conv", canonical_json(json.loads(raw))) != canonical_ids[cid]:
                errors["lossless_json"] += 1
        for table, column in (("source_payloads", "raw_json"), ("source_texts", "text")):
            for raw, sha in conn.execute(f"SELECT p.{column},s.sha256 FROM {table} p JOIN sources s USING(source_id)"):
                encoded = raw.encode("utf-8")
                # UTF-8 BOM is a transport marker, not a decoded JSON field.
                if digest(encoded) != sha and digest(b"\xef\xbb\xbf" + encoded) != sha:
                    errors["source_text_hash"] += 1
        group_conflicts = sum(len(splits) > 1 for splits in group_splits.values())
        if group_conflicts:
            errors["group_leakage"] = group_conflicts
        return {"integrity_check": integrity, "foreign_key_errors": len(foreign), "errors": dict(errors), "passed": integrity == "ok" and not foreign and not errors}
    finally:
        if owned:
            conn.close()


def ingest(source: Path, output: Path) -> dict:
    """Build atomically from immutable source, or reuse an identical verified build.

    Fully committed stages can resume finalization after inventory validation.
    Valid but incomplete/incompatible stages are preserved for explicit recovery.
    A prior completed database is not replaced until all checks pass.
    """
    source, output = Path(source).resolve(), Path(output).resolve()
    if not source.is_dir():
        raise ValueError(f"Source is not a directory: {source}")
    if output == source or source in output.parents:
        raise ValueError("Output must be outside the read-only source tree")
    output.mkdir(parents=True, exist_ok=True)
    before = inventory(source)
    manifest_hash = digest(canonical_json(before))
    database = output / "corpus.sqlite"
    report_path = output / "ingestion_report.json"
    supporting = [output / name for name in ("schema_dictionary.json", "label_dictionary.json", "source_manifest_before.json", "source_manifest_after.json")]
    if database.exists() and report_path.exists() and all(path.exists() for path in supporting):
        old_report = json.loads(report_path.read_text(encoding="utf-8"))
        with sqlite3.connect(database) as prior:
            metadata = dict(prior.execute("SELECT key,value FROM metadata"))
        if (old_report.get("source_manifest_sha256") == metadata.get("source_manifest_sha256") == manifest_hash
                and old_report.get("ingest_version") == metadata.get("ingest_version") == INGEST_VERSION):
            validation = verify_ingest(database)
            if validation["passed"]:
                after = inventory(source)
                if before != after:
                    raise RuntimeError("Source manifest changed during reuse verification")
                old_report["resume"] = "reused_identical_verified_build"
                old_report["validation"] = validation
                old_report["source_unchanged"] = True
                _write_json(output / "source_manifest_before.json", before)
                _write_json(output / "source_manifest_after.json", after)
                _write_json(report_path, old_report)
                return old_report
    stage = output / "corpus.sqlite.building"
    conn, resumed_stage = _open_stage(stage, before, manifest_hash)
    if resumed_stage:
        schema, dictionary, issues, json_entries, txt_entries = _restore_aggregates(conn, before)
    else:
        schema, dictionary = {}, {}
        issues, json_entries, txt_entries = [], [], []
    counts = Counter()
    hash_sources = defaultdict(list)
    try:
        for entry in before:
            sid, kind = entry["source_id"], entry["kind"]
            if entry["sha256"]:
                hash_sources[entry["sha256"]].append(sid)
            if resumed_stage:
                continue
            status, error = "pending", entry.get("error")
            if error:
                status = "error"
            elif kind in {"zip", "directory"}:
                status = "success"
            elif kind not in {"json", "txt"}:
                status = "held"
                error = "outside_text_json_scope"
            conn.execute("INSERT INTO sources VALUES(?,?,?,?,?,?,?,?,?)", (sid, entry["path"], entry["member"], entry["sha256"], kind, entry["split"], status, None, error))
            if status != "pending":
                continue
            raw_bytes = None
            try:
                raw_bytes = _read(source, entry)
                if digest(raw_bytes) != entry["sha256"]:
                    raise ValueError("source_changed_during_read")
                raw = raw_bytes.decode("utf-8-sig")
                if kind == "txt":
                    conn.execute("INSERT INTO source_texts VALUES(?,?)", (sid, raw))
                    conn.execute("UPDATE sources SET status='success' WHERE source_id=?", (sid,))
                    txt_entries.append(entry)
                    continue
                # Every JSON source retains its full decoded representation,
                # including unsupported shapes. Never silently discard fields.
                conn.execute("INSERT INTO source_payloads VALUES(?,?)", (sid, raw))
                payload = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(f"non-standard JSON constant {value}")))
                encoded = canonical_json(payload)
                if not isinstance(payload, dict) or not isinstance(payload.get("paragraph"), list):
                    raise ValueError("JSON root must be object with paragraph array; raw payload retained")
                cid = stable_id("conv", encoded)
                prior = conn.execute("SELECT conversation_id FROM conversations WHERE conversation_id=?", (cid,)).fetchone()
                conn.execute("UPDATE sources SET conversation_id=?,status=? WHERE source_id=?", (cid, "duplicate" if prior else "success", sid))
                json_entries.append(entry)
                if prior:
                    continue
                _schema_add(schema, payload)
                paragraphs = payload["paragraph"]
                texts = []
                invalid_text = False
                for ordinal, paragraph in enumerate(paragraphs):
                    if not isinstance(paragraph, dict) or not isinstance(paragraph.get("paragraph_text"), str):
                        texts.append("")
                        invalid_text = True
                        issues.append({"source_id": sid, "conversation_id": cid, "paragraph_ordinal": ordinal, "reason": "non_object_paragraph_or_non_string_text_retained_in_raw_json"})
                    else:
                        texts.append(paragraph["paragraph_text"])
                if invalid_text:
                    conn.execute("UPDATE sources SET status='held',error='non_string_paragraph_text_retained_without_text_coercion' WHERE source_id=?", (sid,))
                full_text = "\n".join(texts)
                observed_id = payload.get("id")
                subject = canonical_json(observed_id) if observed_id is not None and observed_id != "" else None
                conn.execute("INSERT INTO conversations VALUES(?,?,?,?,?,?,?,?)", (cid, raw, full_text, sid, entry["split"], entry["split"], cid, subject))
                _labels_add(conn, dictionary, cid, "conversation", payload, TOP_METADATA)
                cursor, sentence_ordinal = 0, 0
                for ordinal, (paragraph, text) in enumerate(zip(paragraphs, texts)):
                    uid = stable_id("utt", cid, ordinal)
                    speaker_raw = paragraph.get("paragraph_speaker") if isinstance(paragraph, dict) else None
                    speaker = speaker_raw if isinstance(speaker_raw, str) or speaker_raw is None else canonical_json(speaker_raw)
                    conn.execute("INSERT INTO utterances VALUES(?,?,?,?,?,?,?,?)", (uid, cid, ordinal, speaker, text, canonical_json(paragraph), cursor, cursor + len(text)))
                    cursor += len(text) + 1
                    if isinstance(paragraph, dict):
                        _labels_add(conn, dictionary, uid, "utterance", paragraph, PARAGRAPH_METADATA)
                    for segment in iter_sentences(text):
                        sentence_id = stable_id("sent", uid, segment.start, segment.end, SENTENCE_METHOD)
                        conn.execute("INSERT INTO sentences VALUES(?,?,?,?,?,?,?,?,?)", (sentence_id, uid, cid, sentence_ordinal, speaker, segment.text, segment.start, segment.end, entry["split"]))
                        sentence_ordinal += 1
                        conn.executemany("INSERT INTO words VALUES(?,?,?,?,?,?,?,?,?)", ((stable_id("word", sentence_id, span.start, span.end, WORD_METHOD), sentence_id, cid, number, span.text, span.normalized, span.start, span.end, entry["split"]) for number, span in enumerate(iter_words(segment.text, segment.start))))
                conn.commit()
            except (OSError, UnicodeError, ValueError, TypeError, zipfile.BadZipFile, RuntimeError) as exc:
                conn.execute("UPDATE sources SET status='error',error=? WHERE source_id=?", (f"{type(exc).__name__}: {exc}", sid))
                if raw_bytes is not None:
                    conn.execute("INSERT OR REPLACE INTO source_error_bytes VALUES(?,?)", (sid, raw_bytes))
        groups = _stored_grouping(conn) if resumed_stage else _group_splits(conn)
        txt_by_key = defaultdict(list)
        for entry in txt_entries:
            txt_by_key[_pair_key(entry)].append(entry)
        pairing = Counter()
        unmatched_json, matched_txt, ambiguous_json = [], set(), []
        if resumed_stage:
            pairing.update(dict(conn.execute("SELECT comparison,count(*) FROM source_pairs GROUP BY comparison")))
        for entry in json_entries:
            sid = entry["source_id"]
            matches = txt_by_key.get(_pair_key(entry), [])
            if not matches:
                unmatched_json.append(sid)
                continue
            if len(matches) > 1:
                ambiguous_json.append(sid)
            if resumed_stage:
                matched_txt.update(row[0] for row in conn.execute("SELECT txt_source_id FROM source_pairs WHERE json_source_id=?", (sid,)))
                continue
            conversation_text = conn.execute("SELECT c.text FROM sources s JOIN conversations c USING(conversation_id) WHERE s.source_id=?", (sid,)).fetchone()[0]
            for match in matches:
                txt_sid = match["source_id"]
                txt = conn.execute("SELECT text FROM source_texts WHERE source_id=?", (txt_sid,)).fetchone()[0]
                comparison = _comparison(conversation_text, txt)
                conn.execute("INSERT INTO source_pairs VALUES(?,?,?)", (sid, txt_sid, comparison))
                pairing[comparison] += 1
                matched_txt.add(txt_sid)
        for table in ("sources", "source_payloads", "source_texts", "conversations", "utterances", "sentences", "words", "original_labels"):
            counts[table] = conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
        for entry in dictionary.values():
            total = counts["conversations"] if entry["scope"] == "conversation" else counts["utterances"]
            entry["missing_count"] = total - entry["present_count"]
            entry["null_count"] = entry["value_counts"].get("null", 0)
            entry["zero_count"] = entry["value_counts"].get("0", 0)
        if not resumed_stage:
            conn.executemany("INSERT INTO metadata VALUES(?,?)", [("ingest_version", INGEST_VERSION), ("source_manifest_sha256", manifest_hash), ("sentence_method", SENTENCE_METHOD), ("word_method", WORD_METHOD), ("normalization_method", NORMALIZATION_METHOD), ("offset_unit", "Unicode code points; end exclusive; sentence/word relative to utterance")])
            conn.commit()
        validation = verify_ingest(conn)
        if not validation["passed"]:
            raise RuntimeError("Ingestion validation failed: " + canonical_json(validation))
        status_counts = dict(conn.execute("SELECT status,count(*) FROM sources GROUP BY status"))
        kind_counts = dict(conn.execute("SELECT kind,count(*) FROM sources GROUP BY kind"))
        split_counts = dict(conn.execute("SELECT split,count(*) FROM conversations GROUP BY split"))
        errors = [{"source_id": row[0], "error": row[1]} for row in conn.execute("SELECT source_id,error FROM sources WHERE status='error'")]
        conn.close()
        after = inventory(source)
        if before != after:
            raise RuntimeError("Source manifest changed during ingestion; completed database not replaced")
        report = {"ingest_version": INGEST_VERSION, "created_at": datetime.now(timezone.utc).isoformat(),
            "source_manifest_sha256": manifest_hash, "source_unchanged": True,
            "resume": "resumed_completed_stage" if resumed_stage else "deterministic_atomic_rebuild", "counts": dict(counts),
            "status_counts": status_counts, "kind_counts": kind_counts,
            "all_sources_accounted": sum(status_counts.values()) == len(before) and not status_counts.get("pending", 0),
            "physical_files": sum(e["member"] is None for e in before),
            "archive_members": sum(e["member"] is not None for e in before),
            "byte_duplicate_groups": [{"sha256": h, "source_ids": ids} for h, ids in sorted(hash_sources.items()) if len(ids) > 1],
            "payload_duplicate_sources": status_counts.get("duplicate", 0),
            "pairing": {"comparison_counts": dict(pairing), "unmatched_json_source_ids": unmatched_json,
                "ambiguous_json_source_ids": ambiguous_json,
                "unmatched_txt_source_ids": [e["source_id"] for e in txt_entries if e["source_id"] not in matched_txt],
                "matching_method": "NFC/casefold stem; resource_/label_ prefix removed; original split required"},
            "splits": split_counts, "grouping": groups, "errors": errors, "issues": issues,
            "segmentation": {"sentence_method": SENTENCE_METHOD, "word_method": WORD_METHOD,
                "normalization": NORMALIZATION_METHOD, "offsets": "Unicode code points, end exclusive; sentences and words relative to utterance",
                "limitations": "Rule-based sentence boundaries; Korean lexical tokens are not morphological words. Original text and exact offsets retained."},
            "validation": validation}
        os.replace(stage, database)
        _write_json(output / "source_manifest_before.json", before)
        _write_json(output / "source_manifest_after.json", after)
        _write_json(output / "schema_dictionary.json", {"scope": "unique canonical JSON conversations", "paths": schema})
        _write_json(output / "label_dictionary.json", {"version": "source-observed-v1", "definition_status": "unresolved", "labels": [dictionary[key] for key in sorted(dictionary)]})
        _write_json(report_path, report)
        return report
    except BaseException:
        try:
            conn.close()
        finally:
            raise

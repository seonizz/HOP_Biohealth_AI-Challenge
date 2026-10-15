"""Exact long validation-target exposure within admitted train assistant text.

FTS only selects candidates; Python verifies every seed and the longest span.
Reports contain hashes, coordinates and source IDs, never source text.
"""
from difflib import SequenceMatcher
import sqlite3

from . import source_sft as source
from .source_selection_audit import normalize

SCHEMA = "malssi-partial-exposure-v1"
THRESHOLD = 200
WINDOW = 100
STRIDE = 50


def audit_partial_exposure(train_messages, validation_targets):
    """Search only rows admitted by the preceding exposure policy.

    Train maps raw text to (conversation, group, past/target) origins.
    A shared span >=150 normalized codepoints contains a sampled 100-char seed,
    so the candidate search is complete for the fixed 200-char hold threshold.
    """
    normalized = {}
    for text, origins in train_messages.items():
        normalized.setdefault(normalize(text), set()).update(origins)
    texts = list(normalized)
    matches, searched, windows, pairs = [], 0, 0, 0
    db = sqlite3.connect(":memory:")
    try:
        db.execute("CREATE VIRTUAL TABLE msg USING fts5(text, tokenize='trigram case_sensitive 1')")
        db.executemany("INSERT INTO msg(rowid,text) VALUES (?,?)", enumerate(texts, 1))
        for row in validation_targets:
            target = normalize(row["text"])
            if len(target) < WINDOW:
                continue
            searched += 1
            candidates = set()
            starts = sorted(set(range(0, len(target) - WINDOW + 1, STRIDE)) | {len(target) - WINDOW})
            for start in starts:
                seed = target[start:start + WINDOW]
                phrase = '"' + seed.replace('"', '""') + '"'
                windows += 1
                for number, text in db.execute("SELECT rowid,text FROM msg WHERE msg MATCH ?", (phrase,)):
                    if seed in text:
                        candidates.add(number - 1)
            evidence = []
            for index in sorted(candidates):
                text = texts[index]
                match = SequenceMatcher(None, target, text, autojunk=False).find_longest_match()
                pairs += 1
                if match.size < THRESHOLD:
                    continue
                evidence.append({
                    "normalized_characters": match.size,
                    "validation_start": match.a, "train_start": match.b,
                    "span_sha256": source.sha_text(target[match.a:match.a + match.size]),
                    "train_message_sha256": source.sha_text(text),
                    "train_sources": [{"conversation_id": cid, "group_id": gid, "role": role}
                                      for cid, gid, role in sorted(normalized[text])],
                })
            if evidence:
                longest = max(item["normalized_characters"] for item in evidence)
                matches.append({
                    **{key: row[key] for key in ("id", "source_conversation_id", "source_group_id")},
                    "target_sha256": source.sha_text(target), "target_characters": len(target),
                    "max_shared_characters": longest, "max_target_coverage": longest / len(target),
                    "decision": "hold_validation_target_pending_semantic_review",
                    "semantic_review": "pending", "same_person_established": False,
                    "matches": evidence,
                })
    finally:
        db.close()
    return {"schema_version": SCHEMA, "threshold_normalized_characters": THRESHOLD,
            "normalization": "NFKC and collapse whitespace", "window": WINDOW, "stride": STRIDE,
            "unique_train_assistant_messages": len(texts), "validation_rows": len(validation_targets),
            "searched_validation_targets": searched, "short_targets_not_searched": len(validation_targets) - searched,
            "windows_searched": windows, "candidate_pairs_verified": pairs,
            "held_validation_rows": len(matches), "matches": matches,
            "coverage": "All contiguous exact overlaps >=200 normalized codepoints inside one admitted train assistant message (past or target).",
            "limitations": ["No semantic, discontinuous or train-user-message overlap search.",
                            "Shared text does not establish participant identity or distinguish templates from substantive answers.",
                            "Validation was used for selection and is not an untouched final test."]}

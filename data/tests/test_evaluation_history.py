"""Synthetic history gates: no real counseling text or independent-test claims."""
import copy
import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from counseling_pipeline import evaluation_history as history
from counseling_pipeline import source_sft as source
from counseling_pipeline import source_admission as admission
from counseling_pipeline import token_admission as token


class EvaluationHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.export = self.root / "candidate" / "source_rows"
        self.export.mkdir(parents=True)
        self.manifest_path = self.export / "export_manifest.json"
        self.release = self.root / "release"
        (self.release / "conversation").mkdir(parents=True)
        self.source_path = self.root / "admission" / "admission_rows.jsonl.gz"
        self.admission_policy_path = self.source_path.parent / "admission_policy.json"
        self.selection_audit_path = self.root / "selection_audit.json"
        self.tokenizer_audit_path = self.root / "tokenizer_audit.json"
        self.lengths_path = self.root / "row_lengths.jsonl.gz"
        self.token_path = self.export.parent / "token_admission_rows.jsonl.gz"
        self.policy_path = self.export.parent / "token_admission_policy.json"
        self.events_path = self.root / "events.jsonl"
        self.evidence_path = self.root / "evidence.json"
        self.rows, self.tokens, self.payloads = [], [], []
        specs = [("synthetic_train", "train", "synthetic_train_group", 200, True),
                 ("synthetic_older_validation", "validation", "synthetic_shared_group", 5000, True),
                 ("synthetic_new_validation", "validation", "synthetic_shared_group", 300, True),
                 ("synthetic_other_validation", "validation", "synthetic_other_group", 400, True),
                 ("synthetic_held_validation", "validation", "synthetic_shared_group", 300, False)]
        for identity, split, group, length, admitted in specs:
            base = {"id": identity, "split": split, "source_group_id": group,
                    "source_conversation_id": "conversation_" + identity}
            reasons = [] if admitted else [admission.TARGET_REASON]
            row = {**base, "admitted": admitted, "status": "admitted" if admitted else "held",
                   "reasons": reasons, "model_training_authorized": False}
            self.rows.append(row)
            self.tokens.append({**base, "source_admitted": admitted, "source_status": row["status"],
                                "source_reasons": reasons, "tokenizer_status": "encoded",
                                "sequence_length": length, "prefix_length": length - 100, "target_length": 100})
            messages = [{"role": "system", "content": "task"}, {"role": "user", "content": "SYNTHETIC_PRIVATE_CONTENT"}]
            if split == "train":
                messages += [{"role": "assistant", "content": "Z" * 80}, {"role": "user", "content": "next"}]
            messages.append({"role": "assistant", "content": identity if admitted else "Z" * 80})
            self.payloads.append({**base, "messages": messages, "target_utterance_ids": [identity + "_target"]})
        self.freeze_sources()
        admission.build_admission(self.release, self.selection_audit_path, self.source_path.parent)
        self.rows = list(source.read_rows(self.source_path))
        self.write_rows(self.source_path, self.rows)
        self.rebind_source_policy_ledger()
        self.write_rows(self.lengths_path, [{**{k: r[k] for k in token.IDENTITY}, "status": "encoded",
                                             **{k: r[k] for k in token.LENGTHS}} for r in self.tokens])
        self.save_tokenizer_audit()
        self.token_report, joined = token.validate_and_summarize(self.release, self.admission_policy_path,
                                                                 self.source_path, self.tokenizer_audit_path, self.lengths_path)
        self.tokens = token.make_cap_ledger(joined, 4096)
        self.save_inputs()
        source.dump_json(self.evidence_path, {"inputs": self.source_files})
        self.events = [self.event()]
        self.save_events()

    def write_rows(self, path, rows):
        with path.open("wb") as raw:
            with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as stream:
                for row in rows:
                    stream.write((json.dumps(row, sort_keys=True) + "\n").encode())

    def freeze_sources(self):
        self.original_manifest = {"schema_version": source.SCHEMA,
                                  "training_profile": "observed_counselor_imitation", "files": {}}
        for split in source.SPLITS:
            rows = [r for r in self.payloads if r["split"] == split]
            dialogues = [{"split": split, "source_conversation_id": r["source_conversation_id"],
                          "source_group_id": r["source_group_id"], "source_subject_key": r["source_conversation_id"],
                          "utterances": [{"utterance_id": r["target_utterance_ids"][0]}, {"utterance_id": "synthetic_past"}]}
                         for r in rows]
            for key, values in ((f"conversation/{split}.jsonl.gz", rows),
                                (f"conversation/source_dialogues.{split}.jsonl.gz", dialogues)):
                path = self.release / key
                self.write_rows(path, values)
                self.original_manifest["files"][key] = {"rows": len(values), "bytes": path.stat().st_size,
                                                         "sha256": source.sha_file(path)}
        source.dump_json(self.release / "manifest.json", self.original_manifest)
        self.original_hash = source.sha_file(self.release / "manifest.json")
        self.source_files = {f"conversation/{split}.jsonl.gz": self.original_manifest["files"][f"conversation/{split}.jsonl.gz"]["sha256"]
                             for split in source.SPLITS}
        train, held = self.payloads[0], self.payloads[4]
        match = {"normalized_characters": 80, "text_sha256": source.sha_text("Z" * 80),
                 "validation_row_ids": [held["id"]],
                 "validation_sources": [{"row_id": held["id"], "conversation_id": held["source_conversation_id"],
                                         "group_id": held["source_group_id"]}],
                 "train_sources": [{"conversation_id": train["source_conversation_id"], "group_id": train["source_group_id"],
                                    "utterance_ids": ["synthetic_past"]}]}
        audit = {"schema_version": "malssi-source-selection-audit-v1", "input_manifest_sha256": self.original_hash,
                 "verified_release_files": {k: v["sha256"] for k, v in self.original_manifest["files"].items()},
                 "candidate_counts": {"accepted": len(self.payloads)}, "bounded_cross_split_overlap": {
                     "first_8_context_messages_min200chars": {"unique_shared_blocks": 0, "examples": []},
                     "whole_normalized_past_assistant_group": {"unique_validation_targets": 1, "validation_rows": 1,
                                                               "matches": [match]}}}
        source.dump_json(self.selection_audit_path, audit)

    def rebind_source_policy_ledger(self):
        policy = source.read_json(self.admission_policy_path)
        policy["files"]["admission_rows.jsonl.gz"] = {"rows": len(self.rows), "bytes": self.source_path.stat().st_size,
                                                        "sha256": source.sha_file(self.source_path)}
        source.dump_json(self.admission_policy_path, policy)

    def save_tokenizer_audit(self):
        def lengths(rows):
            return {name: {"count": len(rows), "sum": sum(r[field] for r in rows), "max": max(r[field] for r in rows)}
                    for field, name in zip(token.LENGTHS, ("full", "prefix", "supervised"))}
        audit = {"status": "passed", "network_access": False, "model_weights_loaded": False, "training_run": False,
                 "manifest_sha256": self.original_hash, "row_lengths_sha256": source.sha_file(self.lengths_path),
                 "expected_rows": len(self.tokens), "processed_rows": len(self.tokens), "statuses": {"encoded": len(self.tokens)},
                 "all_rows_encoded": True, "totals": lengths(self.tokens), "inputs": {}, "splits": {}}
        for split in source.SPLITS:
            key = f"conversation/{split}.jsonl.gz"
            rows = [r for r in self.tokens if r["split"] == split]
            audit["inputs"][split] = {"manifest_key": key, **self.original_manifest["files"][key]}
            audit["splits"][split] = {"processed_rows": len(rows), "statuses": {"encoded": len(rows)}, **lengths(rows)}
        source.dump_json(self.tokenizer_audit_path, audit)

    def save_inputs(self):
        self.write_rows(self.source_path, self.rows)
        self.write_rows(self.token_path, self.tokens)
        selected = {r["id"] for r in self.tokens if r["admitted"]}
        caps, files = token.summarize_caps(self.tokens), {}
        selection = caps["4096"]
        for split in source.SPLITS:
            rows = [r for r in self.payloads if r["id"] in selected and r["split"] == split]
            path = self.export / f"{split}.jsonl.gz"
            self.write_rows(path, rows)
            files[path.name] = {"rows": len(rows), "bytes": path.stat().st_size,
                                "sha256": source.sha_file(path),
                                "uncompressed_sha256": source.sha_text(gzip.decompress(path.read_bytes()).decode()),
                                "source_manifest_key": f"conversation/{split}.jsonl.gz"}
        self.policy = {**copy.deepcopy(self.token_report), "selected_cap": 4096,
                       "rows": len(self.rows), "input_manifest_sha256": self.original_hash,
                       "verified_release_files": self.source_files, "selected": selection, "caps": caps,
                       "input_sha256": {path: source.sha_file(path) for path in self.token_report["input_sha256"]},
                       "files": {"token_admission_rows.jsonl.gz": {"rows": len(self.tokens),
                                 "bytes": self.token_path.stat().st_size, "sha256": source.sha_file(self.token_path)}},
                       "model_training_authorized": False, "full_training_authorized": False, "hop_readiness": False}
        source.dump_json(self.policy_path, self.policy)
        self.manifest = {"schema_version": "malssi-source-filtered-export-v1", "status": "verified",
                         "training_profile": "observed_counselor_imitation", "dataset_kind": "source_conversation_only",
                         "source_manifest_sha256": self.original_hash,
                         "source_admission_policy_sha256": source.sha_file(self.admission_policy_path),
                         "source_admission_ledger_sha256": source.sha_file(self.source_path),
                         "token_admission_policy_sha256": source.sha_file(self.policy_path),
                         "token_admission_ledger_sha256": source.sha_file(self.token_path),
                         "selected_cap": 4096, "verified_source_files": self.source_files,
                         "source_rows_examined": len(self.rows), "files": files, "selection": selection,
                         "model_training_authorized": False, "full_training_authorized": False, "hop_readiness": False}
        self.save_manifest()

    def save_manifest(self):
        source.dump_json(self.manifest_path, self.manifest)

    def event(self, purpose="development_audit"):
        key = "conversation/validation.jsonl.gz"
        return {"schema_version": history.EVENT_SCHEMA, "event_id": "synthetic_event",
                "purpose": purpose, "occurred_at": "2026-10-01T00:00:00+00:00",
                "source_manifest_sha256": self.original_hash,
                "scope": {"kind": "rows", "ids": ["synthetic_older_validation"]},
                "input_sha256": {key: self.source_files[key]},
                "evidence": {"path": self.evidence_path.name, "sha256": source.sha_file(self.evidence_path),
                             "input_pointers": {key: "/inputs/conversation~1validation.jsonl.gz"}}}

    def save_events(self):
        self.events_path.write_text("".join(json.dumps(e) + "\n" for e in self.events), encoding="utf-8")

    def audit(self, intended_use="development"):
        return history.audit_history(self.manifest_path, self.source_path, self.events_path, intended_use=intended_use,
                                      release=self.release, admission_policy=self.admission_policy_path,
                                      selection_audit=self.selection_audit_path, tokenizer_audit=self.tokenizer_audit_path,
                                      row_lengths=self.lengths_path)

    def cli_source_args(self):
        return ["--release", str(self.release), "--admission-policy", str(self.admission_policy_path),
                "--selection-audit", str(self.selection_audit_path), "--tokenizer-audit", str(self.tokenizer_audit_path),
                "--row-lengths", str(self.lengths_path)]

    def forge_matching_downstream_metadata(self, *, remove_hold=False):
        """Rehash all downstream inputs while leaving the real release frozen."""
        self.write_rows(self.source_path, self.rows)
        self.rebind_source_policy_ledger()
        policy = source.read_json(self.admission_policy_path)
        if remove_hold:
            policy["held_validation_example_ids"] = []
        held = [r for r in self.rows if not r["admitted"]]
        policy.update(before=admission.summary(self.rows), after=admission.summary([r for r in self.rows if r["admitted"]]),
                      held=admission.summary(held), counts={"all_rows": len(self.rows), "admitted_rows": len(self.rows)-len(held),
                      "held_rows": len(held), "group_quarantine_rows": 0, "validation_target_hold_rows": len(held),
                      "partial_validation_target_hold_rows": 0, "both_hold_reasons_rows": 0})
        source.dump_json(self.admission_policy_path, policy)
        self.write_rows(self.lengths_path, [{**{k: r[k] for k in token.IDENTITY}, "status": "encoded",
                                             **{k: r[k] for k in token.LENGTHS}} for r in self.tokens])
        self.save_tokenizer_audit()
        self.save_inputs()

    def test_exposure_propagates_from_omitted_row_to_group(self):
        report = self.audit()
        self.assertEqual(report["status"], "verified")
        self.assertEqual(report["counts"]["rows"], 3)
        self.assertEqual(report["counts"]["development_exposed"], 1)
        self.assertEqual(report["counts"]["history_unverified"], 2)
        self.assertEqual(report["splits"]["validation"]["development_exposed"], 1)
        self.assertEqual(report["source_admitted_rows"], {"train": 1, "validation": 3})
        self.assertFalse(report["independent_test_eligible"])

    def test_split_scope_covers_every_candidate_in_source_split(self):
        self.events[0]["scope"] = {"kind": "source_split", "split": "validation"}
        self.save_events()
        report = self.audit("independent_test")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["splits"]["validation"]["development_exposed"], 2)
        self.assertEqual(report["splits"]["validation"]["history_unverified"], 0)

    def test_group_scope_and_held_row_cannot_reset_exposure(self):
        self.events[0]["scope"] = {"kind": "source_groups", "ids": ["synthetic_shared_group"]}
        self.save_events()
        self.assertEqual(self.audit()["counts"]["development_exposed"], 1)
        self.events[0]["scope"] = {"kind": "rows", "ids": ["synthetic_held_validation"]}
        self.save_events()
        self.assertEqual(self.audit()["counts"]["development_exposed"], 1)

    def test_rename_validation_to_test_does_not_promote_candidate(self):
        (self.export / "validation.jsonl.gz").rename(self.export / "test.jsonl.gz")
        self.manifest["files"]["test.jsonl.gz"] = self.manifest["files"].pop("validation.jsonl.gz")
        self.save_manifest()
        report = self.audit("independent_test")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["splits"]["validation"]["development_exposed"], 1)

    def test_recompressed_renamed_export_keeps_source_history(self):
        path = self.export / "validation.jsonl.gz"
        with gzip.open(path, "rb") as stream:
            payload = stream.read()
        replacement = self.export / "new-independent-test.jsonl.gz"
        with replacement.open("wb") as raw:
            with gzip.GzipFile(filename="another-name", mode="wb", fileobj=raw, mtime=123) as stream:
                stream.write(payload)
        metadata = self.manifest["files"].pop(path.name)
        self.assertNotEqual(source.sha_file(replacement), metadata["sha256"])
        metadata.update(sha256=source.sha_file(replacement), bytes=replacement.stat().st_size)
        self.manifest["files"][replacement.name] = metadata
        self.save_manifest()
        report = self.audit("independent_test")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["counts"]["development_exposed"], 1)

    def test_changed_split_identity_is_rejected_even_after_rehash(self):
        path = self.export / "validation.jsonl.gz"
        payload = list(source.read_rows(path))
        for row in payload:
            row["split"] = "test"
        self.write_rows(path, payload)
        meta = self.manifest["files"][path.name]
        meta.update(bytes=path.stat().st_size, sha256=source.sha_file(path),
                    uncompressed_sha256=source.sha_text(gzip.decompress(path.read_bytes()).decode()))
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.audit("independent_test")

    def test_empty_history_is_unverified_and_independent_use_fails(self):
        self.events = []
        self.save_events()
        report = self.audit("independent_test")
        self.assertEqual(report["status"], "blocked")
        self.assertEqual(report["verified_events"], 0)
        self.assertEqual(report["counts"]["history_unverified"], 3)
        self.assertFalse(report["history_completeness_verified"])

    def test_non_development_record_cannot_claim_complete_unused_history(self):
        self.events = [self.event("custody_record")]
        self.save_events()
        report = self.audit("independent_test")
        self.assertEqual(report["counts"]["history_unverified"], 3)
        self.assertEqual(report["status"], "blocked")

    def test_later_custody_record_does_not_clear_development_use(self):
        event = self.event("custody_record")
        event.update(event_id="synthetic_later_event", occurred_at="2026-10-02T00:00:00Z")
        self.events.append(event)
        self.save_events()
        self.assertEqual(self.audit()["counts"]["development_exposed"], 1)

    def test_evidence_sha_tampering_fails(self):
        self.evidence_path.write_text('{}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "evidence hash mismatch"):
            self.audit()

    def test_rehashed_evidence_must_still_bind_original_input(self):
        source.dump_json(self.evidence_path, {"inputs": {"conversation/validation.jsonl.gz": "0" * 64}})
        self.events[0]["evidence"]["sha256"] = source.sha_file(self.evidence_path)
        self.save_events()
        with self.assertRaisesRegex(ValueError, "evidence does not bind"):
            self.audit()

    def test_complete_source_ledger_evidence_binds_original_groups(self):
        key = "source_admission_ledger_sha256"
        source.dump_json(self.evidence_path, {"metadata": {key: source.sha_file(self.source_path)}})
        self.events[0]["input_sha256"] = {key: source.sha_file(self.source_path)}
        self.events[0]["evidence"].update(sha256=source.sha_file(self.evidence_path),
                                           input_pointers={key: "/metadata/" + key})
        self.save_events()
        self.assertEqual(self.audit("independent_test")["counts"]["development_exposed"], 1)
        self.events[0]["input_sha256"][key] = "0" * 64
        self.save_events()
        with self.assertRaisesRegex(ValueError, "input binding"):
            self.audit()

    def test_scope_across_source_splits_requires_both_input_hashes(self):
        self.events[0]["scope"] = {"kind": "rows", "ids": ["synthetic_train", "synthetic_older_validation"]}
        self.save_events()
        with self.assertRaisesRegex(ValueError, "input binding"):
            self.audit()
        self.events[0]["input_sha256"] = dict(self.source_files)
        self.events[0]["evidence"]["input_pointers"] = {
            key: "/inputs/" + key.replace("/", "~1") for key in self.source_files}
        self.save_events()
        self.assertEqual(self.audit()["counts"]["development_exposed"], 2)

    def test_missing_evidence_and_missing_history_fail_closed(self):
        self.evidence_path.unlink()
        with self.assertRaises(OSError):
            self.audit()
        self.events_path.unlink()
        with self.assertRaises(OSError):
            self.audit()

    def test_changed_manifest_or_wrong_input_binding_fails(self):
        for field in ("source_manifest_sha256", "input_sha256"):
            with self.subTest(field=field):
                self.events = [self.event()]
                self.events[0][field] = "0" * 64 if field.endswith("sha256") and field != "input_sha256" else {}
                self.save_events()
                with self.assertRaisesRegex(ValueError, "binding"):
                    self.audit()

    def test_scope_cannot_be_unknown_empty_duplicated_or_missing(self):
        scopes = [None, {}, {"kind": "source_split", "split": "test"},
                  {"kind": "all"}, {"kind": "rows", "ids": []},
                  {"kind": "rows", "ids": ["missing_synthetic_row"]},
                  {"kind": "source_groups", "ids": ["missing_synthetic_group"]},
                  {"kind": "rows", "ids": ["synthetic_older_validation"] * 2}]
        for scope in scopes:
            with self.subTest(scope=scope):
                self.events[0]["scope"] = scope
                self.save_events()
                with self.assertRaises(ValueError):
                    self.audit()

    def test_duplicate_and_conflicting_event_ids_fail(self):
        for purpose in ("development_audit", "custody_record"):
            with self.subTest(purpose=purpose):
                self.events = [self.event(), self.event(purpose)]
                self.save_events()
                with self.assertRaisesRegex(ValueError, "duplicate or conflicting"):
                    self.audit()

    def test_duplicate_content_with_different_id_and_equivalent_scope_fails(self):
        event = copy.deepcopy(self.events[0])
        event["event_id"] = "synthetic_alternate_id"
        event["scope"] = {"kind": "source_groups", "ids": ["synthetic_shared_group"]}
        event["occurred_at"] = "2026-10-01T09:00:00+09:00"
        self.events.append(event)
        self.save_events()
        with self.assertRaisesRegex(ValueError, "duplicate history event content"):
            self.audit()

    def test_unknown_purpose_and_timestamp_fail(self):
        for field, value in (("purpose", "unused_forever"), ("occurred_at", "not-a-date"),
                             ("occurred_at", "2026-10-01T00:00:00")):
            with self.subTest(field=field, value=value):
                self.events = [self.event()]
                self.events[0][field] = value
                self.save_events()
                with self.assertRaises(ValueError):
                    self.audit()

    def test_missing_source_ledger_and_rehashed_missing_row_fail(self):
        self.source_path.unlink()
        with self.assertRaises(OSError):
            self.audit()
        self.rows.pop(1)
        self.write_rows(self.source_path, self.rows)
        self.manifest["source_admission_ledger_sha256"] = source.sha_file(self.source_path)
        self.policy["input_sha256"][str(self.source_path)] = source.sha_file(self.source_path)
        source.dump_json(self.policy_path, self.policy)
        self.manifest["token_admission_policy_sha256"] = source.sha_file(self.policy_path)
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "admission rows hash mismatch"):
            self.audit()

    def test_source_ledger_hash_and_token_policy_hash_are_required(self):
        for key in ("source_admission_ledger_sha256", "token_admission_policy_sha256", "token_admission_ledger_sha256"):
            with self.subTest(key=key):
                previous = self.manifest[key]
                self.manifest[key] = "0" * 64
                self.save_manifest()
                with self.assertRaisesRegex(ValueError, "hash mismatch"):
                    self.audit()
                self.manifest[key] = previous

    def test_missing_source_policy_hash_cannot_be_rebound_as_null(self):
        self.manifest["source_admission_policy_sha256"] = None
        self.policy["input_sha256"][str(self.admission_policy_path)] = None
        source.dump_json(self.policy_path, self.policy)
        self.manifest["token_admission_policy_sha256"] = source.sha_file(self.policy_path)
        self.save_manifest()
        with self.assertRaisesRegex(ValueError, "admission policy hash mismatch"):
            self.audit()

    def test_source_group_relabeling_in_export_is_rejected(self):
        self.payloads[2]["source_group_id"] = "synthetic_fresh_group"
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "identity changed"):
            self.audit()

    def test_inconsistent_token_decision_is_rejected_after_rehash(self):
        self.tokens[1]["admitted"] = True
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "verified source decisions"):
            self.audit()

    def test_group_relabel_in_both_ledgers_export_and_rehashed_metadata_fails(self):
        for collection in (self.rows, self.tokens, self.payloads):
            collection[2]["source_group_id"] = "synthetic_relabelled_group"
        self.forge_matching_downstream_metadata()
        with self.assertRaisesRegex(ValueError, "recomputed rules"):
            self.audit()

    def test_row_omission_in_both_ledgers_export_and_rehashed_metadata_fails(self):
        for collection in (self.rows, self.tokens, self.payloads):
            del collection[3]
        self.forge_matching_downstream_metadata()
        with self.assertRaisesRegex(ValueError, "total row count mismatch"):
            self.audit()

    def test_removed_hold_in_source_policy_and_both_ledgers_fails_recomputed_rules(self):
        self.rows[4].update(admitted=True, status="admitted", reasons=[])
        self.tokens[4].update(source_admitted=True, source_status="admitted", source_reasons=[])
        self.tokens = token.make_cap_ledger(self.tokens, 4096)
        self.forge_matching_downstream_metadata(remove_hold=True)
        with self.assertRaisesRegex(ValueError, "recomputed rules"):
            self.audit()

    def test_export_text_change_after_rehash_fails_actual_source_line_check(self):
        self.payloads[2]["messages"][-1]["content"] = "synthetic edited answer"
        self.save_inputs()
        with self.assertRaisesRegex(ValueError, "original source line"):
            self.audit()

    def test_actual_source_conversation_change_is_rejected(self):
        path = self.release / "conversation/validation.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "source file byte count mismatch"):
            self.audit()

    def test_actual_source_dialogue_change_is_rejected(self):
        path = self.release / "conversation/source_dialogues.validation.jsonl.gz"
        path.write_bytes(path.read_bytes() + b"changed")
        with self.assertRaisesRegex(ValueError, "manifest file size mismatch"):
            self.audit()

    def test_selection_evidence_change_cannot_silently_redefine_holds(self):
        self.selection_audit_path.write_text('{}\n', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "selection audit binding mismatch"):
            self.audit()

    def test_malformed_policy_files_returns_invalid_json_without_traceback(self):
        self.policy["files"] = []
        source.dump_json(self.policy_path, self.policy)
        self.manifest["token_admission_policy_sha256"] = source.sha_file(self.policy_path)
        self.save_manifest()
        output = self.root / "malformed-report.json"
        command = [sys.executable, "-B", "-m", "counseling_pipeline.evaluation_history",
                   "--export-manifest", str(self.manifest_path), "--source-ledger", str(self.source_path),
                   "--events", str(self.events_path), "--intended-use", "development", "--output", str(output),
                   *self.cli_source_args()]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "invalid")
        self.assertNotIn("Traceback", result.stderr)
        self.assertFalse(output.exists())

    def test_aggregate_contains_no_text_group_conversation_or_event_ids(self):
        serialized = json.dumps(self.audit())
        for row in self.rows:
            for field in ("id", "source_group_id", "source_conversation_id"):
                self.assertNotIn(row[field], serialized)
        self.assertNotIn(self.events[0]["event_id"], serialized)
        self.assertNotIn("SYNTHETIC_PRIVATE_CONTENT", serialized)
        self.assertNotIn(str(self.root), serialized)

    def test_report_overwrite_and_symlink_are_refused(self):
        destination = self.root / "report.json"
        report = self.audit()
        history.write_report(destination, report)
        previous = destination.read_bytes()
        with self.assertRaisesRegex(ValueError, "already exists"):
            history.write_report(destination, {})
        self.assertEqual(destination.read_bytes(), previous)
        link = self.root / "report-link.json"
        link.symlink_to(destination)
        with self.assertRaisesRegex(ValueError, "already exists"):
            history.write_report(link, {})
        dangling = self.root / "dangling-link.json"
        dangling.symlink_to(self.root / "absent.json")
        with self.assertRaisesRegex(ValueError, "already exists"):
            history.write_report(dangling, {})
        self.assertEqual(list(self.root.glob(".evaluation-history-*")), [])

    def test_cli_blocks_independent_use_writes_aggregate_and_never_overwrites(self):
        output = self.root / "cli-report.json"
        command = [sys.executable, "-B", "-m", "counseling_pipeline.evaluation_history",
                   "--export-manifest", str(self.manifest_path), "--source-ledger", str(self.source_path),
                   "--events", str(self.events_path), "--intended-use", "independent_test", "--output", str(output),
                   *self.cli_source_args()]
        result = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(result.returncode, 2, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report, source.read_json(output))
        self.assertEqual(report["status"], "blocked")
        previous = output.read_bytes()
        repeat = subprocess.run(command, capture_output=True, text=True)
        self.assertEqual(repeat.returncode, 2)
        self.assertEqual(json.loads(repeat.stdout)["status"], "invalid")
        self.assertEqual(output.read_bytes(), previous)


if __name__ == "__main__":
    unittest.main()

"""Synthetic one-to-one joins; no actual tokenizer/model certification."""
import copy
import gzip
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from collections import Counter

from counseling_pipeline import source_admission as admission
from counseling_pipeline import source_sft as source
from counseling_pipeline import token_admission as gate


class TokenAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / "release"
        (self.release / "conversation").mkdir(parents=True)
        self.policy_path = self.root / "admission_policy.json"
        self.ledger_path = self.root / "admission_rows.jsonl.gz"
        self.audit_path = self.root / "audit.json"
        self.lengths_path = self.root / "row_lengths.jsonl.gz"
        self.output = self.root / "output"
        self.groups = {"gb", "gv3"};self.targets = {"v2", "v3"}
        self.ledger, self.tokens = [], []
        specifications = [("a", "train", 512), ("b", "train", 513), ("c", "train", 1024),
                          ("d", "train", "runtime_error"), ("v1", "validation", 4096),
                          ("v2", "validation", 520), ("v3", "validation", "held")]
        for identity, split, length in specifications:
            base = {"id": identity, "split": split, "source_group_id": "g" + identity,
                    "source_conversation_id": "conv" + identity}
            reasons = ([admission.GROUP_REASON] if base["source_group_id"] in self.groups else [])
            reasons += [admission.TARGET_REASON] if identity in self.targets else []
            self.ledger.append({**base, "admitted": not reasons, "status": "held" if reasons else "admitted",
                                "reasons": reasons, "model_training_authorized": False})
            if type(length) is int:
                token = {**base, "status": "encoded", "sequence_length": length,
                         "prefix_length": length - 100, "target_length": 100}
            else:
                token = {**base, "status": length, "error_type": "SyntheticError", "error": "synthetic reason"}
            self.tokens.append(token)
        self.save_sources()
        self.save_ledgers()

    def write_rows(self, path, rows):
        with gzip.open(path, "wt", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row) + "\n")

    def save_sources(self):
        self.manifest = {"schema_version": source.SCHEMA, "training_profile": "observed_counselor_imitation", "files": {}}
        for split in source.SPLITS:
            key = f"conversation/{split}.jsonl.gz"
            path = self.release / key
            rows = [{k: r[k] for k in gate.IDENTITY} for r in self.ledger if r["split"] == split]
            self.write_rows(path, rows)
            self.manifest["files"][key] = {"rows": len(rows), "bytes": path.stat().st_size, "sha256": source.sha_file(path)}
        source.dump_json(self.release / "manifest.json", self.manifest)

    def save_ledgers(self):
        self.write_rows(self.ledger_path, self.ledger)
        self.write_rows(self.lengths_path, self.tokens)
        held = [r for r in self.ledger if not r["admitted"]]
        self.policy = {"schema_version": admission.LEGACY_SCHEMA, "model_training_authorized": False,
                       "input_manifest_sha256": source.sha_file(self.release / "manifest.json"),
                       "verified_release_files": {k: v["sha256"] for k, v in self.manifest["files"].items()},
                       "quarantined_source_groups": sorted(self.groups), "held_validation_example_ids": sorted(self.targets),
                       "before": admission.summary(self.ledger),
                       "after": admission.summary([r for r in self.ledger if r["admitted"]]),
                       "held": admission.summary(held),
                       "counts": {"all_rows": len(self.ledger), "admitted_rows": len(self.ledger) - len(held),
                                  "held_rows": len(held), "group_quarantine_rows": 2,
                                  "validation_target_hold_rows": 2, "both_hold_reasons_rows": 1},
                       "files": {"admission_rows.jsonl.gz": {"rows": len(self.ledger),
                                 "bytes": self.ledger_path.stat().st_size, "sha256": source.sha_file(self.ledger_path)}}}
        statuses = dict(Counter(r["status"] for r in self.tokens))
        self.audit = {"status": "failed", "network_access": False, "model_weights_loaded": False, "training_run": False,
                      "manifest_sha256": self.policy["input_manifest_sha256"], "row_lengths_sha256": source.sha_file(self.lengths_path),
                      "expected_rows": len(self.ledger), "processed_rows": len(self.tokens), "statuses": statuses,
                      "all_rows_encoded": False, "inputs": {}, "splits": {}}
        self.audit["totals"] = self.length_summary(self.tokens)
        for split in source.SPLITS:
            key = f"conversation/{split}.jsonl.gz"
            self.audit["inputs"][split] = {"manifest_key": key, **self.manifest["files"][key]}
            rows = [r for r in self.tokens if r["split"] == split]
            self.audit["splits"][split] = {"processed_rows": len(rows), "statuses": dict(Counter(r["status"] for r in rows)),
                                           **self.length_summary(rows)}
        self.save_documents()

    def length_summary(self, rows):
        result = {}
        for field, name in zip(gate.LENGTHS, ("full", "prefix", "supervised")):
            values = [r[field] for r in rows if r["status"] == "encoded"]
            result[name] = {"count": len(values), "sum": sum(values), "max": max(values) if values else None}
        return result

    def save_documents(self):
        source.dump_json(self.policy_path, self.policy)
        source.dump_json(self.audit_path, self.audit)

    def validate(self):
        return gate.validate_and_summarize(self.release, self.policy_path, self.ledger_path,
                                           self.audit_path, self.lengths_path)

    def build(self, cap=512):
        return gate.build_token_admission(self.release, self.policy_path, self.ledger_path,
                                         self.audit_path, self.lengths_path, self.output, cap=cap)

    def export(self, cap=512):
        return gate.export_source_rows(self.release, self.policy_path, self.ledger_path,
                                       self.audit_path, self.lengths_path,
                                       self.output / "token_admission_policy.json",
                                       self.output / "token_admission_rows.jsonl.gz",
                                       self.output / "source_rows", cap=cap)

    def rebind_source_bytes(self):
        for key, metadata in self.manifest["files"].items():
            path = self.release / key
            metadata.update(bytes=path.stat().st_size, sha256=source.sha_file(path))
        source.dump_json(self.release / "manifest.json", self.manifest)
        self.save_ledgers()

    def rewrite_selected_ledger(self, mutate):
        path = self.output / "token_admission_rows.jsonl.gz"
        rows = list(source.read_rows(path));mutate(rows)
        self.write_rows(path, rows)
        policy_path = self.output / "token_admission_policy.json"
        policy = source.read_json(policy_path)
        policy["files"][path.name] = {"rows": len(rows), "bytes": path.stat().st_size, "sha256": source.sha_file(path)}
        source.dump_json(policy_path, policy)

    def test_seven_caps_exclude_prior_holds_and_preserve_all_reasons(self):
        report, joined = self.validate()
        self.assertEqual(set(report["caps"]), {str(c) for c in gate.CAPS})
        self.assertIsNone(report["selected_cap"])
        small = report["caps"]["512"]
        self.assertEqual(small["train"]["admitted_rows"], 1)
        self.assertEqual((small["train"]["full_tokens"], small["train"]["prefix_tokens"],
                          small["train"]["supervised_tokens"]), (512, 412, 100))
        self.assertEqual(report["caps"]["1024"]["train"]["admitted_rows"], 2)
        self.assertEqual(report["caps"]["4096"]["validation"]["admitted_rows"], 1)
        self.assertEqual(small["train"]["source_groups"], 1)
        self.assertEqual(small["train"]["source_conversations"], 1)
        ledger = {r["id"]: r for r in gate.make_cap_ledger(joined, 512)}
        self.assertEqual(ledger["b"]["reasons"], [admission.GROUP_REASON, "sequence_exceeds_cap"])
        self.assertEqual(ledger["v3"]["reasons"], [admission.GROUP_REASON, admission.TARGET_REASON, "tokenizer_held"])
        self.assertEqual(ledger["d"]["tokenizer_error"], {"error_type": "SyntheticError", "error": "synthetic reason"})
        self.assertTrue(all(not r["model_training_authorized"] and not r["hop_readiness"]
                            and r["optimizer_fit"] == "unknown" for r in ledger.values()))

    def test_output_is_explicit_bound_and_does_not_change_inputs(self):
        paths = [self.policy_path, self.ledger_path, self.audit_path, self.lengths_path]
        hashes = {p: source.sha_file(p) for p in paths}
        report = self.build(1024)
        self.assertEqual(report["selected_cap"], 1024)
        path = self.output / "token_admission_rows.jsonl.gz"
        self.assertEqual(report["files"][path.name]["sha256"], source.sha_file(path))
        self.assertEqual(len(list(source.read_rows(path))), 7)
        self.assertEqual(hashes, {p: source.sha_file(p) for p in paths})
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.build(1024)

    def add_partial_hold(self):
        row = next(r for r in self.ledger if r['id'] == 'v1')
        row.update(admitted=False, status='held', reasons=[admission.PARTIAL_REASON])
        self.save_ledgers()
        self.policy.update(schema_version=admission.SCHEMA,
            partial_overlap_held_validation_example_ids=['v1'],
            partial_overlap_audit={'schema_version':'malssi-partial-exposure-v1',
                'threshold_normalized_characters':200, 'held_validation_rows':1,
                'matches':[{k:row[k] for k in gate.IDENTITY} | {'max_shared_characters':210, 'target_characters':300}]})
        self.policy['counts']['partial_validation_target_hold_rows'] = 1
        self.save_documents()

    def test_partial_hold_survives_cap_selection_and_export(self):
        self.add_partial_hold()
        report, joined = self.validate()
        for cap in gate.CAPS:
            self.assertEqual(report['caps'][str(cap)]['validation']['admitted_rows'], 0)
            held = next(r for r in gate.make_cap_ledger(joined, cap) if r['id'] == 'v1')
            self.assertFalse(held['admitted'])
            self.assertIn(admission.PARTIAL_REASON, held['reasons'])
        self.build(4096)
        self.export(4096)
        self.assertEqual(list(source.read_rows(self.output / 'source_rows/validation.jsonl.gz')), [])
        exported = list(source.read_rows(self.output / 'source_rows/train.jsonl.gz'))
        self.assertEqual({r['id'] for r in exported}, {'a','c'})

    def test_partial_policy_requires_versioned_complete_inventory(self):
        self.add_partial_hold()
        original = copy.deepcopy(self.policy)
        for change in ('missing-field','missing-match','duplicate-match','legacy-with-new-fields'):
            self.policy = copy.deepcopy(original)
            if change == 'missing-field': self.policy.pop('partial_overlap_audit')
            elif change == 'missing-match': self.policy['partial_overlap_audit']['matches'] = []
            elif change == 'duplicate-match': self.policy['partial_overlap_audit']['matches'] *= 2
            else: self.policy['schema_version'] = admission.LEGACY_SCHEMA
            self.save_documents()
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, 'partial exposure'):
                self.validate()

    def test_partial_hold_cannot_be_removed_only_from_the_persisted_ledger(self):
        self.add_partial_hold()
        row = next(r for r in self.ledger if r['id'] == 'v1')
        row.update(admitted=True, status='admitted', reasons=[])
        self.write_rows(self.ledger_path, self.ledger)
        self.policy['files']['admission_rows.jsonl.gz'].update(
            bytes=self.ledger_path.stat().st_size, sha256=source.sha_file(self.ledger_path))
        self.save_documents()
        with self.assertRaisesRegex(ValueError, 'hold decision inconsistent'):
            self.validate()

    def test_partial_hold_checks_origin_and_threshold(self):
        self.add_partial_hold()
        original = copy.deepcopy(self.policy)
        for field, value in [('source_group_id','wrong'), ('max_shared_characters',199), ('max_shared_characters',True), ('target_characters',209)]:
            self.policy = copy.deepcopy(original)
            self.policy['partial_overlap_audit']['matches'][0][field] = value
            self.save_documents()
            with self.subTest(field=field,value=value), self.assertRaisesRegex(ValueError, 'partial exposure'):
                self.validate()

    def test_duplicate_token_or_source_ids_fail(self):
        for side in ("tokens", "ledger"):
            original = copy.deepcopy(getattr(self, side))
            getattr(self, side)[1]["id"] = getattr(self, side)[0]["id"]
            self.save_ledgers()
            with self.subTest(side=side), self.assertRaisesRegex(ValueError, "duplicate ledger"):
                self.validate()
            setattr(self, side, original)

    def test_missing_and_extra_id_with_unchanged_row_count_fails(self):
        self.tokens[0]["id"] = "extra"
        self.save_ledgers()
        with self.assertRaisesRegex(ValueError, "ID set mismatch"):
            self.validate()

    def test_join_uses_identity_not_row_order(self):
        _, reference = self.validate()
        self.tokens.reverse();self.save_ledgers()
        _, reordered = self.validate()
        self.assertEqual(reordered, reference)

    def test_missing_row_fails_even_when_audit_is_rehashed(self):
        self.tokens.pop();self.save_ledgers()
        with self.assertRaisesRegex(ValueError, "total row count mismatch"):
            self.validate()

    def test_joined_split_group_or_conversation_mismatch_fails(self):
        for field, value in (("split", "validation"), ("source_group_id", "another"), ("source_conversation_id", "another")):
            old = self.tokens[0][field];self.tokens[0][field] = value;self.save_ledgers()
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "split count mismatch|identity mismatch"):
                self.validate()
            self.tokens[0][field] = old

    def test_cross_split_source_group_or_changed_conversation_origin_fails(self):
        for key, value in (("source_group_id", "ga"), ("source_conversation_id", "conva")):
            old = self.tokens[-1][key];self.tokens[-1][key] = value;self.save_ledgers()
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, "crosses splits|origin mismatch"):
                self.validate()
            self.tokens[-1][key] = old

    def test_inconsistent_zero_boolean_and_negative_token_lengths_fail(self):
        for field, value in (("sequence_length", 513), ("prefix_length", 0), ("target_length", True), ("target_length", -1)):
            old = self.tokens[0][field];self.tokens[0][field] = value;self.save_ledgers()
            with self.subTest(field=field, value=value), self.assertRaisesRegex(ValueError, "token lengths"):
                self.validate()
            self.tokens[0][field] = old

    def test_failure_cannot_contain_lengths_or_omit_reason(self):
        original = copy.deepcopy(self.tokens[-1])
        for change in ("length", "reason"):
            if change == "length":self.tokens[-1]["sequence_length"] = 12
            else:self.tokens[-1].pop("error")
            self.save_ledgers()
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, "unverified lengths|reason missing"):
                self.validate()
            self.tokens[-1] = copy.deepcopy(original)

    def test_policy_held_row_cannot_be_readmitted(self):
        self.ledger[1].update(admitted=True, status="admitted", reasons=[])
        self.save_ledgers()
        with self.assertRaisesRegex(ValueError, "hold decision inconsistent"):
            self.validate()

    def test_each_binding_hash_and_actual_source_bytes_are_checked(self):
        cases = (("policy", "input_manifest_sha256", "manifest hash"),
                 ("audit", "manifest_sha256", "manifest hash"),
                 ("audit", "row_lengths_sha256", "row lengths hash"))
        for target, key, message in cases:
            document = getattr(self, target);old = document[key];document[key] = "0" * 64;self.save_documents()
            with self.subTest(target=target, key=key), self.assertRaisesRegex(ValueError, message):self.validate()
            document[key] = old
        self.save_documents()
        path = self.release / "conversation/train.jsonl.gz"
        raw = bytearray(path.read_bytes());raw[-1] ^= 1;path.write_bytes(raw)
        with self.assertRaisesRegex(ValueError, "source file hash mismatch"):self.validate()

    def test_ledger_hash_or_audit_source_binding_mismatch_fails(self):
        original = copy.deepcopy(self.policy)
        self.policy["files"]["admission_rows.jsonl.gz"]["sha256"] = "0" * 64;self.save_documents()
        with self.assertRaisesRegex(ValueError, "admission rows hash mismatch"):self.validate()
        self.policy = original
        self.audit["inputs"]["train"]["sha256"] = "0" * 64;self.save_documents()
        with self.assertRaisesRegex(ValueError, "source hash binding mismatch"):self.validate()

    def test_incomplete_or_inconsistent_audit_outcome_cannot_claim_success(self):
        for key, value, message in (("status", "running", "incomplete"),
                                    ("status", "passed", "outcome inconsistent"),
                                    ("all_rows_encoded", True, "outcome inconsistent"),
                                    ("statuses", {"encoded": 7}, "status count mismatch")):
            old = self.audit[key];self.audit[key] = value;self.save_documents()
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, message):self.validate()
            self.audit[key] = old

    def test_row_lengths_must_agree_with_audit_totals_and_split_summary(self):
        for summary in (self.audit["totals"], self.audit["splits"]["train"]):
            old = summary["full"]["sum"]
            summary["full"]["sum"] += 1;self.save_documents()
            with self.assertRaisesRegex(ValueError, "length summary mismatch"):
                self.validate()
            summary["full"]["sum"] = old

    def test_cap_is_mandatory_and_failure_creates_no_output(self):
        for cap in (None, True, 500):
            with self.subTest(cap=cap), self.assertRaisesRegex(ValueError, "explicit supported"):
                self.build(cap)
        self.assertFalse(self.output.exists())
        result = subprocess.run([sys.executable, "-B", "-m", "counseling_pipeline.token_admission",
                                 "--release", str(self.release), "--admission-policy", str(self.policy_path),
                                 "--admission-rows", str(self.ledger_path), "--tokenizer-audit", str(self.audit_path),
                                 "--row-lengths", str(self.lengths_path), "--output", str(self.output)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertIn("--cap", result.stderr)
        self.assertFalse(self.output.exists())

    def test_export_copies_original_jsonl_bytes_including_messages_and_crlf(self):
        originals = {}
        for split in source.SPLITS:
            path = self.release / f"conversation/{split}.jsonl.gz"
            rows = list(source.read_rows(path))
            with gzip.open(path, "wb") as stream:
                for row in rows:
                    row["messages"] = [{"role": "user", "content": "반복된 말\n그대로"},
                                       {"role": "assistant", "content": " 원문 답변을 유지합니다. "}]
                    row["loss_message_mask"] = [0, 1]
                    line = (" \t" + json.dumps(row, ensure_ascii=False, separators=(", ", " : ")) + "\r\n").encode()
                    stream.write(line);originals[row["id"]] = line
        self.rebind_source_bytes()
        report = self.build(4096)
        source_hashes = {p: source.sha_file(p) for p in self.release.rglob("*") if p.is_file()}
        exported = self.export(4096)
        selected = list(source.read_rows(self.output / "token_admission_rows.jsonl.gz"))
        for split in source.SPLITS:
            wanted = [r["id"] for r in selected if r["split"] == split and r["admitted"]]
            path = self.output / "source_rows" / f"{split}.jsonl.gz"
            with gzip.open(path, "rb") as stream:
                self.assertEqual(stream.read(), b"".join(originals[i] for i in wanted))
            self.assertEqual(exported["files"][path.name]["rows"], len(wanted))
            self.assertEqual(exported["files"][path.name]["sha256"], source.sha_file(path))
        self.assertEqual(source_hashes, {p: source.sha_file(p) for p in source_hashes})
        self.assertEqual(exported["source_manifest_sha256"], report["input_manifest_sha256"])
        self.assertTrue(exported["original_jsonl_lines_preserved"])
        self.assertFalse(exported["tokens_truncated"])
        self.assertFalse(exported["full_training_authorized"])
        self.assertFalse(exported["hop_readiness"])
        self.assertEqual(exported["dataset_kind"], "source_conversation_only")
        self.assertTrue(all(not r["exported"] and not r["training_approved"]
                            for r in exported["analysis_references"].values()))

    def test_export_rejects_rehashed_tampered_selection_decision(self):
        self.build()
        self.rewrite_selected_ledger(lambda rows: rows[1].update(admitted=True, status="admitted", reasons=[]))
        with self.assertRaisesRegex(ValueError, "differs from verified decisions"):
            self.export()
        self.assertFalse((self.output / "source_rows").exists())

    def test_export_rejects_missing_selected_id_even_if_rehashed(self):
        self.build()
        self.rewrite_selected_ledger(lambda rows: rows.pop(0))
        with self.assertRaisesRegex(ValueError, "selected ledger ID set or count"):
            self.export()
        self.assertFalse((self.output / "source_rows").exists())

    def test_export_rejects_source_identity_gap_after_all_hashes_are_rebound(self):
        path = self.release / "conversation/train.jsonl.gz"
        rows = list(source.read_rows(path));rows[0]["id"] = "unlisted"
        self.write_rows(path, rows);self.rebind_source_bytes();self.build()
        with self.assertRaisesRegex(ValueError, "source JSONL ID missing"):
            self.export()
        self.assertFalse((self.output / "source_rows").exists())
        self.assertFalse(list(self.output.glob(".malssi-source-export-*")))

    def test_export_rejects_missing_original_line_even_if_source_hash_is_rebound(self):
        path = self.release / "conversation/train.jsonl.gz"
        rows = list(source.read_rows(path));rows.pop(0)
        self.write_rows(path, rows);self.rebind_source_bytes();self.build()
        with self.assertRaisesRegex(ValueError, "source JSONL row count mismatch"):
            self.export()
        self.assertFalse((self.output / "source_rows").exists())

    def test_export_rejects_duplicate_original_id_and_changed_source_group(self):
        path = self.release / "conversation/train.jsonl.gz"
        originals = list(source.read_rows(path))
        for mutation, message in (("duplicate", "duplicate source JSONL"), ("group", "identity disagrees")):
            rows = copy.deepcopy(originals)
            if mutation == "duplicate":rows[1] = copy.deepcopy(rows[0])
            else:rows[0]["source_group_id"] = "wrong-group"
            self.write_rows(path, rows);self.rebind_source_bytes()
            self.output = self.root / mutation;self.build()
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError, message):
                self.export()
            self.assertFalse((self.output / "source_rows").exists())

    def test_export_rejects_stale_source_hash_and_existing_output(self):
        self.build()
        self.export()
        destination = self.output / "source_rows" / "train.jsonl.gz"
        digest = source.sha_file(destination)
        with self.assertRaisesRegex(ValueError, "output already exists"):
            self.export()
        self.assertEqual(source.sha_file(destination), digest)
        self.output = self.root / "second";self.build()
        source_path = self.release / "conversation/train.jsonl.gz"
        source_path.write_bytes(source_path.read_bytes() + b"x")
        with self.assertRaisesRegex(ValueError, "source file byte count mismatch"):
            self.export()
        self.assertFalse((self.output / "source_rows").exists())

    def test_cli_export_flag_writes_bound_source_only_export(self):
        result = subprocess.run([sys.executable, "-B", "-m", "counseling_pipeline.token_admission",
                                 "--release", str(self.release), "--admission-policy", str(self.policy_path),
                                 "--admission-rows", str(self.ledger_path), "--tokenizer-audit", str(self.audit_path),
                                 "--row-lengths", str(self.lengths_path), "--output", str(self.output),
                                 "--cap", "4096", "--export-source-rows"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        exported = source.read_json(self.output / "source_rows" / "export_manifest.json")
        self.assertEqual(exported["selected_cap"], 4096)
        self.assertEqual(sum(f["rows"] for f in exported["files"].values()), 3)


if __name__ == "__main__":
    unittest.main()

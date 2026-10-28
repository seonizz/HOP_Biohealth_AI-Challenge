"""Synthetic regression tests for development-only gates and full pending review."""
from contextlib import redirect_stdout
from copy import deepcopy
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

import audit_final_validation as audit
import test_staged_dataset as fixtures


class FinalValidationTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.StagedDatasetTests()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.root = self.fixture.root
        self.private = tempfile.TemporaryDirectory(prefix="final-validation-test-", dir=Path(__file__).resolve().parents[2] / "runtime")
        self.addCleanup(self.private.cleanup)
        self.output = Path(self.private.name) / "review"
        common = "A synthetic shared rationale, not clinical source material. " * 6
        self.target("train", 0, {"reason": common, "tag": "train"})
        self.target("train", 1, {"reason": "An unrelated short train fixture."})
        self.target("validation", 0, {"reason": common, "tag": "validation"})
        self.target("validation", 1, {"reason": "A different short validation fixture."})
        self.write()

    def target(self, split, position, content):
        values = self.fixture.values(audit.SERVICE_PHASE, split)
        row, index = values["rows"][position], values["indexes"][position]
        row["messages"][-1]["content"] = json.dumps(content, ensure_ascii=False)
        row["target_sha256"] = audit.sha(row["messages"][-1]["content"].encode())
        index["target_sha256"] = row["target_sha256"]
        index["messages_sha256"] = audit.staged.messages_digest(row["messages"])

    def write(self):
        self.fixture.write_bundle()
        path = self.root / "DATASET_MANIFEST.json"
        manifest = json.loads(path.read_text())
        manifest.update(schema="malssi-two-stage-data-manifest-v1", clinical_or_human_approval=False, independent_test_eligible=False)
        path.write_bytes(audit.encoded(manifest))

    def source(self):
        return audit.load_source(self.root)

    def prepared(self):
        source = self.source()
        result = audit.write_review(source, self.output)
        return source, result

    def forge_review(self, filename, update):
        path = self.output / filename
        values = list(audit.rows(path.read_bytes()))
        update(values)
        path.write_bytes(b"".join(audit.encoded(row) for row in values))
        manifest_path = self.output / "manifest.json"
        manifest = audit.parse(manifest_path.read_bytes())
        manifest["files"][filename] = {"bytes": path.stat().st_size, "sha256": audit.staged.digest(path)}
        manifest_path.write_bytes(audit.encoded(manifest))
        return audit.staged.digest(manifest_path)

    def test_overlap_and_leaf_values_are_separate_and_public_report_has_no_text(self):
        report = audit.audit(self.source())
        self.assertEqual((report["validation_rows"], report["long_match_rows"], report["no_long_match_detected_rows"]), (2, 1, 1))
        self.assertEqual(report["identical_target_rows"], 0)
        self.assertEqual(report["rows_with_shared_string_leaves_ge20"], 1)
        self.assertEqual(report["validation_source_groups"], 2)
        self.assertEqual(report["shared_leaf_fields"], {"reason": 1})
        self.assertNotIn("synthetic shared rationale", json.dumps(report))
        self.assertNotIn("group:02b", json.dumps(report))

    def test_both_overlap_and_no_match_subsets_remain_development_only(self):
        report = audit.audit(self.source())
        for subset in ("all_validation", "long_match", "no_long_match_detected"):
            for purpose in ("independent_test", "human_approved", "clinical_validation", "unexpected"):
                result = audit.usage_gate(report, purpose, subset)
                self.assertFalse(result["allowed"])
                self.assertFalse(result["independent_test_eligible"])
            self.assertTrue(audit.usage_gate(report, "schema_regression", subset)["allowed"])

    def test_unaligned_exact_200_character_overlap_is_detected_but_199_is_not(self):
        for length in (199, 200):
            with self.subTest(length=length):
                self.target("train", 0, {"a": "L" + "C" * length + "T"})
                self.target("validation", 0, {"b": "R" + "C" * length + "V"})
                self.write()
                report = audit.audit(self.source())
                self.assertEqual(report["long_match_rows"], int(length == 200))

    def test_cli_returns_nonzero_for_independent_test_without_echoing_source(self):
        with redirect_stdout(io.StringIO()) as output:
            code = audit.main(["gate", "--root", str(self.root), "--purpose", "independent_test", "--subset", "no_long_match_detected"])
        self.assertEqual(code, 2)
        self.assertFalse(json.loads(output.getvalue())["allowed"])
        self.assertNotIn("synthetic", output.getvalue())

    def test_complete_pending_handoff_covers_all_auxiliary_rows_and_masks_targets(self):
        self.fixture.add_phase("aux_sentence", None, auxiliary=True)
        self.write()
        source, result = self.prepared()
        self.assertEqual(result["review_units"], 12)
        self.assertEqual(audit.verify_review(source, self.output, result["manifest_sha256"])["status"], "verified_pending_review")
        blind = list(audit.rows((self.output / "blind_inputs.jsonl").read_bytes()))
        requests = list(audit.rows((self.output / "review_requests.jsonl").read_bytes()))
        self.assertEqual(len(blind), 12)
        self.assertTrue(all(row["prefix"][-1]["role"] == "user" for row in blind))
        self.assertTrue(all("target" not in row for row in blind))
        self.assertTrue(all(row["decision"] is None and row["human_approved"] is False for row in requests))
        self.assertEqual((self.output.stat().st_mode & 0o777), 0o700)
        self.assertTrue(all((p.stat().st_mode & 0o777) == 0o600 for p in self.output.iterdir()))

    def test_empty_review_forms_cannot_be_promoted(self):
        source, result = self.prepared()
        pin = self.forge_review("review_requests.jsonl", lambda rows: rows[0].update(human_approved=True))
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, pin)

    def test_sample_only_review_cannot_claim_full_coverage_even_after_rehash(self):
        source, result = self.prepared()
        pin = self.forge_review("review_requests.jsonl", lambda rows: rows.pop())
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, pin)

    def test_duplicate_review_unit_is_rejected_after_rehash(self):
        source, result = self.prepared()
        pin = self.forge_review("review_requests.jsonl", lambda rows: rows.append(deepcopy(rows[0])))
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, pin)

    def test_changed_target_is_rejected_after_rehash(self):
        source, result = self.prepared()
        pin = self.forge_review("target_packets.jsonl", lambda rows: rows[0].update(target="An altered synthetic target"))
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, pin)

    def test_reviewer_identity_or_decision_is_never_generated_or_authenticated(self):
        source, result = self.prepared()
        pin = self.forge_review("review_requests.jsonl", lambda rows: rows[0].update(reviewer_id="not-a-real-reviewer", decision="approved"))
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, pin)

    def test_external_pin_and_file_inventory_are_required(self):
        source, result = self.prepared()
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, "0" * 64)
        (self.output / "extra.json").write_text("{}")
        with self.assertRaises(ValueError):
            audit.verify_review(source, self.output, result["manifest_sha256"])

    def test_source_mutation_after_capture_is_rejected_before_publication(self):
        source = self.source()
        path = self.root / "COURSE.json"
        previous = path.read_bytes()
        path.write_bytes(previous + b" ")
        path.write_bytes(previous)
        with self.assertRaises(ValueError):
            audit.write_review(source, self.output)
        self.assertFalse(self.output.exists())

    def test_mismatched_source_content_and_duplicate_index_are_rejected(self):
        path = self.root / "COURSE.json"
        path.write_bytes(path.read_bytes() + b" ")
        with self.assertRaises(ValueError):
            self.source()
        values = self.fixture.values(audit.SERVICE_PHASE, "train")
        values["indexes"][1]["row_id"] = values["indexes"][0]["row_id"]
        self.write()
        with self.assertRaises(ValueError):
            self.source()

    def test_source_cannot_self_promote_or_hide_duplicate_json_keys(self):
        path = self.root / "DATASET_MANIFEST.json"
        original = path.read_bytes()
        manifest = audit.parse(original)
        manifest["clinical_or_human_approval"] = True
        path.write_bytes(audit.encoded(manifest))
        with self.assertRaises(ValueError):
            self.source()
        path.write_bytes(original[:-2] + b',"clinical_or_human_approval":false}\n')
        with self.assertRaises(ValueError):
            self.source()

    def test_private_payloads_cannot_be_written_to_public_source_or_existing_paths(self):
        source, result = self.prepared()
        with self.assertRaises(ValueError):
            audit.write_review(source, self.output)
        with self.assertRaises(ValueError):
            audit.write_review(source, Path(__file__).resolve().parents[2] / "docs" / "not-private-review")
        with self.assertRaises(ValueError):
            audit.write_review(source, self.root / "review")

    def test_lexical_dot_paths_are_rejected_promptly_without_parent_walk_hang(self):
        repo = Path(__file__).resolve().parents[2]
        paths = [
            f"{repo.parent}/../{repo.parent.name}/{repo.name}/training_data/review_probe_only",
            f"{repo}/training_data/../training_data/review_probe_only",
            f"{repo}/training_data/./review_probe_only",
            "training_data/./review_probe_only",
        ]
        script = ("import sys; sys.path.insert(0, 'ai/scripts'); import audit_final_validation as a\n"
                  "try: a.private_destination(sys.argv[1])\n"
                  "except ValueError: print('rejected'); sys.exit(2)\n"
                  "print('unexpectedly accepted')\n")
        for path in paths:
            with self.subTest(path=path):
                result = subprocess.run([sys.executable, "-B", "-c", script, path], cwd=repo,
                                        capture_output=True, text=True, timeout=2)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout.strip(), "rejected")

    def test_review_cli_preserves_dot_components_for_path_rejection(self):
        repo = Path(__file__).resolve().parents[2]
        destination = str(self.output.parent) + "/./review"
        result = subprocess.run([sys.executable, "-B", str(Path(audit.__file__)), "prepare-review",
                                 "--root", str(self.root), "--review", destination],
                                cwd=repo, capture_output=True, text=True, timeout=3)
        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["status"], "rejected")
        self.assertFalse(self.output.exists())

    def test_inside_symlink_and_filesystem_root_are_rejected_but_normal_path_passes(self):
        target = self.output.parent / "actual"
        target.mkdir()
        link = self.output.parent / "alias"
        link.symlink_to(target, target_is_directory=True)
        for destination in (link / "review", Path("/")):
            with self.subTest(path=destination), self.assertRaises(ValueError):
                audit.private_destination(destination)
        self.assertEqual(audit.private_destination(self.output), self.output)

    def test_unicode_jsonl_roundtrip_and_whitespace_normalization(self):
        self.target("validation", 1, {"reason": "Synthetic\u2028line\u2029separator"})
        self.write()
        source, result = self.prepared()
        self.assertEqual(audit.verify_review(source, self.output, result["manifest_sha256"])["review_units"], 8)
        self.assertEqual(audit.normalize(" Ａ  B\nC "), "A B C")


if __name__ == "__main__":
    unittest.main()

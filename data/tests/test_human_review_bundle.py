"""Synthetic handoff integrity tests; no actual human approvals are fabricated."""
import copy
from contextlib import contextmanager, redirect_stderr, redirect_stdout
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from counseling_pipeline import human_review_bundle as bundle, agent_dataset as draft
from counseling_pipeline import agent_training as training, annotations, source_sft as source
from tests.test_agent_dataset import episode, review
from tests.test_agent_training import fixture


class HumanReviewBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.release = self.root / "release"
        episodes = [episode("one", "train"), episode("two", "validation")]
        draft.build_dataset(episodes, [review(row) for row in episodes], self.release)
        case = fixture()
        case.update(split="development", training_allowed=False)
        case["decision"] = {"primary_action": "ASK_CFI", "response_components": ["user_question"],
                            "question_id": "Q01", "question_need": "Synthetic decision-relevant reason"}
        case["resource_dependencies"] = [training.question_bank_dependency({"target"})]
        self.pending = self.root / "pending.jsonl"
        self.pending.write_bytes(bundle._jsonl([case]))
        self.contract = self.root / "contract.md"
        self.contract.write_text("Synthetic review contract; no clinical or human approval.\n")
        self.legacy = self.root / "legacy"
        self.legacy.mkdir()
        prefix = {"messages": [{"message_id": "u", "role": "user", "content": "Synthetic source context."}]}
        target = "Synthetic observed counselor response."
        queue = [{"id": "synthetic-queue", "status": "review_pending", "human_verified": False,
                  "training_allowed": False, "review": None, "prefix": prefix,
                  "prefix_sha256": annotations.digest(prefix), "target_response": target,
                  "target_sha256": source.sha_text(target)}]
        requests = [{"request_id": "synthetic-authoring", "status": "authoring_pending",
                     "training_allowed": False, "human_verified": False,
                     **dict.fromkeys(("prefix", "target_response", "author_id", "review"), None)}]
        payloads = {"source_review_queue.jsonl": bundle._jsonl(queue),
                    "agent_authoring_requests.jsonl": bundle._jsonl(requests),
                    "annotation_batch.jsonl": bundle._jsonl([{"offline_only": True}]),
                    "evaluation_history_events.jsonl": b"", "summary.json": b"{}\n",
                    "evaluation_history.json": b"{}\n"}
        for name, data in payloads.items():
            (self.legacy / name).write_bytes(data)
        self.legacy_manifest = {"status": "prepared_pending_review", "training_allowed": False,
            "actual_human_decisions": 0, "queue_rows": 1, "files": {
                name: {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data)} for name, data in payloads.items()}}
        source.dump_json(self.legacy / "manifest.json", self.legacy_manifest)
        self.inputs = dict(release=self.release, pending_cases=self.pending, legacy_review=self.legacy, contract=self.contract)
        self.output = self.root / "handoff"

    def build(self):
        return bundle.build(self.output, **self.inputs)

    def verify(self, **kwargs):
        return bundle.verify(self.output, **kwargs, **self.inputs)

    def rewrite_bundle_rows(self, name, update):
        rows = bundle._read(self.output / name)
        update(rows)
        content = bundle._jsonl(rows)
        (self.output / name).write_bytes(content)
        manifest = bundle._read(self.output / "manifest.json")
        manifest["files"][name] = {"sha256": hashlib.sha256(content).hexdigest(), "bytes": len(content)}
        source.dump_json(self.output / "manifest.json", manifest)

    def test_roundtrip_preserves_pending_units_and_distinct_denominators(self):
        result = self.build()
        self.assertEqual(result, self.verify(expected_manifest_sha256=result["manifest_sha256"]))
        self.assertEqual((result["supporter_episodes"], result["supporter_response_units"],
                          result["specialist_hold_units"], result["pending_review_units"]), (2, 4, 1, 5))
        self.assertEqual((result["existing_source_review_requests"], result["existing_authoring_requests"]), (1, 1))
        self.assertEqual(result["ai_review_records"], 2)
        self.assertEqual(result["distinct_declared_ai_reviewers"], 1)
        for row in bundle._read(self.output / "review_requests.jsonl"):
            self.assertFalse(row["human_approved"])
            self.assertFalse(row["training_authorized"])
            self.assertEqual(row["review_split"], "review_only")
            self.assertTrue(all(row[key] is None for key in ("reviewer_id", "decision", "rationale")))
            self.assertTrue(all(value is None for value in row["checks"].values()))

    def test_blind_first_response_has_no_target_annotation_or_future(self):
        self.build()
        blind = bundle._read(self.output / "blind_inputs.jsonl")
        targets = bundle._read(self.output / "target_packets.jsonl")
        first = blind[0]
        self.assertEqual(len(first["prefix"]["messages"]), 1)
        self.assertEqual(first["prefix"]["messages"][-1]["role"], "user")
        serialized = annotations.canonical(first)
        self.assertNotIn(targets[0]["target"]["response"], serialized)
        self.assertNotIn("target", first)
        self.assertNotIn("annotation", first)
        self.assertNotIn("저도 잠깐 쉬고 싶지만", serialized)
        self.assertEqual(first["review_unit_sha256"], targets[0]["review_unit_sha256"])

    def test_specialist_case_keeps_original_hash_and_development_hold(self):
        self.build()
        packet = bundle._read(self.output / "target_packets.jsonl")[-1]
        case = packet["target"]
        self.assertEqual(packet["source_binding"]["case_sha256"], training.case_hash(case))
        self.assertFalse(case["training_allowed"])
        self.assertEqual(case["split"], "development")
        self.assertIn("domain_expert", bundle._read(self.output / "review_requests.jsonl")[-1]["requirements"])
        self.assertEqual(training.audit([case])["eligible_count"], 0)

    def test_missing_payload_is_rejected(self):
        self.build()
        (self.output / "blind_inputs.jsonl").unlink()
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.verify()

    def test_duplicate_unit_is_rejected_even_after_rehash(self):
        self.build()
        self.rewrite_bundle_rows("review_requests.jsonl", lambda rows: rows.append(copy.deepcopy(rows[0])))
        with self.assertRaises(ValueError):
            self.verify()

    def test_changed_target_is_rejected_even_after_rehash(self):
        self.build()
        self.rewrite_bundle_rows("target_packets.jsonl", lambda rows: rows[0]["target"].update(response="Synthetic replacement"))
        with self.assertRaises(ValueError):
            self.verify()

    def test_forged_approval_or_identity_is_rejected_even_after_rehash(self):
        for change in ({"human_approved": True}, {"training_authorized": True},
                       {"reviewer_id": "fabricated-human", "decision": "approved"},
                       {"human_approved": 0}, {"review_split": "train"}):
            with self.subTest(change=change):
                output = self.root / ("handoff-" + str(len(list(self.root.iterdir()))))
                self.output = output
                self.build()
                self.rewrite_bundle_rows("review_requests.jsonl", lambda rows: rows[0].update(change))
                with self.assertRaises(ValueError):
                    self.verify()

    def test_forged_manifest_approval_is_rejected(self):
        self.build()
        manifest = bundle._read(self.output / "manifest.json")
        manifest.update(human_approved=1, training_authorized=True)
        source.dump_json(self.output / "manifest.json", manifest)
        with self.assertRaises(ValueError):
            self.verify()

    def test_changed_original_case_invalidates_unchanged_bundle(self):
        self.build()
        cases = bundle._read(self.pending)
        cases[0]["target_response"] += " Synthetic changed response."
        self.pending.write_bytes(bundle._jsonl(cases))
        with self.assertRaisesRegex(ValueError, "original input"):
            self.verify()

    def test_missing_original_contract_is_rejected(self):
        self.build()
        self.contract.unlink()
        with self.assertRaisesRegex(ValueError, "contract"):
            self.verify()

    def test_duplicate_specialist_case_is_rejected_before_writing(self):
        cases = bundle._read(self.pending)
        self.pending.write_bytes(bundle._jsonl(cases + cases))
        with self.assertRaisesRegex(ValueError, "duplicate source identity"):
            self.build()
        self.assertFalse(self.output.exists())

    def test_legacy_queue_content_tampering_is_rejected(self):
        self.build()
        path = self.legacy / "source_review_queue.jsonl"
        rows = bundle._read(path)
        rows[0]["target_response"] += " Changed"
        path.write_bytes(bundle._jsonl(rows))
        with self.assertRaisesRegex(ValueError, "legacy file hash"):
            self.verify()

    def test_duplicate_json_keys_are_rejected(self):
        self.build()
        path = self.output / "manifest.json"
        path.write_text('{"status":"forged",' + path.read_text()[1:])
        with self.assertRaisesRegex(ValueError, "duplicate JSON key"):
            self.verify()

    def test_extra_or_symlinked_bundle_payload_is_rejected(self):
        self.build()
        extra = self.output / "extra.json"
        extra.write_text("{}")
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.verify()
        extra.unlink()
        path = self.output / "review_contract.md"
        path.unlink()
        path.symlink_to(self.contract)
        with self.assertRaisesRegex(ValueError, "inventory"):
            self.verify()

    def test_existing_bundle_is_never_overwritten(self):
        self.build()
        before = source.sha_file(self.output / "manifest.json")
        with self.assertRaisesRegex(ValueError, "output exists"):
            self.build()
        self.assertEqual(source.sha_file(self.output / "manifest.json"), before)

    def test_pinned_manifest_refuses_another_digest(self):
        self.build()
        with self.assertRaisesRegex(ValueError, "pinned manifest"):
            self.verify(expected_manifest_sha256="0" * 64)

    @contextmanager
    def change_after_read(self, trigger, change):
        """Schedule a writer after a complete read, including streamed hashing."""
        original_open = Path.open
        fired = []

        @contextmanager
        def scheduled_open(path, mode="r", *args, **kwargs):
            with original_open(path, mode, *args, **kwargs) as stream:
                if path != trigger or mode != "rb":
                    yield stream
                    return

                class Reader:
                    def read(self, *read_args):
                        value = stream.read(*read_args)
                        if not fired and (not read_args or not value):
                            fired.append(True)
                            change()
                        return value

                    def fileno(self):
                        return stream.fileno()

                yield Reader()

        with patch.object(Path, "open", scheduled_open):
            yield fired

    def test_hr3_manifest_change_after_capture_rejected_and_restore_recovers(self):
        built = self.build()
        path = self.output / "manifest.json"
        original = path.read_bytes()
        payloads = {p.name: p.read_bytes() for p in self.output.iterdir() if p != path}

        def replace_same_bytes():
            replacement = self.root / "replacement.json"
            replacement.write_bytes(original)
            os.replace(replacement, path)

        for name, change in (("whitespace", lambda: path.write_bytes(b"\n" + original)),
                             ("identical-byte-replacement", replace_same_bytes)):
            with self.subTest(change=name):
                path.write_bytes(original)
                with self.change_after_read(path, change) as fired:
                    with self.assertRaises(ValueError):
                        self.verify(expected_manifest_sha256=built["manifest_sha256"])
                self.assertEqual(fired, [True], "the concurrent writer must actually run")
                self.assertEqual(payloads, {p.name: p.read_bytes() for p in self.output.iterdir() if p != path})
                path.write_bytes(original)
                self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)

    def test_hr3_manifest_change_during_payload_check_is_rejected(self):
        built = self.build()
        path = self.output / "manifest.json"
        original = path.read_bytes()
        with self.change_after_read(self.output / "review_contract.md",
                                    lambda: path.write_bytes(b"\n" + original)) as fired:
            with self.assertRaises(ValueError):
                self.verify(expected_manifest_sha256=built["manifest_sha256"])
        self.assertEqual(fired, [True])
        path.write_bytes(original)
        self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)

    def test_hr3_success_hash_is_of_captured_bytes_not_canonical_json(self):
        built = self.build()
        path = self.output / "manifest.json"
        path.write_bytes(b"\n" + path.read_bytes())
        changed_pin = source.sha_file(path)
        verified = self.verify(expected_manifest_sha256=changed_pin)
        self.assertTrue(verified["verified"])
        self.assertEqual(verified["manifest_sha256"], changed_pin)
        self.assertNotEqual(changed_pin, built["manifest_sha256"])
        with self.assertRaisesRegex(ValueError, "pinned manifest"):
            self.verify(expected_manifest_sha256=built["manifest_sha256"])

    def test_hr4_transitive_code_and_resource_changes_reject_old_pin_in_isolated_cli(self):
        # Copy executable code and synthetic fixtures only, never actual review data.
        data = self.root / "isolated" / "data"
        package, tests = data / "counseling_pipeline", data / "tests"
        package.mkdir(parents=True)
        tests.mkdir()
        (tests / "__init__.py").write_text("")
        for name in ("__init__.py", "human_review_bundle.py", "agent_dataset.py", "agent_training.py",
                     "annotations.py", "source_sft.py", "source_selection_audit.py"):
            shutil.copyfile(Path(bundle.__file__).parent / name, package / name)
        for name in ("test_human_review_bundle.py", "test_agent_dataset.py", "test_agent_training.py"):
            shutil.copyfile(Path(__file__).parent / name, tests / name)
        bank = data / "docs/support_agent/question_bank.json"
        bank.parent.mkdir(parents=True)
        bank.write_text(json.dumps({"version": "synthetic-hr4", "questions": []}))
        env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONPATH": str(data)}
        build_code = '''import json, tempfile
from pathlib import Path
from tests.test_human_review_bundle import HumanReviewBundleTests
tempfile.tempdir = str(Path.cwd())
t = HumanReviewBundleTests(); t.setUp()
t.pending.write_bytes(b"")
result = t.build()
Path("state.json").write_text(json.dumps({"inputs": {k:str(v) for k,v in t.inputs.items()},
    "output": str(t.output), "pin": result["manifest_sha256"]}))
t.temp._finalizer.detach()
'''
        built = subprocess.run([sys.executable, "-B", "-c", build_code], cwd=data.parent,
                               env=env, capture_output=True, text=True)
        self.assertEqual((built.returncode, built.stderr), (0, ""))
        state = json.loads((data.parent / "state.json").read_text())
        output = Path(state["output"])
        before = {p.name: p.read_bytes() for p in output.iterdir()}
        command = [sys.executable, "-B", "-m", "counseling_pipeline.human_review_bundle", "--verify",
                   "--output", str(output), "--expected-manifest-sha256", state["pin"]]
        for key, value in state["inputs"].items():
            command += ["--" + key.replace("_", "-"), value]

        def check(expected):
            run = subprocess.run(command, cwd=data.parent, env=env, capture_output=True, text=True)
            self.assertEqual((run.returncode, run.stderr), (expected, ""))
            result = json.loads(run.stdout)
            self.assertFalse(result["training_authorized"])
            self.assertEqual(result["human_approved"], 0)
            self.assertNotIn(str(self.root), run.stdout)
            if expected == 0:
                self.assertTrue(result["verified"])
                self.assertEqual(result["manifest_sha256"], state["pin"])
            else:
                self.assertEqual(result["status"], "invalid")
            self.assertEqual({p.name: p.read_bytes() for p in output.iterdir()}, before)

        check(0)
        dependency = package / "source_selection_audit.py"
        original = dependency.read_text()
        needle = 'return " ".join(unicodedata.normalize("NFKC", text).split())'
        self.assertEqual(original.count(needle), 1)
        mutations = [(dependency, original.replace(needle, "return text")),
                     (package / "__init__.py", '__version__ = "synthetic-changed"\n'),
                     (bank, json.dumps({"version": "synthetic-hr4", "questions": [
                         {"canonical_question": "Unmatched synthetic resource sentence."}]}))]
        for path, changed in mutations:
            with self.subTest(dependency=path.name):
                saved = path.read_bytes()
                try:
                    path.write_text(changed)
                    check(2)
                finally:
                    path.write_bytes(saved)
                check(0)

    def test_hr4_question_bank_shapes_keep_generic_error_and_restore_contract(self):
        bank = self.root / "question_bank.json"
        original = {"version": "synthetic-shape-v1", "questions": []}
        original_bytes = bundle._encoded(original)
        bank.write_bytes(original_bytes)
        self.pending.write_bytes(b"")
        invalid = [
            {"questions": []},
            *[{"version": value, "questions": []} for value in (None, "", 1)],
            {"version": "synthetic-shape-v1"},
            *[{**original, "questions": value} for value in (None, {}, "SYNTHETIC_PRIVATE_MARKER",
                [None], ["SYNTHETIC_PRIVATE_MARKER"], [{"canonical_question": 7}], [{"supporting_text": None}])],
        ]
        with patch.object(training, "QUESTION_BANK_PATH", bank):
            built = self.build()
            before = {p.name: p.read_bytes() for p in self.output.iterdir()}
            command = ["human_review_bundle", "--verify", "--output", str(self.output),
                       "--expected-manifest-sha256", built["manifest_sha256"]]
            for key, value in self.inputs.items():
                command += ["--" + key.replace("_", "-"), str(value)]
            for index, malformed in enumerate(invalid):
                with self.subTest(shape=index):
                    try:
                        bank.write_bytes(bundle._encoded(malformed))
                        stdout, stderr = io.StringIO(), io.StringIO()
                        with patch.object(sys, "argv", command), redirect_stdout(stdout), redirect_stderr(stderr):
                            self.assertEqual(bundle.main(), 2)
                        result = json.loads(stdout.getvalue())
                        self.assertEqual(result["status"], "invalid")
                        self.assertFalse(result["training_authorized"])
                        self.assertEqual(result["human_approved"], 0)
                        self.assertEqual(stderr.getvalue(), "")
                        self.assertNotIn("SYNTHETIC_PRIVATE_MARKER", stdout.getvalue())
                        self.assertNotIn(str(self.root), stdout.getvalue())
                        self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()}, before)
                    finally:
                        bank.write_bytes(original_bytes)
                        self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)

    def test_input_change_before_publication_leaves_no_bundle(self):
        original = bundle._verify
        def change_after_verification(*args, **kwargs):
            result = original(*args, **kwargs)
            self.contract.write_text("Synthetic concurrently updated contract")
            return result
        with patch.object(bundle, "_verify", side_effect=change_after_verification):
            with self.assertRaisesRegex(ValueError, "changed before publication"):
                self.build()
        self.assertFalse(self.output.exists())

    @contextmanager
    def substitute_second_binary_read(self, path, replacement):
        """Write B for a real read, then restore A; never fake hash/parser output."""
        original_open = Path.open
        original = path.read_bytes()
        reads, fired = [], []

        @contextmanager
        def scheduled_open(candidate, mode="r", *args, **kwargs):
            substitute = False
            if candidate == path and mode == "rb":
                reads.append(True)
                substitute = len(reads) == 2
            if substitute:
                with original_open(path, "wb") as writer:
                    writer.write(replacement)
                fired.append(True)
            try:
                with original_open(candidate, mode, *args, **kwargs) as reader:
                    yield reader
            finally:
                if substitute:
                    with original_open(path, "wb") as writer:
                        writer.write(original)

        with patch.object(Path, "open", scheduled_open):
            yield fired
        self.assertEqual(path.read_bytes(), original)

    @contextmanager
    def substitute_during_call(self, module, name, path, replacement):
        """Keep captured A on disk except while the actual consumer executes."""
        original = path.read_bytes()
        consumer = getattr(module, name)
        fired = []

        def consume(*args, **kwargs):
            path.write_bytes(replacement)
            fired.append(True)
            try:
                return consumer(*args, **kwargs)
            finally:
                path.write_bytes(original)

        with patch.object(module, name, side_effect=consume):
            yield fired
        self.assertEqual(path.read_bytes(), original)

    def test_hr5_pending_and_contract_read_substitution_cannot_publish_unbound_bytes(self):
        original_cases = bundle._read(self.pending)
        changed_cases = copy.deepcopy(original_cases)
        changed_cases[0]["target_response"] += " Synthetic transient replacement."
        for name, path, replacement in (
            ("pending", self.pending, bundle._jsonl(changed_cases)),
            ("contract", self.contract, b"Synthetic transient contract replacement.\n"),
        ):
            with self.subTest(input=name):
                self.output = self.root / ("transient-" + name)
                original = path.read_bytes()
                with self.substitute_second_binary_read(path, replacement) as fired:
                    try:
                        built = self.build()
                    except ValueError:
                        self.assertFalse(self.output.exists())
                        built = None
                self.assertEqual(fired, [True], "the A -> B -> A writer must execute")
                self.assertEqual(path.read_bytes(), original)
                if built is not None:
                    manifest = bundle._read(self.output / "manifest.json")
                    self.assertEqual(manifest["inputs"][str(path.resolve())], {
                        "sha256": hashlib.sha256(original).hexdigest(), "bytes": len(original)})
                    self.assertEqual(bundle._read(self.output / "target_packets.jsonl")[-1]["target"],
                                     original_cases[0])
                    self.assertEqual((self.output / "review_contract.md").read_bytes(), self.contract.read_bytes())
                    self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)
                else:
                    # Restoring the input must leave the ordinary pinned roundtrip usable.
                    built = self.build()
                    self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)

    def test_hr5_release_validation_cannot_reread_a_different_valid_release(self):
        paths = sorted(self.release.rglob("*.jsonl")) + [self.release / "manifest.json"]
        for index, path in enumerate(paths):
            with self.subTest(input=path.relative_to(self.release)):
                self.output = self.root / ("release-substitution-" + str(index))
                valid = path.read_bytes()
                if path.name == "manifest.json":
                    invalid = json.loads(valid)
                    invalid["counts"]["conversation"]["train"] += 1
                    captured = bundle._encoded(invalid)
                else:
                    # Valid JSONL, but these bytes disagree with the release ledger.
                    captured = b"\n" + valid
                try:
                    path.write_bytes(captured)
                    with self.assertRaises(ValueError):
                        self.build()
                    with self.substitute_during_call(draft, "audit_release", path, valid) as fired:
                        with self.assertRaises(ValueError):
                            self.build()
                    self.assertTrue(fired, "the release-validator writer must execute")
                    self.assertFalse(self.output.exists())
                finally:
                    path.write_bytes(valid)

    def test_hr5_question_bank_detection_must_use_the_captured_resource(self):
        bank = self.root / "question_bank.json"
        cases = bundle._read(self.pending)
        phrase = cases[0]["prefix"]["messages"][0]["content"]
        captured = bundle._encoded({"version": "synthetic-hr5", "questions": [
            {"canonical_question": phrase, "supporting_text": ""}]})
        substitute = bundle._encoded({"version": "synthetic-hr5", "questions": []})
        bank.write_bytes(captured)
        with patch.object(training, "QUESTION_BANK_PATH", bank):
            # The captured resource requires a prefix declaration that is absent.
            cases[0]["resource_dependencies"] = [training.question_bank_dependency({"target"})]
            self.pending.write_bytes(bundle._jsonl(cases))
            with self.assertRaisesRegex(ValueError, "usage location"):
                self.build()
            with self.substitute_during_call(training, "detected_question_bank_usage", bank, substitute) as fired:
                with self.assertRaises(ValueError):
                    self.build()
            self.assertTrue(fired, "the question-bank writer must execute")
            self.assertFalse(self.output.exists())

    def test_hr5_legacy_validation_and_references_must_use_captured_bytes(self):
        for index, name in enumerate(sorted(bundle.LEGACY_FILES | {"manifest.json"})):
            with self.subTest(input=name):
                self.output = self.root / ("legacy-substitution-" + str(index))
                path = self.legacy / name
                valid = path.read_bytes()
                if name == "manifest.json":
                    invalid = json.loads(valid)
                    invalid["queue_rows"] += 1
                    captured = bundle._encoded(invalid)
                else:
                    captured = b"\n" + valid
                try:
                    path.write_bytes(captured)
                    with self.assertRaises(ValueError):
                        self.build()
                    with self.substitute_during_call(bundle, "_legacy", path, valid) as fired:
                        with self.assertRaises(ValueError):
                            self.build()
                    self.assertTrue(fired, "the legacy-input writer must execute")
                    self.assertFalse(self.output.exists())
                finally:
                    path.write_bytes(valid)

    def test_hr5_persistent_pending_change_rejects_and_restoration_recovers(self):
        original = self.pending.read_bytes()
        cases = bundle._read(self.pending)
        cases[0]["target_response"] += " Synthetic persistent replacement."
        replacement = bundle._jsonl(cases)
        with self.change_after_read(self.pending, lambda: self.pending.write_bytes(replacement)) as fired:
            with self.assertRaises(ValueError):
                self.build()
        self.assertEqual(fired, [True])
        self.assertEqual(self.pending.read_bytes(), replacement)
        self.assertFalse(self.output.exists())
        self.pending.write_bytes(original)
        built = self.build()
        self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)

    def test_hr5_verify_rechecks_inputs_after_bundle_validation(self):
        built = self.build()
        payloads = {path.name: path.read_bytes() for path in self.output.iterdir()}
        original_verify = bundle._verify
        for path in (self.pending, self.contract):
            with self.subTest(input=path.name):
                original = path.read_bytes()
                fired = []

                def change_after_verification(*args, **kwargs):
                    result = original_verify(*args, **kwargs)
                    path.write_bytes(original + b"\n")
                    fired.append(True)
                    return result

                try:
                    with patch.object(bundle, "_verify", side_effect=change_after_verification):
                        with self.assertRaises(ValueError):
                            self.verify(expected_manifest_sha256=built["manifest_sha256"])
                    self.assertEqual(fired, [True])
                    self.assertEqual(path.read_bytes(), original + b"\n")
                    self.assertEqual({file.name: file.read_bytes() for file in self.output.iterdir()}, payloads)
                finally:
                    path.write_bytes(original)
                self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)
                self.assertEqual({file.name: file.read_bytes() for file in self.output.iterdir()}, payloads)

    def test_hr6_unicode_jsonl_roundtrips_raw_escaped_lf_and_crlf(self):
        cases = bundle._read(self.pending)
        for character in ("\u2028", "\u2029"):
            for escaped in (False, True):
                for newline in ("\n", "\r\n"):
                    with self.subTest(codepoint=ord(character), escaped=escaped, newline=repr(newline)):
                        self.output = self.root / f"unicode-{ord(character)}-{escaped}-{len(newline)}"
                        cases[0]["decision"]["question_need"] = "Synthetic before" + character + "after."
                        training.validate_case(cases[0])
                        # Empty records were already accepted; preserve that policy for CRLF too.
                        encoded = json.dumps(cases[0], ensure_ascii=escaped)
                        self.pending.write_bytes((newline + encoded + newline + newline).encode("utf-8"))
                        self.assertEqual(bundle._read(self.pending), cases)
                        built = self.build()
                        self.assertEqual(bundle._read(self.output / "target_packets.jsonl")[-1]["target"], cases[0])
                        self.assertEqual(self.verify(expected_manifest_sha256=built["manifest_sha256"]), built)

    def test_hr6_whitespace_only_jsonl_records_remain_invalid(self):
        cases = bundle._read(self.pending)
        for newline in (b"\n", b"\r\n"):
            with self.subTest(newline=newline):
                self.pending.write_bytes(b" \t" + newline + bundle._jsonl(cases))
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse(self.output.exists())

    def test_cli_failure_does_not_echo_private_parser_values(self):
        self.build()
        marker = "SYNTHETIC_PRIVATE_MARKER"
        self.pending.write_text('{"' + marker + '": invalid}\n')
        command = [sys.executable, "-B", "-m", "counseling_pipeline.human_review_bundle", "--verify", "--output", str(self.output)]
        for key, value in self.inputs.items():
            command += ["--" + key.replace("_", "-"), str(value)]
        completed = subprocess.run(command, text=True, capture_output=True, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(completed.returncode, 2)
        self.assertNotIn(marker, completed.stdout + completed.stderr)
        self.assertEqual(completed.stderr, "")
        self.assertEqual(json.loads(completed.stdout)["human_approved"], 0)

    def assert_cli_invalid_without_traceback(self, *, verify=False):
        command = [sys.executable, "-B", "-m", "counseling_pipeline.human_review_bundle", "--output", str(self.output)]
        if verify:
            command.append("--verify")
        for key, value in self.inputs.items():
            command += ["--" + key.replace("_", "-"), str(value)]
        completed = subprocess.run(command, text=True, capture_output=True,
                                   env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(completed.returncode, 2)
        self.assertEqual(completed.stderr, "")
        self.assertEqual(json.loads(completed.stdout)["status"], "invalid")
        self.assertFalse(json.loads(completed.stdout)["training_authorized"])
        self.assertEqual(json.loads(completed.stdout)["human_approved"], 0)
        for hidden in ("SYNTHETIC_PRIVATE_MARKER", str(self.root)):
            self.assertNotIn(hidden, completed.stdout + completed.stderr)
        if not verify:
            self.assertFalse(self.output.exists())

    def test_hr2_cli_release_file_metadata_types_fail_before_building(self):
        path = self.release / "manifest.json"
        original = bundle._read(path)
        for value in ([], None, "SYNTHETIC_PRIVATE_MARKER"):
            with self.subTest(value_type=type(value).__name__):
                manifest = copy.deepcopy(original)
                manifest["files"]["episodes.jsonl"] = value
                source.dump_json(path, manifest)
                self.assert_cli_invalid_without_traceback()
        source.dump_json(path, original)
        self.assertFalse(self.build()["training_authorized"])

    def test_hr2_cli_verify_failure_preserves_existing_bundle_and_recovers_after_restore(self):
        built = self.build()
        before = {p.name: p.read_bytes() for p in self.output.iterdir()}
        path = self.release / "manifest.json"
        original_bytes = path.read_bytes()
        original = bundle._read(path)
        for value in ([], None, "SYNTHETIC_PRIVATE_MARKER"):
            with self.subTest(value_type=type(value).__name__):
                manifest = copy.deepcopy(original)
                manifest["files"]["episodes.jsonl"] = value
                source.dump_json(path, manifest)
                self.assert_cli_invalid_without_traceback(verify=True)
                self.assertEqual({p.name: p.read_bytes() for p in self.output.iterdir()}, before)
        path.write_bytes(original_bytes)
        verified = self.verify(expected_manifest_sha256=built["manifest_sha256"])
        self.assertTrue(verified["verified"])
        self.assertFalse(verified["training_authorized"])

    def rehash_legacy(self, name):
        path = self.legacy / name
        self.legacy_manifest["files"][name] = {"sha256": source.sha_file(path), "bytes": path.stat().st_size}
        source.dump_json(self.legacy / "manifest.json", self.legacy_manifest)

    def test_cli_nonobject_pending_jsonl_rows_fail_with_generic_json(self):
        for value in ([], None, True, 7, "SYNTHETIC_PRIVATE_MARKER"):
            with self.subTest(value_type=type(value).__name__):
                self.pending.write_bytes(bundle._jsonl([value]))
                self.assert_cli_invalid_without_traceback()

    def test_cli_pending_nested_container_shapes_fail_closed(self):
        original = bundle._read(self.pending)
        for field in ("prefix", "annotation_provenance", "decision"):
            with self.subTest(field=field):
                cases = copy.deepcopy(original)
                cases[0][field] = []
                self.pending.write_bytes(bundle._jsonl(cases))
                self.assert_cli_invalid_without_traceback()
        for messages in ({}, [None]):
            with self.subTest(messages_type=type(messages).__name__):
                cases = copy.deepcopy(original)
                cases[0]["prefix"]["messages"] = messages
                self.pending.write_bytes(bundle._jsonl(cases))
                self.assert_cli_invalid_without_traceback()

    def test_cli_legacy_manifest_container_shapes_fail_closed(self):
        for value in ([], None, "SYNTHETIC_PRIVATE_MARKER",
                      {**self.legacy_manifest, "files": sorted(bundle.LEGACY_FILES)},
                      {**self.legacy_manifest, "files": {name: [] for name in bundle.LEGACY_FILES}}):
            with self.subTest(value_type=type(value).__name__):
                source.dump_json(self.legacy / "manifest.json", value)
                self.assert_cli_invalid_without_traceback()

    def test_cli_legacy_rows_and_prefix_shapes_fail_closed_after_rehash(self):
        for name in ("source_review_queue.jsonl", "agent_authoring_requests.jsonl", "annotation_batch.jsonl"):
            path = self.legacy / name
            original = path.read_bytes()
            with self.subTest(name=name):
                path.write_bytes(bundle._jsonl([[]]))
                self.rehash_legacy(name)
                self.assert_cli_invalid_without_traceback()
            path.write_bytes(original)
            self.rehash_legacy(name)
        path = self.legacy / "source_review_queue.jsonl"
        original = bundle._read(path)
        for field in ("prefix", "target_response"):
            with self.subTest(field=field):
                rows = copy.deepcopy(original)
                rows[0][field] = []
                if field == "prefix":
                    rows[0]["prefix_sha256"] = annotations.digest([])
                path.write_bytes(bundle._jsonl(rows))
                self.rehash_legacy(path.name)
                self.assert_cli_invalid_without_traceback()


if __name__ == "__main__":
    unittest.main()

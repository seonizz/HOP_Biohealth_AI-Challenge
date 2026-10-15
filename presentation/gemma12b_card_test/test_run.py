"""Offline contract and workflow tests; no model calls."""

import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import run
import assemble


class CardWorkflowTests(unittest.TestCase):
    def setUp(self):
        # Fake transports must never wait on a live model's cross-process lock.
        inference = patch.object(run, "inference_call", side_effect=lambda args, request:
                                 run.api_call(args.base_url, "/api/chat", args.timeout, request))
        inference.start()
        self.addCleanup(inference.stop)

    @classmethod
    def setUpClass(cls):
        cls.case = run.read_json(run.ROOT / "cases" / "jimin.json")
        cls.ids = run.validate_case(cls.case)
        cls.references = {c["section"]: c for c in run.read_json(run.ROOT / "reference" / "cards.json")["cards"]}

    def test_source_answers_and_reference_contract(self):
        self.assertEqual(self.ids, [f"q{i:02d}" for i in range(1, 30)])
        self.assertEqual(set(self.references), set(run.SECTIONS))
        for section, card in self.references.items():
            run.validate_card(card, section, "reference", self.ids)

    def test_duplicate_evidence_id_in_case_is_rejected(self):
        case = copy.deepcopy(self.case)
        case["answers"][1]["id"] = case["answers"][0]["id"]
        with self.assertRaises(ValueError):
            run.validate_case(case)

    def test_wrong_section_unknown_evidence_and_extra_fields_are_rejected(self):
        for update in ({"section": "next"}, {"evidence_ids": ["q99"]}, {"invented": "value"}):
            card = copy.deepcopy(self.references["caregiver"])
            card.update(update)
            with self.assertRaises(ValueError):
                run.validate_card(card, "caregiver", "reference", self.ids)

    def test_partial_empty_and_repeated_paragraphs_are_rejected(self):
        for paragraphs in (["one"], ["", "two"], ["same", "same"]):
            card = copy.deepcopy(self.references["caregiver"])
            card["paragraphs"] = paragraphs
            with self.assertRaises(ValueError):
                run.validate_card(card, "caregiver", "reference", self.ids)

    def test_truncated_generation_is_not_accepted_as_finished_json(self):
        response = {"done": True, "done_reason": "length", "message": {"content": "{}"}}
        with self.assertRaises(ValueError):
            run.parse_response(response)

    def test_thinking_is_never_used_as_final_content(self):
        response = {"done": True, "done_reason": "stop", "message": {"content": "", "thinking": "{\"section\":\"caregiver\"}"}}
        with self.assertRaises(ValueError):
            run.parse_response(response)

    def test_html_escapes_case_output(self):
        card = copy.deepcopy(self.references["caregiver"])
        card["paragraphs"] = ["<script>alert(1)</script>", "A & B"]
        rendered = run.render_card(card)
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("A &amp; B", rendered)

    def test_dry_run_has_five_isolated_requests_without_api(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "dry"
            with patch.object(run, "api_call", side_effect=AssertionError("API must not be called")):
                self.assertEqual(run.main(["--dry-run", "--out", str(out)]), 0)
            manifest = run.read_json(out / "manifest.json")
            self.assertEqual(manifest["status"], "dry_run")
            self.assertTrue(manifest["all_five_selected"])
            for section in run.SECTIONS:
                request = run.read_json(out / "requests" / f"{section}.json")
                self.assertEqual([m["role"] for m in request["messages"]], ["system", "user"])
                self.assertEqual(request["format"]["properties"]["section"]["enum"], [section])
                self.assertFalse(request["think"])
                self.assertIn("q29", request["messages"][1]["content"])
                self.assertEqual(request["options"]["num_predict"], 16384)
                self.assertEqual(request["options"]["num_ctx"], 32768)

    def fake_api(self, base_url, path, timeout, payload=None):
        if path == "/api/tags":
            return {"models": [{"name": "gemma4:12b", "digest": "test-only"}]}
        if path == "/api/show":
            return {"thinking": {"values": [False, True]}}
        section = payload["format"]["properties"]["section"]["enum"][0]
        return {"done": True, "done_reason": "stop", "message": {"content": run.json.dumps(self.references[section], ensure_ascii=False)}, "eval_count": 50}

    def test_successful_workflow_writes_all_five_and_comparison(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "success"
            with patch.object(run, "api_call", side_effect=self.fake_api):
                self.assertEqual(run.main(["--detail", "reference", "--out", str(out)]), 0)
            manifest = run.read_json(out / "manifest.json")
            self.assertEqual(manifest["status"], "completed")
            self.assertEqual(len(manifest["calls"]), 10)
            self.assertEqual(len(run.read_json(out / "result.json")["cards"]), 5)
            self.assertTrue((out / "comparison.html").is_file())

    def test_invalid_card_is_repaired_locally(self):
        calls = []

        def fake(base_url, path, timeout, payload=None):
            if path == "/api/chat":
                calls.append(payload)
                if len(calls) == 1:
                    return {"done": True, "done_reason": "stop", "message": {"content": "not JSON"}}
            return self.fake_api(base_url, path, timeout, payload)

        with tempfile.TemporaryDirectory() as directory:
            with patch.object(run, "api_call", side_effect=fake):
                self.assertEqual(run.main(["--detail", "reference", "--passes", "1", "--card", "caregiver", "--out", str(Path(directory) / "repair")]), 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(len(calls[0]["messages"]), 2)
        self.assertEqual(len(calls[1]["messages"]), 4)

    def test_transport_failure_preserves_manifest_and_no_completed_report(self):
        def fake(base_url, path, timeout, payload=None):
            if path == "/api/chat":
                raise RuntimeError("test offline")
            return self.fake_api(base_url, path, timeout, payload)

        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "failed"
            with patch.object(run, "api_call", side_effect=fake):
                self.assertEqual(run.main(["--detail", "reference", "--out", str(out)]), 1)
            self.assertEqual(run.read_json(out / "manifest.json")["status"], "failed")
            self.assertFalse((out / "comparison.html").exists())
            self.assertTrue((out / "requests" / "caregiver.pass1.attempt1.json").exists())

    def test_extended_minimum_length_is_enforced(self):
        card = copy.deepcopy(self.references["caregiver"])
        card["paragraphs"] = [f"짧은 문단 {i}" for i in range(4)]
        with self.assertRaisesRegex(ValueError, "최소 1200자"):
            run.validate_card(card, "caregiver", "extended", self.ids)

    def test_evidence_ids_are_rejected_in_reader_facing_prose(self):
        for section in ("caregiver", "avoid"):
            card = copy.deepcopy(self.references[section])
            if section == "caregiver":
                card["paragraphs"][0] += " q23에서 확인했어요."
            else:
                card["items"][0]["instead"] += " (q13)"
            with self.assertRaisesRegex(ValueError, "근거 번호"):
                run.validate_card(card, section, "reference", self.ids)

    def test_evidence_normalization_preserves_prose_and_raw_object(self):
        card = copy.deepcopy(self.references["caregiver"])
        original_ids = card["evidence_ids"] + card["evidence_ids"][:1]
        card["evidence_ids"] = original_ids
        normalized, changes = run.normalize_evidence_ids(card)
        self.assertEqual(card["evidence_ids"], original_ids)
        self.assertEqual(normalized["paragraphs"], card["paragraphs"])
        self.assertEqual(changes, ["deduplicated_evidence_ids"])
        run.validate_card(normalized, "caregiver", "reference", self.ids)

    def test_normalization_does_not_hide_unknown_evidence(self):
        card = copy.deepcopy(self.references["caregiver"])
        card["evidence_ids"] = ["q99", "q99"]
        normalized, _ = run.normalize_evidence_ids(card)
        with self.assertRaises(ValueError):
            run.validate_card(normalized, "caregiver", "reference", self.ids)

    def test_interrupt_is_preserved_without_completed_report(self):
        def fake(base_url, path, timeout, payload=None):
            if path == "/api/chat":
                raise KeyboardInterrupt
            return self.fake_api(base_url, path, timeout, payload)

        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "interrupt"
            with patch.object(run, "api_call", side_effect=fake):
                self.assertEqual(run.main(["--out", str(out)]), 130)
            self.assertEqual(run.read_json(out / "manifest.json")["status"], "interrupted")
            self.assertFalse((out / "comparison.html").exists())

    def make_saved_run(self, path, sections=None, changed_case=False, changed_card=False, status="completed"):
        path.mkdir()
        (path / "cards").mkdir()
        case = copy.deepcopy(self.case)
        if changed_case:
            case["case_id"] = "other"
        cards = [copy.deepcopy(self.references[s]) for s in (sections or run.SECTIONS)]
        if changed_card:
            cards[0]["paragraphs"][0] += " 다음 실행의 출력."
        run.write_json(path / "case.json", case)
        run.write_json(path / "reference.json", {"cards": list(self.references.values())})
        run.write_json(path / "manifest.json", {"status": status, "model": "gemma4:12b", "installed_model": {"digest": "test"}, "detail": "reference"})
        run.write_json(path / "result.json", {"cards": cards})
        for card in cards:
            run.write_json(path / "cards" / f"{card['section']}.json", card)

    def test_assembly_uses_later_card_without_changing_sources(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.make_saved_run(base / "first")
            self.make_saved_run(base / "later", ["caregiver"], changed_card=True)
            out = assemble.assemble([base / "first", base / "later"], base / "merged")
            cards = run.read_json(out / "result.json")["cards"]
            self.assertEqual(len(cards), 5)
            self.assertTrue(cards[0]["paragraphs"][0].endswith("다음 실행의 출력."))
            original = run.read_json(base / "first" / "cards" / "caregiver.json")
            self.assertEqual(original, self.references["caregiver"])
            manifest = run.read_json(out / "manifest.json")
            self.assertIn("later", manifest["source_cards"]["caregiver"])

    def test_assembly_rejects_different_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.make_saved_run(base / "first")
            self.make_saved_run(base / "other", changed_case=True)
            with self.assertRaises(ValueError):
                assemble.assemble([base / "first", base / "other"], base / "merged")
            self.assertFalse((base / "merged").exists())

    def test_assembly_checks_selected_cards_after_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.make_saved_run(base / "first")
            result = run.read_json(base / "first" / "result.json")
            result["cards"][0]["paragraphs"][0] += " (q23)"
            run.write_json(base / "first" / "result.json", result)
            run.write_json(base / "first" / "cards" / "caregiver.json", result["cards"][0])
            with self.assertRaisesRegex(ValueError, "근거 번호"):
                assemble.assemble([base / "first"], base / "invalid")
            self.make_saved_run(base / "later", ["caregiver"])
            out = assemble.assemble([base / "first", base / "later"], base / "merged")
            self.assertEqual(run.read_json(out / "result.json")["cards"][0], self.references["caregiver"])

    def test_assembly_requires_five_cards_and_completed_runs(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.make_saved_run(base / "partial", ["caregiver"])
            self.make_saved_run(base / "running", status="running")
            for name in ("partial", "running"):
                with self.assertRaises(ValueError):
                    assemble.assemble([base / name], base / "merged")

    def test_assembly_rejects_mismatched_provenance_card(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.make_saved_run(base / "first")
            card_path = base / "first" / "cards" / "caregiver.json"
            run.write_json(card_path, {})
            with self.assertRaises(ValueError):
                assemble.assemble([base / "first"], base / "merged")

    def test_partial_recovery_requires_explicit_flag_and_preserves_source_status(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            self.make_saved_run(base / "failed", status="failed")
            (base / "failed" / "result.json").unlink()
            out = assemble.assemble([base / "failed"], base / "merged", include_partial=True)
            self.assertEqual(len(run.read_json(out / "result.json")["cards"]), 5)
            self.assertEqual(run.read_json(base / "failed" / "manifest.json")["status"], "failed")


if __name__ == "__main__":
    unittest.main()

import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import ubuntu_controlled_service as service


class ControlledServiceTests(unittest.TestCase):
    def test_direct_greedy_stop_cap_timeout_and_partial_failure(self):
        tokens = []
        self.assertEqual(service.greedy_loop(lambda _: 106, 4, [106], lambda: False, tokens), "stop")
        self.assertEqual(tokens, [106])
        tokens = []
        self.assertEqual(service.greedy_loop(lambda _: 7, 3, [106], lambda: False, tokens), "length")
        self.assertEqual(tokens, [7, 7, 7])
        tokens = []
        self.assertEqual(service.greedy_loop(lambda _: 7, 3, [106], lambda: True, tokens), "timeout")
        self.assertEqual(tokens, [])
        def fail_after_one(tokens):
            if tokens:
                raise RuntimeError("CUDA error")
            return 8
        with self.assertRaises(RuntimeError):
            service.greedy_loop(fail_after_one, 4, [106], lambda: False, tokens)
        self.assertEqual(tokens, [8])

    def test_generation_config_contract(self):
        config = types.SimpleNamespace(eos_token_id=[1, 106, 50], suppress_tokens=[258883, 258882])
        self.assertEqual(service.decode_contract(config)[0], [1, 106, 50])
        config.repetition_penalty = 1.1
        with self.assertRaisesRegex(RuntimeError, "processor"):
            service.decode_contract(config)

    def test_forward_cache_full_prefill_then_one_token_grown_mask_and_suppression(self):
        class Scores:
            def __init__(self, values):
                self.values = list(values)
            def __getitem__(self, _):
                return self
            def float(self):
                return self
            def clone(self):
                return Scores(self.values)
            def __setitem__(self, key, value):
                for i in key[1]:
                    self.values[i] = value
            def argmax(self, _):
                return types.SimpleNamespace(item=lambda: max(range(len(self.values)), key=self.values.__getitem__))
        class Torch:
            long = "long"
            @staticmethod
            def tensor(values, **kwargs):
                return values
            @staticmethod
            def ones(shape, **kwargs):
                return shape
            @staticmethod
            def isfinite(scores):
                flags = [value not in (float("inf"), -float("inf")) for value in scores.values]
                return types.SimpleNamespace(all=lambda: all(flags), any=lambda: any(flags))
        calls, caches = [], []
        def cache_factory():
            cache = {"length": 0}
            caches.append(cache)
            return cache
        def model(**kwargs):
            calls.append(kwargs)
            cache = kwargs["past_key_values"]
            if cache is not None:
                cache["length"] += len(kwargs["input_ids"][0])
            return types.SimpleNamespace(logits=Scores([0, 3, 1, 0, 99]), past_key_values=cache)
        options = {"FORCE_USE_FLEX_ATTENTION": True}
        step = service.forward_stepper(model, [8, 9], Torch, options, [4], cache_factory)
        tokens = []
        service.greedy_loop(step, 3, [2], lambda: False, tokens)
        self.assertEqual(tokens, [1, 1, 1])  # suppressed token 4 had maximum raw logit
        self.assertEqual([call["input_ids"] for call in calls], [[[8, 9]], [[1]], [[1]]])
        self.assertEqual([call["attention_mask"] for call in calls], [(1, 2), (1, 3), (1, 4)])
        self.assertTrue(all(call["past_key_values"] is caches[0] for call in calls))
        self.assertTrue(all(call["kernel_options"] is options and call["use_cache"] and call["logits_to_keep"] == 1 for call in calls))
        service.forward_stepper(model, [8, 9], Torch, options, [4], cache_factory)
        self.assertIsNot(caches[0], caches[1])
        calls.clear()
        uncached = service.forward_stepper(model, [8, 9], Torch, options, [4], cache_factory, use_cache=False)
        service.greedy_loop(uncached, 2, [2], lambda: False, [])
        self.assertEqual([call["input_ids"] for call in calls], [[[8, 9]], [[8, 9, 1]]])
        self.assertTrue(all(call["past_key_values"] is None and not call["use_cache"] for call in calls))

    def payload(self):
        return {"model": "baseline", "messages": [{"role": "user", "content": "synthetic"}],
                "temperature": 0, "seed": 3407, "max_tokens": 1024}

    def test_frozen_transport_validation(self):
        service.validate_payload(self.payload(), True)
        for field, value in (("response_format", {"type": "json_object"}), ("stream", True),
                             ("temperature", .1), ("seed", 42), ("max_tokens", 1025)):
            with self.assertRaises(service.RequestError):
                service.validate_payload({**self.payload(), field: value}, True)

    def test_720_fixed_fatal_single_dispatch_and_pending_denominator(self):
        assignments = [{"model": "baseline", "request_id": str(i), "request": self.payload()} for i in range(720)]
        called = []
        def generate(*args, **kwargs):
            called.append(args)
            raise RuntimeError("CUDA failure")
        with tempfile.TemporaryDirectory() as temp:
            records, fatal = service.fixed_batch(assignments, generate, Path(temp) / "raw.jsonl")
            self.assertEqual(len(called), 1)
            self.assertEqual(len(records), 720)
            self.assertEqual(sum(r["execution_status"] == "not_run" for r in records), 719)
            self.assertTrue(records[0]["infrastructure_fatal"])
            self.assertEqual(fatal["message"], "CUDA failure")
            self.assertEqual(len((Path(temp) / "raw.jsonl").read_text().splitlines()), 1)

    def test_model_request_error_continues_without_retry(self):
        assignments = [{"model": "baseline", "request_id": str(i), "request": self.payload()} for i in range(2)]
        called = []
        def generate(model, payload, request_id, **kwargs):
            called.append(request_id)
            if request_id == "0":
                raise service.RequestError("bounded timeout", 504, {"partial_text": "partial"})
            return {"execution_status": "output_received", "status": 200, "text": "{}", "proof": {}}
        with tempfile.TemporaryDirectory() as temp:
            records, fatal = service.fixed_batch(assignments, generate, Path(temp) / "raw.jsonl")
        self.assertIsNone(fatal)
        self.assertEqual(called, ["0", "1"])
        self.assertEqual(records[0]["text"], "partial")
        self.assertEqual(records[1]["execution_status"], "output_received")

    def test_queue_serialization_and_response_idempotency(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "case-1"
            directory.mkdir()
            service.save(directory / "request.json", {"request_id": "case-1", "model": "baseline", "payload": self.payload()})
            calls = []
            def generate(*args, **kwargs):
                calls.append(args)
                return {"status": 200, "response": {"choices": []}, "proof": {"model": "baseline"}}
            self.assertIsNone(service.serve_one(directory, generate))
            response = json.loads((directory / "response.json").read_text())
            self.assertEqual(response["request_id"], "case-1")
            self.assertEqual(response["status"], 200)
            self.assertIn("request_file_sha256", response["proof"])
            self.assertIsNone(service.serve_one(directory, generate))
            self.assertEqual(len(calls), 1)

    def test_queue_fatal_valueerror_not_disguised_as_model_400(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "case"
            directory.mkdir()
            service.save(directory / "request.json", {"request_id": "case", "model": "baseline", "payload": self.payload()})
            def generate(*args, **kwargs):
                raise ValueError("loaded adapter mismatch")
            fatal = service.serve_one(directory, generate)
            self.assertEqual(fatal["message"], "loaded adapter mismatch")
            self.assertEqual(json.loads((directory / "response.json").read_text())["status"], 503)

    def test_cancel_before_dispatch_makes_no_model_call(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp) / "case"
            directory.mkdir()
            service.save(directory / "request.json", {"request_id": "case", "model": "baseline", "payload": self.payload()})
            service.save(directory / "cancel.json", {"request_id": "case"})
            def generate(*args, **kwargs):
                self.fail("cancelled request must not dispatch")
            self.assertIsNone(service.serve_one(directory, generate))
            response = json.loads((directory / "response.json").read_text())
            self.assertEqual(response["status"], 499)
            self.assertFalse(response["proof"]["model_called"])

    def test_end_to_end_cpu_receipt_no_node_launch(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            work = root / "work"
            flow = work / "controlled/full-flow"
            flow.mkdir(parents=True)
            service.save(flow / "summary.json", {"assigned": 18, "completed": 18})
            service.save(work / "controlled/full-flow-done.json", {"summary_sha256": service.digest(flow / "summary.json")})
            assignments = [{"model": "baseline", "request_id": "one", "request": self.payload()}]
            panel = types.SimpleNamespace(prepare_fixed=lambda *_: assignments, finalize_fixed=lambda *_: {"ok": True}, build_report=lambda *_: None)
            class Engine:
                def __init__(self, *args):
                    pass
                def generate(self, *args, **kwargs):
                    return {"execution_status": "output_received", "status": 200, "text": "{}", "proof": {}}
            with patch.dict("sys.modules", {"ubuntu_v13_panel": panel}), patch.object(service, "NativeEngine", Engine):
                summary = service.run_controlled(root, {"controlled": {"expected_fixed_assigned": 1}}, work, *([None] * 7))
            self.assertTrue(summary["completed"])
            self.assertEqual(summary["full_flow_terminal"], 18)
            self.assertTrue((work / "controlled/FIXED_COMPLETE.json").exists())


if __name__ == "__main__":
    unittest.main()


class UnsetGenerationDefaultsTest(unittest.TestCase):
    def test_none_is_neutral_but_explicit_active_penalty_is_rejected(self):
        from types import SimpleNamespace
        from ubuntu_controlled_service import decode_contract
        config=SimpleNamespace(eos_token_id=[1,106,50],suppress_tokens=[258883,258882],repetition_penalty=None,num_beams=None,min_length=None)
        self.assertEqual(decode_contract(config),([1,106,50],[258883,258882]))
        config.repetition_penalty=1.2
        with self.assertRaises(RuntimeError):decode_contract(config)

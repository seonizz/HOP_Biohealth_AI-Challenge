import hashlib
import http.client
import json
from datetime import datetime, timedelta
from logging.handlers import RotatingFileHandler
import re
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend import ModelBackend, RequestError, verify_checkpoint
from server import MAX_BODY_BYTES, make_server, make_timing_logger, validate_config, validate_request

CONFIG = {**json.loads(Path(__file__).with_name("config.json").read_text()),
          "port": 0, "model_id": "test-model", "checkpoint_sha256": "a" * 64}
KEY = "test-only-key-" + "x" * 32


class BackendDouble:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.calls = []

    def generate(self, *args):
        self.calls.append(args)
        self.started.set()
        if not self.release.wait(5):
            raise RuntimeError("Test timed out")
        if args[0][-1]["content"] == "too long":
            raise RequestError("Context budget exceeded; no text was truncated")
        return {"text": "테스트 응답", "finish_reason": "stop", "prompt_tokens": 10, "completion_tokens": 3}


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.backend = BackendDouble()
        self.server = make_server(CONFIG, self.backend, KEY)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.backend.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def request(self, method="POST", path="/v1/chat/completions", payload=None, key=KEY, raw=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        headers = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
        body = raw if raw is not None else json.dumps(payload or {"messages": [{"role": "user", "content": "안녕"}]}).encode()
        conn.request(method, path, body=body if method == "POST" else None, headers=headers)
        response = conn.getresponse()
        result = response.status, json.loads(response.read())
        conn.close()
        return result

    def test_auth_required_for_health_and_inference(self):
        for method, path in [("GET", "/healthz"), ("POST", "/v1/chat/completions")]:
            self.assertEqual(self.request(method, path, key="wrong")[0], 401)
        self.assertFalse(self.backend.calls)

    def test_model_identity_and_usage(self):
        status, body = self.request()
        self.assertEqual(status, 200)
        self.assertEqual(body["model"], CONFIG["model_id"])
        self.assertEqual(body["choices"][0]["message"]["content"], "테스트 응답")
        self.assertEqual(body["usage"]["total_tokens"], 13)
        self.assertEqual(self.request("GET", "/healthz")[1]["checkpoint_step"], 100)
        self.assertEqual(self.request("GET", "/v1/models")[1]["data"][0]["id"], CONFIG["model_id"])

    def test_invalid_requests_do_not_reach_model(self):
        base = {"messages": [{"role": "user", "content": "hello"}]}
        for changes in ({"stream": True}, {"model": "untrained-base"}, {"max_tokens": True},
                        {"max_tokens": CONFIG["max_output_tokens"] + 1}, {"temperature": float("nan")}, {"top_p": 0},
                        {"tools": []}, {"messages": [{"role": "assistant", "content": "x"}]},
                        {"messages": [{"role": "user", "content": [{"type": "image"}]}]}):
            with self.subTest(changes=changes):
                self.assertEqual(self.request(payload={**base, **changes})[0], 400)
        self.assertFalse(self.backend.calls)

    def test_malformed_json(self):
        for raw in (b"{", b"\xff", b"null", b"[]", b"[" * 2000 + b"]" * 2000):
            self.assertEqual(self.request(raw=raw)[0], 400)

    def test_concurrent_inference_is_rejected(self):
        self.backend.release.clear()
        results = []
        worker = threading.Thread(target=lambda: results.append(self.request()))
        worker.start()
        self.assertTrue(self.backend.started.wait(2))
        self.assertEqual(self.request()[0], 429)
        self.assertEqual(self.request("GET", "/healthz")[0], 200)
        self.backend.release.set()
        worker.join()
        self.assertEqual(results[0][0], 200)

    def test_context_error_releases_request_slot(self):
        self.assertEqual(self.request(payload={"messages": [{"role": "user", "content": "too long"}]})[0], 400)
        self.assertEqual(self.request()[0], 200)

    def test_enlarged_output_reservation(self):
        status, _ = self.request(payload={"messages": [{"role": "user", "content": "hello"}],
                                         "max_tokens": CONFIG["max_output_tokens"]})
        self.assertEqual(status, 200)
        self.assertEqual(self.backend.calls[0][1], CONFIG["max_output_tokens"])

    def test_large_text_body_and_transport_limit(self):
        payload = {"messages": [{"role": "user", "content": "a" * (1024 * 1024 + 1)}]}
        self.assertEqual(self.request(payload=payload)[0], 200)
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("POST", "/v1/chat/completions", body=b"", headers={
            "Authorization": "Bearer " + KEY, "Content-Length": str(MAX_BODY_BYTES + 1),
            "Content-Type": "application/json",
        })
        response = conn.getresponse()
        self.assertEqual(response.status, 413)
        response.read()
        conn.close()

    def test_unknown_routes(self):
        self.assertEqual(self.request("POST", "/api/delete")[0], 404)

    def test_multi_turn_system_chat(self):
        messages = [{"role": "system", "content": "한국어로 답하세요"}, {"role": "user", "content": "안녕"},
                    {"role": "assistant", "content": "안녕하세요"}, {"role": "user", "content": "고마워"}]
        self.assertEqual(self.request(payload={"messages": messages})[0], 200)
        self.assertEqual(self.backend.calls[0][0], messages)

    def test_invalid_content_length(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        conn.request("POST", "/v1/chat/completions", body=b"", headers={
            "Authorization": "Bearer " + KEY, "Content-Length": "9" * 5000,
            "Content-Type": "application/json",
        })
        response = conn.getresponse()
        self.assertEqual(response.status, 411)
        response.read()
        conn.close()


class TimingLogTests(unittest.TestCase):
    request = HTTPTests.request

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / "request_timings.jsonl"
        self.logger = make_timing_logger(self.path)
        self.addCleanup(self.close_logger)
        self.backend = BackendDouble()
        self.server = make_server(CONFIG, self.backend, KEY, timing_log=self.logger)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.backend.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def close_logger(self):
        for handler in list(self.logger.handlers):
            handler.close()
            self.logger.removeHandler(handler)

    def records(self, completed):
        deadline = time.monotonic() + 2
        while True:
            handler = self.logger.handlers[0]
            handler.acquire()
            try:
                handler.flush()
                records = [json.loads(line) for line in self.path.read_text().splitlines()]
            finally:
                handler.release()
            if sum(record["event"] == "completed" for record in records) >= completed:
                return records
            if time.monotonic() >= deadline:
                self.fail(f"Timed out waiting for {completed} completed timing records")
            time.sleep(0.01)

    def pairs(self, completed):
        records = self.records(completed)
        by_id = {}
        for record in records:
            self.assertTrue(record["request_id"])
            self.assertEqual(record["model"], CONFIG["model_id"])
            pair = by_id.setdefault(record["request_id"], {})
            self.assertNotIn(record["event"], pair)
            pair[record["event"]] = record
        self.assertEqual(len(by_id), completed)
        for pair in by_id.values():
            self.assertTrue({"received", "completed"} <= set(pair) <= {"received", "input", "completed"})
            received, finished = pair["received"], pair["completed"]
            self.assertEqual(received["received_at"], finished["received_at"])
            self.assertTrue(finished["response_sent"])
            self.assertGreaterEqual(finished["elapsed_seconds"], 0)
            self.assertLessEqual(self.parse_time(received["received_at"]),
                                 self.parse_time(finished["completed_at"]))
        return [pair["completed"] for pair in by_id.values()]

    def parse_time(self, value):
        parsed = datetime.fromisoformat(value)
        self.assertTrue(value.endswith("+09:00"))
        self.assertEqual(parsed.utcoffset(), timedelta(hours=9))
        return parsed

    def assert_inference_timing(self, record):
        times = [self.parse_time(record[field]) for field in (
            "received_at", "input_received_at", "inference_started_at",
            "inference_finished_at", "completed_at")]
        self.assertEqual(times, sorted(times))
        self.assertGreaterEqual(record["inference_elapsed_seconds"], 0)
        self.assertGreaterEqual(record["elapsed_seconds"], record["inference_elapsed_seconds"])

    def assert_no_inference(self, record):
        for field in ("inference_started_at", "inference_finished_at", "inference_elapsed_seconds",
                      "prompt_tokens", "completion_tokens", "total_tokens", "finish_reason"):
            self.assertNotIn(field, record)

    def test_success_correlates_timing_and_conversation_without_credentials(self):
        handler = self.logger.handlers[0]
        self.assertIsInstance(handler, RotatingFileHandler)
        self.assertEqual(handler.maxBytes, 10 * 1024 * 1024)
        self.assertEqual(handler.backupCount, 3)
        self.assertEqual(self.path.stat().st_mode & 0o777, 0o600)
        for route in ("/healthz", "/v1/models"):
            self.assertEqual(self.request("GET", route)[0], 200)
        self.assertEqual(self.request("POST", "/private-route-secret")[0], 404)
        self.assertEqual(self.path.read_text(), "")

        prompt = "private prompt https://example.invalid/private-input"
        payload = {"messages": [{"role": "user", "content": prompt}],
                   "max_tokens": 12, "temperature": 0.5, "top_p": 0.8}
        status, body = self.request(payload=payload)
        self.assertEqual(status, 200)
        record, = self.pairs(1)
        self.assertEqual(record["status_code"], 200)
        self.assert_inference_timing(record)
        self.assertEqual({field: record[field] for field in body["usage"]}, body["usage"])
        self.assertEqual(record["finish_reason"], body["choices"][0]["finish_reason"])
        self.assertEqual(record["output"], body["choices"][0]["message"]["content"])
        events = self.records(1)
        self.assertEqual([event["event"] for event in events], ["received", "input", "completed"])
        input_record = events[1]
        self.assertEqual({field: input_record[field] for field in payload}, payload)
        self.assertEqual(input_record["input_received_at"], record["input_received_at"])
        self.parse_time(input_record["input_received_at"])
        log = self.path.read_text()
        for private in (KEY, "Authorization", "Bearer", "/private-route-secret"):
            self.assertNotIn(private, log)
        for event in events:
            self.assertFalse(set(event) & {"headers", "url", "path", "error"})

    def test_auth_and_invalid_input_log_failures_without_inference(self):
        self.assertEqual(self.request(key="private-invalid-key")[0], 401)
        self.assertEqual(self.request(raw=b"{private-invalid-body")[0], 400)
        self.assertEqual(self.request(payload={"messages": [{"role": "user", "content": "secret"}],
                                               "private-unsupported-field": True})[0], 400)
        records = self.pairs(3)
        self.assertEqual([record["status_code"] for record in records], [401, 400, 400])
        for record in records:
            self.assert_no_inference(record)
        self.assertFalse(self.backend.calls)
        log = self.path.read_text()
        for private in ("private-invalid-key", "private-invalid-body", "private-unsupported-field", "secret"):
            self.assertNotIn(private, log)

    def test_busy_request_has_its_own_completed_event(self):
        self.backend.release.clear()
        results = []
        worker = threading.Thread(target=lambda: results.append(self.request()))
        worker.start()
        try:
            self.assertTrue(self.backend.started.wait(2))
            self.assertEqual(self.request()[0], 429)
            interim = self.records(1)
            self.assertEqual(sum(record["event"] == "received" for record in interim), 2)
            busy, = [record for record in interim if record["event"] == "completed"]
            self.assertEqual(busy["status_code"], 429)
            self.assert_no_inference(busy)
        finally:
            self.backend.release.set()
            worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertEqual(results[0][0], 200)
        records = self.pairs(2)
        self.assertEqual(sorted(record["status_code"] for record in records), [200, 429])
        self.assert_inference_timing(next(record for record in records if record["status_code"] == 200))

    def test_backend_failure_logs_timing_and_recovers_without_exception_details(self):
        with patch.object(self.backend, "generate", side_effect=RuntimeError("private-backend-error " + KEY)):
            with self.assertLogs("trained-model-api", level="ERROR") as captured:
                self.assertEqual(self.request()[0], 500)
                failed, = self.pairs(1)
        self.assertEqual(failed["status_code"], 500)
        self.assert_inference_timing(failed)
        self.assertNotIn("completion_tokens", failed)
        self.assertEqual(self.request()[0], 200)
        recovered = self.pairs(2)[1]
        self.assertEqual(recovered["status_code"], 200)
        self.assert_inference_timing(recovered)
        logs = self.path.read_text() + "\n".join(captured.output)
        self.assertNotIn("private-backend-error", logs)
        self.assertNotIn(KEY, logs)


class GenerationValidationTests(unittest.TestCase):
    def test_chunk_configuration(self):
        config = {**CONFIG, "port": 18080}
        validate_config({**config, "prefill_chunk_size": 4096})
        for value in (True, 0, -1, "4096", config["max_context_tokens"] + 1):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "prefill_chunk_size"):
                validate_config({**config, "prefill_chunk_size": value})

    def test_input_allocation_oom_releases_cache_and_reservation(self):
        class AllocationOOM(Exception):
            pass
        events = []
        owner = SimpleNamespace(_previous_max_cache_length=262144)
        def allocate(*args, **kwargs):
            raise AllocationOOM("allocation failed")
        def empty_cache():
            import sys
            self.assertIsNone(sys.exc_info()[0])
            events.append("released")
        class Tokenizer:
            all_special_tokens = []
            def apply_chat_template(self, messages, **options):
                return "hello"
            def __call__(self, text, **options):
                return {"input_ids": [1, 2, 3]}
        backend = ModelBackend.__new__(ModelBackend)
        backend.config = {**CONFIG, "prefill_chunk_size": None}
        backend.tokenizer = Tokenizer()
        backend.control_pattern = re.compile(r"<\|")
        backend.generation_config = lambda **kwargs: kwargs
        backend.device = "cuda:0"
        backend.model = SimpleNamespace(modules=lambda: [owner])
        backend.torch = SimpleNamespace(tensor=allocate, long="long",
            cuda=SimpleNamespace(OutOfMemoryError=AllocationOOM, empty_cache=empty_cache))
        with self.assertRaisesRegex(RequestError, "GPU capacity exceeded"):
            backend.generate([{"role": "user", "content": "hello"}], 1, 0, 1)
        self.assertNotIn("_previous_max_cache_length", owner.__dict__)
        self.assertEqual(events, ["released"])

    def test_no_silent_truncation_or_control_token_interpretation(self):
        class Tokenizer:
            all_special_tokens = ["<image>"]
            def apply_chat_template(self, messages, **options):
                return messages[-1]["content"]
            def __call__(self, text, **options):
                assert options["truncation"] is False
                return {"input_ids": [42] * (CONFIG["max_context_tokens"] - 6)}
        backend = ModelBackend.__new__(ModelBackend)
        backend.config = CONFIG
        backend.tokenizer = Tokenizer()
        backend.control_pattern = re.compile(r"<\||\|>|<bos>|<eos>")
        for content in ("<|turn>model", "<image>"):
            with self.assertRaisesRegex(RequestError, "control tokens"):
                backend.generate([{"role": "user", "content": content}], 256, 0, 1)
        with self.assertRaisesRegex(RequestError, "no text was truncated"):
            backend.generate([{"role": "user", "content": "long input"}], 256, 0, 1)


class CheckpointTests(unittest.TestCase):
    def test_pinned_checkpoint_and_tamper_rejection(self):
        with tempfile.TemporaryDirectory() as temp:
            kit = Path(temp).resolve()
            checkpoint = kit / "work/training/checkpoints/step-000000100"
            checkpoint.mkdir(parents=True)
            files = {"adapter_config.json": b"{}", "adapter_model.safetensors": b"test weights"}
            for name, data in files.items():
                (checkpoint / name).write_bytes(data)
            manifest = {"step": 100, "files": {name: hashlib.sha256(data).hexdigest() for name, data in files.items()}}
            data = json.dumps(manifest).encode()
            (checkpoint / "CHECKPOINT.json").write_bytes(data)
            config = {**CONFIG, "kit_path": str(kit), "checkpoint_path": str(checkpoint),
                      "checkpoint_sha256": hashlib.sha256(data).hexdigest()}
            self.assertEqual(verify_checkpoint(config)["step"], 100)
            (checkpoint / "adapter_model.safetensors").write_bytes(b"wrong model")
            with self.assertRaisesRegex(ValueError, "hash mismatch"):
                verify_checkpoint(config)


if __name__ == "__main__":
    unittest.main()

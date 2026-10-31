import http.client
import json
import socket
import threading
import unittest

from backend import RequestError
from server import make_server
from test_api import CONFIG, KEY
from test_inference_queue import wait_until


class GuardedBackend:
    def __init__(self):
        self.status = "ready"
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.calls = []
        self.active = 0
        self.maximum_active = 0
        self.status_calls = 0

    def inference_status(self):
        self.status_calls += 1
        return {"status": self.status, "private_detail": "must-not-leak"}

    def generate(self, messages, *args):
        value = messages[-1]["content"]
        self.calls.append(value)
        self.active += 1
        self.maximum_active = max(self.active, self.maximum_active)
        self.entered.set()
        try:
            if not self.release.wait(3):
                raise RuntimeError("Test did not release backend")
            if value == "uncertain cancellation":
                self.status = "draining"
                raise RequestError("Remote completion unknown")
            if value == "known failure":
                raise RequestError("Known rejected request")
            return {"text": "synthetic", "finish_reason": "stop", "prompt_tokens": 5, "completion_tokens": 1}
        finally:
            self.active -= 1


class QueueHTTPTests(unittest.TestCase):
    def setUp(self):
        self.backend = GuardedBackend()
        self.server = make_server({**CONFIG, "inference_queue_max_requests": 2,
                                   "inference_queue_max_bytes": 1024,
                                   "require_backend_status": True}, self.backend, KEY)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.backend.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(2)

    def request(self, text="writer", method="POST", key=KEY, extra=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        body = json.dumps({"messages": [{"role": "user", "content": text}], **(extra or {})})
        connection.request(method, "/healthz" if method == "GET" else "/v1/chat/completions",
                           body=body if method == "POST" else None,
                           headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
        response = connection.getresponse()
        result = response.status, json.loads(response.read())
        connection.close()
        return result

    def start_request(self, text, results):
        thread = threading.Thread(target=lambda: results.append((text, self.request(text)[0])))
        thread.start()
        return thread

    def test_writer_review_repair_share_fifo_slot_and_health_is_read_only(self):
        self.backend.release.clear()
        results = []
        first = self.start_request("writer", results)
        self.assertTrue(self.backend.entered.wait(1))
        threads = [first]
        for index, text in enumerate(("review", "repair"), 1):
            threads.append(self.start_request(text, results))
            wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == index)
        health = self.request(method="GET")
        self.assertEqual(health[0], 200)
        self.assertEqual(health[1]["status"], "busy")
        self.assertNotIn("must-not-leak", json.dumps(health))
        self.assertEqual(self.backend.calls, ["writer"])
        self.assertEqual(self.request("overflow")[0], 429)
        self.backend.release.set()
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(self.backend.calls, ["writer", "review", "repair"])
        self.assertEqual(self.backend.maximum_active, 1)
        self.assertEqual(sorted(status for _, status in results), [200, 200, 200])

    def test_queued_disconnection_never_calls_backend(self):
        self.backend.release.clear()
        results = []
        running = self.start_request("writer", results)
        self.assertTrue(self.backend.entered.wait(1))
        connection = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2)
        body = json.dumps({"messages": [{"role": "user", "content": "cancelled review"}]}).encode()
        connection.sendall(("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n"
                            "Authorization: Bearer " + KEY + "\r\nContent-Type: application/json\r\n"
                            "Content-Length: " + str(len(body)) + "\r\n\r\n").encode() + body)
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 1)
        connection.close()
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 0)
        self.backend.release.set()
        running.join(2)
        self.assertEqual(self.backend.calls, ["writer"])

    def test_running_disconnect_waits_for_remote_return_and_then_guard(self):
        self.backend.release.clear()
        # The deliberately closed socket may reject its final HTTP error body.
        self.server.handle_error = lambda *args: None
        connection = socket.create_connection(("127.0.0.1", self.server.server_port), timeout=2)
        body = json.dumps({"messages": [{"role": "user", "content": "uncertain cancellation"}]}).encode()
        connection.sendall(("POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\n"
                            "Authorization: Bearer " + KEY + "\r\nContent-Type: application/json\r\n"
                            "Content-Length: " + str(len(body)) + "\r\n\r\n").encode() + body)
        self.assertTrue(self.backend.entered.wait(1))
        connection.close()
        results = []
        waiting = self.start_request("review", results)
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 1)
        self.assertEqual(self.backend.calls, ["uncertain cancellation"])
        self.assertTrue(self.server.inference_queue.snapshot()["active"])
        self.backend.release.set()
        waiting.join(2)
        self.assertEqual(results, [("review", 503)])
        self.assertEqual(self.backend.calls, ["uncertain cancellation"])
        self.backend.status = "ready"
        self.assertEqual(self.request("review")[0], 200)
        self.assertEqual(self.backend.maximum_active, 1)

    def test_shutdown_wakes_queued_http_request_without_starting_it(self):
        self.backend.release.clear()
        results = []
        running = self.start_request("writer", results)
        self.assertTrue(self.backend.entered.wait(1))
        waiting = self.start_request("review", results)
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 1)
        self.server.shutdown()
        waiting.join(2)
        self.assertIn(("review", 503), results)
        self.assertEqual(self.backend.calls, ["writer"])
        self.assertTrue(self.server.inference_queue.snapshot()["active"])
        self.backend.release.set()
        running.join(2)

    def test_uncertain_completion_blocks_until_backend_explicitly_ready(self):
        self.assertEqual(self.request("uncertain cancellation")[0], 400)
        self.assertEqual(self.request(method="GET")[0], 503)
        self.assertEqual(self.request("review")[0], 503)
        self.assertEqual(self.backend.calls, ["uncertain cancellation"])
        self.backend.status = "busy"
        self.assertEqual(self.request("review")[0], 503)
        self.backend.status = "ready"
        self.assertEqual(self.request("review")[0], 200)
        self.assertEqual(self.backend.maximum_active, 1)

    def test_known_failure_releases_slot_without_loading_or_health_generation(self):
        self.assertEqual(self.request("known failure")[0], 400)
        count = len(self.backend.calls)
        self.assertEqual(self.request(method="GET")[0], 200)
        self.assertEqual(len(self.backend.calls), count)
        self.assertEqual(self.request("review")[0], 200)

    def test_invalid_auth_and_schema_never_enter_queue(self):
        self.assertEqual(self.request(key="wrong")[0], 401)
        self.assertEqual(self.request(extra={"response_format": {"type": "json_object"}})[0], 400)
        self.assertEqual(self.server.inference_queue.snapshot()["queued_requests"], 0)
        self.assertEqual(self.backend.calls, [])

    def test_unready_invalid_or_throwing_hook_fails_closed(self):
        for status in ("draining", "unavailable", "unknown"):
            self.backend.status = status
            self.assertEqual(self.request(method="GET")[0], 503)
            self.assertEqual(self.request()[0], 503)
        def raises():
            raise RuntimeError("private-status-data")
        self.backend.inference_status = raises
        self.assertEqual(self.request(method="GET")[0], 503)
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.backend.calls, [])


class StatusConfigurationTests(unittest.TestCase):
    def test_required_hook_rejects_missing_and_invalid_configuration(self):
        with self.assertRaisesRegex(ValueError, "inference_status"):
            make_server({**CONFIG, "require_backend_status": True}, object(), KEY)
        for value in ("true", 1, None):
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, "require_backend_status"):
                make_server({**CONFIG, "require_backend_status": value}, object(), KEY)


if __name__ == "__main__":
    unittest.main()

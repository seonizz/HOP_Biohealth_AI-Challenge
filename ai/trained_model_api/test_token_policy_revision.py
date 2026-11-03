import http.client
import json
import threading
import unittest

from server import make_server
from test_api import CONFIG, KEY
from test_api_queue import GuardedBackend


class TokenPolicyRevisionTests(unittest.TestCase):
    def setUp(self):
        self.config = {**CONFIG, "require_backend_status": True, "max_input_tokens": 4096}
        self.backend = GuardedBackend()
        self.server = self.start_server(self.config, self.backend)

    def start_server(self, config, backend):
        server = make_server(config, backend, KEY)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        thread.start()

        def close():
            backend.release.set()
            server.shutdown()
            server.server_close()
            thread.join(2)
            self.assertFalse(thread.is_alive())

        self.addCleanup(close)
        return server

    def request(self, *, server=None, method="POST", revisions=(), key=KEY, extra=None):
        connection = http.client.HTTPConnection("127.0.0.1", (server or self.server).server_port, timeout=3)
        body = json.dumps({"messages": [{"role": "user", "content": "synthetic policy test"}], **(extra or {})}).encode()
        try:
            connection.putrequest(method, "/healthz" if method == "GET" else "/v1/chat/completions")
            connection.putheader("Authorization", "Bearer " + key)
            for revision in revisions:
                connection.putheader("X-Malssi-Token-Policy-Revision", revision)
            if method == "POST":
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", str(len(body)))
            connection.endheaders(body if method == "POST" else None)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def revision(self, server=None):
        status, health = self.request(method="GET", server=server)
        self.assertEqual(status, 200)
        return health["token_policy_revision"]

    def test_health_advertises_stable_opaque_revision_and_valid_limits_without_inference(self):
        status, health = self.request(method="GET")
        self.assertEqual(status, 200)
        self.assertRegex(health["token_policy_revision"], r"^[a-f0-9]{64}$")
        self.assertEqual(health["token_policy_revision"], self.revision())
        for field in ("model", "checkpoint_step", "checkpoint_sha256", "max_context_tokens", "max_output_tokens", "max_input_tokens"):
            self.assertEqual(health[field], self.config["model_id" if field == "model" else field])
        self.assertNotIn("private_detail", health)
        self.assertEqual(self.backend.calls, [])

    def test_replacement_server_rejects_old_revision_before_inference(self):
        old_revision = self.revision()
        replacement_backend = GuardedBackend()
        replacement = self.start_server(self.config, replacement_backend)
        new_revision = self.revision(replacement)
        self.assertNotEqual(old_revision, new_revision)
        status, body = self.request(server=replacement, revisions=[old_revision])
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "token_policy_changed")
        self.assertNotIn(new_revision, json.dumps(body))
        self.assertEqual(replacement_backend.calls, [])
        self.assertEqual(self.request(server=replacement, revisions=[new_revision])[0], 200)

    def test_current_revision_and_legacy_requests_keep_normal_dispatch(self):
        self.assertEqual(self.request(revisions=[self.revision()])[0], 200)
        self.assertEqual(self.request()[0], 200)
        self.assertEqual(self.backend.calls, ["synthetic policy test"] * 2)

    def test_stale_empty_duplicate_and_combined_headers_never_enter_admission(self):
        revision = self.revision()
        status_calls = self.backend.status_calls
        for revisions in (["0" * 64], [""], [revision, revision], [revision, "0" * 64], [revision + ", " + revision]):
            with self.subTest(revisions=revisions):
                status, body = self.request(revisions=revisions)
                self.assertEqual(status, 409)
                self.assertEqual(body["error"]["code"], "token_policy_changed")
                self.assertEqual(self.server.inference_queue.snapshot()["queued_requests"], 0)
                self.assertFalse(self.server.inference_queue.snapshot()["active"])
        self.assertEqual(self.backend.calls, [])
        self.assertEqual(self.backend.status_calls, status_calls)

    def test_authentication_precedes_revision_check(self):
        for method in ("GET", "POST"):
            status, body = self.request(method=method, revisions=["stale"], key="wrong")
            self.assertEqual(status, 401)
            self.assertNotIn("token_policy_changed", json.dumps(body))
        self.assertEqual(self.backend.calls, [])

    def test_cached_policy_does_not_bypass_live_readiness(self):
        revision = self.revision()
        for state in ("draining", "unavailable", "busy"):
            self.backend.status = state
            status_calls = self.backend.status_calls
            self.assertEqual(self.request(revisions=[revision])[0], 503)
            self.assertGreater(self.backend.status_calls, status_calls)
            self.assertEqual(self.backend.calls, [])
        self.backend.status = "ready"
        self.assertEqual(self.request(revisions=[revision])[0], 200)

    def test_external_configuration_mutation_does_not_change_advertised_or_enforced_policy(self):
        revision = self.revision()
        original_output = self.config["max_output_tokens"]
        self.config.update(model_id="changed-model", max_output_tokens=1,
                           max_context_tokens=2, max_input_tokens=1, checkpoint_sha256="b" * 64)
        status, health = self.request(method="GET")
        self.assertEqual(status, 200)
        self.assertEqual(health["token_policy_revision"], revision)
        self.assertEqual(health["model"], CONFIG["model_id"])
        self.assertEqual(health["max_output_tokens"], original_output)
        self.assertEqual(health["max_context_tokens"], CONFIG["max_context_tokens"])
        self.assertEqual(health["max_input_tokens"], 4096)
        self.assertEqual(health["checkpoint_sha256"], CONFIG["checkpoint_sha256"])
        status, result = self.request(revisions=[revision], extra={"model": CONFIG["model_id"], "max_tokens": original_output})
        self.assertEqual(status, 200)
        self.assertEqual(result["model"], CONFIG["model_id"])

    def test_invalid_optional_input_limits_are_not_advertised(self):
        for value in (None, True, 0, -1, 1.5, "4096", CONFIG["max_context_tokens"] + 1):
            with self.subTest(value=value):
                server = self.start_server({**CONFIG, "max_input_tokens": value}, GuardedBackend())
                status, health = self.request(server=server, method="GET")
                self.assertEqual(status, 200)
                self.assertNotIn("max_input_tokens", health)


if __name__ == "__main__":
    unittest.main()

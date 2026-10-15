"""Gateway contracts exercised without sockets, Ollama, or external requests."""

import http.client
import io
import json
from email.message import Message
import threading
import unittest
from unittest.mock import Mock, patch
import urllib.error

import ollama_gateway as gateway


API_KEY = "gateway-test-key-" + "a" * 32
MODEL = "gemma4:12b"
UPSTREAM = "http://127.0.0.1:11434"


class MemorySocket:
    """Supply wire-format HTTP to the real handler without opening a port."""

    def __init__(self, request=b""):
        self.input = io.BytesIO(request)
        self.output = io.BytesIO()

    def makefile(self, *args, **kwargs):
        return self.input

    def sendall(self, data):
        self.output.write(data)


class UpstreamResponse(io.BytesIO):
    def __init__(self, body=b"{}", status=200, content_type="application/json"):
        super().__init__(body)
        self.code = status
        self.headers = Message()
        self.headers["Content-Type"] = content_type


class GatewayContracts(unittest.TestCase):
    def setUp(self):
        self.config = {
            "api_key": API_KEY,
            "ollama_url": UPSTREAM,
            "model": MODEL,
            "port": 0,
        }
        # The real server still supplies its handler and concurrency gate. Only
        # binding/listening is bypassed; request and response parsing stay real.
        with patch.object(gateway.ThreadingHTTPServer, "server_bind"), \
                patch.object(gateway.ThreadingHTTPServer, "server_activate"):
            self.server = gateway.make_server(self.config)
        self.addCleanup(self.server.server_close)
        patcher = patch.object(
            gateway.urllib.request, "urlopen",
            side_effect=AssertionError("Unexpected upstream request"),
        )
        self.urlopen = patcher.start()
        self.addCleanup(patcher.stop)

    def upstream(self, body=b"{}", status=200, content_type="application/json"):
        self.urlopen.side_effect = None
        self.urlopen.return_value = UpstreamResponse(body, status, content_type)

    def raw_request(self, method="GET", path="/v1/models", body=b"",
                    authenticated=True, headers=(), auto_length=True):
        if isinstance(body, str):
            body = body.encode()
        fields = [("Host", "localhost"), ("Connection", "close")]
        if authenticated:
            fields.append(("Authorization", "Bearer " + API_KEY))
        fields.extend(headers)
        if method == "POST" and auto_length:
            fields.append(("Content-Length", str(len(body))))
        lines = [f"{method} {path} HTTP/1.1"]
        lines.extend(f"{name}: {value}" for name, value in fields)
        return "\r\n".join(lines).encode() + b"\r\n\r\n" + body

    def handle(self, raw):
        connection = MemorySocket(raw)
        self.server.RequestHandlerClass(connection, ("127.0.0.1", 12345), self.server)
        return connection.output.getvalue()

    def request(self, **kwargs):
        wire = self.handle(self.raw_request(**kwargs))
        response = http.client.HTTPResponse(MemorySocket(wire))
        response.begin()
        return response.status, response.headers, response.read(), wire

    def post(self, payload, **kwargs):
        return self.request(method="POST", path="/api/generate",
                            body=json.dumps(payload).encode(), **kwargs)

    def assert_rejected(self, status, **kwargs):
        actual, _, body, _ = self.request(**kwargs)
        self.assertEqual(actual, status)
        self.assertEqual(json.loads(body)["error"]["type"], "gateway_error")
        self.urlopen.assert_not_called()

    def test_binds_only_to_loopback(self):
        self.assertEqual(self.server.server_address, ("127.0.0.1", 0))

    def test_rejects_keys_shorter_than_32_ascii_characters(self):
        for key in ("a" * 31, "가" * 32, None):
            with self.subTest(key=key), self.assertRaises(ValueError):
                gateway.make_server({**self.config, "api_key": key})

    def test_rejects_nonlocal_upstream_configuration(self):
        for upstream in ("http://example.invalid", "http://127.0.0.1:11435"):
            with self.subTest(upstream=upstream), self.assertRaises(ValueError):
                gateway.make_server({**self.config, "ollama_url": upstream})

    def test_returns_401_without_authorization(self):
        self.assert_rejected(401, authenticated=False)

    def test_returns_401_with_incorrect_key(self):
        self.assert_rejected(401, authenticated=False,
                             headers=[("Authorization", "Bearer " + "b" * 32)])

    def test_returns_401_for_wrong_authorization_scheme(self):
        self.assert_rejected(401, authenticated=False,
                             headers=[("Authorization", "Basic " + API_KEY)])

    def test_unauthorized_response_advertises_bearer_and_disables_caching(self):
        status, headers, body, _ = self.request(authenticated=False)
        self.assertEqual(status, 401)
        self.assertEqual(headers["WWW-Authenticate"], "Bearer")
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn(API_KEY.encode(), body)

    def test_blocks_model_pull_route(self):
        self.assert_rejected(404, method="POST", path="/api/pull", body=b"{}")

    def test_blocks_model_delete_route(self):
        self.assert_rejected(405, method="DELETE", path="/api/delete")

    def test_blocks_unknown_routes_and_query_suffixes(self):
        for path in ("/", "/api/ps", "/v1/models?token=secret", "/api/generate/extra"):
            with self.subTest(path=path):
                self.assert_rejected(404, path=path)

    def test_blocks_mutating_http_methods(self):
        for method in ("PUT", "PATCH"):
            with self.subTest(method=method):
                self.assert_rejected(405, method=method, path="/api/generate")

    def test_rejects_requests_for_a_different_model(self):
        self.assert_rejected(400, method="POST", path="/api/generate",
                             body=b'{"model":"other-model"}')

    def test_injects_configured_model_when_omitted(self):
        self.upstream()
        status, _, _, _ = self.post({"prompt": "hello"})
        self.assertEqual(status, 200)
        request = self.urlopen.call_args.args[0]
        self.assertEqual(json.loads(request.data), {"model": MODEL, "prompt": "hello"})

    def test_preserves_valid_unicode_payload(self):
        self.upstream()
        self.post({"model": MODEL, "prompt": "한국어로 답하세요", "stream": True})
        self.assertEqual(json.loads(self.urlopen.call_args.args[0].data), {
            "model": MODEL, "prompt": "한국어로 답하세요", "stream": True,
        })

    def test_forwards_allowed_metadata_routes(self):
        for path in ("/v1/models", "/api/tags", "/api/version"):
            with self.subTest(path=path):
                self.upstream()
                status, _, _, _ = self.request(path=path)
                self.assertEqual(status, 200)
                request = self.urlopen.call_args.args[0]
                self.assertEqual(request.full_url, UPSTREAM + path)
                self.assertEqual(request.get_method(), "GET")

    def test_does_not_forward_client_credentials_or_headers(self):
        self.upstream()
        self.post({"prompt": "hello"}, headers=[
            ("Cookie", "session=private"), ("X-API-Key", "private"),
            ("X-Forwarded-For", "203.0.113.1"),
        ])
        request = self.urlopen.call_args.args[0]
        self.assertEqual(dict(request.header_items()), {"Content-type": "application/json"})
        self.assertNotIn(API_KEY, repr(request.header_items()))

    def test_rejects_malformed_json(self):
        self.assert_rejected(400, method="POST", path="/api/generate", body=b'{"prompt":')

    def test_rejects_json_values_that_are_not_objects(self):
        for body in (b"[]", b"null", b'"prompt"', b"42"):
            with self.subTest(body=body):
                self.assert_rejected(400, method="POST", path="/api/generate", body=body)

    def test_rejects_nonfinite_json_numbers(self):
        for number in ("NaN", "Infinity", "-Infinity"):
            with self.subTest(number=number):
                self.assert_rejected(400, method="POST", path="/api/generate",
                                     body='{"temperature":' + number + '}')

    def test_rejects_invalid_unicode_payload(self):
        self.assert_rejected(400, method="POST", path="/api/generate",
                             body=b'{"prompt":"\\ud800"}')

    def test_requires_content_length(self):
        self.assert_rejected(411, method="POST", path="/api/generate",
                             body=b"{}", auto_length=False)

    def test_rejects_nonnumeric_content_length(self):
        for length in ("invalid", "-1", "+2", "1_0", "0x02"):
            with self.subTest(length=length):
                self.assert_rejected(411, method="POST", path="/api/generate", body=b"{}",
                                     auto_length=False, headers=[("Content-Length", length)])

    def test_rejects_duplicate_content_length(self):
        self.assert_rejected(411, method="POST", path="/api/generate", body=b"{}",
                             auto_length=False, headers=[("Content-Length", "2"),
                                                         ("Content-Length", "2")])

    def test_rejects_empty_or_oversized_bodies_before_reading(self):
        for length in ("0", str(gateway.MAX_BODY + 1)):
            with self.subTest(length=length):
                self.assert_rejected(413, method="POST", path="/api/generate",
                                     auto_length=False, headers=[("Content-Length", length)])

    def test_rejects_body_shorter_than_declared_length(self):
        self.assert_rejected(400, method="POST", path="/api/generate", body=b"{}",
                             auto_length=False, headers=[("Content-Length", "100")])

    def test_rejects_transfer_encoding_requests(self):
        self.assert_rejected(400, method="POST", path="/api/generate", body=b"{}",
                             headers=[("Transfer-Encoding", "chunked")])

    def test_returns_503_when_upstream_cannot_connect(self):
        self.urlopen.side_effect = urllib.error.URLError("connection refused")
        status, _, body, _ = self.post({"prompt": "hello"})
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body)["error"]["message"], "Ollama is unavailable")

    def test_preserves_upstream_http_error_status_and_body(self):
        headers = Message()
        headers["Content-Type"] = "application/json"
        self.urlopen.side_effect = urllib.error.HTTPError(
            UPSTREAM + "/api/generate", 400, "Bad Request", headers,
            io.BytesIO(b'{"error":"invalid option"}'),
        )
        status, _, body, _ = self.post({"prompt": "hello"})
        self.assertEqual(status, 400)
        self.assertEqual(body, b'{"error":"invalid option"}')

    def test_health_requires_authorization(self):
        self.assert_rejected(401, path="/healthz", authenticated=False)

    def test_health_reports_ready_when_configured_model_exists(self):
        self.upstream(json.dumps({"models": [{"name": MODEL}]}).encode())
        status, _, body, _ = self.request(path="/healthz")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"status": "ok", "model": MODEL})
        self.urlopen.assert_called_once_with(UPSTREAM + "/api/tags", timeout=5)

    def test_health_reports_missing_when_only_other_models_exist(self):
        self.upstream(b'{"models":[{"name":"other-model"}]}')
        status, _, body, _ = self.request(path="/healthz")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"status": "model_missing", "model": MODEL})

    def test_health_returns_503_when_upstream_is_unavailable(self):
        self.urlopen.side_effect = urllib.error.URLError("connection refused")
        status, _, body, _ = self.request(path="/healthz")
        self.assertEqual(status, 503)
        self.assertEqual(json.loads(body), {"status": "ollama_unavailable"})

    def test_health_returns_503_for_malformed_upstream_data(self):
        for data in (b"not-json", b"{}", b'{"models":null}',
                     b'{"models":[null]}', b"[]"):
            with self.subTest(data=data):
                self.upstream(data)
                status, _, body, _ = self.request(path="/healthz")
                self.assertEqual(status, 503)
                self.assertEqual(json.loads(body), {"status": "ollama_unavailable"})

    def test_streams_chunked_response_and_preserves_content_type(self):
        body = b'data: {"text":"hello"}\n\ndata: [DONE]\n\n'
        self.upstream(body, content_type="text/event-stream")
        status, headers, actual, wire = self.post({"prompt": "hello", "stream": True})
        self.assertEqual(status, 200)
        self.assertEqual(actual, body)
        self.assertEqual(headers["Content-Type"], "text/event-stream")
        self.assertEqual(headers["Transfer-Encoding"], "chunked")
        self.assertEqual(headers["X-Accel-Buffering"], "no")
        self.assertNotIn("Content-Length", headers)
        self.assertTrue(wire.endswith(b"0\r\n\r\n"))

    def test_writes_each_stream_chunk_before_reading_the_next(self):
        connection = MemorySocket(self.raw_request(
            method="POST", path="/api/generate", body=b'{"stream":true}',
        ))
        chunks = iter([b"first\n", b"second\n", b""])

        def read_chunk(size):
            chunk = next(chunks)
            if chunk == b"second\n":
                self.assertTrue(connection.output.getvalue().endswith(b"6\r\nfirst\n\r\n"))
            return chunk

        self.upstream(content_type="application/x-ndjson")
        self.urlopen.return_value.read1 = read_chunk
        self.server.RequestHandlerClass(connection, ("127.0.0.1", 12345), self.server)
        response = http.client.HTTPResponse(MemorySocket(connection.output.getvalue()))
        response.begin()
        self.assertEqual(response.read(), b"first\nsecond\n")

    def test_releases_inference_slot_after_upstream_connection_failure(self):
        self.urlopen.side_effect = [urllib.error.URLError("connection refused"), UpstreamResponse()]
        self.assertEqual(self.post({"prompt": "first"})[0], 503)
        self.assertEqual(self.post({"prompt": "second"})[0], 200)

    def test_signals_stream_failure_without_success_terminator(self):
        self.upstream()
        self.urlopen.return_value.read1 = Mock(side_effect=[b"partial\n", OSError("broken stream")])
        with self.assertLogs(gateway.LOG, level="WARNING") as logs:
            wire = self.handle(self.raw_request(method="POST", path="/api/generate", body=b"{}"))
        response = http.client.HTTPResponse(MemorySocket(wire))
        response.begin()
        with self.assertRaises(http.client.IncompleteRead):
            response.read()
        self.assertNotIn(API_KEY, "\n".join(logs.output))

    def test_releases_inference_slot_after_stream_read_failure(self):
        broken = UpstreamResponse()
        broken.read1 = Mock(side_effect=OSError("broken stream"))
        self.urlopen.side_effect = [broken, UpstreamResponse()]
        with self.assertLogs(gateway.LOG, level="WARNING"), \
                self.assertRaises(http.client.IncompleteRead):
            self.post({"prompt": "first"})
        self.assertEqual(self.post({"prompt": "second"})[0], 200)

    def test_returns_429_while_an_inference_stream_is_active(self):
        started = threading.Event()
        release = threading.Event()
        failures = []
        result = []
        self.upstream()

        def blocked_read(size):
            started.set()
            if not release.wait(timeout=3):
                raise AssertionError("Test did not release upstream stream")
            return b""

        self.urlopen.return_value.read1 = blocked_read

        def first_request():
            try:
                result.append(self.post({"prompt": "first"})[0])
            except BaseException as error:
                failures.append(error)

        thread = threading.Thread(target=first_request, daemon=True)
        thread.start()
        try:
            self.assertTrue(started.wait(timeout=3), "First request did not reach upstream")
            self.assertEqual(self.post({"prompt": "second"})[0], 429)
            self.assertEqual(self.urlopen.call_count, 1)
        finally:
            release.set()
            thread.join(timeout=3)
        self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(result, [200])


if __name__ == "__main__":
    unittest.main()

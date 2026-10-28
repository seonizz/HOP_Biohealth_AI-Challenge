import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

from client import LEGACY_MODEL, NoRedirect, chat, selected_model


class ClientConfigurationTests(unittest.TestCase):
    def test_model_selection_preserves_legacy_and_supports_env_and_explicit_v11(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(selected_model(), LEGACY_MODEL)
        with patch.dict(os.environ, {"MALSSI_MODEL": "configured-candidate"}):
            self.assertEqual(selected_model(), "configured-candidate")
            self.assertEqual(selected_model("malssi-gemma4-31b-v11-epoch3"), "malssi-gemma4-31b-v11-epoch3")

    def test_v11_request_uses_selected_model_and_exact_body(self):
        observed = {}
        messages = [{"role": "user", "content": "독립 합성 연결 검사"}]

        class Opener:
            def open(self, request, timeout):
                observed.update(url=request.full_url, body=json.loads(request.data), timeout=timeout,
                                authorization=request.headers["Authorization"])
                return io.BytesIO(b'{"choices":[{"message":{"content":"synthetic"}}]}')

        with patch("client.urllib.request.build_opener", return_value=Opener()):
            result = chat(messages, api_key="synthetic-test-key", model="malssi-gemma4-31b-v11-epoch3",
                          max_tokens=8192, temperature=0.2, timeout=7200)
        self.assertEqual(observed["body"]["model"], "malssi-gemma4-31b-v11-epoch3")
        self.assertEqual(observed["body"]["messages"], messages)
        self.assertEqual(observed["body"]["max_tokens"], 8192)
        self.assertEqual(observed["body"]["temperature"], 0.2)
        self.assertFalse(observed["body"]["stream"])
        self.assertEqual(observed["timeout"], 7200)
        self.assertEqual(result["choices"][0]["message"]["content"], "synthetic")

    def test_redirect_does_not_create_a_request_with_credentials(self):
        request = urllib.request.Request("https://source.invalid/v1/chat/completions",
            data=b"synthetic", headers={"Authorization": "Bearer synthetic-test-key"})
        for code in (301, 302, 303, 307, 308):
            self.assertIsNone(NoRedirect().redirect_request(request, None, code, "redirect", {},
                "https://other.invalid/v1/chat/completions"))

    def test_invalid_endpoint_and_model_fail_before_credential_read_or_connection(self):
        with patch("client.Path.read_text", side_effect=AssertionError("credential read")), \
                patch("client.urllib.request.build_opener", side_effect=AssertionError("connection")):
            for url in ("ftp://host/v1", "http://user:secret@host/v1", "http://host/v1?key=x", "http://host/v1#part"):
                with self.subTest(url=url), self.assertRaises(ValueError):
                    chat([], base_url=url)
            for model in ("", "a b", "a\nb"):
                with self.subTest(model=model), self.assertRaises(ValueError):
                    chat([], model=model)


class ClientHTTPTests(unittest.TestCase):
    def setUp(self):
        self.observed = []
        observed = self.observed

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = self.rfile.read(int(self.headers['Content-Length']))
                observed.append((self.path, json.loads(body)))
                if self.path.startswith('/redirect'):
                    self.send_response(307)
                    self.send_header('Location', '/destination')
                    result = b''
                else:
                    self.send_response(200)
                    result = json.dumps({'model': json.loads(body)['model'],
                        'choices': [{'message': {'content': 'synthetic'}}]}).encode()
                self.send_header('Content-Length', str(len(result)))
                self.end_headers(); self.wfile.write(result)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join()

    def test_v11_uses_real_loopback_http_without_model_generation(self):
        result = chat([{'role': 'user', 'content': 'synthetic'}], api_key='synthetic-test-key',
            model='malssi-gemma4-31b-v11-epoch3',
            base_url=f'http://127.0.0.1:{self.server.server_port}/v1')
        self.assertEqual(result['model'], 'malssi-gemma4-31b-v11-epoch3')
        self.assertEqual(self.observed[0][0], '/v1/chat/completions')

    def test_real_redirect_is_returned_without_second_request(self):
        with self.assertRaises(urllib.error.HTTPError) as caught:
            chat([{'role': 'user', 'content': 'synthetic'}], api_key='synthetic-test-key',
                base_url=f'http://127.0.0.1:{self.server.server_port}/redirect')
        self.assertEqual(caught.exception.code, 307)
        caught.exception.close()
        self.assertEqual(len(self.observed), 1)


if __name__ == "__main__":
    unittest.main()

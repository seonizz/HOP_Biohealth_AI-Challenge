#!/usr/bin/env python3
"""Authenticated localhost gateway for Ollama, published by Tailscale Funnel."""

import argparse
import hmac
import http.client
import json
import logging
from pathlib import Path
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import urllib.error
import urllib.request

GET_ROUTES = {"/v1/models", "/api/tags", "/api/version"}
POST_ROUTES = {
    "/v1/chat/completions", "/v1/completions", "/v1/embeddings",
    "/api/chat", "/api/generate", "/api/embed", "/api/embeddings",
}
MAX_BODY = 8 * 1024 * 1024
LOG = logging.getLogger("gemma-api")


def make_server(config):
    """Create a server; configuration and credentials never appear in logs."""
    api_key = config["api_key"]
    if not isinstance(api_key, str) or len(api_key) < 32 or not api_key.isascii():
        raise ValueError("api_key must contain at least 32 ASCII characters")
    upstream = config["ollama_url"].rstrip("/")
    if upstream != "http://127.0.0.1:11434":
        raise ValueError("ollama_url must be http://127.0.0.1:11434")
    model = config["model"]
    inference_slot = threading.BoundedSemaphore(1)

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "GemmaAPI"
        sys_version = ""

        def log_message(self, format, *args):
            # Do not record URLs, payloads, or Authorization headers.
            pass

        def send_json(self, status, payload):
            data = json.dumps(payload, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            if status == 401:
                self.send_header("WWW-Authenticate", "Bearer")
            self.end_headers()
            self.wfile.write(data)
            self.close_connection = True

        def reject(self, status, message):
            self.send_json(status, {"error": {"message": message, "type": "gateway_error"}})

        def authenticated(self):
            supplied = self.headers.get("Authorization", "")
            return hmac.compare_digest(supplied.encode(), ("Bearer " + api_key).encode())

        def do_GET(self):
            self.handle_request()

        def do_POST(self):
            self.handle_request()

        def do_DELETE(self):
            self.reject(405, "Method not allowed")

        def do_PUT(self):
            self.reject(405, "Method not allowed")

        def do_PATCH(self):
            self.reject(405, "Method not allowed")

        def handle_request(self):
            if not self.authenticated():
                self.reject(401, "A valid Bearer API key is required")
                return
            if self.path == "/healthz" and self.command == "GET":
                try:
                    with urllib.request.urlopen(upstream + "/api/tags", timeout=5) as response:
                        models = json.load(response)["models"]
                    ready = any(item.get("name") == model for item in models)
                    self.send_json(200 if ready else 503, {
                        "status": "ok" if ready else "model_missing", "model": model,
                    })
                except (OSError, ValueError, KeyError, TypeError, AttributeError):
                    self.send_json(503, {"status": "ollama_unavailable"})
                return
            allowed = GET_ROUTES if self.command == "GET" else POST_ROUTES
            if self.path not in allowed:
                self.reject(404, "Endpoint not exposed")
                return
            if self.headers.get("Transfer-Encoding"):
                self.reject(400, "Use Content-Length for request bodies")
                return
            body = None
            if self.command == "POST":
                lengths = self.headers.get_all("Content-Length", [])
                try:
                    if len(lengths) != 1:
                        raise ValueError
                    if not lengths[0].isascii() or not lengths[0].isdecimal():
                        raise ValueError
                    length = int(lengths[0])
                except ValueError:
                    self.reject(411, "A valid Content-Length is required")
                    return
                if length <= 0 or length > MAX_BODY:
                    self.reject(413, "Request body must be between 1 byte and 8 MiB")
                    return
                try:
                    raw = self.rfile.read(length)
                    if len(raw) != length:
                        raise ValueError
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        raise ValueError
                except (ValueError, OSError):
                    self.reject(400, "Request body must be a JSON object")
                    return
                requested_model = payload.get("model", model)
                if requested_model != model:
                    self.reject(400, "Only " + model + " is available")
                    return
                payload["model"] = model
                try:
                    body = json.dumps(payload, ensure_ascii=False, allow_nan=False).encode()
                except (ValueError, UnicodeError):
                    self.reject(400, "Request body must contain valid JSON values")
                    return
            acquired = False
            if self.command == "POST":
                acquired = inference_slot.acquire(blocking=False)
                if not acquired:
                    self.reject(429, "Model is busy; retry after the current request completes")
                    return
            try:
                self.forward(body)
            finally:
                if acquired:
                    inference_slot.release()

        def forward(self, body):
            request = urllib.request.Request(
                upstream + self.path, data=body, method=self.command,
                headers={"Content-Type": "application/json"},
            )
            try:
                response = urllib.request.urlopen(request, timeout=600)
            except urllib.error.HTTPError as exc:
                response = exc
            except OSError:
                self.reject(503, "Ollama is unavailable")
                return
            with response:
                self.send_response(response.code)
                self.send_header("Content-Type", response.headers.get("Content-Type", "application/json"))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Connection", "close")
                self.end_headers()
                self.close_connection = True
                try:
                    while chunk := response.read1(65536):
                        self.wfile.write(f"{len(chunk):X}\r\n".encode() + chunk + b"\r\n")
                        self.wfile.flush()
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                except (OSError, http.client.HTTPException):
                    # Closing an unfinished chunked response signals failure to the client.
                    LOG.warning("Client disconnected or upstream stream ended unexpectedly")

    class Server(ThreadingHTTPServer):
        daemon_threads = True

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(30)
            return connection, address

    return Server(("127.0.0.1", config.get("port", 11435)), Handler)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--start-ollama", action="store_true", help="Open Ollama on macOS if needed")
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.start_ollama:
        try:
            with urllib.request.urlopen(config["ollama_url"] + "/api/version", timeout=3):
                pass
        except OSError:
            subprocess.run(["/usr/bin/open", "-g", "-a", "/Applications/Ollama.app"], check=True)
    server = make_server(config)
    LOG.info("Gemma gateway listening on 127.0.0.1:%s, model=%s", server.server_port, config["model"])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

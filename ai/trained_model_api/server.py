#!/usr/bin/env python3
"""Authenticated, text-only chat API for the evaluated step-100 model."""

import argparse
from datetime import datetime, timedelta, timezone
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import logging
from logging.handlers import RotatingFileHandler
import math
import os
from pathlib import Path
import secrets
import select
import signal
import socket
import time
import uuid

from backend import ModelBackend, RequestError, BackendUnavailableError
from inference_queue import (InferenceQueue, queue_limits, QueueFull, QueueClosed,
                             RequestCancelled, BackendUnavailable)

HERE = Path(__file__).resolve().parent
MAX_BODY_BYTES = 8 * 1024 * 1024
LOG = logging.getLogger("trained-model-api")
KST = timezone(timedelta(hours=9))


def timestamp():
    return datetime.now(KST).isoformat(timespec="milliseconds")


class PrivateRotatingFileHandler(RotatingFileHandler):
    def _open(self):
        fd = os.open(self.baseFilename, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        return os.fdopen(fd, self.mode, encoding=self.encoding, errors=self.errors)


def make_timing_logger(path):
    path = Path(path)
    if path.is_symlink() or path.parent != path.parent.resolve():
        raise ValueError("Timing log must not traverse symlinks")
    logger = logging.Logger("api-request-timing", level=logging.INFO)
    handler = PrivateRotatingFileHandler(path, maxBytes=10 * 1024 * 1024, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
    return logger


def validate_config(config):
    queue_limits(config)
    if type(config.get("require_backend_status", False)) is not bool:
        raise ValueError("Invalid require_backend_status")
    if config.get("host") != "127.0.0.1":
        raise ValueError("Bind to 127.0.0.1 and use an SSH tunnel for remote access")
    for key in ("port", "checkpoint_step", "max_context_tokens", "max_output_tokens", "default_output_tokens"):
        if type(config.get(key)) is not int or config[key] <= 0:
            raise ValueError("Invalid configuration: " + key)
    chunk = config.get("prefill_chunk_size")
    if chunk is not None and (type(chunk) is not int or not 1 <= chunk <= config["max_context_tokens"]):
        raise ValueError("Invalid prefill_chunk_size")
    if config["port"] > 65535:
        raise ValueError("Invalid port")
    if not config["default_output_tokens"] <= config["max_output_tokens"] < config["max_context_tokens"]:
        raise ValueError("Invalid token budgets")
    if not isinstance(config.get("model_id"), str) or not config["model_id"]:
        raise ValueError("Invalid model_id")
    profile = config.get("training_profile")
    if profile is not None:
        if profile != "supporter-v11":
            raise ValueError("Unsupported training_profile")
        from supporter_backend import validate_profile_config
        validate_profile_config(config)
    return config


def load_backend(config, runtime):
    if config.get("training_profile") == "supporter-v11":
        from supporter_backend import SupporterV11Backend
        return SupporterV11Backend(config, runtime)
    if config.get("training_profile") is not None:
        raise ValueError("Unsupported training_profile")
    return ModelBackend(config, runtime)


def validate_request(payload, config):
    if not isinstance(payload, dict):
        raise RequestError("Request body must be a JSON object")
    allowed = {"model", "messages", "max_tokens", "temperature", "top_p", "stream", "n"}
    if set(payload) - allowed:
        raise RequestError("Unsupported request fields: " + ", ".join(sorted(set(payload) - allowed)))
    if payload.get("model", config["model_id"]) != config["model_id"]:
        raise RequestError("Only " + config["model_id"] + " is available")
    if type(payload.get("stream", False)) is not bool or payload.get("stream", False):
        raise RequestError("Only stream:false is supported")
    if type(payload.get("n", 1)) is not int or payload.get("n", 1) != 1:
        raise RequestError("Only n:1 is supported")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not 1 <= len(messages) <= 128:
        raise RequestError("messages must contain 1 to 128 text messages")
    expected = "user"
    for i, message in enumerate(messages):
        if not isinstance(message, dict) or set(message) != {"role", "content"}:
            raise RequestError("Each message requires exactly role and content")
        if not isinstance(message["content"], str) or not message["content"].strip():
            raise RequestError("Message content must be a non-empty string")
        if i == 0 and message["role"] == "system":
            continue
        if message["role"] != expected:
            raise RequestError("After an optional system message, alternate user and assistant messages")
        expected = "assistant" if expected == "user" else "user"
    if messages[-1]["role"] != "user":
        raise RequestError("The final message must have role user")
    max_tokens = payload.get("max_tokens", config["default_output_tokens"])
    if type(max_tokens) is not int or not 1 <= max_tokens <= config["max_output_tokens"]:
        raise RequestError(f"max_tokens must be between 1 and {config['max_output_tokens']}")
    temperature, top_p = payload.get("temperature", 0), payload.get("top_p", 1)
    for name, value, low, high in (("temperature", temperature, 0, 2), ("top_p", top_p, 0, 1)):
        if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
            raise RequestError("Invalid " + name)
    if top_p == 0:
        raise RequestError("top_p must be greater than zero")
    return messages, max_tokens, temperature, top_p


def make_server(config, backend, api_key, timing_log=None):
    admission = InferenceQueue(*queue_limits(config))
    require_status = config.get("require_backend_status", False)
    if type(require_status) is not bool:
        raise ValueError("Invalid require_backend_status")
    if require_status and not callable(getattr(backend, "inference_status", None)):
        raise ValueError("Backend inference_status is required")

    def backend_status():
        # A remote wrapper supplies a read-only status derived from its existing
        # worker state. Absence preserves the synchronous local-backend contract.
        hook = getattr(backend, "inference_status", None)
        if hook is None:
            return "ready"
        try:
            value = hook()
            status = value.get("status") if isinstance(value, dict) else None
            return status if status in {"ready", "busy", "draining", "unavailable"} else "unavailable"
        except Exception:
            return "unavailable"

    class Handler(BaseHTTPRequestHandler):
        server_version, sys_version = "MalssiAPI", ""

        def log_message(self, *args):
            pass  # Request details go only to the explicit private JSONL log.

        def reply(self, status, body):
            data = json.dumps(body, ensure_ascii=False, allow_nan=False).encode()
            self.response_status = status
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            if status == 401:
                self.send_header("WWW-Authenticate", "Bearer")
            if status == 429:
                self.send_header("Retry-After", "5")
            self.end_headers()
            self.wfile.write(data)
            self.response_sent = True
            self.close_connection = True

        def reject(self, status, message):
            self.reply(status, {"error": {"message": message, "type": "invalid_request_error" if status < 500 else "server_error"}})

        def authenticated(self):
            supplied = self.headers.get_all("Authorization", [])
            if len(supplied) != 1 or not hmac.compare_digest(supplied[0].encode(), ("Bearer " + api_key).encode()):
                self.reject(401, "A valid Bearer API key is required")
                return False
            return True

        def disconnected(self):
            try:
                readable, _, _ = select.select([self.connection], [], [], 0)
                return bool(readable) and self.connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
            except (OSError, ValueError):
                return True

        def do_GET(self):
            if not self.authenticated():
                return
            if self.path == "/healthz":
                status = backend_status()
                state = admission.snapshot()
                if state["closed"]:
                    status = "unavailable"
                elif status == "ready" and state["active"]:
                    status = "busy"
                self.reply(200 if status in {"ready", "busy"} else 503,
                                {"status": status, "model": config["model_id"],
                                 "checkpoint_step": config["checkpoint_step"],
                                 "checkpoint_sha256": config["checkpoint_sha256"],
                                 "max_context_tokens": config["max_context_tokens"],
                                 "max_output_tokens": config["max_output_tokens"],
                                 "inference_queue": state})
            elif self.path == "/v1/models":
                self.reply(200, {"object": "list", "data": [{"id": config["model_id"], "object": "model", "created": 0, "owned_by": "local"}]})
            else:
                self.reject(404, "Endpoint not found")

        def do_POST(self):
            if self.path != "/v1/chat/completions" or timing_log is None:
                return self.handle_chat_request()
            started = time.monotonic()
            self.timing = {"request_id": uuid.uuid4().hex, "model": config["model_id"],
                           "received_at": timestamp()}
            self.response_status = None
            self.response_sent = False
            timing_log.info(json.dumps({**self.timing, "event": "received"}))
            try:
                self.handle_chat_request()
            finally:
                timing_log.info(json.dumps({**self.timing, "event": "completed",
                    "completed_at": timestamp(), "elapsed_seconds": round(time.monotonic() - started, 6),
                    "status_code": self.response_status, "response_sent": self.response_sent}, ensure_ascii=False))

        def handle_chat_request(self):
            if not self.authenticated():
                return
            if self.path != "/v1/chat/completions":
                self.reject(404, "Endpoint not found")
                return
            if self.headers.get("Transfer-Encoding"):
                self.reject(400, "Use Content-Length for request bodies")
                return
            lengths = self.headers.get_all("Content-Length", [])
            if len(lengths) != 1 or len(lengths[0]) > 10 or not lengths[0].isascii() or not lengths[0].isdecimal():
                self.reject(411, "A valid Content-Length is required")
                return
            length = int(lengths[0])
            if not 1 <= length <= MAX_BODY_BYTES:
                self.reject(413, "Request body must be between 1 byte and 8 MiB")
                return
            if self.headers.get_content_type() != "application/json":
                self.reject(415, "Content-Type must be application/json")
                return
            try:
                raw = self.rfile.read(length)
                if hasattr(self, "timing"):
                    self.timing["input_received_at"] = timestamp()
                if len(raw) != length:
                    raise RequestError("Incomplete request body")
                values = validate_request(json.loads(raw), config)
            except TimeoutError:
                self.reject(408, "Request body timed out")
                return
            except RequestError as exc:
                self.reject(400, str(exc))
                return
            except (ValueError, UnicodeError, RecursionError):
                self.reject(400, "Invalid JSON body")
                return
            if hasattr(self, "timing"):
                messages, max_tokens, temperature, top_p = values
                timing_log.info(json.dumps({**self.timing, "event": "input", "messages": messages,
                    "max_tokens": max_tokens, "temperature": temperature, "top_p": top_p}, ensure_ascii=False))
            try:
                permit = admission.acquire(length, cancelled=self.disconnected,
                                           ready=lambda: backend_status() == "ready")
            except QueueFull:
                self.reject(429, "Model is busy; retry after the current request completes")
                return
            except (QueueClosed, BackendUnavailable):
                self.reject(503, "Model is not ready for inference")
                return
            except RequestCancelled:
                self.close_connection = True
                return
            try:
                if self.disconnected():
                    self.close_connection = True
                    return
                if backend_status() != "ready":
                    self.reject(503, "Model is not ready for inference")
                    return
                inference_started = time.monotonic()
                if hasattr(self, "timing"):
                    self.timing["inference_started_at"] = timestamp()
                try:
                    result = backend.generate(*values)
                finally:
                    if hasattr(self, "timing"):
                        self.timing.update(inference_finished_at=timestamp(),
                            inference_elapsed_seconds=round(time.monotonic() - inference_started, 6))
                prompt, completion = result["prompt_tokens"], result["completion_tokens"]
                if hasattr(self, "timing"):
                    self.timing.update(prompt_tokens=prompt, completion_tokens=completion,
                        total_tokens=prompt + completion, finish_reason=result["finish_reason"], output=result["text"])
                self.reply(200, {
                    "id": "chatcmpl-" + uuid.uuid4().hex, "object": "chat.completion", "created": int(time.time()),
                    "model": config["model_id"], "system_fingerprint": "step-" + str(config["checkpoint_step"]) + "-" + config["checkpoint_sha256"][:12],
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": result["text"]}, "finish_reason": result["finish_reason"]}],
                    "usage": {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion},
                })
            except BackendUnavailableError:
                self.reject(503, "Model is not ready for inference")
            except RequestError as exc:
                self.reject(400, str(exc))
            except (BrokenPipeError, ConnectionResetError):
                pass
            except Exception as exc:
                LOG.error("Inference failed: %s", type(exc).__name__)
                self.reject(500, "Inference failed; see server status")
            finally:
                # The physical slot is released only after generate returns.
                # A remote wrapper with an uncertain termination remains
                # draining/unavailable; the next acquire must observe ready.
                admission.release(permit)

    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True

        def shutdown(self):
            admission.close()
            super().shutdown()

        def server_close(self):
            admission.close()
            super().server_close()

        def get_request(self):
            connection, address = super().get_request()
            connection.settimeout(30)
            return connection, address

    server = Server((config["host"], config["port"]), Handler)
    server.inference_queue = admission
    return server


def load_api_key(runtime):
    key = os.environ.get("MALSSI_API_KEY")
    if key is None:
        path = runtime / "api_key"
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            if path.is_symlink() or path.stat().st_mode & 0o077:
                raise ValueError("runtime/api_key must be a private regular file (mode 600)")
            key = path.read_text().strip()
        else:
            key = secrets.token_urlsafe(32)
            with os.fdopen(fd, "w") as stream:
                stream.write(key + "\n")
    if not isinstance(key, str) or len(key) < 32 or not key.isascii() or any(c.isspace() for c in key):
        raise ValueError("MALSSI_API_KEY must contain at least 32 non-whitespace ASCII characters")
    return key


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, default=HERE / "config.json")
    parser.add_argument("--verify-chunking", action="store_true", help="Check a synthetic full/chunk response before serving")
    args = parser.parse_args()
    config = validate_config(json.loads(args.config.read_text()))
    runtime = HERE / "runtime"
    if runtime != runtime.resolve():
        raise ValueError("runtime must not traverse symlinks")
    runtime.mkdir(mode=0o700, exist_ok=True)
    key = load_api_key(runtime)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    timing_log = make_timing_logger(runtime / "request_timings.jsonl")
    def stop(signum, frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, stop)
    # Fail on an occupied port before spending time or VRAM loading the model.
    # Bind-only preflight never serves requests or advertises backend readiness.
    server = make_server({**config, "require_backend_status": False}, None, key)
    server.server_close()
    status_path = runtime / "status.json"
    status_path.write_text(json.dumps({"status": "loading", "pid": os.getpid()}) + "\n")
    backend = None
    server = None
    try:
        backend = load_backend(config, runtime)
        if args.verify_chunking:
            from verify_prefill import verify_prefill
            verify_prefill(backend, HERE / "prefill_verification.json")
        server = make_server(config, backend, key, timing_log=timing_log)
        status_path.write_text(json.dumps({"status": "ready", "pid": os.getpid(), "model": config["model_id"],
            "checkpoint_step": config["checkpoint_step"], "checkpoint_sha256": config["checkpoint_sha256"],
            "adapter_parameters_sha256": backend.adapter_sha256, "port": config["port"]}, indent=2) + "\n")
        LOG.info("Ready: http://%s:%s/v1 model=%s", config["host"], config["port"], config["model_id"])
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if server is not None:
            server.server_close()
        if backend is not None:
            backend.close()
        status_path.write_text(json.dumps({"status": "stopped", "pid": os.getpid()}) + "\n")
        for handler in timing_log.handlers:
            handler.close()


if __name__ == "__main__":
    main()

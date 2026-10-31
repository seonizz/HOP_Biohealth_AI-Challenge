#!/usr/bin/env python3
"""Opt-in local HTTP bridge for an explicitly reviewed remote worker command.

Importing this module does not read configuration, create secrets, start a
worker, or bind a server. The JSON configuration has ``api`` (server settings)
and ``worker`` (RemoteWorker arguments) objects. Expected identity uses the
worker's ready-event field names, with no implicit checkpoint/path selection.
The key file is an existing UTF-8 file containing only the bearer key.
"""

import argparse
from copy import deepcopy
import json
from pathlib import Path
import signal
import subprocess

from remote_worker import RemoteWorker
from server import make_server, validate_config


def create_guarded_bridge(config, api_key, *, process_factory=subprocess.Popen,
                          server_factory=make_server):
    """Create a bound server and dormant worker; the caller explicitly starts it."""
    if not isinstance(config, dict) or set(config) != {"api", "worker"}:
        raise ValueError("Bridge configuration requires api and worker objects")
    if not isinstance(config["api"], dict) or not isinstance(config["worker"], dict):
        raise ValueError("Bridge configuration requires api and worker objects")
    if (not isinstance(api_key, str) or len(api_key) < 32 or not api_key.isascii() or
            any(c.isspace() or not c.isprintable() for c in api_key)):
        raise ValueError("An explicit valid API key is required")
    options = deepcopy(config["worker"])
    allowed = {"command", "expected", "startup_timeout", "generation_timeout", "cancel_grace", "close_grace", "send_timeout"}
    if set(options) - allowed or not {"command", "expected"} <= options.keys():
        raise ValueError("Invalid worker configuration fields")
    worker = RemoteWorker(**options, process_factory=process_factory)
    api = deepcopy(config["api"])
    if api.get("require_backend_status", True) is not True:
        raise ValueError("The remote bridge requires backend readiness status")
    api["require_backend_status"] = True
    api.setdefault("inference_queue_max_requests", 8)
    api.setdefault("inference_queue_max_bytes", 16 * 1024 * 1024)
    validate_config(api)
    if api["inference_queue_max_requests"] < 1:
        raise ValueError("The remote bridge requires a bounded waiting queue")
    for key in ("checkpoint_sha256", "checkpoint_step", "max_input_tokens", "max_output_tokens", "max_context_tokens"):
        if type(api.get(key)) is not type(worker.expected[key]) or api.get(key) != worker.expected[key]:
            raise ValueError("API and worker identity or limits differ: " + key)
    server = server_factory(api, worker, api_key, timing_log=None)
    original_handler = server.RequestHandlerClass

    class Handler(original_handler):
        def handle_chat_request(self):
            worker.context.connection = self.connection
            try:
                return super().handle_chat_request()
            finally:
                worker.context.connection = None

    server.RequestHandlerClass = Handler
    return server, worker


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    parser.add_argument("--key-file", required=True, type=Path)
    args = parser.parse_args(argv)
    config = json.loads(args.config.read_text(encoding="utf-8"))
    api_key = args.key_file.read_text(encoding="utf-8").strip()
    server, worker = create_guarded_bridge(config, api_key)

    def stop(signum, frame):
        raise KeyboardInterrupt

    previous = {}
    try:
        for signum in (signal.SIGINT, signal.SIGTERM):
            previous[signum] = signal.signal(signum, stop)
        worker.start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            server.server_close()
        finally:
            try:
                worker.close()
            finally:
                for signum, handler in previous.items():
                    signal.signal(signum, handler)


if __name__ == "__main__":
    main()

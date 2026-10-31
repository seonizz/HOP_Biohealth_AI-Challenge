"""Remote bridge tests: fake stdio and loopback HTTP, no SSH or model."""

from copy import deepcopy
import http.client
import importlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import uuid

from backend import BackendUnavailableError, RequestError
import guarded_bridge
from remote_worker import PROTOCOL, RemoteWorker
from server import make_server


EXPECTED = {
    "checkpoint_sha256": "a" * 64, "adapter_sha256": "b" * 64,
    "checkpoint_path": "/reviewed/checkpoint", "checkpoint_step": 100,
    "max_input_tokens": 65536, "max_output_tokens": 8192,
    "max_context_tokens": 69632, "gpu_only": True, "terminal_reply_after_idle": True,
}
RESULT = {"text": "synthetic answer", "prompt_tokens": 8, "completion_tokens": 2, "finish_reason": "stop"}
MESSAGES = [{"role": "user", "content": "synthetic input"}]
KEY = "synthetic-key-for-local-tests-only-0000"


def wait_until(predicate, timeout=1):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        threading.Event().wait(0.005)
    raise AssertionError("Timed out waiting for fake worker state")


class FakeReader:
    def __init__(self):
        reader, writer = os.pipe()
        self.stream = os.fdopen(reader, "rb", buffering=0)
        self.writer = os.fdopen(writer, "wb", buffering=0)

    @property
    def closed(self):
        return self.stream.closed

    def fileno(self):
        return self.stream.fileno()

    def readline(self, size):
        raise AssertionError("Buffered readline must not be used")

    def close(self):
        self.stream.close()

    def eof(self):
        self.writer.close()


class FakeWriter:
    def __init__(self, process):
        self.process = process
        reader, writer = os.pipe()
        self.reader = os.fdopen(reader, "rb", buffering=0)
        self.stream = os.fdopen(writer, "wb", buffering=0)

    @property
    def closed(self):
        return self.stream.closed

    def fileno(self):
        return self.stream.fileno()

    def write(self, text):
        raise AssertionError("Buffered write must not be used")

    def flush(self):
        raise AssertionError("Buffered flush must not be used")

    def close(self):
        self.stream.close()
        if self.process.stop_on_close:
            self.process.finish()


class FakeProcess:
    def __init__(self, stop_on_close=True, consume=True, keep_stdout_open=False):
        self.pid = 1234
        self.returncode = None
        self.sent = queue.Queue()
        self.stdout = FakeReader()
        self.stdin = FakeWriter(self)
        self.done = threading.Event()
        self.stop_on_close = stop_on_close
        self.keep_stdout_open = keep_stdout_open
        self.terminate_calls = 0
        self.pump = threading.Thread(target=self._consume, daemon=True) if consume else None
        if self.pump:
            self.pump.start()

    def _consume(self):
        try:
            while True:
                line = self.stdin.reader.readline()
                if not line:
                    return
                try:
                    self.sent.put(json.loads(line))
                except ValueError:
                    pass
        except (OSError, ValueError):
            pass
        finally:
            self.stdin.reader.close()

    def emit(self, kind, **fields):
        try:
            self.stdout.writer.write((json.dumps({"protocol": PROTOCOL, "kind": kind, **fields}) + "\n").encode())
        except (OSError, ValueError):
            pass

    def poll(self):
        return self.returncode

    def finish(self):
        if self.returncode is not None:
            return
        self.returncode = 0
        self.done.set()
        if not self.keep_stdout_open:
            self.stdout.eof()

    def wait(self, timeout):
        if not self.done.wait(timeout):
            raise subprocess.TimeoutExpired("synthetic-worker", timeout)
        return self.returncode

    def terminate(self):
        self.terminate_calls += 1
        self.finish()

    def dispose(self):
        self.stdin.close()
        self.stdout.close()
        self.stdout.eof()
        if self.pump:
            self.pump.join(1)
        self.stdin.reader.close()


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.workers = []
        self.threads = []

    def tearDown(self):
        for worker in self.workers:
            worker.close()
        for thread in self.threads:
            thread.join(1)
            self.assertFalse(thread.is_alive())

    def worker(self, *, ready=None, process=None, **options):
        process = process or FakeProcess()
        self.addCleanup(process.dispose)
        calls = []

        def factory(*args, **kwargs):
            calls.append((args, kwargs))
            if ready is not False:
                process.emit("ready", **(EXPECTED if ready is None else ready))
            return process

        worker = RemoteWorker(["reviewed-ssh-command", "explicit-argument"], EXPECTED,
            process_factory=factory, startup_timeout=0.2, cancel_grace=0.05,
            close_grace=0.01, **options)
        self.workers.append(worker)
        return worker, process, calls

    def generate(self, worker, *, connection=None, cancel_event=None):
        outcome = {}

        def run():
            worker.context.connection = connection
            worker.context.cancel_event = cancel_event
            try:
                outcome["result"] = worker.generate(MESSAGES, 32, 0, 1)
            except Exception as error:
                outcome["error"] = error

        thread = threading.Thread(target=run, daemon=True)
        self.threads.append(thread)
        thread.start()
        return thread, outcome

    def sent(self, process, op):
        message = process.sent.get(timeout=1)
        self.assertEqual(message["op"], op)
        self.assertEqual(uuid.UUID(hex=message["id"]).hex, message["id"])
        return message

    def test_construction_health_and_generate_never_spawn(self):
        worker, process, calls = self.worker()
        self.assertIsNone(worker.generation_timeout)
        for _ in range(3):
            self.assertEqual(worker.inference_status(), {"status": "unavailable"})
        with self.assertRaisesRegex(RequestError, "not verified idle"):
            worker.generate(MESSAGES, 32, 0, 1)
        self.assertEqual(calls, [])
        worker.start()
        self.assertEqual(worker.inference_status(), {"status": "ready"})
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][0][0], ["reviewed-ssh-command", "explicit-argument"])
        self.assertEqual(calls[0][1]["stderr"], subprocess.DEVNULL)
        with self.assertRaisesRegex(RequestError, "one-shot"):
            worker.start()
        self.assertEqual(len(calls), 1)

    def test_every_expected_field_is_verified_and_mismatch_closes_owned_child(self):
        for field in EXPECTED:
            with self.subTest(field=field):
                ready = deepcopy(EXPECTED)
                ready[field] = "mismatch"
                worker, process, calls = self.worker(ready=ready)
                with self.assertRaisesRegex(RequestError, "not verified"):
                    worker.start()
                self.assertEqual(worker.inference_status(), {"status": "unavailable"})
                self.assertIsNotNone(process.poll())
                self.assertEqual(len(calls), 1)

    def test_identity_compares_types_and_additional_expected_fields(self):
        worker, process, _ = self.worker(ready={**EXPECTED, "checkpoint_step": 100.0})
        with self.assertRaises(RequestError):
            worker.start()
        worker, process, _ = self.worker()
        worker.expected["campaign_sha256"] = "c" * 64
        with self.assertRaises(RequestError):
            worker.start()

    def test_legacy_ready_without_terminal_after_idle_capability_is_rejected(self):
        for capability in (None, False):
            with self.subTest(capability=capability):
                ready = deepcopy(EXPECTED)
                if capability is None:
                    del ready["terminal_reply_after_idle"]
                else:
                    ready["terminal_reply_after_idle"] = capability
                worker, _, _ = self.worker(ready=ready)
                with self.assertRaises(BackendUnavailableError):
                    worker.start()
        with self.assertRaises(ValueError):
            RemoteWorker(["reviewed-command"], {**EXPECTED, "terminal_reply_after_idle": False})

    def test_missing_ready_times_out_without_reload(self):
        worker, process, calls = self.worker(ready=False)
        with self.assertRaisesRegex(RequestError, "not verified"):
            worker.start()
        self.assertEqual(len(calls), 1)
        self.assertIsNotNone(process.poll())

    def test_one_inflight_request_and_unchanged_payload_result(self):
        worker, process, _ = self.worker()
        worker.start()
        thread, outcome = self.generate(worker)
        request = self.sent(process, "generate")
        self.assertEqual(request["payload"], {"messages": MESSAGES, "max_tokens": 32, "temperature": 0, "top_p": 1})
        self.assertEqual(worker.inference_status(), {"status": "busy"})
        with self.assertRaisesRegex(RequestError, "not verified idle"):
            worker.generate(MESSAGES, 32, 0, 1)
        self.assertTrue(process.sent.empty())
        # No implicit whole-generation deadline is installed.
        thread.join(0.08)
        self.assertTrue(thread.is_alive())
        self.assertTrue(process.sent.empty())
        process.emit("reply", id=request["id"], ok=True, result=RESULT)
        thread.join(1)
        self.assertEqual(outcome, {"result": RESULT})
        self.assertEqual(worker.inference_status(), {"status": "ready"})

    def test_cancel_ack_does_not_release_and_late_reply_is_never_new_result(self):
        worker, process, _ = self.worker()
        worker.start()
        thread, outcome = self.generate(worker)
        request = self.sent(process, "generate")
        self.assertFalse(worker.cancel("wrong-id"))
        self.assertTrue(worker.cancel(request["id"]))
        cancel = self.sent(process, "cancel")
        self.assertEqual(cancel["target_id"], request["id"])
        self.assertNotEqual(cancel["id"], request["id"])
        process.emit("reply", id=cancel["id"], ok=True,
                     result={"cancel_accepted": True, "target_id": request["id"]})
        thread.join(1)
        self.assertIsInstance(outcome.get("error"), RequestError)
        self.assertIn("still draining", str(outcome["error"]))
        self.assertEqual(worker.inference_status(), {"status": "draining"})
        with self.assertRaises(RequestError):
            worker.generate(MESSAGES, 32, 0, 1)
        process.emit("reply", id="wrong-id", ok=True, result=RESULT)
        self.assertEqual(worker.inference_status(), {"status": "draining"})
        process.emit("reply", id=request["id"], ok=False,
                     error={"type": "cancelled", "message": "synthetic private detail"})
        wait_until(lambda: worker.inference_status()["status"] == "ready")
        second, second_outcome = self.generate(worker)
        next_request = self.sent(process, "generate")
        self.assertNotEqual(next_request["id"], request["id"])
        process.emit("reply", id=request["id"], ok=True, result=RESULT)
        process.emit("reply", id=cancel["id"], ok=True, result=RESULT)
        second.join(0.08)
        self.assertTrue(second.is_alive())
        self.assertEqual(worker.inference_status(), {"status": "busy"})
        final_result = {**RESULT, "text": "second synthetic answer"}
        process.emit("reply", id=next_request["id"], ok=True, result=final_result)
        second.join(1)
        self.assertEqual(second_outcome, {"result": final_result})
        self.assertNotIn("result", outcome)

    def test_disconnect_explicit_cancel_and_timeout_target_exact_request(self):
        for trigger in ("disconnect", "event", "timeout"):
            with self.subTest(trigger=trigger):
                stopped = threading.Event()
                connection = object()
                worker, process, _ = self.worker(
                    generation_timeout=0.02 if trigger == "timeout" else None,
                    disconnected=lambda value: stopped.is_set() and trigger == "disconnect")
                worker.start()
                thread, outcome = self.generate(worker, connection=connection,
                    cancel_event=stopped if trigger == "event" else None)
                request = self.sent(process, "generate")
                stopped.set()
                cancel = self.sent(process, "cancel")
                self.assertEqual(cancel["target_id"], request["id"])
                self.assertEqual(worker.inference_status(), {"status": "draining"})
                process.emit("reply", id=request["id"], ok=True, result=RESULT)
                thread.join(1)
                self.assertIsInstance(outcome.get("error"), RequestError)
                self.assertNotIn("result", outcome)
                self.assertEqual(worker.inference_status(), {"status": "ready"})

    def test_eof_and_process_exit_never_restart_or_restore_ready(self):
        for failure in ("eof", "exit", "pid_change"):
            with self.subTest(failure=failure):
                worker, process, calls = self.worker()
                worker.start()
                thread, outcome = self.generate(worker)
                request = self.sent(process, "generate")
                if failure == "eof":
                    process.stdout.close()
                elif failure == "exit":
                    process.finish()
                else:
                    process.pid += 1
                wait_until(lambda: worker.inference_status()["status"] == "unavailable")
                thread.join(1)
                self.assertIsInstance(outcome.get("error"), RequestError)
                process.emit("reply", id=request["id"], ok=True, result=RESULT)
                with self.assertRaises(RequestError):
                    worker.generate(MESSAGES, 32, 0, 1)
                self.assertEqual(worker.inference_status(), {"status": "unavailable"})
                self.assertEqual(len(calls), 1)

    def test_send_failure_quarantines_even_if_late_reply_arrives(self):
        worker, process, calls = self.worker()
        worker.start()
        write = os.write

        def fail_after_write(fd, data):
            write(fd, data)
            raise BrokenPipeError("synthetic private transport detail")

        with patch("remote_worker.os.write", side_effect=fail_after_write):
            with self.assertRaisesRegex(BackendUnavailableError, "channel is unavailable"):
                worker.generate(MESSAGES, 32, 0, 1)
        request = self.sent(process, "generate")
        process.emit("reply", id=request["id"], ok=True, result=RESULT)
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})
        self.assertEqual(len(calls), 1)

    def test_new_ready_event_cannot_silently_reload_identity(self):
        worker, process, _ = self.worker()
        worker.start()
        process.emit("ready", **EXPECTED)
        wait_until(lambda: worker.inference_status()["status"] == "unavailable")

    def test_budget_errors_are_safe_and_fatal_errors_quarantine(self):
        cases = [
            ("invalid_request", "Prompt exceeds the v11 input budget; no text was truncated", "ready"),
            ("invalid_request", "synthetic private prompt or path", "ready"),
            ("generation_failed", "synthetic private traceback", "unavailable"),
            ("eof", "synthetic private traceback", "unavailable"),
        ]
        for error_type, message, status in cases:
            with self.subTest(error_type=error_type, message=message):
                worker, process, _ = self.worker()
                worker.start()
                thread, outcome = self.generate(worker)
                request = self.sent(process, "generate")
                process.emit("reply", id=request["id"], ok=False, error={"type": error_type, "message": message})
                thread.join(1)
                error = outcome.get("error")
                self.assertIsInstance(error, RequestError)
                self.assertNotIn("synthetic private", str(error))
                if message.startswith("Prompt"):
                    self.assertEqual(str(error), message)
                self.assertEqual(worker.inference_status(), {"status": status})

    def test_malformed_terminal_reply_quarantines(self):
        for payload in ({"ok": True, "result": {"text": "partial"}}, {"ok": False}, {"ok": 1, "result": RESULT}):
            with self.subTest(payload=payload):
                worker, process, _ = self.worker()
                worker.start()
                thread, outcome = self.generate(worker)
                request = self.sent(process, "generate")
                process.emit("reply", id=request["id"], **payload)
                thread.join(1)
                self.assertIsInstance(outcome.get("error"), RequestError)
                self.assertEqual(worker.inference_status(), {"status": "unavailable"})

    def test_close_sends_shutdown_then_only_terminates_owned_child_if_needed(self):
        process = FakeProcess(stop_on_close=False)
        worker, process, calls = self.worker(process=process)
        worker.start()
        worker.close()
        self.sent(process, "shutdown")
        self.assertEqual(process.terminate_calls, 1)
        self.assertTrue(process.stdin.closed)
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})
        worker.close()
        self.assertEqual(process.terminate_calls, 1)
        self.assertEqual(len(calls), 1)

    @staticmethod
    def fill_stdin(process):
        while True:
            try:
                os.write(process.stdin.fileno(), b"x" * 65536)
            except BlockingIOError:
                return

    def test_full_stdin_send_is_bounded_and_quarantines_without_generation_deadline(self):
        process = FakeProcess(stop_on_close=False, consume=False)
        worker, process, calls = self.worker(process=process, send_timeout=0.03)
        worker.start()
        self.fill_stdin(process)
        started = time.monotonic()
        with self.assertRaises(BackendUnavailableError):
            worker.generate(MESSAGES, 32, 0, 1)
        self.assertLess(time.monotonic() - started, 0.3)
        self.assertIsNone(worker.generation_timeout)
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})
        self.assertEqual(len(calls), 1)

    def test_close_interrupts_full_stdin_and_bounds_shutdown_send(self):
        process = FakeProcess(stop_on_close=False, consume=False)
        worker, process, _ = self.worker(process=process, send_timeout=10)
        worker.start()
        self.fill_stdin(process)
        generating, outcome = self.generate(worker)
        wait_until(lambda: worker.inference_status()["status"] == "busy")
        closing = threading.Thread(target=worker.close, daemon=True)
        closing.start()
        closing.join(0.3)
        self.assertFalse(closing.is_alive(), "close must not wait on blocked transport")
        generating.join(0.3)
        self.assertIsInstance(outcome.get("error"), BackendUnavailableError)
        self.assertEqual(process.terminate_calls, 1)
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})

    def test_cancellation_and_explicit_timeout_interrupt_full_stdin(self):
        for trigger in ("cancel", "timeout"):
            with self.subTest(trigger=trigger):
                process = FakeProcess(stop_on_close=False, consume=False)
                stopped = threading.Event()
                worker, process, _ = self.worker(process=process, send_timeout=10,
                    generation_timeout=0.03 if trigger == "timeout" else None)
                worker.start()
                self.fill_stdin(process)
                thread, outcome = self.generate(worker, cancel_event=stopped)
                wait_until(lambda: worker.inference_status()["status"] == "busy")
                if trigger == "cancel":
                    stopped.set()
                thread.join(0.3)
                self.assertFalse(thread.is_alive())
                self.assertIsInstance(outcome.get("error"), BackendUnavailableError)
                self.assertEqual(worker.inference_status(), {"status": "unavailable"})

    def test_stalled_cancel_write_is_bounded_by_cancel_grace(self):
        process = FakeProcess(stop_on_close=False, consume=False)
        worker, process, _ = self.worker(process=process, send_timeout=10)
        worker.start()
        generating, outcome = self.generate(worker)
        request = json.loads(process.stdin.reader.readline())
        self.fill_stdin(process)
        started = time.monotonic()
        with self.assertRaises(BackendUnavailableError):
            worker.cancel(request["id"])
        self.assertLess(time.monotonic() - started, 0.3)
        generating.join(0.3)
        self.assertIsInstance(outcome.get("error"), BackendUnavailableError)
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})

    def test_buffered_write_flush_readline_are_never_used(self):
        worker, process, _ = self.worker()
        blocked = threading.Event()
        with patch.object(process.stdin, "write", side_effect=lambda *_: blocked.wait()) as write, \
                patch.object(process.stdin, "flush", side_effect=lambda: blocked.wait()) as flush, \
                patch.object(process.stdout, "readline", side_effect=lambda *_: blocked.wait()) as read:
            try:
                worker.start()
                thread, outcome = self.generate(worker)
                request = self.sent(process, "generate")
                process.emit("reply", id=request["id"], ok=True, result=RESULT)
                thread.join(0.3)
                self.assertEqual(outcome, {"result": RESULT})
                worker.close()
                write.assert_not_called()
                flush.assert_not_called()
                read.assert_not_called()
            finally:
                blocked.set()

    def test_close_does_not_wait_for_stdout_eof_after_child_exit(self):
        process = FakeProcess(keep_stdout_open=True)
        worker, process, _ = self.worker(process=process)
        worker.start()
        process.finish()
        self.assertFalse(process.stdout.writer.closed)
        closing = threading.Thread(target=worker.close, daemon=True)
        closing.start()
        closing.join(0.3)
        self.assertFalse(closing.is_alive(), "retained stdout writer must not block close")
        self.assertEqual(process.terminate_calls, 0)
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})

    def test_concurrent_close_never_writes_to_reused_stdin_descriptor(self):
        process = FakeProcess(stop_on_close=False, consume=False, keep_stdout_open=True)
        worker, process, _ = self.worker(process=process)
        worker.start()
        old_fd = worker._stdin_fd
        entered_wait, release_wait = threading.Event(), threading.Event()

        def paused_wait(timeout):
            entered_wait.set()
            if not release_wait.wait(1):
                raise subprocess.TimeoutExpired("synthetic-worker", timeout)
            process.finish()
            return 0

        process.wait = paused_wait
        first = threading.Thread(target=worker.close, daemon=True)
        first.start()
        self.assertTrue(entered_wait.wait(1))
        self.assertIsNone(worker._stdin_fd)
        second = None
        try:
            with tempfile.TemporaryFile() as unrelated:
                duplicate = unrelated.fileno() != old_fd
                if duplicate:
                    os.dup2(unrelated.fileno(), old_fd)
                try:
                    second = threading.Thread(target=worker.close, daemon=True)
                    second.start()
                    # Both closes may now wait only on this owned child. The
                    # second shutdown must not use the unrelated reused fd.
                    second.join(0.05)
                    release_wait.set()
                    first.join(1)
                    second.join(1)
                    unrelated.seek(0)
                    self.assertEqual(unrelated.read(), b"")
                    self.assertFalse(first.is_alive())
                    self.assertFalse(second.is_alive())
                    self.assertIsNone(worker._stdin_fd)
                    self.assertIsNone(worker._stdout_fd)
                finally:
                    if duplicate:
                        os.close(old_fd)
        finally:
            release_wait.set()
            first.join(1)
            if second is not None:
                second.join(1)


def bridge_config():
    return {"api": {
        "host": "127.0.0.1", "port": 18080, "model_id": "synthetic-model",
        "checkpoint_sha256": EXPECTED["checkpoint_sha256"], "checkpoint_step": 100,
        "max_input_tokens": 65536, "max_output_tokens": 8192,
        "max_context_tokens": 69632, "default_output_tokens": 512,
    }, "worker": {"command": ["reviewed-command"], "expected": deepcopy(EXPECTED)}}


class BridgeTests(unittest.TestCase):
    def test_import_does_not_read_config_bind_server_or_start_process(self):
        try:
            with patch("pathlib.Path.read_text") as read, patch("subprocess.Popen") as spawn, patch("server.make_server") as server:
                importlib.reload(guarded_bridge)
                read.assert_not_called()
                spawn.assert_not_called()
                server.assert_not_called()
        finally:
            importlib.reload(guarded_bridge)

    def test_factory_enables_queue_and_status_without_starting_worker(self):
        captured = {}

        def server_factory(config, worker, key, timing_log):
            captured.update(config=config, worker=worker, key=key, timing_log=timing_log)

            class Handler:
                def handle_chat_request(self):
                    self.bound_connection = worker.context.connection
                    if getattr(self, "fail", False):
                        raise ValueError("synthetic handler failure")
                    return "handled"

            class Server:
                RequestHandlerClass = Handler

            return Server()

        original = bridge_config()
        with patch("subprocess.Popen") as spawn:
            server, worker = guarded_bridge.create_guarded_bridge(original, KEY,
                process_factory=spawn, server_factory=server_factory)
            spawn.assert_not_called()
        self.assertNotIn("require_backend_status", original["api"])
        self.assertEqual(captured["config"]["inference_queue_max_requests"], 8)
        self.assertTrue(captured["config"]["require_backend_status"])
        self.assertIsNone(captured["timing_log"])
        self.assertEqual(worker.inference_status(), {"status": "unavailable"})
        handler = server.RequestHandlerClass()
        handler.connection = object()
        self.assertEqual(handler.handle_chat_request(), "handled")
        self.assertIs(handler.bound_connection, handler.connection)
        self.assertIsNone(worker.context.connection)
        handler.fail = True
        with self.assertRaises(ValueError):
            handler.handle_chat_request()
        self.assertIsNone(worker.context.connection)
        worker.close()

    def test_factory_rejects_identity_mismatch_queue_disable_and_missing_key_before_bind(self):
        for field, value in (("max_input_tokens", 1024), ("checkpoint_sha256", "c" * 64),
                             ("inference_queue_max_requests", 0), ("require_backend_status", False)):
            with self.subTest(field=field):
                config = bridge_config()
                config["api"][field] = value
                with patch("subprocess.Popen") as spawn, patch("server.make_server") as bind:
                    with self.assertRaises(ValueError):
                        guarded_bridge.create_guarded_bridge(config, KEY, process_factory=spawn, server_factory=bind)
                    spawn.assert_not_called()
                    bind.assert_not_called()
        with self.assertRaisesRegex(ValueError, "API key"):
            guarded_bridge.create_guarded_bridge(bridge_config(), "")

    def test_cli_reads_only_explicit_files_starts_before_serving_and_closes(self):
        events = []

        class Worker:
            def start(self):
                events.append("start")

            def close(self):
                events.append("worker_close")

        class Server:
            def serve_forever(self):
                events.append("serve")
                raise KeyboardInterrupt

            def server_close(self):
                events.append("server_close")

        with tempfile.TemporaryDirectory() as directory:
            config_path, key_path = Path(directory) / "config.json", Path(directory) / "key"
            config_path.write_text(json.dumps(bridge_config()), encoding="utf-8")
            key_path.write_text(KEY + "\n", encoding="utf-8")
            with patch.object(guarded_bridge, "create_guarded_bridge", return_value=(Server(), Worker())) as factory:
                guarded_bridge.main(["--config", str(config_path), "--key-file", str(key_path)])
            factory.assert_called_once_with(bridge_config(), KEY)
        self.assertEqual(events, ["start", "serve", "server_close", "worker_close"])


class BridgeHTTPTests(unittest.TestCase):
    """Loopback HTTP only; the worker remains entirely fake stdio."""

    def setUp(self):
        self.process = FakeProcess()
        self.spawn_calls = 0
        self.request_threads = []

        def factory(*args, **kwargs):
            self.spawn_calls += 1
            self.process.emit("ready", **EXPECTED)
            return self.process

        # A validated deployment port is replaced by an OS-assigned test port
        # only at the injected binding boundary, avoiding port reservation races.
        def server_factory(config, *args, **kwargs):
            return make_server({**config, "port": 0}, *args, **kwargs)

        config = bridge_config()
        config["api"]["inference_queue_max_requests"] = 2
        config["worker"].update(startup_timeout=0.2, cancel_grace=0.05, close_grace=0.01)
        self.server, self.worker = guarded_bridge.create_guarded_bridge(
            config, KEY, process_factory=factory, server_factory=server_factory)
        self.server.handle_error = lambda *args: None
        self.server_thread = threading.Thread(
            target=lambda: self.server.serve_forever(poll_interval=0.01), daemon=True)
        self.server_thread.start()

    def tearDown(self):
        self.worker.close()
        self.server.shutdown()
        self.server.server_close()
        self.server_thread.join(1)
        for thread in self.request_threads:
            thread.join(1)
            self.assertFalse(thread.is_alive())
        self.process.dispose()

    def connection(self):
        return http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=2)

    def send(self, connection, text):
        connection.request("POST", "/v1/chat/completions",
            body=json.dumps({"messages": [{"role": "user", "content": text}], "max_tokens": 32}),
            headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"})

    def request(self, text=None):
        connection = self.connection()
        try:
            if text is None:
                connection.request("GET", "/healthz", headers={"Authorization": "Bearer " + KEY})
            else:
                self.send(connection, text)
            response = connection.getresponse()
            return response.status, json.loads(response.read())
        finally:
            connection.close()

    def request_thread(self, text):
        outcome = {}

        def run():
            try:
                outcome["response"] = self.request(text)
            except Exception as error:
                outcome["error"] = error

        thread = threading.Thread(target=run, daemon=True)
        self.request_threads.append(thread)
        thread.start()
        return thread, outcome

    def terminal(self, request, text):
        self.process.emit("reply", id=request["id"], ok=True, result={**RESULT, "text": text})

    def test_health_never_starts_worker_and_writer_review_repair_share_fifo(self):
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.request("before explicit start")[0], 503)
        self.assertEqual(self.spawn_calls, 0)
        self.worker.start()
        self.assertEqual(self.request()[0], 200)
        writer, writer_outcome = self.request_thread("writer")
        first = self.process.sent.get(timeout=1)
        self.assertEqual(first["payload"]["messages"][-1]["content"], "writer")
        reviewer, reviewer_outcome = self.request_thread("review")
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 1)
        repair, repair_outcome = self.request_thread("repair")
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 2)
        health = self.request()
        self.assertEqual(health[0], 200)
        self.assertEqual(health[1]["status"], "busy")
        self.assertTrue(self.process.sent.empty())
        self.terminal(first, "writer result")
        second = self.process.sent.get(timeout=1)
        self.assertEqual(second["payload"]["messages"][-1]["content"], "review")
        self.terminal(second, "review result")
        third = self.process.sent.get(timeout=1)
        self.assertEqual(third["payload"]["messages"][-1]["content"], "repair")
        self.terminal(third, "repair result")
        for thread, outcome, expected_text in (
                (writer, writer_outcome, "writer result"),
                (reviewer, reviewer_outcome, "review result"),
                (repair, repair_outcome, "repair result")):
            thread.join(1)
            self.assertNotIn("error", outcome)
            status, body = outcome["response"]
            self.assertEqual(status, 200)
            self.assertEqual(body["choices"][0]["message"]["content"], expected_text)
        self.assertEqual(self.spawn_calls, 1)

    def test_http_disconnect_keeps_admission_closed_until_exact_terminal_reply(self):
        self.worker.start()
        disconnected = self.connection()
        self.send(disconnected, "disconnect this writer")
        first = self.process.sent.get(timeout=1)
        review, review_outcome = self.request_thread("waiting review")
        wait_until(lambda: self.server.inference_queue.snapshot()["queued_requests"] == 1)
        disconnected.close()
        cancel = self.process.sent.get(timeout=1)
        self.assertEqual(cancel["op"], "cancel")
        self.assertEqual(cancel["target_id"], first["id"])
        self.process.emit("reply", id=cancel["id"], ok=True,
            result={"cancel_accepted": True, "target_id": first["id"]})
        review.join(1)
        self.assertEqual(review_outcome["response"][0], 503)
        self.assertEqual(self.request()[1]["status"], "draining")
        self.assertEqual(self.request("must not start during draining")[0], 503)
        self.assertTrue(self.process.sent.empty())
        self.terminal(first, "discard this late result")
        wait_until(lambda: self.worker.inference_status()["status"] == "ready")
        self.assertEqual(self.request()[0], 200)
        next_thread, next_outcome = self.request_thread("next writer")
        next_request = self.process.sent.get(timeout=1)
        self.assertNotEqual(next_request["id"], first["id"])
        self.terminal(first, "old replay must not complete next writer")
        self.terminal(next_request, "new result")
        next_thread.join(1)
        self.assertEqual(next_outcome["response"][1]["choices"][0]["message"]["content"], "new result")
        self.assertEqual(self.spawn_calls, 1)

    def test_http_worker_eof_returns_503_and_budget_rejection_stays_400(self):
        self.worker.start()
        budget, budget_outcome = self.request_thread("synthetic budget rejection")
        first = self.process.sent.get(timeout=1)
        self.process.emit("reply", id=first["id"], ok=False, error={"type": "invalid_request",
            "message": "Prompt exceeds the v11 input budget; no text was truncated"})
        budget.join(1)
        self.assertEqual(budget_outcome["response"][0], 400)
        active, active_outcome = self.request_thread("synthetic EOF")
        self.process.sent.get(timeout=1)
        self.process.stdout.eof()
        active.join(1)
        self.assertEqual(active_outcome["response"][0], 503)
        self.assertEqual(active_outcome["response"][1]["error"]["message"], "Model is not ready for inference")
        self.assertEqual(self.request()[0], 503)
        self.assertEqual(self.request("after EOF")[0], 503)
        self.assertEqual(self.spawn_calls, 1)


if __name__ == "__main__":
    unittest.main()

"""Explicitly started, identity-pinned SSH stdio inference worker.

Construction and health inspection never spawn, reconnect, load, or probe.
Only the owned local child is managed here; its reviewed command is supplied
by the caller. Uncertain remote completion keeps admission unavailable.
"""

from copy import deepcopy
import json
import math
import os
import select
import socket
import subprocess
import threading
import time
import uuid

from backend import BackendUnavailableError, RequestError
from inference_budget import safe_budget_error_message

PROTOCOL = "hop-v11-live-v1"
MAX_LINE_BYTES = 8 * 1024 * 1024
REQUIRED_IDENTITY = {
    "checkpoint_sha256", "adapter_sha256", "checkpoint_path", "checkpoint_step",
    "max_input_tokens", "max_output_tokens", "max_context_tokens", "gpu_only", "terminal_reply_after_idle",
}


def _seconds(value, name, *, optional=False):
    if optional and value is None:
        return None
    if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
        raise ValueError("Invalid " + name)
    return value


def _disconnected(connection):
    if connection is None:
        return False
    try:
        readable, _, _ = select.select([connection], [], [], 0)
        return bool(readable) and connection.recv(1, socket.MSG_PEEK | socket.MSG_DONTWAIT) == b""
    except (OSError, ValueError):
        return True


class RemoteWorker:
    def __init__(self, command, expected, *, process_factory=subprocess.Popen,
                 startup_timeout=300, generation_timeout=None, cancel_grace=40,
                 close_grace=5, send_timeout=5, disconnected=_disconnected):
        if not isinstance(command, list) or not command or any(
                not isinstance(part, str) or not part or "\0" in part for part in command):
            raise ValueError("A trusted command argument list is required")
        if not isinstance(expected, dict) or not REQUIRED_IDENTITY <= expected.keys():
            raise ValueError("Complete expected worker identity is required")
        for name in ("checkpoint_sha256", "adapter_sha256"):
            value = expected[name]
            if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
                raise ValueError("Invalid expected worker identity")
        if not isinstance(expected["checkpoint_path"], str) or not expected["checkpoint_path"].startswith("/"):
            raise ValueError("Invalid expected checkpoint path")
        for name in ("checkpoint_step", "max_input_tokens", "max_output_tokens", "max_context_tokens"):
            if type(expected[name]) is not int or expected[name] <= 0:
                raise ValueError("Invalid expected worker limits")
        if expected["gpu_only"] is not True or expected["terminal_reply_after_idle"] is not True or not (
                expected["max_output_tokens"] < expected["max_context_tokens"] and
                expected["max_input_tokens"] <= expected["max_context_tokens"]):
            raise ValueError("Invalid expected worker limits")
        # Reject unserializable/nonfinite expectations without exposing them.
        try:
            json.dumps(expected, allow_nan=False)
        except (TypeError, ValueError):
            raise ValueError("Invalid expected worker identity") from None
        self.command = tuple(command)
        self.expected = deepcopy(expected)
        self.process_factory = process_factory
        self.startup_timeout = _seconds(startup_timeout, "startup_timeout")
        self.generation_timeout = _seconds(generation_timeout, "generation_timeout", optional=True)
        self.cancel_grace = _seconds(cancel_grace, "cancel_grace")
        self.close_grace = _seconds(close_grace, "close_grace")
        self.send_timeout = _seconds(send_timeout, "send_timeout")
        self.disconnected = disconnected
        self.context = threading.local()
        self._condition = threading.Condition()
        self._send_lock = threading.Lock()
        self._process = None
        self._stdin_fd = None
        self._stdout_fd = None
        self._epoch = None
        self._verified_pid = None
        self._status = "unavailable"
        self._started = False
        self._closed = False
        self._active = None

    def _unavailable_locked(self):
        self._status = "unavailable"
        self._verified_pid = None
        self._condition.notify_all()

    def _refresh_locked(self):
        process = self._process
        if process is not None and (process.poll() is not None or
                self._verified_pid is not None and process.pid != self._verified_pid):
            self._unavailable_locked()

    def inference_status(self):
        with self._condition:
            self._refresh_locked()
            status = self._status
            return {"status": status if status in {"ready", "busy", "draining"} else "unavailable"}

    def start(self):
        with self._condition:
            if self._started or self._closed:
                raise BackendUnavailableError("Worker start is one-shot; create a new explicitly approved worker")
            self._started = True
            self._status = "starting"
            self._epoch = object()
            epoch = self._epoch
        try:
            process = self.process_factory(list(self.command), stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
        except Exception:
            with self._condition:
                self._unavailable_locked()
            raise BackendUnavailableError("Worker process could not be started") from None
        with self._condition:
            self._process = process
            if self._closed:
                self._unavailable_locked()
        try:
            # Bypass buffered stream operations entirely: a blocked write,
            # flush, readline or buffered close must never own our shutdown.
            with self._condition:
                self._stdin_fd, self._stdout_fd = process.stdin.fileno(), process.stdout.fileno()
                os.set_blocking(self._stdin_fd, False)
                os.set_blocking(self._stdout_fd, False)
            reader = threading.Thread(target=self._read, args=(process, epoch), daemon=True)
            reader.start()
            deadline = time.monotonic() + self.startup_timeout
            with self._condition:
                while self._status == "starting":
                    self._refresh_locked()
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        self._unavailable_locked()
                        break
                    self._condition.wait(min(0.05, remaining))
                if self._status != "ready" or self._closed:
                    raise BackendUnavailableError("Worker startup identity or readiness was not verified")
            return self
        except BaseException:
            self.close()
            raise

    def _send(self, process, epoch, body, *, closing=False, interrupted=lambda: False, timeout=None):
        deadline = time.monotonic() + (self.send_timeout if timeout is None else timeout)
        acquired = False
        try:
            wire = (json.dumps(body, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
            offset = 0
            while offset < len(wire):
                if time.monotonic() >= deadline or interrupted():
                    raise BackendUnavailableError("Worker channel is unavailable")
                if not acquired:
                    acquired = self._send_lock.acquire(timeout=min(0.01, max(0, deadline - time.monotonic())))
                    if not acquired:
                        continue
                with self._condition:
                    self._refresh_locked()
                    if (process is not self._process or epoch is not self._epoch or
                            self._stdin_fd is None or (self._closed or self._status == "unavailable") and not closing):
                        raise BackendUnavailableError("Worker channel is unavailable")
                    try:
                        # The descriptor is nonblocking. Holding this lock only
                        # across os.write prevents close/reused-fd races.
                        written = os.write(self._stdin_fd, wire[offset:])
                    except BlockingIOError:
                        written = 0
                if written:
                    offset += written
                else:
                    time.sleep(min(0.01, max(0, deadline - time.monotonic())))
        except (OSError, ValueError, TypeError):
            with self._condition:
                if process is self._process and epoch is self._epoch:
                    self._unavailable_locked()
            # A partially written JSON frame cannot safely be followed by a
            # cancel frame. Quarantine the channel instead of claiming idle.
            raise BackendUnavailableError("Worker channel is unavailable") from None
        finally:
            if acquired:
                self._send_lock.release()

    def _read(self, process, epoch):
        pending = bytearray()
        try:
            while True:
                with self._condition:
                    if self._closed or process is not self._process or epoch is not self._epoch:
                        return
                    try:
                        chunk = os.read(self._stdout_fd, 65536)
                    except BlockingIOError:
                        chunk = None
                if chunk is None:
                    time.sleep(0.01)
                    continue
                if not chunk:
                    break
                pending.extend(chunk)
                while b"\n" in pending:
                    line, _, rest = pending.partition(b"\n")
                    pending = bytearray(rest)
                    if len(line) + 1 > MAX_LINE_BYTES:
                        return
                    try:
                        event = json.loads(line)
                    except (ValueError, TypeError, RecursionError):
                        continue
                    if isinstance(event, dict) and event.get("protocol") == PROTOCOL:
                        self._receive(process, epoch, event)
                if len(pending) > MAX_LINE_BYTES:
                    break
        except (OSError, ValueError, UnicodeError):
            pass
        finally:
            with self._condition:
                if process is self._process and epoch is self._epoch:
                    self._unavailable_locked()

    def _receive(self, process, epoch, event):
        with self._condition:
            if process is not self._process or epoch is not self._epoch or self._closed:
                return
            self._refresh_locked()
            if self._status == "unavailable":
                return
            kind = event.get("kind")
            if kind in {"fatal", "eof", "stopped"}:
                self._unavailable_locked()
            elif kind == "ready":
                if (self._status != "starting" or type(process.pid) is not int or process.pid <= 0 or process.poll() is not None or
                        any(type(event.get(key)) is not type(value) or event.get(key) != value
                            for key, value in self.expected.items())):
                    self._unavailable_locked()
                else:
                    self._verified_pid = process.pid
                    self._status = "ready"
                    self._condition.notify_all()
            elif kind == "reply" and self._active is not None and event.get("id") == self._active["id"]:
                # Cancel/shutdown acknowledgements have their own IDs and can
                # never release this generation's slot.
                error = event.get("error")
                if (type(event.get("ok")) is not bool or
                        event["ok"] and not self._valid_result(event.get("result")) or
                        not event["ok"] and (not isinstance(error, dict) or not isinstance(error.get("type"), str))):
                    self._unavailable_locked()
                    return
                active = self._active
                active["reply"] = event
                self._active = None
                if not event["ok"] and error["type"] not in {"invalid_request", "cancelled", "deadline"}:
                    self._unavailable_locked()
                else:
                    self._status = "ready"
                    self._condition.notify_all()

    @staticmethod
    def _valid_result(result):
        return (isinstance(result, dict) and isinstance(result.get("text"), str) and
                all(type(result.get(key)) is int and result[key] >= 0 for key in ("prompt_tokens", "completion_tokens")) and
                result.get("finish_reason") in {"stop", "length"})

    def cancel(self, request_id=None):
        with self._condition:
            active = self._active
            if active is None or self._status not in {"busy", "draining"} or (
                    request_id is not None and request_id != active["id"]):
                return False
            if active["cancelled"]:
                return True
            active["cancelled"] = True
            active["cancel_at"] = time.monotonic()
            self._status = "draining"
            process, epoch = self._process, self._epoch
            self._condition.notify_all()
        self._send(process, epoch, {"id": uuid.uuid4().hex, "op": "cancel", "target_id": active["id"]},
                   timeout=min(self.send_timeout, self.cancel_grace))
        return True

    def generate(self, messages, max_tokens, temperature, top_p):
        with self._condition:
            self._refresh_locked()
            if self._status != "ready" or self._active is not None or self._closed:
                raise BackendUnavailableError("Worker is not verified idle")
            active = {"id": uuid.uuid4().hex, "reply": None, "cancelled": False, "cancel_at": None}
            self._active = active
            self._status = "busy"
            process, epoch = self._process, self._epoch
        deadline = None if self.generation_timeout is None else time.monotonic() + self.generation_timeout
        connection = getattr(self.context, "connection", None)
        cancel_event = getattr(self.context, "cancel_event", None)

        def interrupted():
            return (self.disconnected(connection) or cancel_event is not None and cancel_event.is_set() or
                    deadline is not None and time.monotonic() >= deadline or active["cancelled"])

        self._send(process, epoch, {"id": active["id"], "op": "generate", "payload": {
            "messages": messages, "max_tokens": max_tokens, "temperature": temperature, "top_p": top_p}},
            interrupted=interrupted)
        while True:
            disconnected = self.disconnected(connection)
            cancelled = cancel_event is not None and cancel_event.is_set()
            timed_out = deadline is not None and time.monotonic() >= deadline
            if (disconnected or cancelled or timed_out) and not active["cancelled"]:
                self.cancel(active["id"])
                # A reply may have completed just before cancel acquired the
                # lock. This caller must still discard it after cancellation.
                with self._condition:
                    active["cancelled"] = True
                    active["cancel_at"] = active["cancel_at"] or time.monotonic()
            with self._condition:
                self._refresh_locked()
                if self._status == "unavailable" or self._closed:
                    raise BackendUnavailableError("Worker is unavailable; remote completion was not confirmed")
                reply = active["reply"]
                if reply is not None:
                    if active["cancelled"]:
                        raise RequestError("Request cancelled; output discarded")
                    if not reply["ok"]:
                        error = reply.get("error")
                        message = safe_budget_error_message(error.get("message")) if isinstance(error, dict) else None
                        raise RequestError(message or "GPU worker rejected the request")
                    return reply["result"]
                if active["cancelled"] and time.monotonic() - active["cancel_at"] >= self.cancel_grace:
                    # The reader remains alive. Only the exact late terminal
                    # reply can make this same verified process idle again.
                    raise BackendUnavailableError("Request cancelled; remote completion is still draining")
                self._condition.wait(0.05)

    def close(self):
        with self._condition:
            self._closed = True
            process, epoch = self._process, self._epoch
            self._unavailable_locked()
        if process is None:
            return
        if process.poll() is None:
            try:
                self._send(process, epoch, {"id": uuid.uuid4().hex, "op": "shutdown"},
                           closing=True, timeout=min(self.send_timeout, self.close_grace))
            except RequestError:
                pass
            try:
                with self._condition:
                    # Invalidate before closing: a concurrent/retried close
                    # must not write through an OS-reused descriptor number.
                    self._stdin_fd = None
                    process.stdin.close()
            except (OSError, ValueError):
                pass
            try:
                process.wait(timeout=self.close_grace)
            except subprocess.TimeoutExpired:
                process.terminate()  # Only the local child created by start().
                try:
                    process.wait(timeout=self.close_grace)
                except subprocess.TimeoutExpired:
                    raise BackendUnavailableError("Owned worker channel did not terminate") from None
        for name, stream in (("_stdin_fd", process.stdin), ("_stdout_fd", process.stdout)):
            try:
                with self._condition:
                    setattr(self, name, None)
                    stream.close()
            except (OSError, ValueError):
                pass

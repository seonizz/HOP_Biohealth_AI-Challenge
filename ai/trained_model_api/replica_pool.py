"""Explicit, identity-pinned NF4 replicas; no model work during health checks."""

from collections import deque
from copy import deepcopy
import re
import subprocess
import threading
import time
import uuid

from backend import BackendUnavailableError
from remote_worker import RemoteWorker, REQUIRED_IDENTITY
from server import make_server, validate_config

_GPU_UUID = re.compile(r"GPU-[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\Z")


def _identity(worker):
    expected = getattr(worker, "expected", None)
    required = REQUIRED_IDENTITY | {"model_id", "quantization", "gpu_uuid"}
    if not isinstance(expected, dict) or not required <= expected.keys():
        raise ValueError("Complete explicit replica identity is required")
    if expected["quantization"] != "nf4" or not _GPU_UUID.fullmatch(expected["gpu_uuid"] if isinstance(expected["gpu_uuid"], str) else ""):
        raise ValueError("Replicas require pinned NF4 quantization and GPU UUID")
    if not isinstance(expected["model_id"], str) or not expected["model_id"]:
        raise ValueError("An explicit replica model_id is required")
    for name in ("checkpoint_sha256", "adapter_sha256"):
        if not isinstance(expected[name], str) or not re.fullmatch(r"[0-9a-f]{64}", expected[name]):
            raise ValueError("Invalid replica checkpoint identity")
    if not isinstance(expected["checkpoint_path"], str) or not expected["checkpoint_path"].startswith("/"):
        raise ValueError("Invalid replica checkpoint path")
    for name in ("checkpoint_step", "max_input_tokens", "max_output_tokens", "max_context_tokens"):
        if type(expected[name]) is not int or expected[name] <= 0:
            raise ValueError("Invalid replica limits")
    if expected["gpu_only"] is not True or expected["terminal_reply_after_idle"] is not True or not (
            expected["max_output_tokens"] < expected["max_context_tokens"] and
            expected["max_input_tokens"] <= expected["max_context_tokens"]):
        raise ValueError("Unsafe replica completion or budget contract")
    if not isinstance(getattr(worker, "context", None), threading.local) or any(
            not callable(getattr(worker, name, None)) for name in ("start", "generate", "close", "inference_status")):
        raise ValueError("Replica must implement the explicit RemoteWorker contract")
    return deepcopy(expected)


class ReplicaPool:
    parallel_capacity = 2

    def __init__(self, workers, *, dispatch_logger=None):
        if not isinstance(workers, (list, tuple)) or len(workers) != 2 or workers[0] is workers[1]:
            raise ValueError("Exactly two separate explicit workers are required")
        identities = [_identity(worker) for worker in workers]
        if identities[0]["gpu_uuid"].lower() == identities[1]["gpu_uuid"].lower():
            raise ValueError("Replicas must use separate pinned GPU UUIDs")
        common = [{key: value for key, value in identity.items() if key != "gpu_uuid"} for identity in identities]
        if common[0] != common[1]:
            raise ValueError("Replica identity, quantization, or token budgets differ")
        self.workers = tuple(workers)
        self.expected = common[0]
        self._identities = identities
        self.context = threading.local()
        self._lock = threading.Lock()
        self._reserved = {}
        self._next_replica = 0
        self._events = deque(maxlen=256)
        self._started = self._ready = self._closed = False
        self._dispatch_logger = dispatch_logger

    @staticmethod
    def _status(worker):
        try:
            status = worker.inference_status()
            value = status.get("status") if isinstance(status, dict) else None
            return value if value in {"ready", "busy", "draining"} else "unavailable"
        except Exception:
            return "unavailable"

    def _status_locked(self):
        if self._closed or not self._ready:
            return "unavailable"
        if any(worker.expected != expected for worker, expected in zip(self.workers, self._identities)):
            return "unavailable"
        statuses = [self._status(worker) for worker in self.workers]
        # Uncertain drain quarantines new admission without interrupting the
        # other replica's already-running request or claiming another free slot.
        if "unavailable" in statuses:
            return "unavailable"
        if "draining" in statuses:
            return "draining"
        return "ready" if any(status == "ready" and index not in self._reserved
                              for index, status in enumerate(statuses)) else "busy"

    def inference_status(self):
        with self._lock:
            return {"status": self._status_locked(), "active_count": len(self._reserved),
                    "parallel_capacity": self.parallel_capacity}

    def snapshot(self):
        with self._lock:
            return {"status": self._status_locked(), "active_count": len(self._reserved),
                    "capacity": self.parallel_capacity, "dispatches": deepcopy(list(self._events))}

    def start(self):
        with self._lock:
            if self._started or self._closed:
                raise BackendUnavailableError("Replica pool start is one-shot")
            self._started = True
        try:
            for worker, expected in zip(self.workers, self._identities):
                with self._lock:
                    if self._closed:
                        raise BackendUnavailableError("Replica pool closed during startup")
                if worker.expected != expected:
                    raise BackendUnavailableError("Replica identity changed before start")
                worker.start()
                if worker.expected != expected or self._status(worker) != "ready":
                    raise BackendUnavailableError("Replica startup was not verified")
            with self._lock:
                if self._closed:
                    raise BackendUnavailableError("Replica pool closed during startup")
                self._ready = True
            return self
        except BaseException:
            self.close()
            raise

    def _record(self, event):
        with self._lock:
            self._events.append(event)
        if self._dispatch_logger:
            try:
                self._dispatch_logger(deepcopy(event))
            except Exception:
                pass

    def generate(self, messages, max_tokens, temperature, top_p):
        with self._lock:
            if self._status_locked() != "ready":
                raise BackendUnavailableError("No verified replica slot is available")
            order = [(self._next_replica + offset) % len(self.workers) for offset in range(len(self.workers))]
            index = next((index for index in order
                          if index not in self._reserved and self._status(self.workers[index]) == "ready"), None)
            if index is None:
                raise BackendUnavailableError("No verified replica slot is available")
            request_id = uuid.uuid4().hex
            self._reserved[index] = request_id
            self._next_replica = (index + 1) % len(self.workers)
        worker = self.workers[index]
        started = time.monotonic()
        self._record({"event": "dispatch", "request_id": request_id, "replica": index,
                      "gpu_uuid": self._identities[index]["gpu_uuid"], "started_at": time.time()})
        self.context.active_replica = index
        for name in ("connection", "cancel_event"):
            setattr(worker.context, name, getattr(self.context, name, None))
        outcome = "returned"
        try:
            return worker.generate(messages, max_tokens, temperature, top_p)
        except BaseException:
            outcome = "failed"
            raise
        finally:
            for name in ("connection", "cancel_event"):
                if hasattr(worker.context, name):
                    delattr(worker.context, name)
            if hasattr(self.context, "active_replica"):
                del self.context.active_replica
            # Release only after the worker returned; readiness is checked again
            # for every subsequent reservation, including uncertain cancellation.
            with self._lock:
                if self._reserved.get(index) == request_id:
                    del self._reserved[index]
            self._record({"event": "completed", "request_id": request_id, "replica": index,
                          "outcome": outcome, "elapsed_seconds": time.monotonic() - started,
                          "finished_at": time.time()})

    def cancel(self, request_id=None):
        index = getattr(self.context, "active_replica", None)
        if index is None:
            return False
        cancel = getattr(self.workers[index], "cancel", None)
        return cancel(request_id) if callable(cancel) else False

    def close(self):
        with self._lock:
            if self._closed:
                return
            self._closed = True
            self._ready = False
        failure = None
        for worker in self.workers:
            try:
                worker.close()
            except Exception as error:
                failure = failure or error
        if failure:
            raise failure


def make_replica_bridge(config, api_key, *, process_factory=subprocess.Popen,
                        worker_factory=RemoteWorker, server_factory=make_server):
    """Bind an authenticated API with a dormant pool; start is always explicit."""
    if not isinstance(config, dict) or set(config) != {"api", "workers"} or not isinstance(config["api"], dict):
        raise ValueError("Replica bridge requires api and workers objects")
    if not isinstance(config["workers"], list) or len(config["workers"]) != 2:
        raise ValueError("Replica bridge requires two explicit worker configurations")
    if (not isinstance(api_key, str) or len(api_key) < 32 or not api_key.isascii() or
            any(character.isspace() or not character.isprintable() for character in api_key)):
        raise ValueError("An explicit valid API key is required")
    allowed = {"command", "expected", "startup_timeout", "generation_timeout", "cancel_grace", "close_grace", "send_timeout"}
    workers = []
    for options in deepcopy(config["workers"]):
        if not isinstance(options, dict) or set(options) - allowed or not {"command", "expected"} <= options.keys():
            raise ValueError("Invalid worker configuration fields")
        workers.append(worker_factory(**options, process_factory=process_factory))
    pool = ReplicaPool(workers)
    api = deepcopy(config["api"])
    if api.get("require_backend_status", True) is not True:
        raise ValueError("Replica bridge requires backend readiness status")
    api["require_backend_status"] = True
    api.setdefault("inference_parallel_slots", 2)
    if api["inference_parallel_slots"] != 2:
        raise ValueError("Replica bridge requires two inference slots")
    api.setdefault("inference_queue_max_requests", 8)
    api.setdefault("inference_queue_max_bytes", 16 * 1024 * 1024)
    validate_config(api)
    for key in ("model_id", "checkpoint_sha256", "checkpoint_step", "max_input_tokens", "max_output_tokens", "max_context_tokens"):
        if type(api.get(key)) is not type(pool.expected[key]) or api.get(key) != pool.expected[key]:
            raise ValueError("API and replica identity or limits differ: " + key)
    server = server_factory(api, pool, api_key, timing_log=None)
    original_handler = server.RequestHandlerClass

    class Handler(original_handler):
        def handle_chat_request(self):
            pool.context.connection = self.connection
            try:
                return super().handle_chat_request()
            finally:
                for name in ("connection", "cancel_event"):
                    if hasattr(pool.context, name):
                        delattr(pool.context, name)

    server.RequestHandlerClass = Handler
    return server, pool

"""Bounded physical inference slots with cancellable FIFO admission.

Callbacks must be read-only and nonblocking. They run outside the condition
lock: backend readiness must never load a model or wait for inference here.
"""

from collections import deque
import threading


class QueueFull(Exception):
    pass


class QueueClosed(Exception):
    pass


class RequestCancelled(Exception):
    pass


class BackendUnavailable(Exception):
    pass


def queue_limits(config):
    requests = config.get("inference_queue_max_requests", 0)
    size = config.get("inference_queue_max_bytes", 16 * 1024 * 1024)
    if type(requests) is not int or not 0 <= requests <= 128:
        raise ValueError("Invalid inference_queue_max_requests")
    if type(size) is not int or not 1 <= size <= 64 * 1024 * 1024:
        raise ValueError("Invalid inference_queue_max_bytes")
    return requests, size


def parallel_slots(config):
    slots = config.get("inference_parallel_slots", 1)
    if type(slots) is not int or not 1 <= slots <= 2:
        raise ValueError("Invalid inference_parallel_slots")
    return slots


class InferenceQueue:
    def __init__(self, max_requests=0, max_bytes=16 * 1024 * 1024, max_active=1):
        self.max_requests, self.max_bytes = queue_limits({
            "inference_queue_max_requests": max_requests,
            "inference_queue_max_bytes": max_bytes,
        })
        self.max_active = parallel_slots({"inference_parallel_slots": max_active})
        self._condition = threading.Condition()
        self._waiting = deque()
        self._waiting_bytes = 0
        self._active = set()
        self._closed = False

    def snapshot(self):
        with self._condition:
            return {"active": bool(self._active),
                    "active_count": len(self._active), "capacity": self.max_active,
                    "queued_requests": len(self._waiting),
                    "queued_bytes": self._waiting_bytes,
                    "closed": self._closed}

    def acquire(self, size, *, cancelled=lambda: False, ready=lambda: True):
        if type(size) is not int or size < 0:
            raise ValueError("Invalid queued request size")
        if cancelled():
            raise RequestCancelled()
        ticket = object()
        with self._condition:
            if self._closed:
                raise QueueClosed()
            # Tickets fitting free physical slots do not charge waiting limits.
            # Count only the FIFO tail beyond those slots, including when a
            # preceding ticket is checking readiness outside our lock.
            if self.max_active == 1:
                # Preserve the original single-slot admission contract exactly.
                if self._active or self._waiting:
                    if (len(self._waiting) >= self.max_requests or
                            self._waiting_bytes + size > self.max_bytes):
                        raise QueueFull()
            else:
                free_slots = self.max_active - len(self._active)
                waiting_tail = list(self._waiting)[free_slots:]
                if len(self._waiting) >= free_slots:
                    if (len(waiting_tail) >= self.max_requests or
                            sum(item[1] for item in waiting_tail) + size > self.max_bytes):
                        raise QueueFull()
            self._waiting.append((ticket, size))
            self._waiting_bytes += size
        acquired = False
        try:
            while True:
                if cancelled():
                    raise RequestCancelled()
                with self._condition:
                    if self._closed:
                        raise QueueClosed()
                    candidate = len(self._active) < self.max_active and self._waiting[0][0] is ticket
                    if not candidate:
                        # Poll disconnection without introducing a request deadline.
                        self._condition.wait(0.05)
                        continue
                # Only the first ticket probes readiness. Never hold our lock
                # while calling backend or socket code.
                if not ready():
                    raise BackendUnavailable()
                if cancelled():
                    raise RequestCancelled()
                with self._condition:
                    if self._closed:
                        raise QueueClosed()
                    if len(self._active) < self.max_active and self._waiting[0][0] is ticket:
                        self._waiting.popleft()
                        self._waiting_bytes -= size
                        self._active.add(ticket)
                        self._condition.notify_all()
                        acquired = True
                        return ticket
        finally:
            if not acquired:
                with self._condition:
                    try:
                        self._waiting.remove((ticket, size))
                        self._waiting_bytes -= size
                    except ValueError:
                        pass
                    self._condition.notify_all()

    def release(self, ticket):
        with self._condition:
            if not any(active is ticket for active in self._active):
                raise ValueError("Inference permit is not active")
            self._active.remove(ticket)
            self._condition.notify_all()

    def close(self):
        with self._condition:
            self._closed = True
            self._condition.notify_all()

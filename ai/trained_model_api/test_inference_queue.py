import threading
import time
import unittest

from inference_queue import (InferenceQueue, queue_limits, QueueFull, QueueClosed,
                             RequestCancelled, BackendUnavailable)


def wait_until(predicate):
    deadline = time.monotonic() + 2
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("Condition not reached")
        time.sleep(0.005)


class QueueTests(unittest.TestCase):
    def test_default_rejects_waiting_and_next_request_can_acquire(self):
        queue = InferenceQueue()
        first = queue.acquire(20)
        with self.assertRaises(QueueFull):
            queue.acquire(20)
        queue.release(first)
        second = queue.acquire(20)
        queue.release(second)
        self.assertFalse(queue.snapshot()["active"])

    def test_fifo_bounded_waiting_bytes_and_only_one_active(self):
        queue = InferenceQueue(2, 20)
        first = queue.acquire(100)
        observed, threads = [], []
        def run(name):
            permit = queue.acquire(10)
            observed.append(name)
            queue.release(permit)
        for name in ("review", "repair"):
            thread = threading.Thread(target=run, args=(name,))
            thread.start()
            threads.append(thread)
            wait_until(lambda: queue.snapshot()["queued_requests"] == len(threads))
        with self.assertRaises(QueueFull):
            queue.acquire(1)
        self.assertEqual(queue.snapshot()["queued_bytes"], 20)
        queue.release(first)
        for thread in threads:
            thread.join(2)
            self.assertFalse(thread.is_alive())
        self.assertEqual(observed, ["review", "repair"])
        self.assertEqual(queue.snapshot()["queued_bytes"], 0)

    def test_byte_limit_is_independent_of_request_count(self):
        queue = InferenceQueue(4, 2)
        permit = queue.acquire(20)
        with self.assertRaises(QueueFull):
            queue.acquire(3)
        queue.release(permit)

    def test_queued_cancellation_never_receives_a_permit(self):
        queue = InferenceQueue(2, 20)
        permit = queue.acquire(1)
        cancelled, outcome = threading.Event(), []
        def run():
            try:
                queue.acquire(10, cancelled=cancelled.is_set)
                outcome.append("unexpected permit")
            except RequestCancelled:
                outcome.append("cancelled")
        thread = threading.Thread(target=run)
        thread.start()
        wait_until(lambda: queue.snapshot()["queued_requests"] == 1)
        cancelled.set()
        thread.join(2)
        self.assertEqual(outcome, ["cancelled"])
        self.assertEqual(queue.snapshot()["queued_bytes"], 0)
        queue.release(permit)

    def test_unready_backend_cannot_dispatch_until_positive_ready(self):
        queue = InferenceQueue(2, 20)
        with self.assertRaises(BackendUnavailable):
            queue.acquire(2, ready=lambda: False)
        self.assertEqual(queue.snapshot()["queued_requests"], 0)
        permit = queue.acquire(2, ready=lambda: True)
        queue.release(permit)

    def test_callbacks_run_without_condition_lock_and_cancel_after_readiness(self):
        queue = InferenceQueue(2, 20)
        cancelled = threading.Event()
        def ready():
            # A different thread must be able to inspect state during a hook.
            read = threading.Event()
            thread = threading.Thread(target=lambda: (queue.snapshot(), read.set()))
            thread.start()
            self.assertTrue(read.wait(1))
            thread.join()
            cancelled.set()
            return True
        with self.assertRaises(RequestCancelled):
            queue.acquire(2, ready=ready, cancelled=cancelled.is_set)
        self.assertFalse(queue.snapshot()["active"])

    def test_shutdown_wakes_waiters_and_never_revokes_running_permit(self):
        queue = InferenceQueue(2, 20)
        permit, outcome = queue.acquire(2), []
        def run():
            try:
                queue.acquire(2)
            except QueueClosed:
                outcome.append("closed")
        thread = threading.Thread(target=run)
        thread.start()
        wait_until(lambda: queue.snapshot()["queued_requests"] == 1)
        queue.close()
        thread.join(2)
        self.assertEqual(outcome, ["closed"])
        self.assertTrue(queue.snapshot()["active"])
        queue.release(permit)
        with self.assertRaises(QueueClosed):
            queue.acquire(1)

    def test_readiness_exception_cleans_up_ticket(self):
        queue = InferenceQueue(2, 20)
        def raises():
            raise RuntimeError("unavailable")
        with self.assertRaises(RuntimeError):
            queue.acquire(2, ready=raises)
        self.assertEqual(queue.snapshot()["queued_bytes"], 0)
        permit = queue.acquire(2)
        queue.release(permit)

    def test_limits_are_strict_and_no_timeout_is_added(self):
        self.assertEqual(queue_limits({}), (0, 16 * 1024 * 1024))
        for name, values in (("inference_queue_max_requests", [True, -1, 129, "2"]),
                             ("inference_queue_max_bytes", [True, 0, 64 * 1024 * 1024 + 1, "2"])):
            for value in values:
                with self.subTest(name=name, value=value), self.assertRaises(ValueError):
                    queue_limits({name: value})


if __name__ == "__main__":
    unittest.main()

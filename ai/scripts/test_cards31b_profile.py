"""Pure trace math and mocked profiler lifecycle checks; no CUDA dependency."""
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("cards31b_profile", Path(__file__).with_name("cards31b_profile.py"))
profile = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(profile)


def event(device, start, duration, cat="kernel", name="kernel"):
    return {"cat": cat, "ph": "X", "ts": start, "dur": duration, "args": {"device": device}, "name": name}


class TraceTests(unittest.TestCase):
    def test_union_busy_and_intersection_do_not_double_count_overlapping_streams(self):
        result = profile.summarize_trace({"traceEvents": [event(0, 0, 10), event(0, 2, 4), event(0, 8, 7),
                                                        event(1, 5, 5), event(1, 7, 13)]})
        self.assertEqual(result["status"], "available")
        self.assertEqual(result["kernel_busy_us"], {"0": 15, "1": 15})
        self.assertEqual(result["kernel_overlap_us"], 10)
        self.assertEqual(result["gpu_activity_span_us"], 20)
        self.assertEqual(result["kernel_overlap_fraction_of_gpu_span"], 0.5)
        self.assertEqual(result["kernel_overlap_fraction_of_any_kernel_busy"], 0.5)

    def test_disjoint_kernels_keep_idle_gaps_in_span_and_zero_overlap(self):
        result = profile.summarize_trace([event(0, 0, 3), event(1, 8, 2)])
        self.assertEqual(result["kernel_overlap_us"], 0)
        self.assertEqual(result["gpu_activity_span_us"], 10)
        self.assertEqual(result["kernel_overlap_fraction_of_gpu_span"], 0)

    def test_missing_gpu_is_partial_not_measured_zero_utilization(self):
        result = profile.summarize_trace([event("0", 1, 2)])
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["missing_kernel_devices"], [1])
        self.assertIsNone(result["kernel_overlap_us"])
        self.assertIsNone(result["kernel_overlap_fraction_of_gpu_span"])

    def test_no_cuda_kernels_is_unavailable_even_when_cpu_events_exist(self):
        result = profile.summarize_trace([event(0, 0, 20, cat="cpu_op")])
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["gpu_activity_span_us"])
        self.assertIsNone(result["kernel_overlap_fraction_of_gpu_span"])

    def test_memcpy_groups_use_unions_and_expand_activity_span(self):
        result = profile.summarize_trace([event(0, 2, 3), event(1, 3, 3),
                                         event(0, 0, 3, "gpu_memcpy", "HtoD"),
                                         event(0, 1, 3, "gpu_memcpy", "HtoD"),
                                         event(1, 8, 2, "gpu_memcpy", "DtoH")])
        self.assertEqual(result["gpu_activity_span_us"], 10)
        self.assertEqual(result["kernel_overlap_fraction_of_gpu_span"], 0.2)
        self.assertEqual(result["memcpy_busy_union_us"], 6)
        self.assertEqual(result["memcpy_groups"], [
            {"device": 0, "name": "HtoD", "events": 2, "busy_union_us": 4},
            {"device": 1, "name": "DtoH", "events": 1, "busy_union_us": 2}])

    def test_invalid_device_and_nonfinite_durations_do_not_fabricate_overlap(self):
        result = profile.summarize_trace([event(0, 0, 3), event(1, 0, 3), event(None, 0, 4),
                                         event(True, 0, 2), event(1, 0, float("nan")), event(0, 0, -1)])
        self.assertEqual(result["invalid_cuda_events"], 4)
        self.assertEqual(result["status"], "partial")
        self.assertIsNone(result["kernel_overlap_fraction_of_gpu_span"])
        json.dumps(result, allow_nan=False)

    def test_bad_trace_container_fails(self):
        for trace in ({}, None, {"traceEvents": {}}):
            with self.subTest(trace=trace), self.assertRaises(ValueError):
                profile.summarize_trace(trace)


class HostTraceTests(unittest.TestCase):
    def host_event(self, name, start, duration, cat="cuda_runtime", tid=10):
        return {"cat":cat,"ph":"X","pid":1,"tid":tid,"name":name,"ts":start,"dur":duration}

    def test_nested_scalar_reads_merge_within_threads_but_thread_work_adds(self):
        host = profile.summarize_trace([
            self.host_event("aten::item",0,10,"cpu_op"),
            self.host_event("aten::_local_scalar_dense",2,6,"cpu_op"),
            self.host_event("aten::item",0,3,"cpu_op",tid=20),
            self.host_event("cudaStreamSynchronize",3,4),
            self.host_event("cudaLaunchKernel",20,2),
            self.host_event("cuLaunchKernel",22,3,"cuda_driver"),
        ])["host"]
        self.assertEqual(host["sum_thread_union_us"], {"kernel_launch":5,"synchronize":4,"scalar_read":13})
        self.assertEqual(host["event_counts"], {"kernel_launch":2,"synchronize":1,"scalar_read":3})
        self.assertTrue(host["intervals_may_overlap_between_groups"])

    def test_attention_operator_names_are_evidence_not_inferred_gpu_kernels(self):
        host = profile.summarize_trace([
            self.host_event("aten::_scaled_dot_product_flash_attention",0,4,"cpu_op"),
            self.host_event("aten::_scaled_dot_product_flash_attention",5,4,"cpu_op"),
            self.host_event("unrelated",0,2,"cpu_op"),
        ])["host"]
        self.assertEqual(host["attention_operator_calls"], {"aten::_scaled_dot_product_flash_attention":2})
        self.assertEqual(host["status"], "unavailable")

    def test_missing_thread_and_nonfinite_host_durations_are_not_zero_wait_evidence(self):
        missing = self.host_event("cudaDeviceSynchronize",0,10)
        del missing["tid"]
        host = profile.summarize_trace([missing,self.host_event("cudaLaunchKernel",0,float("nan"))])["host"]
        self.assertEqual(host["status"], "partial")
        self.assertEqual(host["invalid_host_events"], 2)
        json.dumps(host, allow_nan=False)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.events = []
        self.options = None
        self.failure = None
        outer = self

        class Profiler:
            def __enter__(self):
                outer.events.append("enter")
                if outer.failure == "enter":
                    raise RuntimeError("entry failed")
                return self

            def __exit__(self, *exception):
                outer.events.append("exit")
                if outer.failure == "exit":
                    raise RuntimeError("exit failed")

            def export_chrome_trace(self, path):
                outer.events.append("export")
                if outer.failure == "export":
                    raise RuntimeError("export failed")
                Path(path).write_text(json.dumps({"traceEvents": [event(0, 0, 2), event(1, 1, 2)]}))

        def create(**kwargs):
            self.options = kwargs
            self.events.append("create")
            if self.failure == "create":
                raise RuntimeError("construction failed")
            return Profiler()

        self.torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(device_count=lambda: 2, synchronize=lambda d: self.events.append("sync" + str(d))),
            profiler=types.SimpleNamespace(profile=create, ProfilerActivity=types.SimpleNamespace(CPU="CPU", CUDA="CUDA")))
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / "trace.json"

    def run_profile(self, function):
        with patch.dict(sys.modules, {"torch": self.torch}):
            return profile.profile_cuda_call(function, self.path)

    def test_success_runs_once_syncs_both_gpus_and_exports_explicit_path(self):
        def call():
            self.events.append("call")
            return "result"
        result, summary = self.run_profile(call)
        self.assertEqual(result, "result")
        self.assertEqual(self.events, ["sync0", "sync1", "create", "enter", "call", "sync0", "sync1", "exit", "export"])
        self.assertEqual(self.options, {"activities": ["CPU", "CUDA"], "record_shapes": False,
                                        "with_stack": False, "profile_memory": False})
        self.assertEqual(summary["trace_path"], str(self.path))
        self.assertTrue(summary["diagnostic_only"])

    def test_only_construction_and_entry_failures_are_optional(self):
        for failure in ("create", "enter"):
            with self.subTest(failure=failure):
                self.failure = failure
                with self.assertRaises(profile.ProfilerUnavailable):
                    self.run_profile(lambda: self.fail("Callable must not start"))

    def test_callable_oom_is_preserved_even_if_profiler_cleanup_also_fails(self):
        error = MemoryError("simulated OOM")
        self.failure = "exit"
        def call():
            raise error
        with self.assertRaises(MemoryError) as raised:
            self.run_profile(call)
        self.assertIs(raised.exception, error)
        self.assertNotIn("export", self.events)

    def test_profiler_initialization_oom_is_fatal(self):
        class OutOfMemoryError(RuntimeError):
            pass
        error = OutOfMemoryError("initialization OOM")
        self.torch.OutOfMemoryError = OutOfMemoryError
        def fail(**kwargs):
            raise error
        self.torch.profiler.profile = fail
        with self.assertRaises(OutOfMemoryError) as raised:
            self.run_profile(lambda: self.fail("Callable must not start"))
        self.assertIs(raised.exception, error)

    def test_exit_and_export_failures_after_call_are_fatal(self):
        for failure in ("exit", "export"):
            with self.subTest(failure=failure):
                self.failure = failure
                with self.assertRaises(RuntimeError) as raised:
                    self.run_profile(lambda: "done")
                self.assertNotIsInstance(raised.exception, profile.ProfilerUnavailable)

    def test_cuda_failure_is_fatal_before_callable(self):
        def fail(device):
            raise RuntimeError("CUDA synchronization failed")
        self.torch.cuda.synchronize = fail
        with self.assertRaises(RuntimeError) as raised:
            self.run_profile(lambda: self.fail("Callable must not start"))
        self.assertNotIsInstance(raised.exception, profile.ProfilerUnavailable)

    def test_cuda_failure_after_callable_is_fatal(self):
        started = []
        def synchronize(device):
            if started:
                raise RuntimeError("asynchronous CUDA failure")
        self.torch.cuda.synchronize = synchronize
        with self.assertRaisesRegex(RuntimeError, "asynchronous CUDA failure") as raised:
            self.run_profile(lambda: started.append(True))
        self.assertNotIsInstance(raised.exception, profile.ProfilerUnavailable)
        self.assertEqual(started, [True])
        self.assertNotIn("export", self.events)


if __name__ == "__main__":
    unittest.main()

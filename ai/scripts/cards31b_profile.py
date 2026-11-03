"""Optional canary diagnostics; instrumented timings are not speedup evidence."""
import json
import math
from pathlib import Path
import sys


class ProfilerUnavailable(RuntimeError):
    """Profiler construction/entry failed before the callable started."""


def _merge(intervals):
    merged = []
    for start, stop in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], stop))
        else:
            merged.append((start, stop))
    return merged


def _duration(intervals):
    return sum(stop - start for start, stop in intervals)


def _intersection(left, right):
    total, i, j = 0.0, 0, 0
    while i < len(left) and j < len(right):
        total += max(0.0, min(left[i][1], right[j][1]) - max(left[i][0], right[j][0]))
        if left[i][1] <= right[j][1]:
            i += 1
        else:
            j += 1
    return total


def _host_summary(events):
    """Selected host API durations, not CPU utilization or measured GPU stalls."""
    groups = {name: {} for name in ("kernel_launch", "synchronize", "scalar_read")}
    counts = {name: 0 for name in groups}
    attention, invalid = {}, 0
    for event in events:
        if not isinstance(event, dict):
            continue
        categories = set(str(event.get("cat", "")).split(","))
        name = str(event.get("name", ""))
        group = None
        if categories & {"cuda_runtime", "cuda_driver"}:
            if name.startswith(("cudaLaunch", "cuLaunch", "cudaGraphLaunch", "cuGraphLaunch")):
                group = "kernel_launch"
            elif name.startswith(("cuda", "cu")) and "Synchronize" in name:
                group = "synchronize"
        elif "cpu_op" in categories:
            if name in ("aten::item", "aten::_local_scalar_dense"):
                group = "scalar_read"
            if any(token in name for token in ("scaled_dot_product", "flex_attention", "flash_attn")):
                attention[name] = attention.get(name, 0) + 1
        if group is None:
            continue
        start, duration = event.get("ts"), event.get("dur")
        pid, tid = event.get("pid"), event.get("tid")
        if (event.get("ph", "X") != "X" or type(pid) not in (int, str)
                or type(tid) not in (int, str) or type(start) not in (int, float)
                or type(duration) not in (int, float) or not math.isfinite(start)
                or not math.isfinite(duration) or start < 0 or duration <= 0
                or not math.isfinite(start + duration) or start + duration <= start):
            invalid += 1
            continue
        groups[group].setdefault((pid, tid), []).append((start, start + duration))
        counts[group] += 1
    return {"scope": "selected host API calls; not CPU utilization or proof of a bottleneck",
            "status": "partial" if invalid else "available" if any(counts.values()) else "unavailable",
            "intervals_may_overlap_between_groups": True,
            "sum_thread_union_us": {name: sum(_duration(_merge(v)) for v in threads.values())
                                    for name, threads in groups.items()},
            "event_counts": counts, "invalid_host_events": invalid,
            "attention_operator_calls": attention}


def summarize_trace(trace):
    """Union Chrome trace intervals in microseconds, without summing concurrency.

    The wall-span denominator runs from first to last observed kernel/memcpy on
    GPUs 0/1, including gaps. This is observed kernel occupancy, not SM utilization.
    Missing/invalid GPU events make the overlap fraction unavailable.
    """
    events = trace.get("traceEvents") if isinstance(trace, dict) else trace
    if not isinstance(events, list):
        raise ValueError("Expected a Chrome trace event list")
    kernels, copies, activity = {0: [], 1: []}, {}, []
    invalid = 0
    for event in events:
        if not isinstance(event, dict):
            continue
        categories = [value.strip() for value in str(event.get("cat", "")).split(",")]
        kind = "kernel" if "kernel" in categories else "gpu_memcpy" if "gpu_memcpy" in categories else None
        if kind is None:
            continue
        args = event.get("args", {})
        device = args.get("device") if isinstance(args, dict) else None
        if isinstance(device, str) and device in ("0", "1"):
            device = int(device)
        start, duration = event.get("ts"), event.get("dur")
        if (type(device) is not int or device not in kernels or event.get("ph", "X") != "X"
                or type(start) not in (int, float) or type(duration) not in (int, float)
                or not math.isfinite(start) or not math.isfinite(duration) or start < 0 or duration <= 0
                or not math.isfinite(start + duration) or start + duration <= start):
            invalid += 1
            continue
        interval = (start, start + duration)
        activity.append(interval)
        if kind == "kernel":
            kernels[device].append(interval)
        else:
            copies.setdefault((device, str(event.get("name", "unnamed"))), []).append(interval)
    merged = {device: _merge(values) for device, values in kernels.items()}
    missing = [device for device, values in merged.items() if not values]
    status = "unavailable" if len(missing) == 2 else "partial" if missing or invalid else "available"
    span = max(stop for _, stop in activity) - min(start for start, _ in activity) if activity else None
    overlap = _intersection(merged[0], merged[1]) if not missing else None
    any_busy = _duration(_merge(kernels[0] + kernels[1]))
    return {"status": status, "diagnostic_only": True, "time_unit": "us",
            "host": _host_summary(events),
            "gpu_activity_span_us": span, "kernel_busy_us": {str(d): _duration(v) for d, v in merged.items()},
            "kernel_event_counts": {str(d): len(v) for d, v in kernels.items()},
            "kernel_overlap_us": overlap,
            "kernel_overlap_fraction_of_gpu_span": overlap / span if status == "available" else None,
            "kernel_overlap_fraction_of_any_kernel_busy": overlap / any_busy if status == "available" else None,
            "missing_kernel_devices": missing, "invalid_cuda_events": invalid,
            "memcpy_busy_union_us": _duration(_merge([v for values in copies.values() for v in values])),
            "memcpy_groups": [{"device": d, "name": name, "events": len(values),
                               "busy_union_us": _duration(_merge(values))}
                              for (d, name), values in sorted(copies.items())]}


def profile_cuda_call(callable, trace_path):
    """Run once with CPU/CUDA tracing; caller supplies an authorized output path.

    No directories are created. Only profiler initialization errors are optional;
    callable/CUDA/export failures propagate, including OOM. The caller owns mode,
    RNG, numerical checks, and uninstrumented performance measurements.
    """
    import torch
    path = Path(trace_path)
    if not path.name or not path.parent.is_dir() or path.is_dir():
        raise ValueError("Supply an explicit trace file in an existing authorized directory")
    if torch.cuda.device_count() != 2:
        raise ValueError("This canary profiler requires exactly two visible CUDA GPUs")
    for device in (0, 1):
        torch.cuda.synchronize(device)
    try:
        profiler = torch.profiler.profile(activities=[torch.profiler.ProfilerActivity.CPU,
                                                     torch.profiler.ProfilerActivity.CUDA],
                                          record_shapes=False, with_stack=False, profile_memory=False)
        profiler.__enter__()
    except Exception as error:
        if isinstance(error, (MemoryError, getattr(torch, "OutOfMemoryError", MemoryError))):
            raise
        raise ProfilerUnavailable("Profiler initialization failed before the callable started") from error
    try:
        result = callable()
        for device in (0, 1):
            torch.cuda.synchronize(device)
    except BaseException as error:
        exception = sys.exc_info()
        for device in (0, 1):
            try:
                torch.cuda.synchronize(device)
            except BaseException as cleanup:
                error.add_note("CUDA cleanup also failed: " + repr(cleanup))
        try:
            profiler.__exit__(*exception)
        except BaseException as cleanup:
            error.add_note("Profiler cleanup also failed: " + repr(cleanup))
        raise
    profiler.__exit__(None, None, None)
    profiler.export_chrome_trace(str(path))
    summary = summarize_trace(json.loads(path.read_text(encoding="utf-8")))
    summary["trace_path"] = str(path)
    return result, summary

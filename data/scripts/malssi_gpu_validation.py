"""Bounded one-GPU validation; never steps an optimizer or saves model weights."""
from __future__ import annotations

import argparse
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import time
import traceback


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def same_gpu_uuid(actual, expected):
    """CUDA exposes the same UUID with or without nvidia-smi's GPU- prefix."""
    return str(actual).removeprefix("GPU-").lower() == str(expected).removeprefix("GPU-").lower()


def probe_list(value):
    if isinstance(value, list):
        return value
    if isinstance(value, dict) and "source_row" in value and "encoded" in value:
        return [value]
    return value.get("probes", []) if isinstance(value, dict) else []


def benchmark_status(benchmarks):
    runs = [run for item in benchmarks for run in item["runs"]]
    passed = sum(run["status"] == "passed" for run in runs)
    oom = any(run["status"] == "oom" for run in runs)
    if not passed:
        return "no_successful_gradient_probe"
    if oom:
        return "partial_gradient_validation_oom"
    return "bounded_gradient_validation_completed"


def smi():
    return subprocess.check_output([
        "nvidia-smi", "--query-gpu=index,uuid,name,memory.total,memory.used,utilization.gpu",
        "--format=csv"], text=True)


def compute_apps():
    text = subprocess.check_output([
        "nvidia-smi", "--query-compute-apps=gpu_uuid,pid,process_name,used_memory",
        "--format=csv,noheader,nounits"], text=True)
    return [line.strip() for line in text.splitlines() if line.strip()]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, required=True)
    parser.add_argument("--model-dir", type=Path, required=True)
    parser.add_argument("--gpu-uuid", required=True)
    parser.add_argument("--probes", type=Path)
    parser.add_argument("--runtime-only", action="store_true")
    parser.add_argument("--max-probe-length", type=int, default=8192)
    args = parser.parse_args()
    root = Path("/home/slim/choieram").resolve()
    task, model_dir = args.workspace.resolve(), args.model_dir.resolve()
    require(task.is_relative_to(root) and model_dir.is_relative_to(root), "Paths outside authorized workspace")
    require(os.environ.get("CUDA_VISIBLE_DEVICES") == args.gpu_uuid, "GPU UUID pin is missing")
    require(args.gpu_uuid.startswith("GPU-"), "Use an exact physical GPU UUID")
    os.chdir(task)
    report_path = task / "reports" / ("gpu_runtime.json" if args.runtime_only else "gpu_validation.json")
    report = {"started_at_unix": time.time(), "pid": os.getpid(), "gpu_uuid": args.gpu_uuid,
              "cuda_visible_devices": os.environ["CUDA_VISIBLE_DEVICES"],
              "workspace": str(task), "model_dir": str(model_dir), "before": smi(),
              "optimizer_steps": 0, "model_weights_saved": False,
              "full_training_run": False, "checks": {}, "benchmarks": [], "errors": []}
    own_model = None

    def event(name, value):
        report["checks"][name] = value
        dump(report_path, report)
        print(json.dumps({"event": name, "value": value}, ensure_ascii=False), flush=True)

    try:
        other = [line for line in compute_apps() if args.gpu_uuid in line and f", {os.getpid()}," not in line]
        require(not other, "Pinned GPU acquired by another compute process: " + str(other))
        report["versions"] = {name: importlib.metadata.version(name) for name in
                              ["torch", "transformers", "unsloth", "unsloth_zoo", "bitsandbytes", "peft", "triton", "trl"]}
        # Unsloth must be imported before Transformers/PEFT patch their classes.
        from unsloth import FastModel
        import torch
        from transformers import AutoTokenizer
        try:
            from gemma4_token_validation import encode_example, collate_examples
        except ImportError:
            from counseling_pipeline.gemma4_token_validation import encode_example, collate_examples

        require(torch.cuda.is_available() and torch.cuda.device_count() == 1, "Exactly one CUDA device must be visible")
        device = torch.cuda.get_device_properties(0)
        if hasattr(device, "uuid"):
            require(same_gpu_uuid(device.uuid, args.gpu_uuid), "CUDA logical device is not the pinned physical GPU")
        value = torch.ones((128, 128), dtype=torch.float16, device="cuda")
        product = value @ value
        torch.cuda.synchronize()
        require(float(product[0, 0]) == 128.0, "CUDA matmul failed")
        event("runtime", {"torch_cuda": torch.version.cuda, "visible_devices": 1,
                          "device_name": device.name, "physical_uuid_verified": str(getattr(device, "uuid", "unavailable")),
                          "bf16_supported": torch.cuda.is_bf16_supported(), "matmul_passed": True,
                          "compute_apps": compute_apps()})
        del value, product
        torch.cuda.empty_cache()
        if args.runtime_only:
            report["status"] = "runtime_validated"
            return 0
        require(args.probes and args.probes.resolve().is_relative_to(task), "Expected probes inside validation workspace")
        probe_data = ([json.loads(p.read_text()) for p in sorted(args.probes.glob("probe_cap_*.json"))]
                      if args.probes.is_dir() else json.loads(args.probes.read_text()))
        # The tokenizer CLI emits a list of original rows and validated token arrays.
        probes = probe_list(probe_data)
        require(probes, "No validated probe rows")
        tokenizer = AutoTokenizer.from_pretrained(str(model_dir), local_files_only=True)
        load_start = time.monotonic()
        own_model, _ = FastModel.from_pretrained(
            model_name=str(model_dir), max_seq_length=args.max_probe_length,
            dtype=torch.bfloat16, load_in_4bit=True, full_finetuning=False,
            device_map={"": 0}, local_files_only=True,
        )
        device_set = sorted({str(p.device) for p in own_model.parameters()})
        require(device_set == ["cuda:0"], "Model unexpectedly spans CPU or a second GPU: " + str(device_set))
        event("model_load", {"seconds": time.monotonic() - load_start, "parameter_devices": device_set,
                             "allocated_gib": torch.cuda.memory_allocated() / 2**30,
                             "reserved_gib": torch.cuda.memory_reserved() / 2**30,
                             "is_loaded_in_4bit": bool(getattr(own_model, "is_loaded_in_4bit", False))})
        require(getattr(own_model, "is_loaded_in_4bit", False), "Quantized checkpoint did not load in four bits")
        own_model = FastModel.get_peft_model(
            own_model, finetune_vision_layers=False, finetune_language_layers=True,
            finetune_attention_modules=True, finetune_mlp_modules=True,
            r=8, lora_alpha=8, lora_dropout=0, bias="none", random_state=3407,
            use_gradient_checkpointing="unsloth",
        )
        parameters = [(name, p) for name, p in own_model.named_parameters() if p.requires_grad]
        device_set = sorted({str(p.device) for p in own_model.parameters()})
        require(device_set == ["cuda:0"], "LoRA model escaped the pinned CUDA device: " + str(device_set))
        require(parameters and all("lora_" in name for name, _ in parameters), "Unexpected non-LoRA trainable parameters")

        def adapter_hash():
            h = hashlib.sha256()
            for name, p in parameters:
                h.update(name.encode())
                h.update(p.detach().cpu().contiguous().view(torch.uint8).numpy().tobytes())
            return h.hexdigest()

        before_hash = adapter_hash()
        event("lora", {"r": 8, "alpha": 8, "trainable_parameters": sum(p.numel() for _, p in parameters),
                       "only_lora_trainable": True, "before_hash": before_hash, "optimizer_created": False,
                       "parameter_devices": device_set})

        # Exercise the installed causal loss API numerically without pre-shifting labels.
        from transformers.loss.loss_utils import ForCausalLMLoss
        torch.manual_seed(3407)
        tiny_logits = torch.randn(2, 6, 17, device="cuda", requires_grad=True)
        tiny_labels = torch.tensor([[-100, -100, -100, 3, 4, 5], [-100, -100, 6, 7, -100, -100]], device="cuda")
        native_loss = ForCausalLMLoss(tiny_logits, tiny_labels, vocab_size=17)
        expected_loss = torch.nn.functional.cross_entropy(tiny_logits[:, :-1].reshape(-1, 17), tiny_labels[:, 1:].reshape(-1))
        require(torch.allclose(native_loss, expected_loss, rtol=1e-6, atol=1e-6), "Installed causal shift differs from expected")
        native_loss.backward()
        require(bool(torch.all(tiny_logits.grad[tiny_labels.roll(-1, dims=1) == -100][:, :] == 0)),
                "Ignored next-token positions contributed gradient")
        event("installed_causal_loss_shift", {"passed": True, "native_loss": float(native_loss.detach()),
                                              "manual_one_shift_loss": float(expected_loss.detach()),
                                              "scope": "installed_loss_API_not_yet_model_fused_loss"})
        del tiny_logits, tiny_labels, native_loss, expected_loss

        own_model.train()
        seen_ids = set()
        for probe in sorted(probes, key=lambda p: p.get("encoded", p).get("sequence_length", 0)):
            row = probe.get("row", probe.get("example", probe.get("source_row")))
            require(isinstance(row, dict), "Probe must retain its original source example")
            if row["id"] in seen_ids:
                continue
            seen_ids.add(row["id"])
            encoded = encode_example(row, tokenizer)
            require(probe.get("encoded") == encoded, "Probe token arrays differ from the current GPU environment")
            if encoded["sequence_length"] > args.max_probe_length:
                continue
            batch = collate_examples([encoded], tokenizer.pad_token_id, args.max_probe_length)
            tensors = {k: torch.tensor(v, device="cuda", dtype=torch.long) for k, v in batch.items()}
            summary = {"row_id": row["id"], "sequence_length": encoded["sequence_length"],
                       "prefix_length": encoded["prefix_length"], "supervised_tokens": encoded["target_length"],
                       "batch_size": 1, "optimizer_state_allocated": False, "runs": []}
            # Two repetitions distinguish first-call compilation from a subsequent run.
            for repetition in range(2):
                outputs = None
                try:
                    own_model.zero_grad(set_to_none=True)
                    gc.collect()
                    torch.cuda.empty_cache()
                    torch.cuda.reset_peak_memory_stats()
                    torch.cuda.synchronize()
                    started = time.monotonic()
                    outputs = own_model(**tensors, use_cache=False)
                    loss = outputs.loss
                    require(loss is not None and bool(torch.isfinite(loss)), "Nonfinite/missing actual model loss")
                    loss.backward()
                    torch.cuda.synchronize()
                    elapsed = time.monotonic() - started
                    nonzero, finite = 0, True
                    for _, p in parameters:
                        if p.grad is not None:
                            finite = finite and bool(torch.isfinite(p.grad).all())
                            nonzero += bool(torch.count_nonzero(p.grad))
                    require(finite and nonzero, "LoRA gradients are missing, zero or nonfinite")
                    run = {"repetition": repetition, "loss": float(loss.detach()), "seconds": elapsed,
                           "input_tokens_per_second": encoded["sequence_length"] / elapsed,
                           "supervised_tokens_per_second": encoded["target_length"] / elapsed,
                           "peak_allocated_gib": torch.cuda.max_memory_allocated() / 2**30,
                           "peak_reserved_gib": torch.cuda.max_memory_reserved() / 2**30,
                           "finite_gradients": finite, "nonzero_gradient_tensors": nonzero,
                           "weights_updated": False, "status": "passed"}
                    summary["runs"].append(run)
                except torch.OutOfMemoryError as exc:
                    summary["runs"].append({"status": "oom", "repetition": repetition, "message": str(exc)[:1000]})
                    break
                finally:
                    outputs = None
                    own_model.zero_grad(set_to_none=True)
                    gc.collect()
                    torch.cuda.empty_cache()
            del tensors
            report["benchmarks"].append(summary)
            dump(report_path, report)
            print(json.dumps({"event": "benchmark", "value": summary}), flush=True)
            if any(r["status"] == "oom" for r in summary["runs"]):
                break
        after_hash = adapter_hash()
        require(before_hash == after_hash, "Adapter weights changed despite no optimizer step")
        event("adapter_weights_unchanged", {"passed": True, "after_hash": after_hash})
        report["status"] = benchmark_status(report["benchmarks"])
        report["successful_gradient_runs"] = sum(r["status"] == "passed" for b in report["benchmarks"] for r in b["runs"])
        report["limitations"] = ["No optimizer step/state; this is not proof of full training memory fit.",
                                 "No B1 trained adapter exists, so no B0/B1 effectiveness claim.",
                                 "Throughput includes this exact forward/backward path, not a full epoch benchmark."]
        return 0 if report["status"] == "bounded_gradient_validation_completed" else 3
    except Exception as exc:
        report["status"] = "blocked_or_failed"
        report["errors"].append({"type": type(exc).__name__, "message": str(exc), "traceback": traceback.format_exc()})
        print(traceback.format_exc(), flush=True)
        raise
    finally:
        own_model = None
        gc.collect()
        report["ended_at_unix"] = time.time()
        report["after"] = smi()
        dump(report_path, report)


if __name__ == "__main__":
    raise SystemExit(main())

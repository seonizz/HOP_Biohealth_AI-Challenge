#!/usr/bin/env python3
"""Fresh-process, single-GPU memory feasibility; never a numerical/DDP qualification.

Run only through the task's Landlock/seccomp bootstrap in the pinned venv, with
one UUID in CUDA_VISIBLE_DEVICES and all runtime/cache paths under --work.
The bootstrap owns GPU exclusion and fallback to the existing training job.
This script never saves adapters, resumes production, changes the environment,
or retries after an error. REPLICA_FIT.json is the sole report it writes.
"""
import argparse
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import sys
import time
import uuid


INITIAL_ADAPTER_SHA = "dd75effaa0fbede54d5a24a302cab6d1520278ed87051f39a174cd934a719e49"
REFERENCE_SHA = "642ea9905fc6f870007767c163eb427082a91f84c6380bf3c422fec01b84b855"
TRAINABLE_ELEMENTS = 61214720
REPORT_NAME = "REPLICA_FIT.json"
CACHE_PATHS = (
    "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "HF_HOME", "HF_HUB_CACHE", "HF_MODULES_CACHE",
    "HF_DATASETS_CACHE", "TORCH_HOME", "TORCH_EXTENSIONS_DIR", "TORCHINDUCTOR_CACHE_DIR",
    "TORCH_COMPILE_DEBUG_DIR", "TRITON_CACHE_DIR", "CUDA_CACHE_PATH", "NUMBA_CACHE_DIR",
    "MPLCONFIGDIR", "IPYTHONDIR", "PIP_CACHE_DIR", "UV_CACHE_DIR", "WANDB_DIR",
    "UNSLOTH_COMPILE_LOCATION",
)


class StopRequested(Exception):
    """A coordinator/user stop must not trigger an automatic training fallback."""


def check_stop(work):
    if any(path.exists() for path in (work / "STOP", work.parent / "STOP", work.parent / "CANCEL")):
        raise StopRequested("STOP/CANCEL requested; do not start or resume training")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def canonical_path(path):
    path = Path(path)
    require(path.is_absolute() and path == path.resolve(strict=True)
            and not any(p.is_symlink() for p in (path, *path.parents)),
            "Path must exist and be canonical without symlinks: " + str(path))
    return path


def child_file(root, name):
    require(isinstance(name, str) and name and not Path(name).is_absolute()
            and all(p not in ("", ".", "..") for p in name.split("/")), "Unsafe relative path")
    path = canonical_path(root / name)
    require(path.is_relative_to(root) and path.is_file(), "File leaves input root")
    return path


def atomic_report(work, report):
    payload = json.dumps(report, sort_keys=True, allow_nan=False) + "\n"
    target = work / REPORT_NAME
    require(not target.is_symlink(), "Report path is a symlink")
    temporary = work / ("." + REPORT_NAME + "." + uuid.uuid4().hex)
    try:
        with temporary.open("x") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def verify_environment(args, config):
    require(sys.flags.isolated and sys.flags.no_site and sys.dont_write_bytecode,
            "Use the isolated bootstrap (python -I -S -B)")
    require(Path(sys.prefix) == Path(config["python_path"]).parent.parent,
            "The pinned existing venv is required")
    require(os.environ.get("CUDA_VISIBLE_DEVICES") == args.gpu_uuid
            and args.gpu_uuid.startswith("GPU-") and "," not in args.gpu_uuid,
            "Exactly one explicit GPU UUID must be pinned before import")
    for key in CACHE_PATHS:
        value = os.environ.get(key)
        require(value, "Missing task-local cache path: " + key)
        require(canonical_path(value).is_relative_to(args.work), "Cache leaves work: " + key)
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_DATASETS_OFFLINE"):
        require(os.environ.get(key) == "1", "Offline bootstrap required: " + key)
    for key in ("UNSLOTH_CE_LOSS_N_CHUNKS", "UNSLOTH_CE_LOSS_TARGET_GB",
                "UNSLOTH_COMPILE_DISABLE", "UNSLOTH_TILED_MLP"):
        require(not os.environ.get(key), "Inherited training override: " + key)
    for key in ("UNSLOTH_RETURN_LOGITS", "UNSLOTH_RETURN_HIDDEN_STATES"):
        require(os.environ.get(key, "0") == "0", "Original fused full-head path required: " + key)


def preflight(args):
    """Verify actual current files, including every original checkpoint code path."""
    for name in ("dataset", "model", "legacy_kit", "initial_checkpoint", "reference_dir"):
        setattr(args, name, canonical_path(getattr(args, name)))
    reference_path = child_file(args.reference_dir, "reference_train_cards_31b.py")
    require(sha(reference_path) == REFERENCE_SHA, "Immutable original runner changed")
    spec = importlib.util.spec_from_file_location("_replica_original_reference", reference_path)
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
    manifest_path = child_file(args.initial_checkpoint, "CHECKPOINT.json")
    manifest = json.loads(manifest_path.read_text())
    binding = manifest["binding"]
    manifest = reference.verify_checkpoint(args.initial_checkpoint, binding)
    require(manifest["adapter_sha256"] == INITIAL_ADAPTER_SHA,
            "Checkpoint is not the pinned initial adapter")
    progress = manifest["progress"]
    require(progress["phase"] == "00_original_warmup" and progress["epoch"] == 0
            and progress["step"] == 0 and progress["cursor"] == 0, "Initial checkpoint required")
    expected = {"optimizer": "AdamW", "learning_rate": 2e-5, "accumulation": 8,
                "seed": 3407, "max_length": 32768,
                "objective": "sum(weight_i * mean_target_CE_i) / N"}
    require(all(binding.get(k) == v for k, v in expected.items()), "Original objective/config changed")
    original_paths = binding["code_sha256"]
    for name, digest in original_paths.items():
        require(sha(canonical_path(name)) == digest, "Original bound source changed: " + name)
    trainer_hashes = [v for k, v in original_paths.items() if Path(k).name == "train_cards_31b.py"]
    require(trainer_hashes == [REFERENCE_SHA], "Reference is not the original checkpoint runner")
    for field, root, name in (
        ("course_sha256", args.dataset, "COURSE.json"),
        ("dataset_manifest_sha256", args.dataset, "MANIFEST.json"),
        ("model_config_sha256", args.model, "config.json"),
        ("model_index_sha256", args.model, "model.safetensors.index.json"),
    ):
        require(sha(child_file(root, name)) == binding[field], "Bound input changed: " + name)
    config = json.loads(child_file(args.legacy_kit, "config/train.json").read_text())
    config.update(max_length=32768, model_path=str(args.model))
    require(config == binding["loader_config"], "Original loader configuration changed")
    require(config["unsloth_tiled_mlp"] is True and config["packing"] is False
            and config["truncation"] is False, "Original tiling/full-input configuration required")
    verify_environment(args, config)
    versions = {name: importlib.metadata.version(name) for name in config["versions"]}
    require(versions == config["versions"] == binding["versions"], "Pinned package versions changed")
    fingerprint = json.loads(child_file(args.legacy_kit, "config/model_fingerprint.json").read_text())
    require(fingerprint["local_file_hashes"] == binding["model_files"], "Model inventory changed")
    for name, item in fingerprint["local_file_hashes"].items():
        path = child_file(args.model, name)
        require(path.stat().st_size == item["bytes"] and sha(path) == item["sha256"],
                "Base model fingerprint differs: " + name)
    fused = Path(sys.prefix) / "lib/python3.12/site-packages/unsloth_zoo/fused_losses/cross_entropy_loss.py"
    for path in (fused, args.legacy_kit / "counseling_pipeline/stage1_preparation.py",
                 args.legacy_kit / "counseling_pipeline/gemma4_token_validation.py"):
        require(str(path) in original_paths and sha(canonical_path(path)) == original_paths[str(path)],
                "Runtime source not bound to original checkpoint: " + str(path))
    require(sha(fused) == config["fused_loss_source_sha256"], "Fused CE source changed")
    course = json.loads((args.dataset / "COURSE.json").read_text())
    require(course["role"] == "cards_31b" and course["phases"][0]["initial_adapter_from"] is None,
            "Fresh 31B course required")
    for name, digest in course["model"]["tokenizer_sha256"].items():
        require(sha(child_file(args.model, name)) == digest, "Dataset/model tokenizer differs")
    # Verify the bundled verifier and its imports before executing them.
    files = json.loads((args.dataset / "MANIFEST.json").read_text())["files"]
    for path in (args.dataset / "scripts").rglob("*.py"):
        name = str(path.relative_to(args.dataset))
        require(name in files and sha(child_file(args.dataset, name)) == files[name]["sha256"],
                "Dataset verifier source changed: " + name)
    sys.path.insert(0, str(args.dataset / "scripts"))
    import expanded_card_dataset
    import role_dataset
    for module in (expanded_card_dataset, role_dataset):
        require(Path(module.__file__).parent == args.dataset / "scripts", "Unexpected dataset module")
    verified = expanded_card_dataset.verify(args.dataset)
    require(verified["status"] == "passed", "Full dataset verification failed")
    datasets = {}
    for phase in course["phases"]:
        part = phase["data"]["train"]
        datasets[phase["id"]] = role_dataset.IndexedTokens(
            child_file(args.dataset, part["token_index"]), child_file(args.dataset, part["token_binary"]))
    proof = {"checkpoint_manifest_sha256": sha(manifest_path), "reference_sha256": REFERENCE_SHA,
             "probe_sha256": sha(Path(__file__)), "original_binding": binding,
             "dataset_verification": verified, "venv": sys.prefix,
             "placement_override": {"device_map": {"": 0}, "gpu_uuid": args.gpu_uuid},
             "all_original_bound_code_hashes_verified": True}
    return reference, config, datasets, proof


def select_probes(datasets):
    """Deterministic maxima across all training phases; never slice a sequence."""
    rows = [(phase, index, row) for phase, dataset in datasets.items()
            for index, row in enumerate(dataset.entries)]
    require(rows, "No training rows")
    for _, _, row in rows:
        require(row["split"] == "train" and 0 < row["prefix_length"] < row["sequence_length"] <= 32768
                and row["sequence_length"] == row["prefix_length"] + row["target_length"],
                "Invalid full training-row metadata")
    longest = max(rows, key=lambda item: item[2]["sequence_length"])
    targets = max(rows, key=lambda item: item[2]["target_length"])
    require(longest[2]["sequence_length"] == 25316, "Pinned maximum training length changed")
    return [{"stage": stage, "phase": phase, "index": index,
             **{key: row[key] for key in ("row_id", "sequence_length", "prefix_length", "target_length")}}
            for stage, (phase, index, row) in zip(
                ("first_longest_update", "largest_target_update", "repeat_longest_with_adam_state"),
                (longest, targets, longest))]


def load_replica(args, config, reference):
    # Same loader call order/arguments as the verified legacy source; placement is
    # the sole model-loading override. Import Unsloth before torch/transformers.
    from unsloth import FastModel
    import torch
    from transformers import AutoTokenizer
    require(torch.cuda.device_count() == 1, "One visible CUDA device required")
    physical = str(torch.cuda.get_device_properties(0).uuid)
    require(physical.removeprefix("GPU-") == args.gpu_uuid.removeprefix("GPU-"), "Physical UUID differs")
    tokenizer = AutoTokenizer.from_pretrained(config["model_path"], local_files_only=True)
    model, _ = FastModel.from_pretrained(
        model_name=config["model_path"], max_seq_length=config["max_length"], dtype=torch.bfloat16,
        load_in_4bit=True, full_finetuning=False, device_map={"": 0}, local_files_only=True,
        unsloth_tiled_mlp=config["unsloth_tiled_mlp"])
    model = FastModel.get_peft_model(
        model, finetune_vision_layers=False, finetune_language_layers=True,
        finetune_attention_modules=True, finetune_mlp_modules=True,
        r=8, lora_alpha=8, lora_dropout=0, bias="none", random_state=3407,
        use_gradient_checkpointing="unsloth")
    require(model.is_loaded_in_4bit and {str(p.device) for p in model.parameters()} == {"cuda:0"},
            "Entire quantized model must reside on the one GPU")
    mapping = getattr(model, "hf_device_map", {})
    require(mapping and all(str(v) in ("0", "cuda:0") for v in mapping.values()),
            "CPU/disk weight offload is forbidden")
    require(not any(getattr(getattr(m, "_hf_hook", None), "offload", False)
                    for m in model.modules()), "Weight-offload hooks are forbidden")
    text = getattr(model.config, "text_config", model.config)
    require(text.num_hidden_layers == 60 and text.hidden_size == 5376, "Unexpected text model")
    tiled = [n for n, m in model.named_modules() if "language_model.layers." in n and n.endswith(".mlp")
             and getattr(m.forward, "__name__", "") == "tiled_forward_arctic_size"]
    require(len(tiled) == 60, "All 60 original TiledMLPs must remain active")
    pp = reference.parameters(model)
    require(all(p.dtype == torch.float32 for p in pp), "FP32 LoRA/AdamW parameters required")
    saved_adapter = json.loads(child_file(args.initial_checkpoint, "adapter_config.json").read_text())
    adapter = model.peft_config["default"]
    for key, wanted in (("r", 8), ("lora_alpha", 8), ("lora_dropout", 0), ("bias", "none")):
        require(getattr(adapter, key) == saved_adapter[key] == wanted, "LoRA configuration differs: " + key)
    actual_targets, saved_targets = adapter.target_modules, saved_adapter["target_modules"]
    require((actual_targets == saved_targets if isinstance(actual_targets, str)
             else set(actual_targets) == set(saved_targets)), "LoRA target modules differ")
    head, embedding = model.get_output_embeddings().weight, model.get_input_embeddings().weight
    require(head.dtype == embedding.dtype == torch.bfloat16 and not head.requires_grad
            and head.device == embedding.device and tokenizer.pad_token_id == 0,
            "Original BF16 frozen head/embedding/tokenizer contract changed")
    quantized = [p for p in model.parameters() if getattr(p, "quant_state", None) is not None]
    require(quantized and all(p.quant_state.quant_type == "nf4" for p in quantized), "NF4 weights required")
    model.config.use_cache = False
    torch.set_float32_matmul_precision("highest")
    from peft.utils.save_and_load import load_peft_weights, set_peft_model_state_dict
    set_peft_model_state_dict(model, load_peft_weights(str(args.initial_checkpoint), device="cpu"),
                             adapter_name="default")
    actual = reference.parameter_sha(model)
    require(actual == INITIAL_ADAPTER_SHA, "Loaded adapter differs from the exact original initialization")
    require(all(bool(torch.isfinite(p).all().item()) for p in pp), "Nonfinite initial adapter")
    optimizer = torch.optim.AdamW(pp, lr=2e-5, weight_decay=0.01, foreach=False)
    require(not optimizer.state, "Probe optimizer must begin without state")
    return model, optimizer, {"gpu_uuid": args.gpu_uuid, "device_name": torch.cuda.get_device_name(0),
                              "total_memory_bytes": torch.cuda.get_device_properties(0).total_memory,
                              "trainable_elements": sum(p.numel() for p in pp), "tiled_mlp_count": len(tiled),
                              "initial_adapter_sha256": actual, "initial_adapter_all_finite": True}


def optimizer_inventory(model, optimizer, reference):
    """Require initialized, finite FP32 Adam moments for every LoRA parameter."""
    import torch
    pp = reference.parameters(model)
    require(len(optimizer.state) == len(pp) > 0, "Incomplete/empty optimizer state")
    elements = {"exp_avg": 0, "exp_avg_sq": 0}
    steps = set()
    for p in pp:
        state = optimizer.state[p]
        require(set(state) == {"step", "exp_avg", "exp_avg_sq"}, "Unexpected AdamW state")
        for name in elements:
            value = state[name]
            require(value.dtype == torch.float32 and value.device == p.device
                    and value.shape == p.shape and bool(torch.isfinite(value).all().item()),
                    "Invalid FP32 optimizer moment: " + name)
            elements[name] += value.numel()
        step = state["step"]
        require(step.numel() == 1 and bool(torch.isfinite(step).item()), "Invalid AdamW step")
        steps.add(float(step))
    require(set(elements.values()) == {TRAINABLE_ELEMENTS} and len(steps) == 1 and min(steps) > 0,
            "AdamW state does not cover the original LoRA")
    return {"parameter_tensors": len(pp), "moment_elements": elements,
            "moment_dtype": "torch.float32", "moment_device": "cuda:0",
            "optimizer_step": steps.pop(), "all_finite": True}


def run(args, report):
    def checkpoint(stage, **fields):
        report.update(stage=stage, **fields)
        atomic_report(args.work, report)

    checkpoint("preflight")
    check_stop(args.work)
    reference, config, datasets, proof = preflight(args)
    probes = select_probes(datasets)
    plans = {phase: reference.epoch_plan(dataset.entries, 8, 3407) for phase, dataset in datasets.items()}
    for probe in probes:
        coefficient = reference.coefficient(datasets[probe["phase"]].entries[probe["index"]], plans[probe["phase"]])
        probe["coefficient"] = {"numerator": coefficient.numerator, "denominator": coefficient.denominator}
    checkpoint("model_load", input_proof=proof, probes=probes)
    check_stop(args.work)
    model, optimizer, runtime = load_replica(args, config, reference)
    checkpoint("model_loaded", runtime=runtime, initial_adapter_sha256=runtime["initial_adapter_sha256"])
    import torch
    for probe in probes:
        checkpoint(probe["stage"], active_probe=probe)
        check_stop(args.work)
        torch.cuda.synchronize(0)
        torch.cuda.reset_peak_memory_stats(0)
        start = time.monotonic()
        evidence = reference.update(model, optimizer, datasets[probe["phase"]],
                                    [probe["index"]], plans[probe["phase"]])
        torch.cuda.synchronize(0)
        elapsed = time.monotonic() - start
        record = {**probe, **evidence, "seconds": elapsed,
                  "peak_allocated_bytes": torch.cuda.max_memory_allocated(0),
                  "peak_reserved_bytes": torch.cuda.max_memory_reserved(0)}
        report["updates"].append(record)
        report["completed_updates"] = len(report["updates"])
        # Inventory is outside update timing; any allocation/error still fails
        # this process. The next measured update begins with this state live.
        record["optimizer_inventory"] = optimizer_inventory(model, optimizer, reference)
        require(record["optimizer_inventory"]["optimizer_step"] == len(report["updates"]),
                "Unexpected optimizer step")
        checkpoint(probe["stage"] + "_completed", completed_updates=len(report["updates"]))
    checkpoint("final_verification")
    check_stop(args.work)
    final_sha = reference.parameter_sha(model)
    require(final_sha != INITIAL_ADAPTER_SHA, "Probe completed without an adapter update")
    require(all(bool(torch.isfinite(p).all().item()) for p in reference.parameters(model)), "Nonfinite final adapter")
    require(sha(Path(__file__)) == proof["probe_sha256"], "Probe source changed during execution")
    require(sha(args.reference_dir / "reference_train_cards_31b.py") == REFERENCE_SHA, "Reference changed during execution")
    checkpoint("completed", status="fit_passed", final_adapter_sha256=final_sha,
               final_adapter_all_finite=True, optimizer_all_finite=True, gradients_all_finite=True,
               numerical_qualification=False, ddp_qualification=False, completed_updates=3)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("work", "dataset", "model", "legacy-kit", "initial-checkpoint", "reference-dir"):
        parser.add_argument("--" + name, required=True, type=Path)
    parser.add_argument("--gpu-uuid", required=True)
    args = parser.parse_args(argv)
    args.work = canonical_path(args.work)
    require(args.work.is_dir() and not (args.work / REPORT_NAME).exists(), "Use a fresh work/report directory")
    report = {"schema": "cards31b-single-gpu-fit-v1", "status": "running", "pid": os.getpid(),
              "gpu_uuid": args.gpu_uuid, "started_at": time.time(), "updates": [], "completed_updates": 0,
              "numerical_qualification": False, "ddp_qualification": False,
              "scope": "three original full-context/full-head row updates; no production checkpoint writes"}
    try:
        run(args, report)
    except (StopRequested, KeyboardInterrupt) as error:
        report.update(status="cancelled", error_type=type(error).__name__, error=str(error),
                      finished_at=time.time(), automatic_fallback_allowed=False)
        atomic_report(args.work, report)
        raise SystemExit(130) from error
    except BaseException as error:
        # No CUDA operations, empty_cache, retry, or model reuse after an error.
        torch = sys.modules.get("torch")
        oom_type = getattr(torch, "OutOfMemoryError", ()) if torch is not None else ()
        oom = isinstance(error, oom_type)
        report.update(status="failed", failure_kind="cuda_out_of_memory" if oom else "exception",
                      error_type=type(error).__name__, error=str(error), finished_at=time.time())
        if oom:
            report["conclusion"] = ("Unchanged full replica did not fit this single GPU; "
                                    "DDP feasibility is not established. Exit without model reuse.")
        atomic_report(args.work, report)
        raise
    report["finished_at"] = time.time()
    atomic_report(args.work, report)
    print(json.dumps({"status": report["status"], "report": str(args.work / REPORT_NAME),
                      "pid": os.getpid(), "completed_updates": report["completed_updates"]}), flush=True)


if __name__ == "__main__":
    main()

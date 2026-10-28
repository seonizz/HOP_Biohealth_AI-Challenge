"""One-epoch, last-response-only QLoRA loop; importing this module needs no torch.

The caller owns model loading, GPU isolation and dataset admission. ``bindings``
identifies its immutable model/data/config inputs. Checkpoints contain adapters,
optimizer/scheduler states and RNG states, never the full base model. A canary is
an explicitly separate run over caller-selected longest rows, not training proof.
"""

from contextlib import contextmanager
from copy import deepcopy
import hashlib
import json
import math
import os
from pathlib import Path
import random
import shutil
import time
import uuid

from .gemma4_token_validation import collate_examples
from . import supporter_weighted_loss


class TrainingLoopError(ValueError):
    """A run or checkpoint violates the fixed training contract."""


def _require(condition, message):
    if not condition:
        raise TrainingLoopError(message)


def _json_bytes(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _sha(value):
    return hashlib.sha256(_json_bytes(value)).hexdigest()


def _file_sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path, value):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as handle:
            handle.write(_json_bytes(value) + b"\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def _run_lock(directory):
    import fcntl
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".runtime.lock").open("a") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise TrainingLoopError("Another process owns this output directory") from exc
        try:
            yield
        finally:
            fcntl.flock(handle, fcntl.LOCK_UN)


def make_plan(rows, *, pad_id, max_length=4096, accumulation_steps=8, seed=3407,
              shuffle=True):
    """Validate unshifted examples and return a deterministic order and digest."""
    _require(isinstance(rows, (list, tuple)) and bool(rows), "No encoded training rows")
    _require(type(accumulation_steps) is int and accumulation_steps > 0,
             "Invalid accumulation_steps")
    _require(type(seed) is int and type(shuffle) is bool, "Invalid shuffle settings")
    digest = hashlib.sha256()
    for row in rows:
        batch = collate_examples([row], pad_id, max_length, packing=False)
        digest.update(_json_bytes(batch) + b"\n")
    order = list(range(len(rows)))
    if shuffle:
        random.Random(seed).shuffle(order)
    return {"order": order, "encoded_rows_sha256": digest.hexdigest(),
            "rows": len(rows), "optimizer_steps": math.ceil(len(rows) / accumulation_steps),
            "supervised_tokens": sum(row["target_length"] for row in rows)}


def window_weights(rows, indices):
    """Each model loss is a mean over shifted, nonignored target labels."""
    _require(bool(indices), "Empty accumulation window")
    counts = [sum(token != -100 for token in rows[index]["labels"][1:]) for index in indices]
    _require(all(count > 0 for count in counts), "Zero-target microbatch")
    total = sum(counts)
    return counts, [count / total for count in counts]


def _weighted_plan(rows, entries, *, task, bindings, **settings):
    """Bind the complete, single-task train policy to the existing row API."""
    _require(isinstance(entries, (list, tuple)) and len(entries) == len(rows),
             "Weighted entries must match every training row")
    weighted = supporter_weighted_loss.make_plan(entries, task=task, bindings=bindings, **settings)
    _require(all(_json_bytes(row) == _json_bytes(entry["encoded"])
                 for row, entry in zip(rows, entries)), "Weighted entries/encoded rows differ")
    return weighted


def _trainable(model):
    parameters = [(name, parameter) for name, parameter in model.named_parameters()
                  if parameter.requires_grad]
    _require(bool(parameters), "No trainable adapter parameters")
    return parameters


def _parameter_sha(model):
    digest = hashlib.sha256()
    for name, parameter in _trainable(model):
        tensor = parameter.detach().cpu().contiguous()
        digest.update(_json_bytes([name, list(tensor.shape), str(tensor.dtype)]))
        # uint8 avoids NumPy's lack of bfloat16 support.
        import torch
        digest.update(tensor.view(torch.uint8).numpy().tobytes())
    return digest.hexdigest()


def _optimizer_signature(model, optimizer):
    named = _trainable(model)
    by_id = {id(parameter): name for name, parameter in named}
    actual = [parameter for group in optimizer.param_groups for parameter in group["params"]]
    _require(len(actual) == len(by_id) and {id(p) for p in actual} == set(by_id),
             "Optimizer must contain every trainable parameter exactly once")
    return {"class": type(optimizer).__module__ + "." + type(optimizer).__qualname__,
            "defaults": optimizer.defaults,
            "parameter_groups": [{"names": [by_id[id(p)] for p in group["params"]],
                                  "options": {k: v for k, v in group.items() if k != "params"}}
                                 for group in optimizer.param_groups],
            "parameter_shapes": [[name, list(p.shape), str(p.dtype)] for name, p in named]}


def _batch(row, pad_id, max_length, device):
    import torch
    return {key: torch.tensor(value, dtype=torch.long, device=device)
            for key, value in collate_examples([row], pad_id, max_length).items()}


def _rng_state():
    import torch
    return {"python": random.getstate(), "cpu": torch.get_rng_state(),
            "cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_available() else []}


def _restore_rng(state):
    import torch
    random.setstate(state["python"])
    torch.set_rng_state(state["cpu"])
    _require(len(state["cuda"]) == (torch.cuda.device_count() if torch.cuda.is_available() else 0),
             "CUDA device count changed across resume")
    if state["cuda"]:
        torch.cuda.set_rng_state_all(state["cuda"])


def _save_checkpoint(model, optimizer, scheduler, directory, run, step, cursor):
    import torch
    checkpoint_root = directory / "checkpoints"
    checkpoint_root.mkdir(exist_ok=True)
    destination = checkpoint_root / f"step-{step:09d}"
    _require(not destination.exists(), "Checkpoint exists; refusing to overwrite")
    temporary = checkpoint_root / f".writing-{uuid.uuid4().hex}"
    temporary.mkdir()
    try:
        model.save_pretrained(temporary, safe_serialization=True)
        adapter_sha = _parameter_sha(model)
        state = {"step": step, "cursor": cursor, "order": run["plan"]["order"],
                 "run_sha256": _sha(run), "optimizer": optimizer.state_dict(),
                 "scheduler": scheduler.state_dict() if scheduler is not None else None,
                 "rng": _rng_state()}
        weighted = run.get("weighted_loss_plan")
        if weighted is not None:
            state.update(weighted_loss_plan=weighted, writer_pid=os.getpid())
        torch.save(state, temporary / "training_state.pt")
        _require(not any(path.is_symlink() for path in temporary.rglob("*")),
                 "Checkpoint symlinks are forbidden")
        files = {str(path.relative_to(temporary)): _file_sha(path)
                 for path in temporary.rglob("*") if path.is_file()}
        _require(any(name.startswith("adapter_model.") for name in files),
                 "save_pretrained did not produce adapter_model weights")
        manifest = {"schema_version": 1, "run_sha256": _sha(run), "step": step, "cursor": cursor,
                    "adapter_parameters_sha256": adapter_sha, "files": files}
        if weighted is not None:
            manifest.update(weighted_plan_sha256=weighted["plan_sha256"], writer_pid=os.getpid())
        _atomic_json(temporary / "CHECKPOINT.json", manifest)
        for path in temporary.rglob("*"):
            if path.is_file():
                with path.open("rb") as handle:
                    os.fsync(handle.fileno())
        os.rename(temporary, destination)
    finally:
        # Only this invocation's unpublished directory is disposable. A rename
        # commits the checkpoint even if updating latest.json subsequently fails.
        if temporary.exists():
            shutil.rmtree(temporary)
    _atomic_json(directory / "latest.json", {"checkpoint": str(destination.relative_to(directory))})
    return destination


def _peft_restore(model, checkpoint):
    from peft.utils.save_and_load import load_peft_weights, set_peft_model_state_dict
    weights = load_peft_weights(str(checkpoint), device="cpu")
    result = set_peft_model_state_dict(model, weights, adapter_name="default")
    _require(not result.unexpected_keys, "Unexpected adapter keys during restore")


def _state_equal(actual, expected):
    import torch
    if isinstance(actual, torch.Tensor) and isinstance(expected, torch.Tensor):
        return actual.dtype == expected.dtype and torch.equal(actual.detach().cpu(), expected.cpu())
    if isinstance(actual, dict) and isinstance(expected, dict):
        return actual.keys() == expected.keys() and all(_state_equal(actual[k], expected[k]) for k in actual)
    if isinstance(actual, (list, tuple)) and isinstance(expected, (list, tuple)):
        return len(actual) == len(expected) and all(_state_equal(a, b) for a, b in zip(actual, expected))
    return type(actual) is type(expected) and actual == expected


def _load_checkpoint(model, optimizer, scheduler, directory, run, resume_from, restore_adapter):
    import torch
    if str(resume_from) == "latest":
        # The directory rename commits a checkpoint. Recover even if a process
        # died before updating the convenience latest.json pointer.
        candidates = sorted((directory / "checkpoints").glob("step-[0-9]*"))
        _require(bool(candidates), "No committed checkpoint to resume")
        checkpoint = candidates[-1]
    else:
        checkpoint = Path(resume_from)
        if not checkpoint.is_absolute():
            checkpoint = directory / checkpoint
    _require(not checkpoint.is_symlink(), "Checkpoint symlink is forbidden")
    checkpoint = checkpoint.resolve()
    _require(checkpoint.parent == (directory / "checkpoints").resolve(),
             "Resume checkpoint must belong to this output directory")
    _require(not any(path.is_symlink() for path in checkpoint.rglob("*")),
             "Checkpoint symlinks are forbidden")
    manifest = json.loads((checkpoint / "CHECKPOINT.json").read_text())
    _require(manifest.get("schema_version") == 1 and manifest.get("run_sha256") == _sha(run),
             "Checkpoint run binding mismatch")
    actual_paths = {str(path.relative_to(checkpoint)) for path in checkpoint.rglob("*")
                    if path.is_file() and path.name != "CHECKPOINT.json"}
    _require(actual_paths == set(manifest["files"]), "Checkpoint file inventory mismatch")
    for name, digest in manifest["files"].items():
        path = checkpoint / name
        _require(not path.is_symlink() and path.resolve().is_relative_to(checkpoint)
                 and _file_sha(path) == digest, "Checkpoint file hash/path mismatch")
    state = torch.load(checkpoint / "training_state.pt", map_location="cpu", weights_only=True)
    cursor, step = state["cursor"], state["step"]
    count, accumulation = run["plan"]["rows"], run["settings"]["accumulation_steps"]
    _require(type(cursor) is int and 0 < cursor <= count and type(step) is int and step > 0
             and (cursor == count or cursor % accumulation == 0)
             and step == math.ceil(cursor / accumulation), "Invalid checkpoint progress")
    _require(state["run_sha256"] == _sha(run) and state["order"] == run["plan"]["order"]
             and cursor == manifest["cursor"] and step == manifest["step"],
             "Checkpoint cursor/order binding mismatch")
    weighted = run.get("weighted_loss_plan")
    if weighted is not None:
        _require(state.get("weighted_loss_plan") == weighted
                 and manifest.get("weighted_plan_sha256") == weighted["plan_sha256"]
                 and type(state.get("writer_pid")) is int
                 and state["writer_pid"] == manifest.get("writer_pid"),
                 "Checkpoint weighted policy binding mismatch")
    (restore_adapter or _peft_restore)(model, checkpoint)
    _require(_parameter_sha(model) == manifest["adapter_parameters_sha256"],
             "Restored adapter parameters differ from saved parameters")
    optimizer.load_state_dict(state["optimizer"])
    _require(_state_equal(optimizer.state_dict(), state["optimizer"]),
             "Restored optimizer state differs from saved state")
    _require((scheduler is None) == (state["scheduler"] is None), "Scheduler mismatch")
    if scheduler is not None:
        scheduler.load_state_dict(state["scheduler"])
        _require(_state_equal(scheduler.state_dict(), state["scheduler"]),
                 "Restored scheduler state differs from saved state")
    _restore_rng(state["rng"])
    _require(_state_equal(_rng_state(), state["rng"]), "Restored RNG state differs from saved state")
    if weighted is not None:
        record = {"checkpoint": str(checkpoint), "step": step, "next_row_cursor": cursor,
                  "checkpoint_writer_pid": state["writer_pid"], "resume_pid": os.getpid(),
                  "different_process": state["writer_pid"] != os.getpid(),
                  "adapter_equal": True, "optimizer_equal": True, "scheduler_equal": True,
                  "rng_equal": True, "weighted_plan_sha256": weighted["plan_sha256"]}
        with (directory / "resume.jsonl").open("a") as handle:
            handle.write(_json_bytes(record).decode() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    return step, cursor, checkpoint


def _loss_for_row(model, row, pad_id, max_length, device, callback):
    """A callback may select output logits, but may not edit its full input."""
    if callback is None:
        return model(**_batch(row, pad_id, max_length, device)).loss
    snapshot = deepcopy(row)
    loss = callback(snapshot)
    _require(_json_bytes(snapshot) == _json_bytes(row), "Loss callback mutated its encoded input")
    return loss


def _weighted_backward(model, rows, entries, plan, window_index, *, pad_id, max_length,
                       device, loss_callback):
    import torch
    coefficients = []
    indices = plan["windows"][window_index]

    def callback(row):
        index = indices[len(coefficients)]
        _require(_json_bytes(row) == _json_bytes(rows[index]), "Weighted callback row changed")
        loss = _loss_for_row(model, row, pad_id, max_length, device, loss_callback)
        ratio = plan["row_coefficients"][index]
        expected = ratio["numerator"] / ratio["denominator"]
        evidence = {"row_id": entries[index]["row_id"], "row_index": index,
                    "target_tokens": row["target_length"], "coefficient": ratio,
                    "observed_upstream_gradient": None}
        coefficients.append(evidence)

        def observe(gradient):
            actual = float(gradient.detach().item())
            _require(evidence["observed_upstream_gradient"] is None,
                     "Mean loss was backpropagated more than once")
            expected_tensor = torch.tensor(expected, dtype=gradient.dtype, device=gradient.device)
            _require(math.isfinite(actual) and torch.equal(gradient, expected_tensor),
                "Actual loss gradient differs from fixed policy coefficient")
            evidence["observed_upstream_gradient"] = actual
            evidence["upstream_gradient_dtype"] = str(gradient.dtype)

        loss.register_hook(observe)
        return loss

    result = supporter_weighted_loss.backward_window(callback, entries, plan, window_index)
    _require(len(coefficients) == len(indices)
             and all(row["observed_upstream_gradient"] is not None for row in coefficients),
             "Missing actual weighted backward evidence")
    return result, coefficients


def _gradient_evidence(parameters, required_devices):
    import torch
    grouped = {}
    for parameter in parameters:
        grouped.setdefault(str(parameter.device), []).append(parameter)
    if required_devices is not None:
        _require(set(grouped) == set(required_devices), "Trainable gradient devices changed")
    evidence = {}
    for device, group in sorted(grouped.items()):
        finite = bool(torch.stack([torch.isfinite(p.grad).all() for p in group]).all().item())
        nonzero = bool(torch.stack([p.grad.ne(0).any() for p in group]).any().item())
        _require(finite and nonzero, f"Nonfinite or zero trainable gradients on {device}")
        evidence[device] = {"parameters": len(group), "elements": sum(p.numel() for p in group),
                            "finite": finite, "nonzero": nonzero}
    return evidence


def run_training(model, optimizer, rows, output_dir, *, pad_id, bindings, max_length=4096,
                 accumulation_steps=8, seed=3407, checkpoint_every=100, max_steps=None,
                 scheduler=None, resume_from=None, mode="train", shuffle=True,
                 restore_adapter=None, device=None, weighted_entries=None, task=None,
                 loss_callback=None, loss_callback_id=None, required_gradient_devices=None):
    """Run at most one epoch, resuming only at committed optimizer boundaries.

    ``max_steps`` caps the *total* step number, including restored steps. Every
    microbatch has size one. The model must return the mean causal target loss;
    the caller must validate that numerical contract before running this loop.
    ``restore_adapter(model, checkpoint_path)`` may replace the default PEFT load.

    ``weighted_entries`` opts into the frozen v11 consumer. Supply the complete
    single-task train split, with encoded values identical to ``rows``. Its full
    epoch K/Z divisor is retained when ``max_steps`` pauses an epoch. The caller
    authenticates source/policy manifests in ``bindings`` before this function.
    ``loss_callback(encoded_row)`` may replace forward for memory-efficient CE;
    it must preserve the full input and return an unweighted scalar mean target
    CE. Its stable ``loss_callback_id`` is part of the immutable run binding.
    Required gradient devices, if supplied, must exactly match trainable devices.
    """
    import torch
    _require(mode in {"train", "canary"}, "Unknown run mode")
    _require(isinstance(bindings, dict) and bool(bindings), "Missing immutable input bindings")
    _require(type(checkpoint_every) is int and checkpoint_every > 0, "Invalid checkpoint interval")
    _require(max_steps is None or (type(max_steps) is int and max_steps > 0), "Invalid step cap")
    _require((loss_callback is None and loss_callback_id is None)
             or (callable(loss_callback) and isinstance(loss_callback_id, str)
                 and bool(loss_callback_id.strip())), "Custom loss requires a stable callback ID")
    _require(weighted_entries is not None or task is None, "Task requires weighted entries")
    if required_gradient_devices is not None:
        _require(isinstance(required_gradient_devices, (list, tuple))
                 and bool(required_gradient_devices)
                 and all(isinstance(value, str) and bool(value) for value in required_gradient_devices)
                 and len(set(required_gradient_devices)) == len(required_gradient_devices),
                 "Invalid required gradient devices")
    directory = Path(output_dir).absolute()
    _require(directory == directory.resolve(), "Output directory cannot traverse symlinks")
    plan = make_plan(rows, pad_id=pad_id, max_length=max_length,
                     accumulation_steps=accumulation_steps, seed=seed, shuffle=shuffle)
    weighted = None
    if weighted_entries is not None:
        _require(task is not None, "Weighted entries require an explicit task")
        weighted = _weighted_plan(rows, weighted_entries, task=task, bindings=bindings,
                                  pad_id=pad_id, max_length=max_length,
                                  accumulation_steps=accumulation_steps, seed=seed, shuffle=shuffle)
        _require(weighted["order"] == plan["order"], "Weighted plan order mismatch")
    run = {"schema_version": 1, "output_directory": str(directory), "mode": mode,
           "bindings": bindings, "plan": plan, "optimizer": _optimizer_signature(model, optimizer),
           "scheduler_class": type(scheduler).__qualname__ if scheduler is not None else None,
           "settings": {"pad_id": pad_id, "max_length": max_length,
                        "accumulation_steps": accumulation_steps, "seed": seed, "shuffle": shuffle,
                        "epochs": 1, "microbatch_size": 1, "clip_grad_norm": 1.0}}
    if weighted is not None:
        run.update(schema_version=2, weighted_loss_plan=weighted,
                   weighted_row_ids=[entry["row_id"] for entry in weighted_entries])
    if loss_callback is not None:
        run["settings"]["loss_callback_id"] = loss_callback_id
    if required_gradient_devices is not None:
        run["settings"]["required_gradient_devices"] = sorted(required_gradient_devices)
    run = json.loads(_json_bytes(run))  # Canonical JSON also normalizes optimizer tuples.
    device = device or next(model.parameters()).device
    with _run_lock(directory):
        manifest_path = directory / "RUN.json"
        if resume_from is None:
            _require(not any(p.name != ".runtime.lock" for p in directory.iterdir()),
                     "Fresh run requires an empty output directory")
            _atomic_json(manifest_path, run)
            random.seed(seed)
            torch.manual_seed(seed)
            step, cursor, checkpoint = 0, 0, None
        else:
            _require(json.loads(manifest_path.read_text()) == run, "Run bindings/settings changed")
            step, cursor, checkpoint = _load_checkpoint(
                model, optimizer, scheduler, directory, run, resume_from, restore_adapter)
            _require(max_steps is None or max_steps >= step, "Step cap precedes checkpoint")
        _atomic_json(directory / "TRAINING_RESULT.json", {"schema_version": 1, "status": "running",
                     "mode": mode, "completed_optimizer_steps": step, "next_row_cursor": cursor,
                     "hop_readiness": False})
        model.train()
        optimizer.zero_grad(set_to_none=True)
        while cursor < len(rows) and (max_steps is None or step < max_steps):
            started = time.monotonic()
            indices = plan["order"][cursor:cursor + accumulation_steps]
            if weighted is not None:
                _require(indices == weighted["windows"][step], "Weighted window cursor mismatch")
                weighted_result, coefficients = _weighted_backward(
                    model, rows, weighted_entries, weighted, step, pad_id=pad_id,
                    max_length=max_length, device=device, loss_callback=loss_callback)
                counts = [rows[index]["target_length"] for index in indices]
                target_mean_loss = weighted_result["primary_unweighted_target_token_mean_loss"]
            else:
                counts, weights = window_weights(rows, indices)
                token_loss = 0.0
                for index, count, weight in zip(indices, counts, weights):
                    loss = _loss_for_row(model, rows[index], pad_id, max_length, device, loss_callback)
                    _require(loss.ndim == 0 and bool(torch.isfinite(loss).item()), "Nonfinite/scalar loss")
                    token_loss += float(loss.detach().float().item()) * count
                    (loss * weight).backward()
                    del loss
                target_mean_loss = token_loss / sum(counts)
            parameters = [parameter for _, parameter in _trainable(model)]
            _require(all(parameter.grad is not None for parameter in parameters),
                     "A trainable adapter received no gradient")
            gradient_devices = (_gradient_evidence(parameters, required_gradient_devices)
                                if weighted is not None or required_gradient_devices is not None else None)
            norm = torch.nn.utils.clip_grad_norm_(parameters, 1.0, error_if_nonfinite=True)
            _require(bool(torch.isfinite(norm).item()), "Nonfinite gradient norm")
            optimizer.step()
            _require(all(bool(torch.isfinite(parameter).all().item()) for parameter in parameters),
                     "Optimizer produced nonfinite adapter parameters")
            if scheduler is not None:
                scheduler.step()
            optimizer.zero_grad(set_to_none=True)
            step += 1
            cursor += len(indices)
            record = {"step": step, "next_row_cursor": cursor, "microbatches": len(indices),
                      "supervised_tokens": sum(counts), "target_mean_loss": target_mean_loss,
                      "gradient_norm_before_clip": float(norm.item()),
                      "learning_rates": [group["lr"] for group in optimizer.param_groups],
                      "elapsed_seconds": time.monotonic() - started, "mode": mode}
            if weighted is not None:
                record.update(weighted_loss=weighted_result, coefficient_evidence=coefficients,
                              target_mean_loss_kind="primary_unweighted_target_token_mean",
                              process_pid=os.getpid())
            if gradient_devices is not None:
                record["gradient_devices"] = gradient_devices
            with (directory / "train.jsonl").open("a") as handle:
                handle.write(_json_bytes(record).decode() + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            print(json.dumps(record, ensure_ascii=False), flush=True)
            if step % checkpoint_every == 0 or cursor == len(rows) or step == max_steps:
                checkpoint = _save_checkpoint(model, optimizer, scheduler, directory, run, step, cursor)
        report = {"schema_version": 1, "status": "completed" if cursor == len(rows) else "step_cap_reached",
                  "mode": mode, "completed_optimizer_steps": step, "next_row_cursor": cursor,
                  "total_rows": len(rows), "epoch_completed": cursor == len(rows),
                  "checkpoint": str(checkpoint) if checkpoint is not None else None,
                  "run_sha256": _sha(run), "hop_readiness": False}
        if weighted is not None:
            report.update(weighted_plan_sha256=weighted["plan_sha256"], task=task,
                          planned_optimizer_steps=weighted["optimizer_windows"],
                          raw_target_tokens=weighted["raw_target_tokens"],
                          weighted_target_tokens=weighted["weighted_target_tokens"],
                          process_pid=os.getpid(),
                          complete_weighted_epoch_verified=cursor == len(rows))
        _atomic_json(directory / "TRAINING_RESULT.json", report)
        return report


def evaluate(model, rows, *, pad_id, max_length=4096, device=None, loss_callback=None):
    """Compute token-weighted held-out loss; this is not a behavioral quality test."""
    import torch
    make_plan(rows, pad_id=pad_id, max_length=max_length, shuffle=False)
    device = device or next(model.parameters()).device
    was_training = model.training
    model.eval()
    total_loss, total_tokens = 0.0, 0
    try:
        with torch.no_grad():
            for row in rows:
                loss = _loss_for_row(model, row, pad_id, max_length, device, loss_callback)
                _require(loss.ndim == 0 and bool(torch.isfinite(loss).item()), "Nonfinite validation loss")
                count = row["target_length"]
                total_loss += float(loss.float().item()) * count
                total_tokens += count
    finally:
        model.train(was_training)
    return {"rows": len(rows), "supervised_tokens": total_tokens,
            "target_mean_loss": total_loss / total_tokens,
            "weighting": "shifted_nonignored_target_tokens", "behavioral_quality_verified": False}

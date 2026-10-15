"""One-epoch, last-response-only QLoRA loop; importing this module needs no torch.

The caller owns model loading, GPU isolation and dataset admission. ``bindings``
identifies its immutable model/data/config inputs. Checkpoints contain adapters,
optimizer/scheduler states and RNG states, never the full base model. A canary is
an explicitly separate run over caller-selected longest rows, not training proof.
"""

from contextlib import contextmanager
import hashlib
import json
import math
import os
from pathlib import Path
import random
import time
import uuid

from .gemma4_token_validation import collate_examples


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
    with temporary.open("xb") as handle:
        handle.write(_json_bytes(value) + b"\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


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
    model.save_pretrained(temporary, safe_serialization=True)
    adapter_sha = _parameter_sha(model)
    state = {"step": step, "cursor": cursor, "order": run["plan"]["order"],
             "run_sha256": _sha(run), "optimizer": optimizer.state_dict(),
             "scheduler": scheduler.state_dict() if scheduler is not None else None,
             "rng": _rng_state()}
    torch.save(state, temporary / "training_state.pt")
    files = {str(path.relative_to(temporary)): _file_sha(path)
             for path in temporary.rglob("*") if path.is_file()}
    _require(any(name.startswith("adapter_model.") for name in files),
             "save_pretrained did not produce adapter_model weights")
    _atomic_json(temporary / "CHECKPOINT.json", {
        "schema_version": 1, "run_sha256": _sha(run), "step": step, "cursor": cursor,
        "adapter_parameters_sha256": adapter_sha, "files": files})
    os.rename(temporary, destination)
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
    return step, cursor, checkpoint


def run_training(model, optimizer, rows, output_dir, *, pad_id, bindings, max_length=4096,
                 accumulation_steps=8, seed=3407, checkpoint_every=100, max_steps=None,
                 scheduler=None, resume_from=None, mode="train", shuffle=True,
                 restore_adapter=None, device=None):
    """Run at most one epoch, resuming only at committed optimizer boundaries.

    ``max_steps`` caps the *total* step number, including restored steps. Every
    microbatch has size one. The model must return the mean causal target loss;
    the caller must validate that numerical contract before running this loop.
    ``restore_adapter(model, checkpoint_path)`` may replace the default PEFT load.
    """
    import torch
    _require(mode in {"train", "canary"}, "Unknown run mode")
    _require(isinstance(bindings, dict) and bool(bindings), "Missing immutable input bindings")
    _require(type(checkpoint_every) is int and checkpoint_every > 0, "Invalid checkpoint interval")
    _require(max_steps is None or (type(max_steps) is int and max_steps > 0), "Invalid step cap")
    directory = Path(output_dir).absolute()
    _require(directory == directory.resolve(), "Output directory cannot traverse symlinks")
    plan = make_plan(rows, pad_id=pad_id, max_length=max_length,
                     accumulation_steps=accumulation_steps, seed=seed, shuffle=shuffle)
    run = {"schema_version": 1, "output_directory": str(directory), "mode": mode,
           "bindings": bindings, "plan": plan, "optimizer": _optimizer_signature(model, optimizer),
           "scheduler_class": type(scheduler).__qualname__ if scheduler is not None else None,
           "settings": {"pad_id": pad_id, "max_length": max_length,
                        "accumulation_steps": accumulation_steps, "seed": seed, "shuffle": shuffle,
                        "epochs": 1, "microbatch_size": 1, "clip_grad_norm": 1.0}}
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
            counts, weights = window_weights(rows, indices)
            token_loss = 0.0
            for index, count, weight in zip(indices, counts, weights):
                result = model(**_batch(rows[index], pad_id, max_length, device))
                loss = result.loss
                _require(loss.ndim == 0 and bool(torch.isfinite(loss).item()), "Nonfinite/scalar loss")
                token_loss += float(loss.detach().float().item()) * count
                (loss * weight).backward()
                del loss, result
            parameters = [parameter for _, parameter in _trainable(model)]
            _require(all(parameter.grad is not None for parameter in parameters),
                     "A trainable adapter received no gradient")
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
                      "supervised_tokens": sum(counts), "target_mean_loss": token_loss / sum(counts),
                      "gradient_norm_before_clip": float(norm.item()),
                      "learning_rates": [group["lr"] for group in optimizer.param_groups],
                      "elapsed_seconds": time.monotonic() - started, "mode": mode}
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
        _atomic_json(directory / "TRAINING_RESULT.json", report)
        return report


def evaluate(model, rows, *, pad_id, max_length=4096, device=None):
    """Compute token-weighted held-out loss; this is not a behavioral quality test."""
    import torch
    make_plan(rows, pad_id=pad_id, max_length=max_length, shuffle=False)
    device = device or next(model.parameters()).device
    was_training = model.training
    model.eval()
    total_loss, total_tokens = 0.0, 0
    started = time.monotonic()
    try:
        with torch.no_grad():
            for rows_completed, row in enumerate(rows, start=1):
                loss = model(**_batch(row, pad_id, max_length, device)).loss
                _require(loss.ndim == 0 and bool(torch.isfinite(loss).item()), "Nonfinite validation loss")
                count = row["target_length"]
                total_loss += float(loss.float().item()) * count
                total_tokens += count
                if rows_completed % 100 == 0 or rows_completed == len(rows):
                    print(json.dumps({"event": "evaluation_progress", "rows_completed": rows_completed,
                                      "total_rows": len(rows), "supervised_tokens": total_tokens,
                                      "elapsed_seconds": time.monotonic() - started}), flush=True)
    finally:
        model.train(was_training)
    return {"rows": len(rows), "supervised_tokens": total_tokens,
            "target_mean_loss": total_loss / total_tokens,
            "weighting": "shifted_nonignored_target_tokens", "behavioral_quality_verified": False}

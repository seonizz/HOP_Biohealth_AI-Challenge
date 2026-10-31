#!/usr/bin/env python3
"""Offline, resumable 31B curriculum runner for the indexed card dataset.

Only LoRA parameters are updated. Full inputs and frozen data splits are kept.
The existing qualified Unsloth loader supplies tiled MLP and fused causal CE.
"""
import argparse
from fractions import Fraction
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random
import signal
import time
import uuid

STOP = False


def require(value, message):
    if not value:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as f:
        for block in iter(lambda: f.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def atomic(path, value):
    path = Path(path)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex)
    with temporary.open("x") as f:
        f.write(canonical(value) + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(temporary, path)


def event(kind, **fields):
    print(canonical({"event": kind, "pid": os.getpid(), "time": time.time(), **fields}), flush=True)


def weight(row):
    v = row["weight"]
    require(set(v) == {"numerator", "denominator"} and
            all(type(n) is int and n > 0 for n in v.values()), "Invalid row weight")
    return Fraction(**v)


def epoch_plan(entries, accumulation, seed):
    require(type(accumulation) is int and accumulation > 0 and entries, "Empty/invalid plan")
    ids = [r["row_id"] for r in entries]
    require(len(ids) == len(set(ids)), "Duplicate train row")
    require(sum(weight(r) for r in entries) == len(entries), "Unnormalized row weights")
    order = list(range(len(entries)))
    random.Random(seed).shuffle(order)
    return {"rows": len(entries), "windows": math.ceil(len(entries) / accumulation),
            "order": order, "accumulation": accumulation, "seed": seed}


def coefficient(row, plan):
    # Mean over all K optimizer windows equals the specified full-epoch objective.
    # Neither target length nor the current (possibly short) window changes it.
    return Fraction(plan["windows"], plan["rows"]) * weight(row)


def loss_decision(baseline, values, cap, final=False):
    require(math.isfinite(baseline) and baseline >= 0 and cap > 0, "Invalid baseline/cap")
    require(all(math.isfinite(v) and v >= 0 for v in values), "Invalid validation loss")
    best = reference = baseline
    stale = bad = 0
    for epoch, value in enumerate(values, 1):
        require(epoch <= cap, "History exceeds resource guard")
        improved = baseline - value >= max(0.001, baseline * 0.005)
        delta = max(0.001, reference * 0.005)
        if reference - value >= delta:
            reference, stale = value, 0
        else:
            stale += 1
        bad = bad + 1 if value > best + max(0.001, best * 0.03) else 0
        best = min(best, value)
        status = ("stop_pending_evaluation" if final else
                  "stop_phase_accepted" if improved else
                  "stop_phase_rejected" if bad >= 2 or stale >= 2 else
                  "stop_resource_limit" if epoch == cap else "continue")
        require(status == "continue" or epoch == len(values), "History continued after stop")
    return status if values else "continue"


def verify_checkpoint(path, binding):
    path = Path(path)
    require(path.absolute() == path.resolve() and not any(p.is_symlink() for p in [path, *path.parents]), "Checkpoint link")
    require(not (path / "CHECKPOINT.json").is_symlink(), "Checkpoint manifest link")
    manifest = json.loads((path / "CHECKPOINT.json").read_text())
    require(manifest["binding"] == binding, "Checkpoint input binding differs")
    require(not any(p.is_symlink() for p in path.rglob("*")), "Checkpoint entry link")
    files = {str(p.relative_to(path)) for p in path.rglob("*") if p.is_file() and p != path / "CHECKPOINT.json"}
    require(files == set(manifest["files"]), "Checkpoint file inventory differs")
    for name, digest in manifest["files"].items():
        p = path / name
        require(not p.is_symlink() and p.resolve().is_relative_to(path.resolve()) and sha(p) == digest,
                "Checkpoint path/hash differs")
    return manifest


def parameter_sha(model):
    h = hashlib.sha256()
    for name, p in model.named_parameters():
        if p.requires_grad:
            h.update(name.encode())
            h.update(p.detach().float().cpu().contiguous().numpy().tobytes())
    return h.hexdigest()


def latest_checkpoint(work, binding):
    candidates = []
    for p in (work / "checkpoints").iterdir():
        if p.name.startswith("."):
            continue
        require(p.is_dir() and not p.is_symlink(), "Invalid committed checkpoint")
        m = json.loads((p / "CHECKPOINT.json").read_text())
        require(m["binding"] == binding, "Committed checkpoint binding changed")
        progress = m["progress"]
        phase_number = {"canary": -1, "00_original_warmup": 0, "01_card_repair": 1, "02_card_generation": 2}[progress["phase"]]
        candidates.append(((progress["step"], phase_number, progress["epoch"]), p))
    require(candidates, "No committed checkpoint")
    checkpoint = max(candidates, key=lambda x: x[0])[1]
    verify_checkpoint(checkpoint, binding)
    return checkpoint


def state_equal(actual, expected):
    import torch
    if torch.is_tensor(expected):
        return torch.is_tensor(actual) and actual.dtype == expected.dtype and torch.equal(actual.detach().cpu(), expected.detach().cpu())
    if isinstance(expected, dict):
        return isinstance(actual, dict) and actual.keys() == expected.keys() and all(state_equal(actual[k], v) for k, v in expected.items())
    if isinstance(expected, (tuple, list)):
        return type(actual) is type(expected) and len(actual) == len(expected) and all(state_equal(a, b) for a, b in zip(actual, expected))
    return actual == expected


def parameters(model):
    result = [p for p in model.parameters() if p.requires_grad]
    require(sum(p.numel() for p in result) == 61214720 and
            all("lora_" in n for n, p in model.named_parameters() if p.requires_grad), "Only qualified LoRA may train")
    return result


def save_checkpoint(model, optimizer, work, binding, progress):
    import torch
    root = work / "checkpoints"
    root.mkdir(exist_ok=True)
    label = f"{progress['phase']}-e{progress['epoch']:03d}-s{progress['step']:09d}"
    target = root / label
    require(not target.exists(), "Checkpoint already exists")
    temporary = root / (".writing-" + uuid.uuid4().hex)
    temporary.mkdir()
    model.save_pretrained(temporary, safe_serialization=True)
    state = {"binding": binding, "progress": progress, "optimizer": optimizer.state_dict(),
             "rng": {"python": random.getstate(), "cpu": torch.get_rng_state(), "cuda": torch.cuda.get_rng_state_all()}}
    torch.save(state, temporary / "training_state.pt")
    manifest = {"binding": binding, "progress": progress, "writer_pid": os.getpid(),
                "adapter_sha256": parameter_sha(model),
                "files": {p.name: sha(p) for p in temporary.iterdir() if p.is_file()}}
    atomic(temporary / "CHECKPOINT.json", manifest)
    for p in temporary.iterdir():
        with p.open("rb") as f:
            os.fsync(f.fileno())
    os.rename(temporary, target)
    atomic(work / "latest.json", {"checkpoint": str(target.relative_to(work)), **progress})
    event("checkpoint_saved", checkpoint=str(target), **progress)
    return target


def restore(model, optimizer, checkpoint, binding):
    import torch
    from peft.utils.save_and_load import load_peft_weights, set_peft_model_state_dict
    manifest = verify_checkpoint(checkpoint, binding)
    state = torch.load(checkpoint / "training_state.pt", map_location="cpu", weights_only=True)
    require(state["binding"] == binding and state["progress"] == manifest["progress"], "State binding differs")
    set_peft_model_state_dict(model, load_peft_weights(str(checkpoint), device="cpu"), adapter_name="default")
    require(parameter_sha(model) == manifest["adapter_sha256"], "Restored adapter differs")
    optimizer.load_state_dict(state["optimizer"])
    require(state_equal(optimizer.state_dict(), state["optimizer"]), "Restored optimizer differs")
    random.setstate(state["rng"]["python"])
    torch.set_rng_state(state["rng"]["cpu"])
    torch.cuda.set_rng_state_all(state["rng"]["cuda"])
    event("checkpoint_restored", checkpoint=str(checkpoint), writer_pid=manifest["writer_pid"], **state["progress"])
    return state["progress"]


def selected_loss(model, row):
    import torch
    encoded = row["encoded"]
    require(encoded["sequence_length"] <= 32768 and
            encoded["labels"] == [-100] * encoded["prefix_length"] + encoded["input_ids"][encoded["prefix_length"]:],
            "Full-input last-response mask differs")
    device = model.get_input_embeddings().weight.device
    batch = {k: torch.tensor([encoded[k]], dtype=torch.long, device=device)
             for k in ["input_ids", "attention_mask", "labels"]}
    result = model(**batch, use_cache=False)
    loss = result.loss
    require(loss.ndim == 0 and bool(torch.isfinite(loss).item()), "Nonfinite mean target CE")
    return loss


def update(model, optimizer, dataset, indices, plan):
    import torch
    model.train()
    optimizer.zero_grad(set_to_none=True)
    total = 0.0
    for i in indices:
        row = dataset[i]
        loss = selected_loss(model, row)
        factor = float(coefficient(row, plan))
        total += float(loss.detach()) * factor
        (loss * factor).backward()
        del loss, row
    pp = parameters(model)
    require(all(p.grad is not None for p in pp), "Missing LoRA gradient")
    evidence = {}
    for device in sorted({str(p.device) for p in pp}):
        group = [p.grad for p in pp if str(p.device) == device]
        finite = bool(torch.stack([torch.isfinite(g).all() for g in group]).all().item())
        nonzero = bool(torch.stack([g.ne(0).any() for g in group]).any().item())
        require(finite and nonzero, "Missing/invalid GPU gradient")
        evidence[device] = {"finite": finite, "nonzero": nonzero}
    norm = torch.nn.utils.clip_grad_norm_(pp, 1.0, error_if_nonfinite=True)
    optimizer.step()
    optimizer.zero_grad(set_to_none=True)
    require(all(bool(torch.isfinite(p).all().item()) for p in pp), "Nonfinite adapter")
    return {"weighted_loss_sum": total, "gradient_norm": float(norm), "gradient_devices": evidence}


def status(work, state, **fields):
    atomic(work / "STATUS.json", {"status": state, "pid": os.getpid(), "updated": time.time(),
                                  "training_complete": False, **fields})


def evaluate(model, dataset, path, work, label):
    import torch
    adapter = parameter_sha(model)
    model.eval()
    done = []
    if path.exists():
        done = [json.loads(s) for s in path.read_text().splitlines()]
    for i, r in enumerate(done):
        require(r["row_id"] == dataset.entries[i]["row_id"] and r["adapter_sha256"] == adapter,
                "Validation resume differs")
    with path.open("a") as f, torch.no_grad():
        for i in range(len(done), len(dataset)):
            if STOP or (work / "STOP").exists():
                raise InterruptedError("Stop requested during validation")
            row = dataset[i]
            loss = float(selected_loss(model, row).item())
            item = {"row_id": row["row_id"], "mean_target_ce": loss, "target_tokens": row["target_length"],
                    "adapter_sha256": adapter}
            f.write(canonical(item) + "\n"); f.flush()
            done.append(item)
            if (i + 1) % 10 == 0 or i == 0 or i + 1 == len(dataset):
                os.fsync(f.fileno())
                status(work, "evaluating", stage=label, evaluated=i + 1, total=len(dataset))
                event("validation_progress", stage=label, rows=i + 1, total=len(dataset))
    require(len(done) == len(dataset) and len({r["row_id"] for r in done}) == len(dataset), "Incomplete validation")
    require(parameter_sha(model) == adapter, "Validation changed adapter")
    result = math.fsum(float(weight(row)) * value["mean_target_ce"] / len(dataset)
                       for row, value in zip(dataset.entries, done))
    atomic(path.with_suffix(".summary.json"), {"rows": len(done), "weighted_mean_row_ce": result,
                                              "adapter_sha256": adapter, "validation_never_used_for_gradient": True})
    event("validation_completed", stage=label, rows=len(done), loss=result)
    return result


def causal_reference(model, row):
    import torch
    base = model.get_base_model()
    captured = []
    hook = base.model.register_forward_hook(lambda module, args, output: captured.append(output.last_hidden_state.detach()))
    model.eval()
    with torch.no_grad():
        actual = float(selected_loss(model, row).item())
        hook.remove()
        require(len(captured) == 1, "Missing hidden-state reference")
        encoded = row["encoded"]
        h = captured[0][:, encoded["prefix_length"] - 1:-1].to(base.lm_head.weight.device)
        logits = torch.nn.functional.linear(h, base.lm_head.weight, base.lm_head.bias).float()
        cap = base.config.get_text_config().final_logit_softcapping
        if cap is not None:
            logits = torch.tanh(logits / cap) * cap
        targets = torch.tensor(encoded["input_ids"][encoded["prefix_length"]:], device=logits.device)
        expected = float(torch.nn.functional.cross_entropy(logits[0], targets).item())
    require(math.isclose(actual, expected, rel_tol=0.002, abs_tol=0.002), "Fused CE differs from causal reference")
    return {"fused_ce": actual, "independent_ce": expected, "passed": True}


def run(args):
    import sys
    work = args.work.resolve()
    require(work.is_dir() and work == args.work, "Work directory must be canonical")
    root = args.dataset.resolve()
    sys.path.insert(0, str(root / "scripts"))
    from expanded_card_dataset import verify
    from role_dataset import IndexedTokens
    verified = verify(root)
    require(verified["status"] == "passed", "Dataset verification failed")
    course = json.loads((root / "COURSE.json").read_text())
    require(course["role"] == "cards_31b" and course["phases"][0]["initial_adapter_from"] is None,
            "Fresh 31B course required")
    config = json.loads((args.legacy_kit / "config/train.json").read_text())
    config.update(max_length=32768, model_path=str(args.model))
    versions = {p: importlib.metadata.version(p) for p in config["versions"]}
    require(versions == config["versions"], "Qualified environment changed")
    fingerprint = json.loads((args.legacy_kit / "config/model_fingerprint.json").read_text())
    for name, expected in fingerprint["local_file_hashes"].items():
        p = args.model / name
        require(p.is_file() and not p.is_symlink() and p.stat().st_size == expected["bytes"] and sha(p) == expected["sha256"],
                "Base model fingerprint differs: " + name)
    for name, expected in course["model"]["tokenizer_sha256"].items():
        require(sha(args.model / name) == expected, "Base/dataset tokenizer differs")
    fused_source = Path(__import__('sys').prefix) / 'lib/python3.12/site-packages/unsloth_zoo/fused_losses/cross_entropy_loss.py'
    require(sha(fused_source) == config['fused_loss_source_sha256'], "Qualified fused CE changed")
    source_files = [Path(__file__), args.legacy_kit / "counseling_pipeline/stage1_preparation.py",
                    args.legacy_kit / "counseling_pipeline/gemma4_token_validation.py", fused_source,
                    Path(__file__).with_name('bootstrap.py'), Path(__file__).with_name('boundary.py')]
    binding = {"course_sha256": sha(root / "COURSE.json"), "dataset_manifest_sha256": sha(root / "MANIFEST.json"),
               "model_config_sha256": sha(args.model / "config.json"), "model_index_sha256": sha(args.model / "model.safetensors.index.json"),
               "model_files": fingerprint["local_file_hashes"],
               "code_sha256": {str(p): sha(p) for p in source_files}, "versions": versions,
               "loader_config": config,
               "optimizer": "AdamW", "learning_rate": args.lr, "accumulation": args.accumulation,
               "seed": 3407, "max_length": 32768, "objective": "sum(weight_i * mean_target_CE_i) / N"}
    binding_path = work / "BINDING.json"
    if binding_path.exists():
        require(json.loads(binding_path.read_text()) == binding, "Run inputs changed")
    else:
        atomic(binding_path, binding)
    if args.mode == "preflight":
        status(work, "preflight_passed", versions=versions, dataset_validation=verified)
        event("preflight_passed", dataset_validation=verified, model_files_verified=len(fingerprint["local_file_hashes"]))
        return
    status(work, "loading_fresh_model", mode=args.mode)
    sys.path.insert(0, str(args.legacy_kit))
    from counseling_pipeline.stage1_preparation import load_model
    model, tokenizer = load_model(config)
    import torch
    pp = parameters(model)
    require(tokenizer.pad_token_id == 0 and not any(p.requires_grad and "lora_" not in n for n, p in model.named_parameters()),
            "Unexpected tokenizer/trainable state")
    optimizer = torch.optim.AdamW(pp, lr=args.lr, weight_decay=0.01, foreach=False)
    datasets = {}
    for phase in course["phases"]:
        datasets[phase["id"]] = {split: IndexedTokens(root / part["token_index"], root / part["token_binary"])
                                  for split, part in phase["data"].items()}
    first = datasets[course["phases"][0]["id"]]
    initial_sha = parameter_sha(model)
    event("fresh_model_loaded", initial_adapter_sha256=initial_sha, trainable_parameters=sum(p.numel() for p in pp))

    if args.mode in {"canary", "resume-canary"}:
        dataset = first["train"]
        plan = epoch_plan(dataset.entries, args.accumulation, 3407)
        short = min(range(len(dataset)), key=lambda i: dataset.entries[i]["sequence_length"])
        chosen = list(dict.fromkeys([short, max(range(len(dataset)), key=lambda i: dataset.entries[i]["sequence_length"]),
                                    max(range(len(dataset)), key=lambda i: dataset.entries[i]["target_length"])]))
        if args.mode == "resume-canary":
            checkpoint = latest_checkpoint(work, binding)
            progress = restore(model, optimizer, checkpoint, binding)
            require(verify_checkpoint(checkpoint, binding)["writer_pid"] != os.getpid(), "Use a new process for canary resume")
            if STOP or (work / 'STOP').exists():
                raise InterruptedError('Stop requested before canary resume update')
            evidence = update(model, optimizer, dataset, [short], plan)
            progress = {**progress, "step": progress["step"] + 1, "cursor": progress["cursor"] + 1}
            save_checkpoint(model, optimizer, work, binding, progress)
            if STOP or (work / 'STOP').exists():
                raise InterruptedError('Stop requested at canary resume optimizer boundary')
            atomic(work / "CANARY_RESUME.json", {"status": "passed", "binding": binding, "new_pid": os.getpid(), **evidence})
        else:
            reference = causal_reference(model, dataset[short])
            for step, index in enumerate(chosen, 1):
                if STOP or (work / 'STOP').exists():
                    raise InterruptedError('Stop requested before canary update')
                evidence = update(model, optimizer, dataset, [index], plan)
                event("canary_update", row_id=dataset.entries[index]["row_id"],
                      sequence_length=dataset.entries[index]["sequence_length"], **evidence)
                if STOP or (work / 'STOP').exists():
                    save_checkpoint(model, optimizer, work, binding,
                                    {"phase": "canary", "epoch": 0, "step": step, "cursor": step})
                    raise InterruptedError('Stop requested at canary optimizer boundary')
            longest = max(range(len(first["validation"])), key=lambda i: first["validation"].entries[i]["sequence_length"])
            model.eval()
            with torch.no_grad():
                validation = float(selected_loss(model, first["validation"][longest]))
            save_checkpoint(model, optimizer, work, binding,
                            {"phase": "canary", "epoch": 0, "step": len(chosen), "cursor": len(chosen)})
            require(parameter_sha(model) != initial_sha, 'Canary optimizer did not change adapter')
            atomic(work / "CANARY.json", {"status": "passed", "binding": binding, "initial_adapter_sha256": initial_sha,
                   "causal_reference": reference,
                   "longest_train": max(r["sequence_length"] for r in dataset.entries),
                   "largest_target": max(r["target_length"] for r in dataset.entries),
                   "longest_validation_ce": validation, "adapter_changed": parameter_sha(model) != initial_sha})
        status(work, "canary_passed", mode=args.mode)
        return

    gate = json.loads((args.canary_work / "CANARY_RESUME.json").read_text())
    canary = json.loads((args.canary_work / "CANARY.json").read_text())
    require(gate["status"] == canary["status"] == "passed" and gate["binding"] == canary["binding"] == binding
            and canary["adapter_changed"] and canary["initial_adapter_sha256"] == initial_sha,
            "Current inputs/code and fresh initialization must match canary")
    latest_checkpoint(args.canary_work, binding)
    phases = course["phases"]
    saved = None
    if (work / "checkpoints").exists():
        saved = restore(model, optimizer, latest_checkpoint(work, binding), binding)
    state_path = work / "COURSE_STATE.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"accepted": [], "phases": {}}
    step = saved["step"] if saved else 0
    for position, phase in enumerate(phases):
        pid = phase["id"]
        if pid in state["accepted"]:
            continue
        ds = datasets[pid]
        require(state["accepted"] == [p["id"] for p in phases[:position]], "Invalid phase chain")
        record = state["phases"].setdefault(pid, {"losses": []})
        if record.get("decision", "continue") != "continue":
            status(work, record["decision"], phase=pid, reason="Previous phase stop decision remains in force")
            return
        if "baseline" not in record:
            if not (saved and saved["phase"] == pid and saved["epoch"] == 0):
                if position:
                    optimizer = torch.optim.AdamW(pp, lr=args.lr, weight_decay=0.01, foreach=False)
                checkpoint = save_checkpoint(model, optimizer, work, binding,
                                             {"phase": pid, "epoch": 0, "step": step, "cursor": 0})
                saved = {"phase": pid, "epoch": 0, "step": step, "cursor": 0}
            record["input_adapter_sha256"] = parameter_sha(model)
            record["baseline"] = evaluate(model, ds["validation"], work / (pid + "-baseline.jsonl"), work, pid + ":baseline")
            atomic(state_path, state)
        first_epoch = len(record["losses"]) + 1
        for epoch in range(first_epoch, [3, 2, 5][position] + 1):
            plan = epoch_plan(ds["train"].entries, args.accumulation, 3407 + epoch)
            cursor = saved["cursor"] if saved and saved["phase"] == pid and saved["epoch"] == epoch else 0
            require(cursor == len(ds["train"]) or cursor % args.accumulation == 0, "Uncommitted resume cursor")
            require(0 <= cursor <= len(ds["train"]), "Bad resume cursor")
            train_log = work / f"{pid}-e{epoch:03d}-coverage.jsonl"
            if train_log.exists():
                consumed = [json.loads(s)["row_id"] for s in train_log.read_text().splitlines()]
                expected = [ds["train"].entries[i]["row_id"] for i in plan["order"][:cursor]]
                require(consumed[:cursor] == expected, "Resume train order differs")
                with train_log.open("w") as f:
                    for identity in expected:
                        f.write(canonical({"row_id": identity}) + "\n")
            else:
                require(cursor == 0, "Resume coverage missing")
            checkpoint = None
            last_save = time.monotonic()
            with train_log.open("a") as f:
                while cursor < len(ds["train"]):
                    indices = plan["order"][cursor:cursor + args.accumulation]
                    status(work, "training", phase=pid, epoch=epoch, step=step, cursor=cursor, total=len(ds["train"]))
                    evidence = update(model, optimizer, ds["train"], indices, plan)
                    for i in indices:
                        f.write(canonical({"row_id": ds["train"].entries[i]["row_id"]}) + "\n")
                    f.flush(); os.fsync(f.fileno())
                    cursor += len(indices); step += 1
                    event("optimizer_step", phase=pid, epoch=epoch, step=step, cursor=cursor, **evidence)
                    stop = STOP or (work / "STOP").exists()
                    if step % 100 == 0 or time.monotonic() - last_save >= 600 or cursor == len(ds["train"]) or stop:
                        checkpoint = save_checkpoint(model, optimizer, work, binding,
                                                     {"phase": pid, "epoch": epoch, "step": step, "cursor": cursor})
                        last_save = time.monotonic()
                    if stop:
                        raise InterruptedError("Stop requested at optimizer boundary")
            if checkpoint is None:
                require(saved is not None and cursor == len(ds["train"]), "Missing epoch checkpoint")
                checkpoint = latest_checkpoint(work, binding)
            consumed = [json.loads(s)["row_id"] for s in train_log.read_text().splitlines()]
            require(consumed == [ds["train"].entries[i]["row_id"] for i in plan["order"]], "Incomplete/duplicate epoch")
            result = evaluate(model, ds["validation"], work / f"{pid}-e{epoch:03d}-validation.jsonl", work, pid + ":validation")
            record["losses"].append(result)
            decision = loss_decision(record["baseline"], record["losses"], [3, 2, 5][position], position == 2)
            record["decision"] = decision
            if decision == "stop_phase_accepted":
                state["accepted"].append(pid)
                record["selected_checkpoint"] = str(checkpoint)
                record["selected_adapter_sha256"] = parameter_sha(model)
                atomic(state_path, state)
                event("phase_accepted", phase=pid, validation_loss=result, checkpoint=str(checkpoint))
                saved = None
                break
            atomic(state_path, state)
            if decision != "continue":
                status(work, decision, phase=pid, checkpoint=str(checkpoint), validation_loss=result,
                       reason="role_evaluation_required" if position == 2 else "performance_target_not_met")
                return
            saved = None
    status(work, "stop_pending_evaluation", reason="final_role_quality_gate_required")


def main():
    import fcntl
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dataset", type=Path, required=True)
    p.add_argument("--model", type=Path, required=True)
    p.add_argument("--legacy-kit", type=Path, required=True)
    p.add_argument("--work", type=Path, required=True)
    p.add_argument("--mode", choices=["preflight", "canary", "resume-canary", "train"], required=True)
    p.add_argument("--canary-work", type=Path)
    p.add_argument("--lr", type=float, default=2e-5)
    p.add_argument("--accumulation", type=int, default=8)
    args = p.parse_args()
    require(args.lr > 0 and math.isfinite(args.lr), "Invalid learning rate")
    def request_stop(signum, frame):
        global STOP
        STOP = True
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    with (args.work / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            run(args)
        except InterruptedError as e:
            status(args.work, "stopped", reason=str(e))
            raise SystemExit(130)
        except BaseException as e:
            status(args.work, "failed", error_type=type(e).__name__, error=str(e)[:1000])
            raise


if __name__ == "__main__":
    main()

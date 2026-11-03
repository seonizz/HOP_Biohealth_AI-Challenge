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
COMPUTE_PROFILE = "reference"
EVAL_MAX_BATCH = 4
EVAL_TOKEN_BUDGET = 16384
EVAL_BACKEND = 'serial'
EVAL_WARMUP = None
SEMANTIC_BINDING_KEYS = ('course_sha256','dataset_manifest_sha256','model_config_sha256',
                        'model_index_sha256','model_files','versions','loader_config','optimizer',
                        'learning_rate','accumulation','seed','max_length','objective')


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
    if COMPUTE_PROFILE == "optimized" and torch.is_grad_enabled():
        from cards31b_compute import training_loss
        return training_loss(model, row)
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
    # Preserve every finite check while reading one combined flag per GPU.
    # Reading one scalar per parameter otherwise serializes host/device work.
    for device in sorted({str(p.device) for p in pp}):
        group = [p for p in pp if str(p.device) == device]
        require(bool(torch.stack([torch.isfinite(p).all() for p in group]).all().item()),
                "Nonfinite adapter")
    return {"weighted_loss_sum": total, "gradient_norm": float(norm), "gradient_devices": evidence}


def status(work, state, **fields):
    atomic(work / "STATUS.json", {"status": state, "pid": os.getpid(), "updated": time.time(),
                                  "training_complete": False, **fields})


def reconcile_completion(work, binding, gate):
    """Consume real role evidence while stopped, before loading any model."""
    from cards31b_completion import PHASES, apply_receipts
    state_path = work / 'COURSE_STATE.json'
    if not state_path.exists():
        return False
    state = json.loads(state_path.read_text())
    require(state['accepted'] == PHASES[:len(state['accepted'])], 'Invalid accepted phase prefix')
    complete = state['accepted'] == PHASES
    phase = PHASES[-1] if complete else PHASES[len(state['accepted'])]
    record = state['phases'].get(phase)
    if not record or 'baseline' not in record:
        if state['accepted']:
            # A crash may land between phase acceptance and the next baseline.
            # Recheck the accepted prefix before any next-phase model update.
            prior = state['accepted'][-1]
            checked = {**state, 'accepted': state['accepted'][:-1]}
            receipts = gate.assess(checked, prior, work, binding, verify_checkpoint)
            require(receipts[prior]['decision']['status'] == 'stop_phase_accepted',
                    'Accepted prefix lacks matching performance evidence')
            atomic(state_path, apply_receipts(checked, prior, receipts))
        return False
    previous = record.get('decision', 'continue')
    # Terminal failures cannot be reopened by replacing an evaluation file.
    if previous not in ('continue', 'stop_pending_evaluation', 'stop_phase_accepted'):
        status(work, previous, phase=phase, reason='Previous phase stop decision remains in force')
        return True
    checked = {**state, 'accepted': PHASES[:-1]} if complete else state
    receipts = gate.assess(checked, phase, work, binding, verify_checkpoint)
    decision = receipts[phase]['decision']
    if complete:
        require(decision['model_training_criteria_satisfied_from_supplied_evidence'] is True,
                'Completed state lacks current matching performance evidence')
    state = apply_receipts(checked, phase, receipts)
    atomic(state_path, state)
    if decision['model_training_criteria_satisfied_from_supplied_evidence']:
        status(work, 'training_criteria_satisfied', phase=phase, training_complete=True,
               completion=decision, unseen_test_passed=False, automatic_deployment=False)
        return True
    if decision['status'] not in ('continue', 'stop_phase_accepted'):
        status(work, decision['status'], phase=phase, completion=decision)
        return True
    return False


def evaluate(model, dataset, path, work, label):
    if COMPUTE_PROFILE != "reference":
        return evaluate_optimized(model, dataset, path, work, label)
    return evaluate_reference(model, dataset, path, work, label)


def evaluate_reference(model, dataset, path, work, label):
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


def read_evaluation_journal(path, entries, adapter, evaluator):
    done = {}
    if path.exists():
        for line in path.read_text().splitlines():
            item = json.loads(line)
            identity = item['row_id']
            require(identity in entries and identity not in done and item['adapter_sha256'] == adapter
                    and item['evaluator_sha256'] == evaluator
                    and item['target_tokens'] == entries[identity]['target_length']
                    and math.isfinite(item['mean_target_ce']), 'Validation identity/evaluator binding differs')
            done[identity] = item
    return done


def evaluate_optimized(model, dataset, path, work, label):
    """Full validation with row identities and evaluator-bound resumable batches."""
    import torch
    from cards31b_compute import evaluation_losses, plan_validation_batches
    if EVAL_BACKEND == 'pipeline':
        from cards31b_pipeline import evaluation_losses_pipeline
        evaluation_losses = evaluation_losses_pipeline
    evaluator = hashlib.sha256(canonical({'compute':sha(Path(__file__).with_name('cards31b_compute.py')),
                      'pipeline':sha(Path(__file__).with_name('cards31b_pipeline.py')) if EVAL_BACKEND=='pipeline' else None,
                      'backend':EVAL_BACKEND,'max_batch':EVAL_MAX_BATCH,'token_budget':EVAL_TOKEN_BUDGET,
                      'evaluation_warmup':EVAL_WARMUP}).encode()).hexdigest()
    adapter = parameter_sha(model)
    model.eval()
    entries = {row['row_id']: row for row in dataset.entries}
    require(len(entries) == len(dataset), 'Duplicate validation ID')
    done = read_evaluation_journal(path, entries, adapter, evaluator)
    remaining = [i for i,row in enumerate(dataset.entries) if row['row_id'] not in done]
    with path.open('a') as stream, torch.no_grad():
        for indices in plan_validation_batches(dataset.entries, EVAL_TOKEN_BUDGET, EVAL_MAX_BATCH, remaining):
            if STOP or (work/'STOP').exists():
                raise InterruptedError('Stop requested during optimized validation')
            rows = [dataset[i] for i in indices]
            values = evaluation_losses(model, rows, chunk_tokens=256).cpu().tolist()
            require(len(values) == len(rows), 'Missing per-row validation loss')
            for row,value in zip(rows,values):
                item = {'row_id':row['row_id'], 'mean_target_ce':value, 'target_tokens':row['target_length'],
                        'adapter_sha256':adapter, 'evaluator_sha256':evaluator}
                stream.write(canonical(item)+'\n')
                done[row['row_id']] = item
            stream.flush()
            if len(done) % 20 < len(rows) or len(done) == len(dataset):
                os.fsync(stream.fileno())
                status(work,'evaluating',stage=label,evaluated=len(done),total=len(dataset),compute_profile=COMPUTE_PROFILE)
                event('validation_progress',stage=label,rows=len(done),total=len(dataset))
    require(set(done) == set(entries) and parameter_sha(model) == adapter, 'Incomplete validation or mutated adapter')
    result = math.fsum(float(weight(row))*done[row['row_id']]['mean_target_ce']/len(dataset) for row in dataset.entries)
    atomic(path.with_suffix('.summary.json'),{'rows':len(done),'weighted_mean_row_ce':result,
           'adapter_sha256':adapter,'evaluator_sha256':evaluator,'validation_never_used_for_gradient':True,
           'input_tokens':sum(r['sequence_length'] for r in dataset.entries),
           'target_tokens':sum(r['target_length'] for r in dataset.entries)})
    event('validation_completed',stage=label,rows=len(done),loss=result)
    return result


def validate_qualification(path, profile, batch_size, token_budget, lr, accumulation, current_binding, backend='serial'):
    require(path.resolve() == path and path.is_file(), 'Qualification path differs')
    q = json.loads(path.read_text())
    require(q['status'] == 'passed' and q['compute_profile'] == profile
            and q['eval_max_batch'] == batch_size and q['eval_token_budget'] == token_budget
            and q['eval_backend']==backend and token_budget == (32768 if backend=='pipeline' else 16384)
            and q['learning_rate'] == lr and q['accumulation'] == accumulation,
            'Requested computation was not qualified')
    require({'train_cards_31b.py','cards31b_compute.py','cards31b_pipeline.py','cards31b_profile.py','bootstrap.py','boundary.py'} <= set(q['code_sha256']),
            'Qualification omitted executable code')
    for name,digest in q['code_sha256'].items():
        p = path.parent/'code'/name
        require(Path(name).name == name and p.resolve() == p and sha(p) == digest, 'Qualified code changed')
    evidence_path = path.parent/'benchmark/BENCHMARK.json'
    require(evidence_path.resolve() == evidence_path and sha(evidence_path) == q['benchmark_sha256'], 'Qualification evidence changed')
    evidence = json.loads(evidence_path.read_text())
    require(evidence['execution_proof_rechecked'] and evidence['compute_cpu_tests'] == 30,
            'Incomplete benchmark execution proof')
    proof = evidence['execution_proof']
    from cards31b_compute import WARMUP_PROTOCOL
    require(evidence['evaluation_warmup']['status']=='passed'
            and q['evaluation_warmup']==current_binding['evaluation_warmup']=={
                'protocol':WARMUP_PROTOCOL,'row_id':evidence['evaluation_warmup']['row_id']}
            and evidence['evaluation_warmup']['protocol']==WARMUP_PROTOCOL,
            'Evaluation warmup was not qualified')
    benchmark_binding_path = path.parent/'benchmark/BINDING.json'
    require(benchmark_binding_path.resolve()==benchmark_binding_path
            and sha(benchmark_binding_path)==proof['reference_binding_sha256'], 'Benchmark input binding changed')
    benchmark_binding = json.loads(benchmark_binding_path.read_text())
    require(all(benchmark_binding[key]==current_binding[key] for key in SEMANTIC_BINDING_KEYS),
            'Benchmarked model/data/environment/optimizer differs')
    require(proof['learning_rate'] == q['learning_rate'] and proof['accumulation'] == q['accumulation'],
            'Qualified optimizer settings differ')
    for name in ['cards31b_compute.py','cards31b_pipeline.py','reference_train_cards_31b.py']:
        require(sha(path.parent/'code'/name) == proof['code_sha256'][name], 'Benchmarked computation code changed')
    require(evidence['baseline_comparison']['passed']
            and evidence['baseline_comparison']['rows'] > 0
            and evidence['selected_eval_max_batch'] == batch_size
            and evidence['selected_eval_backend']==backend
            and evidence['selected_eval_token_budget']==token_budget, 'Evaluation comparison did not pass')
    journal = path.parent/'benchmark/BASELINE_COMPARE.jsonl'
    require(journal.resolve() == journal and sha(journal) == evidence['baseline_comparison']['journal_sha256'],
            'Benchmarked validation journal changed')
    if backend=='pipeline':
        require(batch_size==2 and evidence['pipeline']['comparison']['passed'] and evidence['pipeline_adapted_comparison']['passed'],
                'Pipeline did not pass with fresh and trained adapters')
    else:
        require(evidence['evaluation'][f'target_batch{batch_size}']['comparison']['passed'], 'Batched evaluator did not pass')
    require(profile != 'optimized' or evidence['training_optimization_passed'], 'Training comparison did not pass')
    return sha(path)


def near_decision_boundary(baseline, values):
    """Use the original evaluator around every threshold affected by rounding."""
    bound = 2 * max(0.002, 0.002 * max([baseline, *values]))
    best = reference = baseline
    for value in values:
        margins = [baseline-value-max(.001,baseline*.005),
                   reference-value-max(.001,reference*.005),
                   value-best-max(.001,best*.03)]
        if any(abs(margin) <= bound for margin in margins):
            return True
        if reference-value >= max(.001,reference*.005):
            reference = value
        best = min(best,value)
    return False


def original_metric_decision(model, dataset, record, work, binding, phase, cap, final):
    """Recheck thresholds with original CE; restore adapter, RNG and optimizer identity."""
    import torch
    from peft.utils.save_and_load import load_peft_weights, set_peft_model_state_dict
    pp = parameters(model)
    snapshot = [p.detach().cpu().clone() for p in pp]
    before = parameter_sha(model)
    rng = (random.getstate(),torch.get_rng_state(),torch.cuda.get_rng_state_all())
    record['use_reference_decisions'] = True
    try:
        paths = [record['baseline_checkpoint'], *record['epoch_checkpoints']]
        values = []
        for index,name in enumerate(paths):
            checkpoint = Path(name)
            require(checkpoint.is_relative_to(work/'checkpoints'), 'Reference checkpoint outside this run')
            manifest = verify_checkpoint(checkpoint,binding)
            set_peft_model_state_dict(model,load_peft_weights(str(checkpoint),device='cpu'),adapter_name='default')
            require(parameter_sha(model)==manifest['adapter_sha256'],'Reference recheck adapter differs')
            suffix = 'baseline' if index==0 else f'e{index:03d}'
            values.append(evaluate_reference(model,dataset,work/f'{phase}-reference-{suffix}.jsonl',work,
                                            phase+':reference:'+suffix))
        record['reference_baseline'],record['reference_losses'] = values[0],values[1:]
        return loss_decision(values[0],values[1:],cap,final)
    finally:
        with torch.no_grad():
            for p,value in zip(pp,snapshot):p.copy_(value)
        random.setstate(rng[0]);torch.set_rng_state(rng[1]);torch.cuda.set_rng_state_all(rng[2])
        require(parameter_sha(model)==before,'Reference recheck did not restore adapter')


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


def validation_smoke_indices(entries, token_budget, max_batch_size):
    """Cover the production evaluator's largest padded batch and edge rows."""
    from cards31b_compute import plan_validation_batches
    batches = plan_validation_batches(entries, token_budget, max_batch_size)
    largest = max([batch for batch in batches if len(batch) > 1] or batches,
                  key=lambda ids: len(ids) * max(entries[i]['sequence_length'] for i in ids))
    return list(dict.fromkeys([*largest,
        min(range(len(entries)), key=lambda i: entries[i]['sequence_length']),
        max(range(len(entries)), key=lambda i: entries[i]['sequence_length']),
        max(range(len(entries)), key=lambda i: entries[i]['target_length'])]))


def evaluator_canary(model, dataset, work):
    """Exercise production evaluation and journal resume on explicit smoke rows."""
    indices = validation_smoke_indices(dataset.entries, EVAL_TOKEN_BUDGET, EVAL_MAX_BATCH)
    class Subset:
        entries = [dataset.entries[i] for i in indices]
        def __len__(self):
            return len(indices)
        def __getitem__(self, index):
            return dataset[indices[index]]
    subset = Subset()
    original_path = work/'evaluator-smoke-reference.jsonl'
    actual_path = work/'evaluator-smoke-optimized.jsonl'
    # Exercise the production evaluator first so new shapes are not pre-warmed
    # by an original loss call in this trained-adapter canary process.
    actual = evaluate(model, subset, actual_path, work, 'canary:optimized')
    import torch
    from unsloth_zoo.fused_losses.cross_entropy_loss import get_chunk_size
    head = model.get_base_model().lm_head.weight
    with torch.cuda.device(head.device):
        chunks = [{'row_id':row['row_id'], 'sequence_length':row['sequence_length'],
                   'n_chunks':get_chunk_size(1,row['sequence_length'],head.shape[0],target_gb=None,
                       fixed_gb=row['sequence_length']*head.shape[1]*head.element_size()/1024**3)}
                  for row in subset.entries]
    expected = evaluate_reference(model, subset, original_path, work, 'canary:reference')
    before = sha(actual_path)
    resumed = evaluate(model, subset, actual_path, work, 'canary:resume')
    require(actual == resumed and sha(actual_path) == before, 'Evaluator resume changed completed results')
    reference = {r['row_id']:r for r in map(json.loads, original_path.read_text().splitlines())}
    results = {r['row_id']:r for r in map(json.loads, actual_path.read_text().splitlines())}
    require(set(reference) == set(results) == {r['row_id'] for r in subset.entries}, 'Evaluator smoke coverage differs')
    errors = []
    for identity, row in reference.items():
        value = results[identity]
        require(value['target_tokens'] == row['target_tokens'] and
                math.isclose(value['mean_target_ce'], row['mean_target_ce'], rel_tol=.002, abs_tol=.002),
                'Production evaluator differs from original on canary')
        errors.append(abs(value['mean_target_ce'] - row['mean_target_ce']))
    profile = profile_evaluator_canary(model, subset, work)
    return {'status':'passed', 'smoke_rows':len(indices), 'full_validation_unchanged':True,
            'reference_mean':expected, 'optimized_mean':actual, 'max_abs_ce_error':max(errors),
            'resume_journal_unchanged':True, 'optimized_executed_before_reference':True,
            'reference_shape_chunks_after_optimized':chunks, 'gpu_profile':profile}


def profile_evaluator_canary(model, dataset, work):
    """Trace GPU overlap/copies; uninstrumented benchmarks supply speed claims."""
    import torch
    from cards31b_compute import evaluation_losses, plan_validation_batches
    from cards31b_profile import profile_cuda_call, ProfilerUnavailable
    if EVAL_BACKEND == 'pipeline':
        from cards31b_pipeline import evaluation_losses_pipeline
        evaluation_losses = evaluation_losses_pipeline
    def optimized_call():
        values = {}
        for batch in plan_validation_batches(dataset.entries, EVAL_TOKEN_BUDGET, EVAL_MAX_BATCH):
            values.update(zip(batch, evaluation_losses(model,[dataset[i] for i in batch],chunk_tokens=256).cpu().tolist()))
        return [values[i] for i in range(len(dataset))]
    before = parameter_sha(model)
    try:
        with torch.no_grad():
            expected, original_trace = profile_cuda_call(
                lambda:[float(selected_loss(model,dataset[i])) for i in range(len(dataset))],
                work/'profile-original.json')
            actual, optimized_trace = profile_cuda_call(optimized_call,work/'profile-optimized.json')
        require(len(expected)==len(actual) and all(math.isclose(a,b,rel_tol=.002,abs_tol=.002)
                for a,b in zip(expected,actual)), 'Profiled evaluator comparison differs')
        result = {'status':'completed','scope':'canary full-context rows; compute only; diagnostic timing',
                  'reference':original_trace,'optimized':optimized_trace,
                  'max_abs_ce_error':max(abs(a-b) for a,b in zip(expected,actual))}
    except ProfilerUnavailable as exc:
        result = {'status':'unavailable','reason':str(exc)[:1000],
                  'cause_type':type(exc.__cause__).__name__ if exc.__cause__ else None,
                  'cause':str(exc.__cause__)[:1000] if exc.__cause__ else None}
    finally:
        require(parameter_sha(model)==before,'GPU profiling changed adapter')
    atomic(work/'GPU_PROFILE.json',result)
    return result


def run(args):
    import sys
    global COMPUTE_PROFILE, EVAL_MAX_BATCH, EVAL_TOKEN_BUDGET, EVAL_BACKEND, EVAL_WARMUP
    COMPUTE_PROFILE = args.compute_profile
    EVAL_MAX_BATCH = args.eval_max_batch
    EVAL_TOKEN_BUDGET = args.eval_token_budget
    EVAL_BACKEND = args.eval_backend
    work = args.work.resolve()
    require(work.is_dir() and work == args.work, "Work directory must be canonical")
    EVAL_WARMUP = json.loads((work.parent/'QUALIFICATION.json').read_text())['evaluation_warmup'] if COMPUTE_PROFILE!='reference' else None
    root = args.dataset.resolve()
    completion_path = getattr(args, 'completion_config', None)
    completion_gate = None
    if completion_path:
        from cards31b_completion import CompletionGate
        require(COMPUTE_PROFILE == 'reference', 'Completion bridge currently requires the reference profile')
        completion_gate = CompletionGate(completion_path, root)
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
    if COMPUTE_PROFILE != 'reference':
        source_files.append(Path(__file__).with_name('cards31b_compute.py'))
        source_files.append(Path(__file__).with_name('cards31b_pipeline.py'))
        source_files.append(Path(__file__).with_name('cards31b_profile.py'))
    if completion_gate:
        source_files.extend(Path(__file__).with_name(name) for name in
                            ('cards31b_completion.py', 'training_stop.py', 'role_dataset.py'))
    binding = {"course_sha256": sha(root / "COURSE.json"), "dataset_manifest_sha256": sha(root / "MANIFEST.json"),
               "model_config_sha256": sha(args.model / "config.json"), "model_index_sha256": sha(args.model / "model.safetensors.index.json"),
               "model_files": fingerprint["local_file_hashes"],
               "code_sha256": {str(p): sha(p) for p in source_files}, "versions": versions,
               "loader_config": config,
               "optimizer": "AdamW", "learning_rate": args.lr, "accumulation": args.accumulation,
               "seed": 3407, "max_length": 32768, "objective": "sum(weight_i * mean_target_CE_i) / N",
               "compute_profile":COMPUTE_PROFILE,"eval_max_batch":EVAL_MAX_BATCH,"eval_token_budget":EVAL_TOKEN_BUDGET,
               'eval_backend':EVAL_BACKEND, 'evaluation_warmup':EVAL_WARMUP}
    if completion_gate:
        binding['completion'] = completion_gate.binding()
    if COMPUTE_PROFILE != 'reference':
        binding['qualification_sha256'] = validate_qualification(work.parent/'QUALIFICATION.json',
                                        COMPUTE_PROFILE,EVAL_MAX_BATCH,EVAL_TOKEN_BUDGET,args.lr,args.accumulation,binding,EVAL_BACKEND)
    binding_path = work / "BINDING.json"
    if binding_path.exists():
        require(json.loads(binding_path.read_text()) == binding, "Run inputs changed")
    else:
        atomic(binding_path, binding)
    if args.mode == "preflight":
        status(work, "preflight_passed", versions=versions, dataset_validation=verified)
        event("preflight_passed", dataset_validation=verified, model_files_verified=len(fingerprint["local_file_hashes"]))
        return
    if args.mode == 'train' and completion_gate and reconcile_completion(work, binding, completion_gate):
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
    if completion_gate:
        require(initial_sha == completion_gate.baseline['baseline_checkpoint_sha256'],
                'Actual pretraining role baseline must match fresh adapter identity')
    event("fresh_model_loaded", initial_adapter_sha256=initial_sha, trainable_parameters=sum(p.numel() for p in pp))
    if COMPUTE_PROFILE != 'reference':
        from cards31b_compute import stabilize_evaluation
        warmup_ids=[i for i,row in enumerate(first['validation'].entries) if row['row_id']==EVAL_WARMUP['row_id']]
        require(len(warmup_ids)==1,'Qualified warmup row is missing or duplicated')
        warmup=stabilize_evaluation(model,first['validation'][warmup_ids[0]])
        require(warmup['protocol']==EVAL_WARMUP['protocol'] and parameter_sha(model)==initial_sha,
                'Warmup changed protocol or adapter')
        atomic(work/('EVALUATION_WARMUP-'+args.mode+'.json'),warmup)
        event('evaluation_warmup_passed',row_id=warmup['row_id'],protocol=warmup['protocol'])

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
            evaluator_smoke = evaluator_canary(model, first['validation'], work) if COMPUTE_PROFILE != 'reference' else None
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
                   "longest_validation_ce": validation, "evaluator_smoke":evaluator_smoke,
                   "adapter_changed": parameter_sha(model) != initial_sha})
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
            record['baseline_checkpoint'] = str(latest_checkpoint(work,binding))
            record["baseline"] = evaluate(model, ds["validation"], work / (pid + "-baseline.jsonl"), work, pid + ":baseline")
            atomic(state_path, state)
        first_epoch = len(record["losses"]) + 1
        cap = completion_gate.model['phases'][position]['safety_max_epochs'] if completion_gate else [3, 2, 5][position]
        for epoch in range(first_epoch, cap + 1):
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
            record.setdefault('epoch_checkpoints',[]).append(str(checkpoint))
            if completion_gate:
                from cards31b_completion import apply_receipts
                # Persist the completed epoch even if evidence is malformed; a
                # restart must not silently train this epoch a second time.
                atomic(state_path, state)
                receipts = completion_gate.assess(state, pid, work, binding, verify_checkpoint)
                state = apply_receipts(state, pid, receipts)
                record = state['phases'][pid]
                decision = record['decision']
                atomic(state_path, state)
                if decision == 'stop_phase_accepted':
                    event('phase_accepted', phase=pid, validation_loss=result, checkpoint=str(checkpoint))
                    saved = None
                    break
                if decision != 'continue':
                    status(work, decision, phase=pid, checkpoint=str(checkpoint),
                           completion=receipts[pid]['decision'])
                    return
                saved = None
                continue
            if COMPUTE_PROFILE != 'reference' and (record.get('use_reference_decisions') or near_decision_boundary(record['baseline'],record['losses'])):
                decision = original_metric_decision(model,ds['validation'],record,work,binding,pid,[3,2,5][position],position==2)
            else:
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
    if completion_gate:
        require(reconcile_completion(work, binding, completion_gate), 'Missing final completion decision')
    else:
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
    p.add_argument('--compute-profile', choices=['reference','evaluation','optimized'], default='reference')
    p.add_argument('--eval-max-batch',type=int,default=4)
    p.add_argument('--eval-token-budget',type=int,default=16384)
    p.add_argument('--eval-backend',choices=['serial','pipeline'],default='serial')
    p.add_argument('--completion-config', type=Path,
                   help='Freeze actual baseline/suite/policy before a new reference run; never retrofit an existing binding')
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

"""Full-context, per-example CE helpers for the pinned 31B curriculum.

Importing this module needs only the standard library. Callers own model mode,
gradient context, optimizer windows, evaluator provenance and checkpoint state.
No helper changes model weights, package code or the order of training updates.
"""
from contextlib import contextmanager
import math
import os

_CUDA_FORWARD_CE = None
WARMUP_PROTOCOL = "three_original_forwards_v1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def plan_validation_batches(entries, token_budget=16384, max_batch_size=4, indices=None):
    """Return deterministic length-sorted index batches without dropping rows.

    The budget covers padded tokens (batch size * maximum length). An individual
    row longer than the budget remains a singleton; its context is never cut.
    ``indices`` permits explicit remaining-row plans after identity-based resume.
    """
    require(type(token_budget) is int and token_budget > 0, "Invalid token budget")
    require(type(max_batch_size) is int and max_batch_size > 0, "Invalid batch size")
    ids = [r["row_id"] for r in entries]
    require(len(set(ids)) == len(ids), "Duplicate dataset row ID")
    chosen = list(range(len(entries))) if indices is None else list(indices)
    require(all(type(i) is int and 0 <= i < len(entries) for i in chosen)
            and len(set(chosen)) == len(chosen), "Invalid selected indices")
    require(all(type(entries[i]["sequence_length"]) is int
                and 0 < entries[i]["sequence_length"] <= 32768 for i in chosen),
            "Invalid sequence length")
    ordered = sorted(chosen, key=lambda i: (entries[i]["sequence_length"], i))
    result, batch = [], []
    for index in ordered:
        length = entries[index]["sequence_length"]
        if batch and (len(batch) == max_batch_size or (len(batch) + 1) * length > token_budget):
            result.append(batch)
            batch = []
        batch.append(index)
    if batch:
        result.append(batch)
    return result


def collate_rows(rows, pad_token_id=0, max_length=32768):
    """Right-pad independent full contexts; preserve every supervised token."""
    require(rows, "Empty batch")
    require(type(pad_token_id) is int and 0 <= pad_token_id < 262144, "Invalid pad token")
    require(type(max_length) is int and 0 < max_length <= 32768, "Invalid maximum length")
    result = {k: [] for k in ("input_ids", "attention_mask", "labels", "row_ids",
                              "sequence_lengths", "prefix_lengths", "target_lengths")}
    encoded_rows = []
    for row in rows:
        encoded = row["encoded"]
        length, prefix, target = (encoded[k] for k in
                                  ("sequence_length", "prefix_length", "target_length"))
        require(all(type(x) is int and x > 0 for x in (length, prefix, target))
                and length == prefix + target and length <= max_length, "Invalid full context lengths")
        require(all(row.get(k, encoded[k]) == encoded[k]
                    for k in ("sequence_length", "prefix_length", "target_length")),
                "Index and encoded lengths differ")
        ids = encoded["input_ids"]
        require(isinstance(ids, list) and len(ids) == length
                and all(type(t) is int and 0 <= t < 262144 for t in ids), "Invalid full input IDs")
        require(encoded["attention_mask"] == [1] * length, "Input is not an unpadded full context")
        require(encoded["labels"] == [-100] * prefix + ids[prefix:], "Last-response target mask differs")
        require(isinstance(row["row_id"], str) and row["row_id"], "Invalid row ID")
        result["row_ids"].append(row["row_id"])
        result["sequence_lengths"].append(length)
        result["prefix_lengths"].append(prefix)
        result["target_lengths"].append(target)
        encoded_rows.append(encoded)
    require(len(set(result["row_ids"])) == len(rows), "Duplicate batch row ID")
    padded_length = max(result["sequence_lengths"])
    for encoded in encoded_rows:
        padding = padded_length - encoded["sequence_length"]
        result["input_ids"].append(encoded["input_ids"] + [pad_token_id] * padding)
        result["attention_mask"].append(encoded["attention_mask"] + [0] * padding)
        result["labels"].append(encoded["labels"] + [-100] * padding)
    return result


@contextmanager
def _return_hidden_states():
    """Use the installed Unsloth branch for one non-concurrent model call."""
    key = "UNSLOTH_RETURN_HIDDEN_STATES"
    previous = os.environ.get(key)
    os.environ[key] = "1"
    try:
        yield
    finally:
        if previous is None:
            os.environ.pop(key, None)
        else:
            os.environ[key] = previous


def backbone_hidden(model, rows):
    """Run the complete PEFT forward, returning its final hidden-state tensor."""
    import torch
    base = model.get_base_model()
    require(hasattr(base, "model") and hasattr(base, "lm_head"), "Expected conditional-generation base model")
    require(not base.lm_head.weight.requires_grad
            and (getattr(base.lm_head, "bias", None) is None or not base.lm_head.bias.requires_grad),
            "Output head must remain frozen")
    collated = collate_rows(rows)
    device = model.get_input_embeddings().weight.device
    batch = {k: torch.tensor(collated[k], dtype=torch.long, device=device)
             for k in ("input_ids", "attention_mask", "labels")}
    # Keep the original top-level PEFT call, adapter context and forward hooks.
    # The installed Gemma branch exposes final hidden states in .logits while
    # bypassing only the LM head/loss. Do not bypass wrappers via base.model().
    with _return_hidden_states():
        output = model(**batch, use_cache=False, return_dict=True)
    require(hasattr(output, "loss") and output.loss is None,
            "Installed model did not honor the Unsloth hidden-state-only branch")
    hidden = getattr(output, "logits", None)
    require(torch.is_tensor(hidden) and hidden.ndim == 3
            and tuple(hidden.shape[:2]) == tuple(batch["input_ids"].shape)
            and hidden.shape[-1] == base.lm_head.weight.shape[1],
            "Hidden-state-only output differs from the full padded backbone shape")
    return base, hidden, collated


def stabilize_evaluation(model, row):
    """Qualify one bounded cold-to-steady transition using only original forwards.

    Exactly three successful forwards are permitted. Cold evidence is retained;
    calls two and three must agree exactly, with no parameter/buffer mutation.
    Compiler fallback state may settle naturally; this function never forces a
    fallback, clears a cache, or changes environment/precision settings.
    """
    import hashlib
    import json
    import random
    import torch

    def tensor_hash(tensor):
        # reshape first also supports scalar buffers/quantization offsets.
        raw = tensor.detach().cpu().contiguous().reshape(-1).view(torch.uint8)
        return hashlib.sha256(raw.numpy().tobytes()).hexdigest()

    def inventory():
        parameters = dict(model.named_parameters())
        metadata = {name: (p.data_ptr(), p._version, tuple(p.shape), str(p.dtype),
                           str(p.device), p.requires_grad) for name, p in parameters.items()}
        adapters = {name: p for name, p in parameters.items() if p.requires_grad or "lora_" in name}
        buffers = {"buffer:" + name: tensor for name, tensor in model.named_buffers()}
        for name, parameter in parameters.items():
            state, suffix, visited = getattr(parameter, "quant_state", None), "", set()
            while state is not None:
                require(id(state) not in visited, "Cyclic quantization state in stability inventory")
                visited.add(id(state))
                for key in ("absmax", "code", "offset"):
                    tensor = getattr(state, key, None)
                    if torch.is_tensor(tensor):
                        buffers["quant:" + name + suffix + "." + key] = tensor
                state, suffix = getattr(state, "state2", None), suffix + ".state2"
        byte_count = sum(t.numel() * t.element_size() for t in (*adapters.values(), *buffers.values()))
        require(byte_count < 2 * 1024 ** 3, "Stability hash inventory exceeds the 2 GiB bound")
        return {"parameters": metadata,
                "adapters": {name: tensor_hash(t) for name, t in adapters.items()},
                "buffers_quant": {name: (tuple(t.shape), str(t.dtype), str(t.device), tensor_hash(t))
                                  for name, t in buffers.items()},
                "hashed_bytes": byte_count}

    python_rng, cpu_rng = random.getstate(), torch.get_rng_state().clone()
    cuda_rng = torch.cuda.get_rng_state_all() if torch.cuda.is_available() else []
    modes = [(module, module.training) for module in model.modules()]
    report = None
    try:
        require(os.environ.get("UNSLOTH_RETURN_HIDDEN_STATES", "0") != "1",
                "Stability qualification requires the original loss-returning forward")
        base = model.get_base_model()
        require(hasattr(base, "model") and hasattr(base, "lm_head"),
                "Expected conditional-generation base model")
        collated = collate_rows([row])
        device = model.get_input_embeddings().weight.device
        batch = {key: torch.tensor(collated[key], dtype=torch.long, device=device)
                 for key in ("input_ids", "attention_mask", "labels")}
        initial = inventory()
        model.eval()
        losses, hidden_states = [], []
        with torch.no_grad():
            for call in range(3):
                captured = []

                def capture(module, args, output):
                    hidden = getattr(output, "last_hidden_state", None)
                    require(torch.is_tensor(hidden) and hidden.ndim == 3
                            and tuple(hidden.shape[:2]) == tuple(batch["input_ids"].shape)
                            and hidden.shape[-1] == base.lm_head.weight.shape[1],
                            "Original forward did not expose the full final hidden state")
                    captured.append(hidden.detach().clone())

                handle = base.model.register_forward_hook(capture)
                try:
                    output = model(**batch, use_cache=False)
                finally:
                    handle.remove()
                loss = getattr(output, "loss", None)
                require(torch.is_tensor(loss) and loss.ndim == 0 and bool(torch.isfinite(loss).item()),
                        "Nonfinite or missing original CE during stability qualification")
                require(len(captured) == 1, "Expected exactly one complete backbone capture")
                hidden = captured.pop().cpu()
                require(bool(torch.isfinite(hidden).all().item()), "Nonfinite original hidden state")
                losses.append(loss.detach().cpu().clone())
                hidden_states.append(hidden)
                current = inventory()
                for kind in ("parameters", "adapters", "buffers_quant"):
                    changed = sorted(name for name in set(initial[kind]) | set(current[kind])
                                     if initial[kind].get(name) != current[kind].get(name))
                    require(not changed, f"Stability {kind} mutated after call {call + 1}: {changed[:5]}")
        require(losses[1].dtype == losses[2].dtype and torch.equal(losses[1], losses[2]),
                "Original CE did not stabilize exactly after three calls")
        require(hidden_states[1].dtype == hidden_states[2].dtype and torch.equal(hidden_states[1], hidden_states[2]),
                "Original hidden states did not stabilize exactly after three calls")
        values = [float(loss) for loss in losses]
        report = {"status": "passed", "passed": True, "protocol": WARMUP_PROTOCOL,
                  "row_id": row["row_id"], "calls": 3, "losses": values,
                  "cold_ce": values[0], "steady_ce": values[2],
                  "cold_ce_abs_difference": abs(values[0] - values[1]),
                  "ce_2_equals_3": True, "hidden_2_equals_3": True,
                  "cold_hidden_equals_steady": torch.equal(hidden_states[0], hidden_states[1]),
                  "cold_hidden_max_abs": float((hidden_states[0].float() - hidden_states[1].float()).abs().max()),
                  "parameter_metadata_unchanged": True, "adapter_bytes_unchanged": True,
                  "buffer_quant_bytes_unchanged": True, "parameter_count": len(initial["parameters"]),
                  "buffer_quant_count": len(initial["buffers_quant"]), "hashed_bytes": initial["hashed_bytes"],
                  "adapter_sha256": hashlib.sha256(json.dumps(initial["adapters"], sort_keys=True).encode()).hexdigest()}
    finally:
        # Restore every module flag, including any deliberately mixed train/eval
        # modes, without invoking model-specific train() side effects a second time.
        for module, training in modes:
            module.training = training
        random.setstate(python_rng)
        torch.set_rng_state(cpu_rng)
        if cuda_rng:
            torch.cuda.set_rng_state_all(cuda_rng)
        require(random.getstate() == python_rng and torch.equal(torch.get_rng_state(), cpu_rng)
                and (not cuda_rng or all(torch.equal(a, b)
                     for a, b in zip(torch.cuda.get_rng_state_all(), cuda_rng))),
                "Stability qualification failed to restore RNG state")
    report["rng_restored"] = True
    report["model_mode_restored"] = all(module.training == training for module, training in modes)
    return report


def softcap(base):
    config = base.config.get_text_config()
    value = config.final_logit_softcapping
    require(value is None or (isinstance(value, (int, float)) and math.isfinite(value) and value >= 0),
            "Invalid output softcap")
    return value


def _cuda_forward_ce():
    """Compile the installed forward math once, without grad_and_value."""
    global _CUDA_FORWARD_CE
    if _CUDA_FORWARD_CE is None:
        import torch
        from unsloth_zoo.fused_losses.cross_entropy_loss import compute_fused_ce_loss, torch_compile_options
        _CUDA_FORWARD_CE = torch.compile(compute_fused_ce_loss, dynamic=True, fullgraph=True,
                                         options=torch_compile_options)
    return _CUDA_FORWARD_CE


def reference_chunk_ranges(length, prefix, n_chunks, skip_masked=True):
    """Match torch.chunk's original full-length slices, optionally omitting zero loss.

    ``torch.chunk`` may return fewer than n_chunks slices. The last hidden row
    predicts no supervised token; supervised predictor positions are exactly
    [prefix - 1, length - 1). A retained slice keeps its ignored positions too.
    """
    require(type(length) is int and type(prefix) is int and 0 < prefix < length <= 32768,
            "Invalid reference chunk lengths")
    require(type(n_chunks) is int and n_chunks > 0, "Invalid reference chunk count")
    size = (length + n_chunks - 1) // n_chunks
    ranges = [(start, min(start + size, length)) for start in range(0, length, size)]
    if skip_masked:
        ranges = [(start, stop) for start, stop in ranges if start < length - 1 and stop > prefix - 1]
    return ranges


def reference_head_chunk_count(hidden, head):
    """Use the installed full-hidden buffer budget and cached chunk multiplier.

    With a frozen head and overwrite=False the original fixed allocation is one
    gradient-input tensor of full hidden size. The installed multiplier cache
    retains a warmed reference choice for this exact length/width/dtype. For a
    previously unseen shape the installed function still uses current free VRAM;
    this helper does not claim a memory-independent schedule across processes.
    """
    from unsloth_zoo.fused_losses.cross_entropy_loss import get_chunk_size
    require(hidden.ndim == 2 and hidden.shape[1] == head.weight.shape[1], "Invalid full hidden shape")
    require(not head.weight.requires_grad
            and (getattr(head, "bias", None) is None or not head.bias.requires_grad),
            "Reference chunk sizing requires a frozen output head")
    fixed_gb = hidden.numel() * hidden.element_size() / (1024 ** 3)
    count = get_chunk_size(1, hidden.shape[0], head.weight.shape[0], target_gb=None, fixed_gb=fixed_gb)
    require(type(count) is int and 0 < count <= hidden.shape[0], "Installed chunk count is invalid")
    return count


def aligned_head_loss(base, hidden, row, training=False, skip_masked=True):
    """Preserve reference head GEMM shapes and per-chunk normalization.

    ``hidden`` is the final normalized full-context [length, width] tensor on
    either GPU. Only retained original chunks move to the head device. There is
    no per-chunk host synchronization; callers check their final loss for finite
    values. This does not shorten the backbone or omit any supervised target.
    """
    import torch
    require(bool(torch.is_grad_enabled()) == training, "Aligned head gradient mode differs")
    collated = collate_rows([row])
    length, prefix, target_count = (collated[k][0] for k in
                                     ("sequence_lengths", "prefix_lengths", "target_lengths"))
    require(hidden.ndim == 2 and hidden.shape[0] == length, "Aligned head requires the full context")
    count = reference_head_chunk_count(hidden, base.lm_head)
    ranges = reference_chunk_ranges(length, prefix, count, skip_masked=skip_masked)
    shifted = collated["labels"][0][1:length] + [-100]
    divisor = torch.tensor(target_count, dtype=torch.float32, device=base.lm_head.weight.device)
    total = torch.zeros((), dtype=torch.float32, device=base.lm_head.weight.device)
    cap = softcap(base)
    if training:
        from unsloth_zoo.fused_losses.cross_entropy_loss import unsloth_fused_ce_loss
    cuda_forward = _cuda_forward_ce() if not training and base.lm_head.weight.device.type == "cuda" else None
    for start, stop in ranges:
        # Keep M exactly as in the full reference chunk, including ignored prefix
        # and the final ignored position. Compacting to target_count changes BF16
        # GEMM kernels/rounding even if the mathematical objective is identical.
        states = hidden[start:stop].to(device=base.lm_head.weight.device)
        labels = torch.tensor(shifted[start:stop], dtype=torch.long, device=base.lm_head.weight.device)
        if training:
            value = unsloth_fused_ce_loss(
                trainer=None, hidden_states=states.unsqueeze(0), lm_head_weight=base.lm_head.weight,
                lm_head_bias=getattr(base.lm_head, "bias", None), labels=labels.unsqueeze(0), mask=None,
                n_items=divisor, scaling=getattr(base, "accelerator_scaler", None), target_gb=None,
                torch_compile=os.environ.get("UNSLOTH_COMPILE_DISABLE", "0") not in ("1", "partial"),
                overwrite=False, shift_labels=False, n_chunks=1, logit_scale_multiply=0,
                logit_scale_divide=0, logit_softcapping=cap)
        elif cuda_forward is not None:
            value, _ = cuda_forward(hidden_states=states, lm_head_weight=base.lm_head.weight,
                                    lm_head_bias=getattr(base.lm_head, "bias", None), labels=labels,
                                    n_items=divisor, scaling=None, shift_labels=False,
                                    logit_softcapping=cap)
        else:
            logits = torch.nn.functional.linear(states.to(dtype=base.lm_head.weight.dtype),
                                                base.lm_head.weight, getattr(base.lm_head, "bias", None))
            if cap not in (None, 0):
                logits = torch.tanh(logits / cap) * cap
            value = torch.nn.functional.cross_entropy(logits.float(), labels, reduction="sum",
                                                       ignore_index=-100) / divisor
        # The reference divides each chunk by the full row target count before
        # accumulating. Preserve that order instead of dividing the final sum.
        total = total + value
    require(total.ndim == 0, "Aligned head must return one row mean CE")
    return total


def evaluation_losses(model, rows, head_mode="target", chunk_tokens=128):
    """Return one mean-target CE per row; caller must use eval and no_grad.

    ``full`` keeps all output positions as a diagnostic control that isolates the
    removal of fused-CE internal derivatives. ``target`` skips only original
    chunks whose labels are all ignored. Both retain reference head chunk shapes
    and the full backbone. ``chunk_tokens`` remains accepted for caller API
    compatibility; the installed reference chunk schedule always takes priority.
    """
    import torch
    require(not model.training and not torch.is_grad_enabled(), "Evaluation requires eval() and no_grad()")
    require(head_mode in ("target", "full"), "Invalid evaluation head mode")
    require(type(chunk_tokens) is int and chunk_tokens > 0, "Invalid head chunk size")
    base, hidden, collated = backbone_hidden(model, rows)
    losses = [aligned_head_loss(base, hidden[i, :length], row, training=False,
                                skip_masked=head_mode == "target")
              for i, (row, length) in enumerate(zip(rows, collated["sequence_lengths"]))]
    values = torch.stack(losses)
    require(bool(torch.isfinite(values).all().item()), "Nonfinite per-row evaluation CE")
    return values


def training_loss(model, row):
    """Aligned head CE with autograd through the complete, unchanged context."""
    import torch
    require(model.training and torch.is_grad_enabled(), "Training requires train() and gradients")
    base, hidden, _ = backbone_hidden(model, [row])
    loss = aligned_head_loss(base, hidden[0], row, training=True)
    require(loss.ndim == 0 and bool(torch.isfinite(loss).item()), "Nonfinite mean target training CE")
    return loss

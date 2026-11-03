"""Experimental two-forward/serial-backward scheduling for the pinned 31B model.

This candidate is not an optimizer or an approved replacement for the serial
runner. The caller must first complete a reference training update, then qualify
losses, all gradients, clipping, AdamW state and resumed execution. This function
only accumulates gradients for at most two consecutive rows of an existing
optimizer window; it never zeroes, clips or steps the optimizer.

The installed smart checkpointer gives forward contexts distinct CPU slots until
the next forward after a backward. Therefore both forwards finish before either
backward, and no new forward is allowed until both backwards finish. The current
TiledMLP recompute does not invoke another smart checkpoint; each decoder's
checkpoint recomputes Module.__call__, not GradientCheckpointingLayer.__call__.
All main computation stays on the checkpointer's default streams.
"""
import functools
import math

from cards31b_compute import aligned_head_loss, require, training_loss
from cards31b_pipeline import _hooks, _prepare, _layers


def _ready_checkpointer(gc, torch):
    require(gc.FIRST_PASS is False and gc.LAST_GC_INDEX == 60,
            "Complete a reference training update before the pipeline candidate")
    require(gc.BACKWARD_PASS is True and gc.CURRENT_GC_INDEX == 0,
            "An earlier checkpoint graph is still outstanding")
    require(len(gc.MAIN_STREAMS) == 2, "Unexpected checkpointer stream count")
    for i in range(2):
        default = torch.cuda.default_stream(i)
        require(gc.MAIN_STREAMS[i] == default and torch.cuda.current_stream(i) == default,
                "Training pipeline requires the checkpointer's default streams")


def _qualified_training_model(model):
    import torch
    import unsloth_zoo.gradient_checkpointing as gc
    require(model.training and torch.is_grad_enabled(), "Training pipeline requires train() and gradients")
    require(torch.cuda.is_available() and torch.cuda.device_count() == 2, "Training pipeline requires two GPUs")
    _ready_checkpointer(gc, torch)
    base, wrapper = model.get_base_model(), model.get_base_model().model
    language, config = wrapper.language_model, base.config.get_text_config()
    require(config.num_hidden_layers == 60 and len(language.layers) == 60 and config.hidden_size == 5376,
            "Training pipeline requires the qualified 60-layer model")
    require(config.hidden_size_per_layer_input == 0 and not config.enable_moe_block
            and getattr(config, "num_kv_shared_layers", 0) == 0,
            "Training pipeline does not support PLE, MoE or shared KV")
    require(config.attention_dropout == 0 and config.use_bidirectional_attention in (None, "vision")
            and config.sliding_window == 1024 and config._attn_implementation in ("sdpa", "eager"),
            "Training attention contract differs")
    require(len(config.layer_types) == 60
            and set(config.layer_types) == {"full_attention", "sliding_attention"}, "Layer type contract differs")
    require(model.get_input_embeddings().weight.device == torch.device("cuda:0")
            and base.lm_head.weight.device == torch.device("cuda:0")
            and model.get_input_embeddings().weight.dtype == torch.bfloat16,
            "Training embedding/head placement or precision differs")
    require(not base.lm_head.weight.requires_grad
            and (getattr(base.lm_head, "bias", None) is None or not base.lm_head.bias.requires_grad),
            "Output head must remain frozen")
    require(all(p.device == torch.device("cuda:1") for p in language.norm.parameters()),
            "Training final norm placement differs")
    for i, layer in enumerate(language.layers):
        expected = torch.device("cuda:0" if i < 28 else "cuda:1")
        require(all(p.device == expected for p in layer.parameters()), "Training decoder placement differs")
        require(layer.training and layer.gradient_checkpointing and not layer.self_attn.is_kv_shared_layer
                and layer.self_attn.is_causal and layer.self_attn.attention_dropout == 0,
                "Training decoder/checkpoint contract differs")
        require(getattr(layer.self_attn, "_unsloth_shared_kv_carrier", None) is None,
                "Module-scoped shared KV carrier is unsafe")
        checkpoint = layer._gradient_checkpointing_func
        while isinstance(checkpoint, functools.partial):
            checkpoint = checkpoint.func
        require(checkpoint is gc.unsloth_checkpoint, "Unexpected decoder checkpointer")
        require(getattr(layer.mlp.forward, "__name__", "") == "tiled_forward_arctic_size",
                "Unexpected MLP recomputation implementation")
    for module in model.modules():
        hook = getattr(module, "_hf_hook", None)
        if hook is not None:
            require(all(not getattr(h, "offload", False) for h in _hooks(hook)),
                    "Training pipeline cannot use parameter offload hooks")
        require(not getattr(module, "_unsloth_gemma4_carrier_outstanding", False),
                "An earlier carrier graph is outstanding")
    return base, wrapper, language, config, gc


def _slot_fingerprint(gc):
    count = gc.CPU_INDEX
    require(type(count) is int and 0 <= count <= len(gc.CPU_BUFFERS), "Invalid checkpoint slot cursor")
    # Offload writes use PyTorch copy_ on views of these host buffers. Their
    # version counters detect an overwrite as well as explicit resize/replacement.
    return count, tuple((buffer.data_ptr(), buffer.numel(), str(buffer.dtype), buffer._version)
                        for buffer in gc.CPU_BUFFERS[:count])


def _compact_training_head(base, prepared, hidden):
    import torch
    require(hidden.dtype == torch.bfloat16, "Pipeline would change FP32 offload rounding")
    loss = aligned_head_loss(base, hidden[0], prepared["row"], training=True)
    require(loss.ndim == 0, "Training head must return one row mean CE")
    return loss


def accumulate_pair(model, rows, coefficients):
    """Accumulate at most two rows in order; finish both backwards before return.

    Inputs over 8192 tokens, oversized pairs and single rows use the qualified
    serial forward/backward path. This is scheduling fallback, never truncation.
    A runtime failure is fatal to this candidate process: do not catch it and
    retry with live checkpoint graphs or repair package globals in place.
    """
    import torch
    require(1 <= len(rows) <= 2 and len(rows) == len(coefficients), "Expected one or two weighted rows")
    require(len({r["row_id"] for r in rows}) == len(rows), "Duplicate training pair row")
    factors = [float(c) for c in coefficients]
    require(all(not isinstance(c, bool) and math.isfinite(v) and v > 0
                for c, v in zip(coefficients, factors)), "Invalid row coefficient")
    base, wrapper, language, config, gc = _qualified_training_model(model)
    lengths = [row["encoded"]["sequence_length"] for row in rows]
    eligible = len(rows) == 2 and max(lengths) <= 8192 and len(rows) * max(lengths) <= 16384
    schedule = "pair_default_stream_wavefront" if eligible else "serial_single" if len(rows) == 1 else "serial_long"
    losses = []
    slots_verified = False
    try:
        if not eligible:
            for row, factor in zip(rows, factors):
                loss = training_loss(model, row)
                losses.append(loss.detach())
                (loss * factor).backward()
                _ready_checkpointer(gc, torch)
        else:
            prepared = [_prepare(wrapper, language, config, row) for row in rows]
            require(all(p["hidden"].dtype == torch.bfloat16 and p["hidden"].requires_grad for p in prepared),
                    "Prepared training activations must be differentiable BF16")

            def first(item):
                with torch.cuda.device(0):
                    result = _layers(language, config, item["hidden"], item, 0)
                    require(result.dtype == torch.bfloat16, "First-stage offload precision differs")
                    return result

            def second(item, hidden):
                with torch.cuda.device(1):
                    hidden = hidden.to(device="cuda:1", non_blocking=True)
                    hidden = _layers(language, config, hidden, item, 1)
                    hidden = language.norm(hidden)
                    require(hidden.dtype == torch.bfloat16, "Second-stage offload precision differs")
                    return hidden

            # Both devices retain their default streams. CUDA cross-device .to
            # establishes dependencies; no custom streams or package globals are
            # substituted. Stage1(A) may overlap stage0(B).
            a0 = first(prepared[0])
            a1 = second(prepared[0], a0)
            b0 = first(prepared[1])
            with torch.cuda.device(0):
                a_loss = _compact_training_head(base, prepared[0], a1)
            b1 = second(prepared[1], b0)
            with torch.cuda.device(0):
                b_loss = _compact_training_head(base, prepared[1], b1)
            require(gc.CURRENT_GC_INDEX == 120, "Unexpected nested/omitted checkpoint forward")
            slots = _slot_fingerprint(gc)
            # First device-to-host scalar read is after both complete forward
            # graphs have been queued. Preserve the serial runner's finite gate.
            require(bool(torch.isfinite(torch.stack((a_loss.detach(), b_loss.detach()))).all().item()),
                    "Nonfinite training pair loss")
            for loss, factor in zip((a_loss, b_loss), factors):
                losses.append(loss.detach())
                (loss * factor).backward()
                _ready_checkpointer(gc, torch)
                require(_slot_fingerprint(gc) == slots, "Checkpoint CPU slots changed before both backwards finished")
            slots_verified = True
    finally:
        # Also drains the checkpointer's side-copy streams through its existing
        # MAIN_STREAM wait dependencies, before graph references can be released.
        torch.cuda.default_stream(0).synchronize()
        torch.cuda.default_stream(1).synchronize()
    values = [float(value.item()) for value in losses]
    require(all(math.isfinite(value) for value in values), "Nonfinite accumulated row loss")
    return {"losses": values, "weighted_loss_sum": math.fsum(v * f for v, f in zip(values, factors)),
            "schedule": schedule, "offload_slots": gc.CPU_INDEX, "checkpoint_slots_verified": slots_verified}

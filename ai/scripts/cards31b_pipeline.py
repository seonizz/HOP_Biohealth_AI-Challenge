"""Evaluation-only, two-example pipeline for the qualified 28/32 Gemma split.

The existing embedding, RoPE, mask builder, decoder modules and final norm are
reused. Only the scheduling changes. There are no threads, weight moves, module
patches, KV caches, optimizer operations or changes to the supervised objective.
"""
from collections import UserDict

from cards31b_compute import aligned_head_loss, collate_rows, require

_PIPELINE_STREAMS = None


def _streams():
    """Reuse two streams so allocator blocks can be reused across batches."""
    import torch
    global _PIPELINE_STREAMS
    if _PIPELINE_STREAMS is None:
        _PIPELINE_STREAMS = (torch.cuda.Stream(device=0), torch.cuda.Stream(device=1))
    return _PIPELINE_STREAMS


def _hooks(hook):
    yield hook
    for child in getattr(hook, "hooks", ()):
        yield from _hooks(child)


def _qualified_model(model):
    import torch
    require(not model.training and not torch.is_grad_enabled(), "Pipeline requires eval() and no_grad()")
    require(torch.cuda.is_available() and torch.cuda.device_count() == 2, "Pipeline requires the qualified two GPUs")
    base = model.get_base_model()
    wrapper = base.model
    language = wrapper.language_model
    config = base.config.get_text_config()
    require(config.num_hidden_layers == 60 and len(language.layers) == 60
            and config.hidden_size == 5376, "Pipeline requires the qualified 60-layer model")
    require(config.hidden_size_per_layer_input == 0 and not config.enable_moe_block
            and getattr(config, "num_kv_shared_layers", 0) == 0,
            "Pipeline does not support PLE, MoE or shared KV layers")
    require(config.attention_dropout == 0 and config.use_bidirectional_attention in (None, "vision")
            and config.sliding_window == 1024, "Pipeline attention contract differs")
    require(len(config.layer_types) == 60
            and set(config.layer_types) == {"sliding_attention", "full_attention"},
            "Pipeline layer types differ")
    require(config._attn_implementation in ("sdpa", "eager"), "Pipeline requires tensor-based causal masks")
    require(model.get_input_embeddings().weight.device == torch.device("cuda:0")
            and base.lm_head.weight.device == torch.device("cuda:0"), "Embedding/head placement differs")
    require(not base.lm_head.weight.requires_grad
            and (getattr(base.lm_head, "bias", None) is None or not base.lm_head.bias.requires_grad),
            "Output head must remain frozen")
    require(all(p.device == torch.device("cuda:1") for p in language.norm.parameters()),
            "Final norm placement differs")
    for i, layer in enumerate(language.layers):
        device = torch.device("cuda:0" if i < 28 else "cuda:1")
        require(all(p.device == device for p in layer.parameters()), "Decoder placement differs")
        require(not layer.training and not layer.self_attn.is_kv_shared_layer
                and layer.self_attn.is_causal and layer.self_attn.attention_dropout == 0,
                "Decoder attention contract differs")
    for module in model.modules():
        hook = getattr(module, "_hf_hook", None)
        if hook is not None:
            require(all(not getattr(h, "offload", False) for h in _hooks(hook)),
                    "Pipeline cannot use parameter offload hooks")
    return base, wrapper, language, config


def _move_tree(value, device):
    """Only the tensor/None containers used by the pinned mask and RoPE APIs."""
    import torch
    if torch.is_tensor(value):
        return value.to(device=device, non_blocking=True)
    if value is None:
        return None
    if isinstance(value, tuple):
        return tuple(_move_tree(v, device) for v in value)
    if isinstance(value, dict):
        return {k: _move_tree(v, device) for k, v in value.items()}
    raise ValueError("Unsupported pipeline mask or RoPE container")


def _prepare(wrapper, language, config, row):
    import torch
    from transformers.models.gemma4.modeling_gemma4 import create_masks_for_generate
    collated = collate_rows([row])
    device0, device1 = torch.device("cuda:0"), torch.device("cuda:1")
    with torch.cuda.device(device0):
        ids = torch.tensor(collated["input_ids"], dtype=torch.long, device=device0)
        attention_mask = torch.tensor(collated["attention_mask"], dtype=torch.long, device=device0)
        labels = torch.tensor(collated["labels"], dtype=torch.long, device=device0)
        # Match Gemma4Model.forward even for placeholder IDs with no supplied
        # media tensors. Embedding.forward already applies Gemma's BF16 scale.
        image, video, audio = wrapper.get_placeholder_mask(ids, None)
        embedding_ids = torch.where(image | video | audio, config.pad_token_id, ids.clone())
        hidden = wrapper.get_input_embeddings()(embedding_ids)
        positions = torch.arange(hidden.shape[1], device=hidden.device).unsqueeze(0)
        masks = create_masks_for_generate(config=config, inputs_embeds=hidden,
                                         attention_mask=attention_mask, past_key_values=None,
                                         position_ids=positions)
        require(isinstance(masks, dict) and set(config.layer_types).issubset(masks),
                "Canonical Gemma mask mapping differs")
        # Keep the original rotary module and its Accelerate hooks. Preparation
        # is outside the overlapping layer stages because this module is on GPU1.
        rope = {kind: language.rotary_emb(hidden, positions, kind)
                for kind in language.unique_layer_types}
        context0 = {"positions": positions, "labels": labels, "masks": _move_tree(masks, device0),
                    "rope": _move_tree(rope, device0)}
        context1 = {"positions": positions.to(device=device1, non_blocking=True),
                    "labels": labels.to(device=device1, non_blocking=True),
                    "masks": _move_tree(masks, device1), "rope": _move_tree(rope, device1)}
        prefix, length = collated["prefix_lengths"][0], collated["sequence_lengths"][0]
        targets = torch.tensor(collated["input_ids"][0][prefix:length], dtype=torch.long, device=device0)
    # These references live until both streams finish, including source tensors
    # used by cross-device copies. No foreign-device record_stream is needed.
    return {"row": row, "hidden": hidden, "contexts": (context0, context1), "shared": UserDict(),
            "prefix": prefix, "length": length, "target_length": collated["target_lengths"][0],
            "targets": targets, "input_buffers": (ids, attention_mask, labels, embedding_ids, masks, rope)}


def _layers(language, config, hidden, prepared, stage):
    import torch
    context = prepared["contexts"][stage]
    start, stop = (0, 28) if stage == 0 else (28, 60)
    for i in range(start, stop):
        kind = config.layer_types[i]
        hidden = language.layers[i](
            hidden, None, shared_kv_states=prepared["shared"],
            position_embeddings=context["rope"][kind], attention_mask=context["masks"][kind],
            position_ids=context["positions"], past_key_values=None, labels=context["labels"])
        require(torch.is_tensor(hidden) and hidden.ndim == 3, "Decoder must return hidden-state tensor")
    return hidden


def evaluation_losses_pipeline(model, rows, chunk_tokens=256):
    """Return row CE in input order, overlapping stage1(A) with stage0(B).

    Every microbatch contains one complete example. Two examples are kept in
    flight, so peak activation storage is bounded independently of ``len(rows)``.
    This is an eval-only candidate, not a claim of speedup: PCIe copies and module
    internals may serialize. Benchmark complete calls against the serial helper.
    """
    import torch
    require(rows, "Empty pipeline batch")
    require(len({r["row_id"] for r in rows}) == len(rows), "Duplicate pipeline row ID")
    require(type(chunk_tokens) is int and chunk_tokens > 0, "Invalid head chunk size")
    base, wrapper, language, config = _qualified_model(model)
    stream0, stream1 = _streams()
    losses = []
    for offset in range(0, len(rows), 2):
        prepared = [_prepare(wrapper, language, config, r) for r in rows[offset:offset + 2]]
        stream0.wait_stream(torch.cuda.current_stream(0))
        stream1.wait_stream(torch.cuda.current_stream(1))
        retained = []
        try:
            # Both per-device current streams stay selected throughout the
            # schedule. PyTorch cross-device copies then see the producer and
            # consumer streams, in addition to the explicit dependency events.
            with torch.cuda.stream(stream0), torch.cuda.stream(stream1):
                def first(item):
                    with torch.cuda.device(0):
                        hidden = _layers(language, config, item["hidden"], item, 0)
                        ready = torch.cuda.Event()
                        ready.record(stream0)
                        retained.append(hidden)
                        return hidden, ready

                def second(item, first_result):
                    hidden, ready = first_result
                    with torch.cuda.device(1):
                        stream1.wait_event(ready)
                        moved = hidden.to(device="cuda:1", non_blocking=True)
                        hidden = _layers(language, config, moved, item, 1)
                        hidden = language.norm(hidden)
                        ready = torch.cuda.Event()
                        ready.record(stream1)
                        retained.extend((moved, hidden))
                        return hidden, ready

                def score(item, second_result):
                    hidden, ready = second_result
                    with torch.cuda.device(0):
                        stream0.wait_event(ready)
                        return aligned_head_loss(base, hidden[0], item["row"])

                a0 = first(prepared[0])
                a1 = second(prepared[0], a0)
                b0 = first(prepared[1]) if len(prepared) == 2 else None
                b1 = None
                losses.append(score(prepared[0], a1))
                if b0 is not None:
                    b1 = second(prepared[1], b0)
                    losses.append(score(prepared[1], b1))
        finally:
            # Preserve activation, mask, RoPE, KV and copy-source lifetime even
            # on Python errors. Bound memory to the current pair before release.
            stream0.synchronize()
            stream1.synchronize()
        # Drop the completed pair before preparing the next pair. Assignment of
        # a new list alone would temporarily retain both pairs on the RHS.
        del prepared, retained, a0, a1, b0, b1, first, second, score
    values = torch.stack(losses)
    require(bool(torch.isfinite(values).all().item()), "Nonfinite pipeline row CE")
    return values

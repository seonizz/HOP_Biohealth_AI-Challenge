"""Compute global Gemma attention in KV-head groups to bound temporary memory."""
def install_grouped_attention():
    import torch
    from transformers.modeling_utils import ALL_ATTENTION_FUNCTIONS
    original = ALL_ATTENTION_FUNCTIONS["sdpa"]

    def grouped(module, query, key, value, attention_mask,
                dropout=0.0, scaling=None, is_causal=None, **kwargs):
        qheads, kheads = query.shape[1], key.shape[1]
        eligible = (type(module).__name__.startswith("Gemma4")
                    and not getattr(module, "is_sliding", True)
                    and not module.training and dropout == 0
                    and qheads > kheads and qheads % kheads == 0
                    and value.shape[1] == kheads and kwargs.get("position_bias") is None)
        if not eligible:
            return original(module, query, key, value, attention_mask, dropout=dropout,
                            scaling=scaling, is_causal=is_causal, **kwargs)
        qlen, klen = query.shape[2], key.shape[2]
        if qlen > 1 and klen > qlen and attention_mask is None:
            raise ValueError("Cached prefill requires an explicit causal mask")
        causal = is_causal if is_causal is not None else getattr(module, "is_causal", True)
        causal = bool(qlen > 1 and attention_mask is None and causal)
        group_size = qheads // kheads
        parts = []
        for head in range(kheads):
            start, end = head * group_size, (head + 1) * group_size
            # Materialize one group at a time, instead of all repeated KV heads.
            # Contiguous tensors preserve the existing SDPA backend eligibility.
            group_key = key[:, head:head + 1].expand(-1, group_size, -1, -1).contiguous()
            group_value = value[:, head:head + 1].expand(-1, group_size, -1, -1).contiguous()
            mask = attention_mask
            if mask is not None and mask.shape[1] != 1:
                mask = mask[:, start:end]
            parts.append(torch.nn.functional.scaled_dot_product_attention(
                query[:, start:end], group_key, group_value, attn_mask=mask,
                dropout_p=0.0, scale=scaling, is_causal=causal))
            del group_key, group_value
        return torch.cat(parts, dim=1).transpose(1, 2).contiguous(), None

    grouped.original_attention = original
    ALL_ATTENTION_FUNCTIONS["sdpa"] = grouped
    return original

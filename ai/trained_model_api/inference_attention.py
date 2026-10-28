"""Single-token grouped-query attention without materializing repeated KV heads."""


def folded_decode_attention(query, key, value, attention_mask=None, *, scale=None):
    """Return ``[batch, 1, query_heads, value_dim]`` or ``None`` for fallback.

    For single-token decode, the query heads sharing one KV head can be treated
    as independent query positions. SDPA then uses the original K/V tensors in
    one call. This is mathematically equivalent to repeated-KV attention, but a
    different kernel or reduction order can change floating-point rounding.

    Only four-dimensional, strided floating-point tensors and masks of shape
    ``[1 or batch, 1 or query_heads, 1, key_length]`` are supported. The caller
    remains responsible for inference-only/global-attention eligibility.
    """
    import torch
    from torch.nn import functional as F

    tensors = (query, key, value)
    if any(not isinstance(tensor, torch.Tensor) or tensor.is_nested
           or tensor.layout != torch.strided or tensor.ndim != 4
           for tensor in tensors):
        return None
    if query.dtype not in (torch.float16, torch.bfloat16, torch.float32, torch.float64):
        return None
    if any(tensor.dtype != query.dtype or tensor.device != query.device
           for tensor in (key, value)):
        return None

    batch, query_heads, query_length, head_dim = query.shape
    key_batch, kv_heads, key_length, key_dim = key.shape
    value_batch, value_heads, value_length, value_dim = value.shape
    if (min(batch, query_heads, head_dim, kv_heads, key_length, value_dim) <= 0
            or query_length != 1 or batch != key_batch or batch != value_batch
            or head_dim != key_dim or kv_heads != value_heads
            or key_length != value_length or query_heads <= kv_heads
            or query_heads % kv_heads):
        return None

    group_size = query_heads // kv_heads
    mask = attention_mask
    if mask is not None:
        if (not isinstance(mask, torch.Tensor) or mask.is_nested
                or mask.layout != torch.strided or mask.ndim != 4
                or mask.device != query.device
                or mask.dtype not in (torch.bool, torch.float32, query.dtype)
                or mask.shape[0] not in (1, batch)
                or mask.shape[1] not in (1, query_heads)
                or mask.shape[2:] != (1, key_length)):
            return None
        if mask.shape[1] == query_heads:
            mask = mask.reshape(mask.shape[0], kv_heads, group_size, key_length)

    folded_query = query.reshape(batch, kv_heads, group_size, head_dim)
    output = F.scaled_dot_product_attention(
        folded_query, key, value, attn_mask=mask, dropout_p=0.0,
        scale=scale, is_causal=False)
    return output.reshape(batch, query_heads, 1, value_dim).transpose(1, 2).contiguous()

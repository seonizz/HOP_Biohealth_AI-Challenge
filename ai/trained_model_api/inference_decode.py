"""Use Unsloth's existing low-overhead path for single-token GPU decoding."""
from functools import wraps


def install_eager_decode(model, torch, context_factory=None):
    if model.training or any(p.requires_grad or p.device.type != "cuda" for p in model.parameters()):
        raise ValueError("Decode optimization requires a frozen GPU model")
    if getattr(model.forward, "_gpu_eager_decode", False):
        raise ValueError("Decode optimization already installed")
    if context_factory is None:
        from unsloth_zoo.temporary_patches.utils import unsloth_eager_decode
        context_factory = unsloth_eager_decode
    original = model.forward

    @wraps(original)
    def forward(*args, **kwargs):
        ids = kwargs.get("input_ids")
        if ids is None and args:
            ids = args[0]
        if (ids is not None and ids.ndim == 2 and ids.shape[-1] == 1
                and kwargs.get("past_key_values") is not None
                and not torch.is_grad_enabled() and not torch.compiler.is_compiling()):
            with context_factory():
                return original(*args, **kwargs)
        return original(*args, **kwargs)

    forward._gpu_eager_decode = True
    model.forward = forward
    return {"mode": "unsloth_eager_decode", "gpu_only": True}

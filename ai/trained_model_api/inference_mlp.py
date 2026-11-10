"""Remove the training-only tiling wrapper from an already frozen GPU model."""
from functools import wraps
from types import MethodType


def _validated_targets(model):
    if model.training or any(p.requires_grad for p in model.parameters()):
        raise ValueError("MLP restoration requires a frozen inference model")
    if any(p.device.type != "cuda" for p in model.parameters()):
        raise ValueError("Inference parameters must remain on GPUs")
    expected = model.config.get_text_config().num_hidden_layers
    targets = []
    for name, module in model.named_modules():
        if "language_model.layers." not in name or not name.endswith(".mlp"):
            continue
        if (getattr(module.forward, "__name__", "") != "tiled_forward_arctic_size"
                or getattr(module.forward, "__self__", None) is not module):
            raise ValueError("Unexpected MLP forward: " + name)
        # Unsloth replaces forward after Accelerate installs its hooks. A direct
        # bound tiled method can retain inactive hook attributes; an active
        # Accelerate partial/wrapper is rejected by the check above.
        hook = getattr(module, "_hf_hook", None)
        if hook is not None and (getattr(hook, "offload", False)
                                 or getattr(hook, "hooks", ())):
            raise ValueError("Unexpected offload or composite MLP hook: " + name)
        original = getattr(module, "_unsloth_forward", None)
        if not callable(original) or not hasattr(original, "__get__"):
            raise ValueError("Missing saved MLP forward: " + name)
        targets.append((module, original.__get__(module, type(module))))
    if len(targets) != expected:
        raise ValueError(f"Expected {expected} MLPs, found {len(targets)}")
    return targets


def restore_inference_mlp(model):
    """Validate first, then restore the saved MLP forwards without touching weights."""
    targets = _validated_targets(model)
    for module, forward in targets:
        module.forward = forward
    return {"mode": "original_mlp", "restored_layers": len(targets), "gpu_only": True}


def install_decode_mlp(model, torch=None):
    """Bypass tiling only for frozen, no-grad, batch-one/single-token inference.

    Prefill and training retain their original bound forward. The saved original
    sees exactly the same [1, 1, H] input shape as the single-tile implementation.
    Active Accelerate wrappers are rejected; module hooks and weights are kept.
    """
    if torch is None:
        import torch
    targets = _validated_targets(model)
    hidden_width = getattr(model.config.get_text_config(), "hidden_size", None)
    if type(hidden_width) is not int or hidden_width <= 0:
        raise ValueError("Decode MLP requires the model's exact hidden width")
    replacements = []
    for module, original in targets:
        tiled = module.forward
        if getattr(tiled, "_decode_mlp_only", False):
            raise ValueError("Decode MLP optimization already installed")
        parameters = tuple(module.parameters())
        if not parameters:
            raise ValueError("Decode MLP requires its own frozen GPU parameters")

        def make_forward(module, original, tiled, parameters):
            @wraps(tiled)
            def forward(self, x, *args, **kwargs):
                if (not args and not kwargs and not model.training and not self.training
                        and not torch.is_grad_enabled() and torch.is_tensor(x) and x.ndim == 3
                        and x.shape[0] == 1 and x.shape[1] == 1
                        and x.shape[2] == hidden_width
                        and x.device.type == "cuda" and not x.requires_grad
                        and all(not p.requires_grad and p.device.type == "cuda" for p in parameters)):
                    return original(x)
                return tiled(x, *args, **kwargs)

            forward._decode_mlp_only = True
            return MethodType(forward, module)

        replacements.append((module, tiled, make_forward(module, original, tiled, parameters)))
    try:
        for module, _, forward in replacements:
            module.forward = forward
    except BaseException:
        for module, previous, _ in replacements:
            module.forward = previous
        raise
    return {"mode": "decode_only_original_mlp", "patched_layers": len(targets), "gpu_only": True}

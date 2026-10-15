"""Remove the training-only tiling wrapper from an already frozen GPU model."""


def restore_inference_mlp(model):
    """Validate first, then restore the saved MLP forwards without touching weights."""
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
    for module, forward in targets:
        module.forward = forward
    return {"mode": "original_mlp", "restored_layers": len(targets), "gpu_only": True}

"""Experimental, scoped single-tile MLP recompute policy; not production-qualified.

Complete an original training update before entering. Run each row's complete
forward AND backward before starting the next row. A failed scope is fatal to that candidate
run: restoration does not repair an outstanding or partially consumed graph.
No optimizer operation, package patch, checkpoint-buffer mutation, or CUDA stream
change occurs here. GPU loss/gradient/update/memory/timing qualification is still
required in a fresh process before adoption.
"""
from contextlib import contextmanager
import functools
import importlib
import threading
import types

_SCOPE_LOCK = threading.Lock()


def _require(condition, message):
    if not condition:
        raise ValueError(message)


def _checkpoint_matches(layer, gc):
    checkpoint = getattr(layer, "_gradient_checkpointing_func", None)
    while isinstance(checkpoint, functools.partial):
        if (checkpoint.keywords or {}).get("preserve_rng_state", True) is not True:
            return False
        checkpoint = checkpoint.func
    return checkpoint is gc.unsloth_checkpoint


def _ready(gc):
    _require(not gc.in_gradient_checkpoint_recompute(), "Policy boundary cannot occur inside checkpoint recompute")
    _require(gc.FIRST_PASS is False and gc.LAST_GC_INDEX == 60,
             "Complete an original training update before the recompute candidate")
    _require(gc.BACKWARD_PASS is True and gc.CURRENT_GC_INDEX == 0,
             "An earlier checkpoint graph is still outstanding")


def _qualify(model, gc, torch):
    _require(model.training and torch.is_grad_enabled(), "Recompute policy requires training with gradients")
    _ready(gc)
    base = model.get_base_model()
    language = base.model.language_model
    config = base.config.get_text_config()
    _require(config.num_hidden_layers == 60 and len(language.layers) == 60 and config.hidden_size == 5376,
             "Recompute policy requires the qualified 60-layer, width-5376 model")
    _require(config.hidden_size_per_layer_input == 0 and not config.enable_moe_block
             and getattr(config, "num_kv_shared_layers", 0) == 0,
             "Recompute policy does not support PLE, MoE, or shared KV")
    mlps = []
    for layer in language.layers:
        mlp = layer.mlp
        _require(type(layer).__name__ == "Gemma4TextDecoderLayer" and type(mlp).__name__ == "Gemma4TextMLP",
                 "Unsupported decoder or MLP class")
        _require(layer.training and mlp.training and layer.gradient_checkpointing and _checkpoint_matches(layer, gc),
                 "Decoder training/checkpoint contract differs")
        saved = mlp.__dict__.get("forward")
        _require(getattr(saved, "__name__", None) == "tiled_forward_arctic_size"
                 and getattr(saved, "__self__", None) is mlp,
                 "Expected the installed instance-bound arctic tiled forward")
        _require(isinstance(getattr(mlp, "_unsloth_forward", None), types.FunctionType),
                 "Expected an unbound original MLP forward")
        mlps.append((layer, mlp, saved, mlp._unsloth_forward))
    _require(len({id(mlp) for _, mlp, _, _ in mlps}) == 60, "Shared MLP instances are unsupported")
    return mlps


def _dispatch(index, layer, mlp, saved, original, all_pending, progress, report, gc, torch, max_tokens):
    busy = False
    pending = all_pending[index]

    def forward(self, x, *args, **kwargs):
        nonlocal busy
        _require(not busy, "Reentrant MLP policy dispatch is unsupported")
        busy = True
        try:
            if not self.training:
                report["evaluation_calls"] += 1
                return saved(x, *args, **kwargs)
            _require(layer.training and layer.gradient_checkpointing and _checkpoint_matches(layer, gc),
                     "Decoder checkpoint contract changed inside policy scope")
            _require(self._unsloth_forward is original, "Original MLP implementation changed inside policy scope")
            _require(not args and not kwargs and torch.is_tensor(x) and x.ndim == 3
                     and x.shape[0] == 1 and 0 < x.shape[1] <= 32768 and x.shape[2] == 5376,
                     "Training MLP requires one complete width-5376 row")
            signature = (tuple(x.shape), x.dtype)
            if not torch.is_grad_enabled():
                _require(not gc.in_gradient_checkpoint_recompute(), "Unexpected no-grad checkpoint recompute")
                if index == 0:
                    _require(not any(all_pending), "Finish the previous row's backward before starting another row")
                _require(not pending, "Only one pending forward per MLP is supported")
                _require(progress["next_layer"] == index, "Original row forwards must follow all 60 layers in order")
                output = saved(x)
                pending.append(signature)
                progress["next_layer"] += 1
                report["original_forward_calls"] += 1
                return output
            _require(gc.in_gradient_checkpoint_recompute(), "Differentiable MLP call is outside outer checkpoint recompute")
            _require(x.dtype == torch.bfloat16 and x.requires_grad,
                     "Recompute input must be differentiable BF16")
            _require(progress["next_layer"] == 60, "Complete the whole row's forward before backward")
            _require(pending == [signature], "Checkpoint recompute has no matching original forward")
            if x.shape[1] <= max_tokens:
                # Exactly the binding used by installed tiled_forward_arctic_size.
                # B=1 and S<=H preserve its sole tile's GEMM input shape.
                output = original.__get__(self, self.__class__)(x)
                report["bypassed_recompute_calls"] += 1
            else:
                output = saved(x)
                report["long_recompute_calls"] += 1
            pending.clear()
            if not any(all_pending):
                progress["next_layer"] = 0
            return output
        finally:
            busy = False

    return types.MethodType(forward, mlp)


@contextmanager
def single_tile_recompute(model, max_tokens=5376):
    """Yield counters while replacing only eligible checkpoint-recompute calls.

    Only serial row-forward/row-backward scheduling is supported. Nested scopes,
    overlapping rows and scope exit before backward are rejected.
    Existing module pre/post hooks still surround Module.__call__; no hook is
    installed. All exact instance forward values are restored, even on failure.
    """
    _require(type(max_tokens) is int and 0 < max_tokens <= 5376, "Invalid single-tile token limit")
    _require(_SCOPE_LOCK.acquire(blocking=False), "Nested or concurrent recompute policy scope is unsupported")
    installed = []
    report = {"max_tokens": max_tokens, "original_forward_calls": 0, "bypassed_recompute_calls": 0,
              "long_recompute_calls": 0, "evaluation_calls": 0, "restored": False, "completed": False}
    try:
        torch = importlib.import_module("torch")
        gc = importlib.import_module("unsloth_zoo.gradient_checkpointing")
        qualified = _qualify(model, gc, torch)
        all_pending, progress = [[] for _ in qualified], {"next_layer": 0}
        for index, (layer, mlp, saved, original) in enumerate(qualified):
            pending = all_pending[index]
            dispatch = _dispatch(index, layer, mlp, saved, original, all_pending, progress, report, gc, torch, max_tokens)
            installed.append((mlp, saved, dispatch, pending))
            mlp.forward = dispatch
        yield report
        _require(all(mlp.forward is dispatch for mlp, _, dispatch, _ in installed),
                 "An MLP forward changed inside policy scope")
        _require(all(not pending for _, _, _, pending in installed), "Keep policy scope open through every backward")
        _ready(gc)
        report["completed"] = True
    finally:
        for mlp, saved, _, _ in reversed(installed):
            mlp.forward = saved
        report["restored"] = True
        _SCOPE_LOCK.release()

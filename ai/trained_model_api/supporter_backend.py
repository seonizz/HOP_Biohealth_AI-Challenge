"""Inference-only admission for the completed, immutable v11 task checkpoints.

The caller must establish the GPU locks and filesystem/network sandbox before
constructing this backend. This module validates existing cache paths; it never
installs packages, rewrites the environment, or reads pickled training state.
"""

import json
import os
from pathlib import Path
import sys

from backend import ModelBackend, RequestError, file_sha, verify_checkpoint


TOKENIZER_FILES = {
    "tokenizer.json": "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
    "tokenizer_config.json": "239e1a284bd1e75f2d968b11ea148aab984f753fcb437c4deef8c7ee9e5e6a6a",
    "chat_template.jinja": "845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b",
}
RUNTIME_PATHS = (
    "TMPDIR", "TMP", "TEMP", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_STATE_HOME", "XDG_RUNTIME_DIR", "HF_HOME", "HF_HUB_CACHE", "HF_MODULES_CACHE",
    "TORCH_HOME", "TORCH_EXTENSIONS_DIR", "TORCHINDUCTOR_CACHE_DIR", "TRITON_CACHE_DIR",
    "CUDA_CACHE_PATH", "NUMBA_CACHE_DIR", "MPLCONFIGDIR", "IPYTHONDIR", "WANDB_DIR",
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_runtime(runtime):
    """Check the caller's existing isolation without creating or changing paths."""
    runtime = Path(runtime)
    require(runtime.is_absolute() and runtime == runtime.resolve() and runtime.is_dir(),
            "Serving runtime must be an existing canonical directory")
    require(Path.cwd().resolve().is_relative_to(runtime), "Working directory is outside serving runtime")
    for key in RUNTIME_PATHS:
        path = Path(os.environ.get(key, ""))
        require(path.is_absolute() and path == path.resolve() and path.is_dir()
                and path.is_relative_to(runtime), "Unconfined or missing runtime path: " + key)
    for key in ("HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "CUDA_CACHE_DISABLE"):
        require(os.environ.get(key) == "1", "Required isolated runtime setting: " + key)
    for key in ("TRANSFORMERS_CACHE", "HF_DATASETS_CACHE", "TORCH_COMPILE_DEBUG_DIR"):
        if os.environ.get(key):
            path = Path(os.environ[key])
            require(path.is_absolute() and path == path.resolve() and path.is_relative_to(runtime),
                    "Unconfined inherited cache path: " + key)
    require(sys.dont_write_bytecode, "Serving process must disable bytecode writes")
    return runtime


def validate_profile_config(config):
    require(config.get("training_profile") == "supporter-v11", "Explicit supporter-v11 profile required")
    for key in ("task", "entries_path", "base_model_path", "kit_path", "checkpoint_path"):
        require(isinstance(config.get(key), str) and bool(config[key]), "Missing v11 configuration: " + key)
    for key, ceiling in (("max_input_tokens", 4096), ("max_output_tokens", 8192),
                         ("max_context_tokens", 12288)):
        require(type(config.get(key)) is int and 0 < config[key] <= ceiling,
                "Invalid v11 token budget: " + key)
    require(config["max_context_tokens"] >= config["max_input_tokens"] + config["max_output_tokens"],
            "Combined context budget must retain the full input and output reservations")
    for key in ("prefill_chunk_size", "grouped_global_attention", "inference_eager_decode", "inference_mlp_mode"):
        require(not config.get(key), "Unsupported legacy inference override: " + key)


def verify_v11_run(config, manifest, payload, profile, loop, weights):
    """Bind the adapter to the task, complete full-train policy, and exact code."""
    task = config["task"]
    require(task in profile.TASKS, "Unknown supporter task")
    kit = Path(config["kit_path"])
    require(kit.name == task and kit.parent.name == "tasks", "Task directory mismatch")
    directory = kit / "work" / "training"
    run_path = directory / "RUN.json"
    require(run_path.is_file() and run_path == run_path.resolve(), "Invalid run manifest path")
    run = json.loads(run_path.read_text())
    require(loop._sha(run) == manifest.get("run_sha256"), "Checkpoint/run identity mismatch")
    require(run.get("schema_version") == 2 and run.get("output_directory") == str(directory),
            "Not a v11 training run")
    bound = profile.input_bindings(payload, config["base_model_path"])
    require(run.get("bindings") == bound, "Model, data, policy, or training code binding mismatch")
    entries = [e for e in payload["entries"] if e["stream"] == task and e["split"] == "train"]
    plan = weights.make_plan(entries, task=task, bindings=bound, pad_id=0,
                             max_length=4096, accumulation_steps=8, seed=3407, shuffle=True)
    require(run.get("weighted_loss_plan") == plan, "Full task weighted plan mismatch")
    require(run.get("weighted_row_ids") == [e["row_id"] for e in entries], "Task row identity mismatch")
    require(manifest.get("weighted_plan_sha256") == plan["plan_sha256"], "Checkpoint policy mismatch")
    require(run.get("plan") == loop.make_plan([e["encoded"] for e in entries], pad_id=0,
            max_length=4096, accumulation_steps=8, seed=3407, shuffle=True), "Encoded task plan mismatch")
    settings = {"pad_id": 0, "max_length": 4096, "accumulation_steps": 8,
                "seed": 3407, "shuffle": True, "epochs": 1, "microbatch_size": 1,
                "clip_grad_norm": 1.0, "loss_callback_id": profile.LOSS_CALLBACK_ID,
                "required_gradient_devices": ["cuda:0", "cuda:1"]}
    require(run.get("settings") == settings, "Training settings mismatch")
    require(manifest.get("step") == plan["optimizer_windows"]
            and manifest.get("cursor") == len(entries), "Serving requires a completed task epoch")
    return run


def verify_tokenizer_files(model_path):
    for name, expected in TOKENIZER_FILES.items():
        path = Path(model_path) / name
        require(path.is_file() and path == path.resolve() and path.stat().st_nlink == 1
                and file_sha(path) == expected, "Pinned tokenizer file mismatch: " + name)


def serving_generation_config(*, max_new_tokens):
    from counseling_pipeline.gemma4_generation_validation import deterministic_generation_config
    return {**deterministic_generation_config(max_new_tokens=max_new_tokens),
            "disable_compile": True, "cache_implementation": "dynamic"}


class SupporterV11Backend(ModelBackend):
    def __init__(self, config, runtime):
        validate_profile_config(config)
        validate_runtime(runtime)
        self.config = config
        self.manifest = verify_checkpoint(config)
        from counseling_pipeline import supporter_stage1 as profile
        from counseling_pipeline import stage1_training_loop as loop
        from counseling_pipeline import supporter_weighted_loss as weights
        from counseling_pipeline.gemma4_token_validation import _check_template, CONTROL_PATTERN

        payload = profile.validate_inputs(config["entries_path"], config["base_model_path"])
        self.run = verify_v11_run(config, self.manifest, payload, profile, loop, weights)
        verify_tokenizer_files(config["base_model_path"])
        self.model = profile.load_model(config["base_model_path"])
        loop._peft_restore(self.model, Path(config["checkpoint_path"]))
        self.adapter_sha256 = loop._parameter_sha(self.model)
        require(self.adapter_sha256 == self.manifest["adapter_parameters_sha256"],
                "Loaded adapter parameters differ from the pinned checkpoint")
        from transformers import AutoTokenizer
        import torch

        self.tokenizer = AutoTokenizer.from_pretrained(config["base_model_path"],
            local_files_only=True, trust_remote_code=False)
        _check_template(self.tokenizer)
        require(len(self.tokenizer) == 262144 and self.tokenizer.pad_token_id == 0
                and self.tokenizer.bos_token_id == 2 and self.tokenizer.eos_token_id == 1,
                "Pinned tokenizer special tokens changed")
        self.torch = torch
        self.control_pattern = CONTROL_PATTERN
        self.generation_config = serving_generation_config
        self.model.eval()
        self.model.gradient_checkpointing_disable()
        self.model.requires_grad_(False)
        self.model.config.use_cache = True
        self.model.config.get_text_config().use_cache = True
        self.device = self.model.get_input_embeddings().weight.device
        require(all(not p.requires_grad for p in self.model.parameters()), "Inference parameters must be frozen")

    def generate(self, messages, max_tokens, temperature, top_p):
        if type(max_tokens) is not int or not 0 < max_tokens <= self.config["max_output_tokens"]:
            raise RequestError("Output reservation exceeds the v11 serving budget")
        for message in messages:
            content = message["content"]
            if self.control_pattern.search(content) or any(
                token and str(token) in content for token in self.tokenizer.all_special_tokens
            ):
                raise RequestError("Message content contains reserved model control tokens")
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False,
            add_generation_prompt=True, enable_thinking=False)
        ids = self.tokenizer(prompt, add_special_tokens=False, truncation=False)["input_ids"]
        if len(ids) > self.config["max_input_tokens"]:
            raise RequestError("Prompt exceeds the v11 input budget; no text was truncated")
        return super().generate(messages, max_tokens, temperature, top_p)

    def close(self):
        # GPU lock lifetime belongs to the enclosing isolated process.
        self.model = None
        self.torch.cuda.empty_cache()

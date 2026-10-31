"""Load the evaluated LoRA checkpoint without an optimizer or training state."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile


class RequestError(ValueError):
    """A request cannot be served within the configured contract."""


class BackendUnavailableError(RequestError):
    """Inference cannot safely proceed because backend readiness was lost."""


def file_sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_checkpoint(config):
    checkpoint = Path(config["checkpoint_path"])
    kit = Path(config["kit_path"])
    if checkpoint != checkpoint.resolve() or kit != kit.resolve():
        raise ValueError("Model paths must not traverse symlinks")
    if not checkpoint.is_relative_to(kit / "work/training/checkpoints"):
        raise ValueError("Checkpoint is outside the configured training run")
    manifest_path = checkpoint / "CHECKPOINT.json"
    if file_sha(manifest_path) != config["checkpoint_sha256"]:
        raise ValueError("Checkpoint manifest hash mismatch")
    manifest = json.loads(manifest_path.read_text())
    if manifest["step"] != config["checkpoint_step"]:
        raise ValueError("Checkpoint step mismatch")
    # Inference needs only safetensors and adapter configuration. Never unpickle
    # optimizer/RNG state or load a different 'latest' checkpoint implicitly.
    for name in ("adapter_config.json", "adapter_model.safetensors"):
        path = checkpoint / name
        if path != path.resolve() or file_sha(path) != manifest["files"][name]:
            raise ValueError("Adapter file hash mismatch: " + name)
    return manifest


def configure_environment(runtime):
    paths = {
        "XDG_CACHE_HOME": "cache", "HF_HOME": "cache/huggingface",
        "HF_HUB_CACHE": "cache/huggingface/hub", "TORCH_HOME": "cache/torch",
        "TRITON_CACHE_DIR": "cache/triton", "TORCHINDUCTOR_CACHE_DIR": "cache/torchinductor",
        "TORCH_EXTENSIONS_DIR": "cache/torch_extensions", "TMPDIR": "tmp",
        "CUDA_CACHE_PATH": "cache/cuda", "NUMBA_CACHE_DIR": "cache/numba",
        "MPLCONFIGDIR": "cache/matplotlib", "UNSLOTH_COMPILE_LOCATION": "cache/unsloth",
        "HF_DATASETS_CACHE": "cache/datasets", "TORCH_COMPILE_DEBUG_DIR": "cache/compile-debug",
    }
    for key, relative in paths.items():
        path = runtime / relative
        path.mkdir(parents=True, exist_ok=True)
        os.environ[key] = str(path)
    os.environ.update(
        CUDA_VISIBLE_DEVICES="GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c,GPU-a2d3d60c-4eae-7e46-45bc-146e24457642",
        CUDA_DEVICE_ORDER="PCI_BUS_ID", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1",
        HF_HUB_DISABLE_TELEMETRY="1", WANDB_DISABLED="true", UNSLOTH_DISABLE_STATISTICS="1",
        DO_NOT_TRACK="1", TOKENIZERS_PARALLELISM="false", OMP_NUM_THREADS="4",
        UNSLOTH_RETURN_LOGITS="0", PYTHONDONTWRITEBYTECODE="1",
    )
    for key in ("UNSLOTH_CE_LOSS_N_CHUNKS", "UNSLOTH_CE_LOSS_TARGET_GB",
                "UNSLOTH_COMPILE_DISABLE", "UNSLOTH_TILED_MLP"):
        if os.environ.get(key):
            raise ValueError("Unexpected inherited runtime override: " + key)
    sys.dont_write_bytecode = True
    tempfile.tempdir = os.environ["TMPDIR"]
    os.chdir(runtime)


class ModelBackend:
    def __init__(self, config, runtime):
        self.config = config
        self.manifest = verify_checkpoint(config)
        configure_environment(runtime)
        kit = Path(config["kit_path"])
        sys.path.insert(0, str(kit))
        from counseling_pipeline import stage1_preparation as prep
        from counseling_pipeline import stage1_training_loop as loop
        from counseling_pipeline.gemma4_token_validation import _check_template, CONTROL_PATTERN
        from counseling_pipeline.gemma4_generation_validation import deterministic_generation_config

        prep.verify_bundle(kit)
        train_config = prep.load_config(kit)
        prep.verify_environment(kit, train_config)
        self.control_pattern = CONTROL_PATTERN
        self.gpu_locks = prep.gpu_lock(kit / "work")
        try:
            # Reuse the proven model/LoRA architecture and GPU split. This changes
            # only the in-memory serving length, never the training configuration.
            serving_config = {**train_config, "max_length": config["max_context_tokens"]}
            self.model, self.tokenizer = prep.load_model(serving_config)
            _check_template(self.tokenizer)
            loop._peft_restore(self.model, Path(config["checkpoint_path"]))
            self.adapter_sha256 = loop._parameter_sha(self.model)
            if self.adapter_sha256 != self.manifest["adapter_parameters_sha256"]:
                raise ValueError("Loaded adapter parameters differ from the evaluated checkpoint")
            from unsloth import FastModel
            import torch
            self.torch = torch
            self.generation_config = deterministic_generation_config
            self.model.eval()
            FastModel.for_inference(self.model)
            self.model.requires_grad_(False)
            self.model.config.use_cache = True
            if config.get("inference_mlp_mode") == "original":
                from inference_mlp import restore_inference_mlp
                self.inference_mlp = restore_inference_mlp(self.model)
            self.device = self.model.get_input_embeddings().weight.device
            if config.get("inference_eager_decode"):
                from inference_decode import install_eager_decode
                self.inference_decode = install_eager_decode(self.model, torch)
            if config.get("grouped_global_attention"):
                from grouped_attention import install_grouped_attention
                install_grouped_attention()
        except BaseException:
            self.gpu_locks.close()
            raise

    def generate(self, messages, max_tokens, temperature, top_p):
        for message in messages:
            content = message["content"]
            if self.control_pattern.search(content) or any(
                token and str(token) in content for token in self.tokenizer.all_special_tokens
            ):
                raise RequestError("Message content contains reserved model control tokens")
        prompt = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False,
        )
        input_ids = self.tokenizer(prompt, add_special_tokens=False, truncation=False)["input_ids"]
        prompt_tokens = len(input_ids)
        if prompt_tokens + max_tokens > self.config["max_context_tokens"]:
            raise RequestError(
                f"Prompt ({prompt_tokens}) plus max_tokens ({max_tokens}) exceeds "
                f"the {self.config['max_context_tokens']}-token context budget; no text was truncated"
            )
        options = self.generation_config(max_new_tokens=max_tokens)
        options["logits_to_keep"] = 1
        if self.config.get("prefill_chunk_size"):
            # This pinned Unsloth version otherwise overwrites a lone dynamic
            # cache kwarg with static. Copying the config preserves the model
            # default while explicit kwargs select a fresh dynamic cache.
            options.update(prefill_chunk_size=self.config["prefill_chunk_size"],
                           cache_implementation="dynamic",
                           generation_config=deepcopy(self.model.generation_config), disable_compile=True)
        if temperature > 0:
            options.update(do_sample=True, temperature=temperature, top_p=top_p)
        ids = output = None
        out_of_memory = False
        try:
            ids = self.torch.tensor([input_ids], dtype=self.torch.long, device=self.device)
            with self.torch.inference_mode():
                output = self.model.generate(
                    input_ids=ids, attention_mask=self.torch.ones_like(ids), **options,
                )
            suffix = output[0, prompt_tokens:].tolist()
            text = self.tokenizer.decode(suffix, skip_special_tokens=True)
            return {
                "text": text,
                "finish_reason": "stop" if suffix and suffix[-1] in options["eos_token_id"] else "length",
                "prompt_tokens": prompt_tokens, "completion_tokens": len(suffix),
            }
        except self.torch.cuda.OutOfMemoryError:
            out_of_memory = True
        finally:
            ids = output = None
            for module in self.model.modules():
                module.__dict__.pop("_previous_max_cache_length", None)
        if out_of_memory:
            # Leave the CUDA exception scope before releasing unused GPU blocks.
            self.torch.cuda.empty_cache()
            raise RequestError("GPU capacity exceeded; reduce input length or max_tokens")

    def close(self):
        self.gpu_locks.close()

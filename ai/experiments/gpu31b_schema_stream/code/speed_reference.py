"""Bounded final-adapter synthetic generation speed test, launched by bootstrap.

One four-token warmup, then three greedy generations of at most 32 tokens.
Natural EOS remains enabled. Model loading and tokenization are outside timing.
This measures a short model-only prompt, not the application's end-to-end path.
"""
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import statistics
import sys
import time
import uuid


ROOT = Path("/home/slim/choieram")
LEGACY = ROOT / "model_Training/malssi_dualgpu_maxctx_20261009/training_kit"
ORIGINAL = ROOT / "model_Training/cards31b_fresh_lora_20261031_r1/code/train_cards_31b.py"
PLAN = json.loads((Path(__file__).resolve().parent.parent / "plan.json").read_text())
PIN=PLAN['checkpoint']
assert PIN['progress']['step']==5128
assert hashlib.sha256((Path(PIN['checkpoint'])/'CHECKPOINT.json').read_bytes()).hexdigest()==PIN['checkpoint_manifest_sha256']
assert hashlib.sha256((Path(PIN['checkpoint'])/'adapter_model.safetensors').read_bytes()).hexdigest()==PIN['adapter_file_sha256']
SPEC={'path':PIN['checkpoint'],'tensor_digest':PIN['adapter_tensor_digest'],'progress':PIN['progress']}
CHECKPOINT = Path(SPEC["path"])
REFERENCE_SHA = "642ea9905fc6f870007767c163eb427082a91f84c6380bf3c422fec01b84b855"
ADAPTER_SHA = SPEC["tensor_digest"]

PROMPT = "1부터 100까지 숫자를 쉼표로 구분하여 순서대로 출력하세요."


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def real_file(path):
    path = Path(path)
    require(path.is_absolute() and path == path.resolve(strict=True) and path.is_file()
            and not any(p.is_symlink() for p in (path, *path.parents)), "Noncanonical input file")
    return path


def atomic(work, report):
    target = work / "SPEED_RESULT.json"
    require(not target.is_symlink(), "Report cannot be a symlink")
    temporary = work / (".SPEED_RESULT." + uuid.uuid4().hex)
    try:
        with temporary.open("x") as handle:
            json.dump(report, handle, sort_keys=True, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    finally:
        temporary.unlink(missing_ok=True)


def preflight():
    require(sha(real_file(ORIGINAL)) == REFERENCE_SHA, "Immutable original runner changed")
    spec = importlib.util.spec_from_file_location("_speed_original_reference", ORIGINAL)
    reference = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(reference)
    manifest_path = real_file(CHECKPOINT / "CHECKPOINT.json")
    manifest_sha = sha(manifest_path)
    manifest = json.loads(manifest_path.read_text())
    binding = manifest["binding"]
    reference.verify_checkpoint(CHECKPOINT, binding)
    require(manifest["adapter_sha256"] == ADAPTER_SHA, "Unexpected final adapter digest")
    progress = manifest["progress"]
    require(progress == SPEC["progress"], "Unexpected final checkpoint progress")
    for name, digest in binding["code_sha256"].items():
        require(sha(real_file(name)) == digest, "Original bound source changed: " + name)
    require(binding["code_sha256"].get(str(ORIGINAL)) == REFERENCE_SHA,
            "Checkpoint does not bind the immutable reference")
    config = json.loads(real_file(LEGACY / "config/train.json").read_text())
    config.update(max_length=32768, model_path=binding["loader_config"]["model_path"])
    require(config == binding["loader_config"], "Original loader config changed")
    versions = {name: importlib.metadata.version(name) for name in config["versions"]}
    require(versions == config["versions"] == binding["versions"], "Pinned environment changed")
    require(Path(sys.prefix) == Path(config["python_path"]).parent.parent, "Pinned venv required")
    model_path = Path(config["model_path"])
    for name, expected in binding["model_files"].items():
        require(not Path(name).is_absolute() and ".." not in Path(name).parts, "Unsafe model path")
        path = real_file(model_path / name)
        require(path.stat().st_size == expected["bytes"] and sha(path) == expected["sha256"],
                "Base model fingerprint changed: " + name)
    fused = Path(sys.prefix) / "lib/python3.12/site-packages/unsloth_zoo/fused_losses/cross_entropy_loss.py"
    loader = real_file(LEGACY / "counseling_pipeline/stage1_preparation.py")
    require(binding["code_sha256"].get(str(loader)) == sha(loader), "Loader not bound to checkpoint")
    require(sha(real_file(fused)) == config["fused_loss_source_sha256"], "Fused CE source changed")
    return reference, config, binding, manifest_sha


class FirstTokenTimer:
    """HF generate sends the full prompt first, then one greedy token per put."""
    def __init__(self, prompt_tokens, synchronize, clock=time.perf_counter):
        self.prompt_tokens = prompt_tokens
        self.synchronize = synchronize
        self.clock = clock
        self.prompt_seen = False
        self.first_token_at = None
        self.generated_tokens = 0
        self.ended = False

    def put(self, value):
        count = value.numel()
        if not self.prompt_seen:
            require(value.ndim == 2 and value.shape[0] == 1 and count == self.prompt_tokens,
                    "Streamer initial event must be the complete batch-one prompt")
            self.prompt_seen = True
            return
        require(count == 1, "TTFT requires individual greedy token events")
        if self.first_token_at is None:
            self.synchronize()
            self.first_token_at = self.clock()
        self.generated_tokens += count

    def end(self):
        self.ended = True


def sequence_sha(ids):
    return hashlib.sha256(json.dumps(ids, separators=(",", ":")).encode()).hexdigest()


def measure(model, inputs, limit, torch, label):
    def synchronize():
        for device in range(2):
            torch.cuda.synchronize(device)

    count = inputs["input_ids"].shape[1]
    streamer = FirstTokenTimer(count, synchronize)
    synchronize()
    for device in range(2):
        torch.cuda.reset_peak_memory_stats(device)
    start = time.perf_counter()
    with torch.inference_mode():
        output = model.generate(**inputs, max_new_tokens=limit, do_sample=False, num_beams=1,
                                use_cache=True, streamer=streamer, return_dict_in_generate=False,
                                output_scores=False)
    synchronize()
    end = time.perf_counter()
    require(output.ndim == 2 and output.shape[0] == 1, "Unexpected generation shape")
    tokens = output[0, count:].tolist()
    require(0 < len(tokens) <= limit and streamer.generated_tokens == len(tokens)
            and streamer.first_token_at is not None and streamer.ended, "Incomplete token timing evidence")
    elapsed, first = end - start, streamer.first_token_at - start
    require(0 <= first <= elapsed, "Invalid synchronized timestamps")
    decode = elapsed - first
    return {"label": label, "input_tokens": count, "requested_new_tokens": limit,
            "actual_new_tokens": len(tokens), "ended_before_limit": len(tokens) < limit,
            "ttft_seconds": first, "end_to_end_seconds": elapsed, "decode_seconds": decode,
            "decode_seconds_per_token_after_first": decode / (len(tokens) - 1) if len(tokens) > 1 else None,
            "decode_tokens_per_second": (len(tokens) - 1) / decode if len(tokens) > 1 and decode > 0 else None,
            "output_tokens_per_second": len(tokens) / elapsed,
            "output_ids_sha256": sequence_sha(tokens),
            "peak_allocated_bytes": [torch.cuda.max_memory_allocated(i) for i in range(2)],
            "peak_reserved_bytes": [torch.cuda.max_memory_reserved(i) for i in range(2)]}


def adapter_sha_by_names(model, names):
    digest = hashlib.sha256()
    actual = dict(model.named_parameters())
    for name in names:
        digest.update(name.encode())
        digest.update(actual[name].detach().float().cpu().contiguous().numpy().tobytes())
    return digest.hexdigest()


def parameter_metadata(model):
    return {name: (p.data_ptr(), p._version, tuple(p.shape), str(p.dtype))
            for name, p in model.named_parameters()}


def run(work, report):
    def stage(name, **fields):
        report.update(stage=name, **fields)
        atomic(work, report)

    stage("preflight")
    reference, config, binding, manifest_sha = preflight()
    stage("loading_model", checkpoint=str(CHECKPOINT), checkpoint_manifest_sha256=manifest_sha,
          reference_sha256=REFERENCE_SHA, loader_config=config, versions=binding["versions"])
    sys.path.insert(0, str(LEGACY))
    from counseling_pipeline.stage1_preparation import load_model
    model, tokenizer = load_model(config)
    import torch
    from unsloth import FastModel
    from peft.utils.save_and_load import load_peft_weights, set_peft_model_state_dict
    set_peft_model_state_dict(model, load_peft_weights(str(CHECKPOINT), device="cpu"), adapter_name="default")
    names = [name for name, p in model.named_parameters() if p.requires_grad]
    require(sum(p.numel() for p in reference.parameters(model)) == 61214720, "Unexpected adapter size")
    require(reference.parameter_sha(model) == ADAPTER_SHA, "Loaded final adapter hash differs")
    before = parameter_metadata(model)
    FastModel.for_inference(model)
    model.eval()
    require(torch.cuda.device_count() == 2 and not torch.distributed.is_initialized(), "Expected local two-GPU model")
    ids = tokenizer.apply_chat_template([{"role": "user", "content": PROMPT}], tokenize=True,
                                        add_generation_prompt=True, enable_thinking=False)
    require(isinstance(ids, list) and ids and all(type(v) is int for v in ids), "Expected unpadded prompt IDs")
    device = model.get_input_embeddings().weight.device
    inputs = {"input_ids": torch.tensor([ids], dtype=torch.long, device=device),
              "attention_mask": torch.ones((1, len(ids)), dtype=torch.long, device=device)}
    stage("warmup", adapter_sha256=ADAPTER_SHA, input_ids_sha256=sequence_sha(ids), input_tokens=len(ids),
          gpu_uuids=[str(torch.cuda.get_device_properties(i).uuid) for i in range(2)],
          device_names=[torch.cuda.get_device_name(i) for i in range(2)])
    report["warmup"] = measure(model, inputs, 4, torch, "warmup")
    for index in range(3):
        stage("measuring_" + str(index + 1))
        report["runs"].append(measure(model, inputs, 32, torch, "run_" + str(index + 1)))
    stage("verifying_unchanged")
    require(parameter_metadata(model) == before, "Generation changed model parameter metadata")
    require(adapter_sha_by_names(model, names) == ADAPTER_SHA, "Generation changed adapter bytes")
    require(sha(real_file(CHECKPOINT / "CHECKPOINT.json")) == manifest_sha, "Training manifest changed")
    reference.verify_checkpoint(CHECKPOINT, binding)
    for name, digest in binding["code_sha256"].items():
        require(sha(real_file(name)) == digest, "Original training code changed during speed test")
    metrics = ("ttft_seconds", "end_to_end_seconds", "decode_seconds_per_token_after_first",
               "decode_tokens_per_second", "output_tokens_per_second")
    summary = {key: {"min": min(values), "median": statistics.median(values), "max": max(values)}
               for key in metrics if (values := [r[key] for r in report["runs"] if r[key] is not None])}
    stage("completed", status="passed", summary=summary, adapter_unchanged=True,
          checkpoint_files_unchanged=True, original_training_code_unchanged=True,
          output_ids_identical=len({r["output_ids_sha256"] for r in report["runs"]}) == 1)


def main():
    work = Path.cwd()
    require(work == work.resolve() and work.is_dir(), "Bootstrap must select canonical work directory")
    require(not (work / "SPEED_RESULT.json").exists(), "Use a fresh speed work directory")
    report = {"schema": "cards31b-final-adapter-speed-v1", "status": "running", "pid": os.getpid(),
              "started_at": time.time(), "runs": [], "prompt": PROMPT,
              "scope": "short synthetic model-only generation; not app end-to-end latency",
              "method": {"warmup_runs": 1, "warmup_max_new_tokens": 4, "timed_runs": 3,
                         "max_new_tokens": 32, "do_sample": False, "enable_thinking": False,
                         "natural_eos": True, "loading_and_tokenization_excluded": True,
                         "ttft": "first generated streamer token, both GPUs synchronized",
                         "decode": "end-to-end minus TTFT; divided by actual new tokens minus one"}}
    try:
        run(work, report)
    except BaseException as error:
        report.update(status="failed", error_type=type(error).__name__, error=str(error))
        raise
    finally:
        report["finished_at"] = time.time()
        atomic(work, report)


if __name__ == "__main__":
    main()

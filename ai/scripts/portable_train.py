#!/usr/bin/env python3
"""Offline reference trainer for the packaged Gemma4-31B NF4 token entries.

No retokenization, truncation, packing, downloads, resume, or server access.
Only --validate-only has been tested on CPU; a new CUDA environment must run
its own memory/compatibility checks before relying on this reference trainer.
"""
from __future__ import annotations

import argparse
from fractions import Fraction
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import random

TASKS = ("conversation", "sentence", "word", "state_observations",
         "relationship_memory", "relationship_agent_wire")
TOKENIZER_FILES = {
    "tokenizer.json": "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
    "tokenizer_config.json": "239e1a284bd1e75f2d968b11ea148aab984f753fcb437c4deef8c7ee9e5e6a6a",
    "chat_template.jinja": "845f1ee48e39fc942fe190da9df6a1c5db229e17a96ea08966ad1c9274e73d1b",
}
MODEL_FILES = {
    "config.json": "7c1b15e76038d3234812c093638bac540c498beb6331feaeebb59ce160302d25",
    "model.safetensors.index.json": "ea2421fd03e346456c12b324eab5fcb37f095a4b2a1aa8456ac0b0b7d6127d1d",
}
REFERENCE_VERSIONS = {"torch": "2.13.0", "transformers": "5.17.0",
                      "peft": "0.21.2", "bitsandbytes": "0.50.2"}
TARGET_MODULES = (
    r'(?:.*?(?:language|text).*?(?:self_attn|attention|attn|mixer|mlp|feed_forward|ffn|dense|mixer).*?\.(?:linear|q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj))|'
    r'(?:\bmodel\.layers\.[\d]{1,}(?!.*\.experts\.\d)\..*?(?:self_attn|attention|attn|mixer|mlp|feed_forward|ffn|dense|mixer).*?\.(?:(?:linear|q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)))'
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha_file(path):
    h = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def weight(entry):
    value = entry["weight"]
    require(isinstance(value, dict) and set(value) == {"numerator", "denominator"}, "Invalid weight")
    n, d = value["numerator"], value["denominator"]
    require(type(n) is int and type(d) is int and n > 0 and d > 0 and math.gcd(n, d) == 1,
            "Weight must be a positive reduced fraction")
    return Fraction(n, d)


def checked_row(row, max_length):
    ids, labels = row.get("input_ids"), row.get("labels")
    prefix, target = row.get("prefix_length"), row.get("target_length")
    require(isinstance(ids, list) and all(type(i) is int and 0 <= i < 262144 for i in ids), "Invalid token IDs")
    require(type(prefix) is int and 0 < prefix <= 61440 and prefix < len(ids), "Invalid prefix length")
    require(type(target) is int and target == len(ids) - prefix and 0 < target <= 8192, "Invalid target length")
    require(type(row.get("sequence_length")) is int and row["sequence_length"] == len(ids) <= max_length,
            "Sequence exceeds limit or length changed; truncation is forbidden")
    require(isinstance(labels, list) and all(type(i) is int for i in labels)
            and labels == [-100] * prefix + ids[prefix:], "Target mask changed or shifted")
    mask = row.get("attention_mask")
    require(isinstance(mask, list) and all(type(i) is int for i in mask) and mask == [1] * len(ids),
            "Expected full unpadded attention mask")


def read_entries(path, task, max_length):
    require(task in TASKS, "Unsupported task")
    require(type(max_length) is int and 0 < max_length <= 69632, "Invalid maximum length")
    splits, seen, families = {"train": [], "validation": []}, {}, {}
    with Path(path).open(encoding="utf-8") as stream:
        for number, line in enumerate(stream, 1):
            try:
                entry = json.loads(line)
                require(isinstance(entry, dict) and entry.get("stream") in TASKS, "Unknown task")
                require(entry.get("split") in splits, "Only train and validation entries are allowed")
                if entry["stream"] != task:
                    continue
                identity, split = entry.get("row_id"), entry["split"]
                require(isinstance(identity, str) and identity.strip() and identity not in seen, "Missing/duplicate row ID")
                seen[identity] = split
                checked_row(entry["encoded"], max_length)
                weight(entry)
                family = entry.get("family_id")
                if family is not None:
                    require(isinstance(family, str) and family.strip(), "Invalid family ID")
                    require(families.get(family, split) == split, "Family overlaps train/validation")
                    families[family] = split
                splits[split].append(entry)
            except (ValueError, KeyError, TypeError, AttributeError) as exc:
                raise ValueError(f"Invalid entry at line {number}: {exc}") from exc
    for split, rows in splits.items():
        require(rows, f"Missing {split} rows for selected task")
        require(sum((weight(e) * e["encoded"]["target_length"] for e in rows), Fraction())
                == sum(e["encoded"]["target_length"] for e in rows), f"{split} weighted token mass changed")
    return splits


def make_plan(entries, accumulation, seed):
    require(type(accumulation) is int and accumulation > 0, "Invalid accumulation")
    require(entries and all(e["split"] == "train" for e in entries), "Backward plan requires train rows only")
    order = list(range(len(entries)))
    random.Random(seed).shuffle(order)
    windows = [order[i:i + accumulation] for i in range(0, len(order), accumulation)]
    masses = [weight(e) * e["encoded"]["target_length"] for e in entries]
    z = sum(masses, Fraction())
    coefficients = [len(windows) * mass / z for mass in masses]
    require(all(math.isfinite(float(c)) and float(c) > 0 for c in coefficients), "Invalid coefficient")
    return windows, coefficients


def check_assets(directory, expected):
    root = Path(directory).resolve(strict=True)
    require(root.is_dir(), "Expected local asset directory")
    for name, digest in expected.items():
        path = root / name
        require(path.is_file() and sha_file(path) == digest, f"Asset hash mismatch: {name}")
    return root


def validate_args(args):
    require(args.epochs > 0 and args.accumulation > 0 and args.rank > 0, "Positive epochs/accumulation/rank required")
    require(math.isfinite(args.lr) and 0 < args.lr <= 2e-5, "Learning rate must be in (0, 2e-5]")
    require(0 < args.max_length <= 69632, "Maximum length must be in [1, 69632]")
    tokenizer = check_assets(args.tokenizer, TOKENIZER_FILES)
    if args.model:
        model = check_assets(args.model, {**TOKENIZER_FILES, **MODEL_FILES})
        index = json.loads((model / "model.safetensors.index.json").read_text())
        for name in set(index["weight_map"].values()):
            require(Path(name).name == name and (model / name).is_file(), "Missing local model shard")
    if args.initial_adapter:
        adapter = Path(args.initial_adapter).resolve(strict=True)
        config = json.loads((adapter / "adapter_config.json").read_text())
        require(config.get("peft_type") == "LORA" and config.get("r") == args.rank,
                "Initial adapter type/rank differs")
        require((adapter / "adapter_model.safetensors").is_file(), "Missing local adapter safetensors")
    if not args.validate_only:
        require(args.model and args.output, "Training requires --model and a fresh --output directory")
    if args.output:
        output = Path(args.output).resolve()
        require(not output.exists(), "Output already exists; resume/overwrite is not supported")
        for source in [tokenizer, Path(args.entries).resolve(),
                       *([Path(args.model).resolve()] if args.model else []),
                       *([Path(args.initial_adapter).resolve()] if args.initial_adapter else [])]:
            require(source not in output.parents and output not in source.parents and output != source,
                    "Output overlaps an input location")


def selected_loss(model, encoded):
    """Full-context forward with only causal target-tail logits materialized."""
    import torch
    device = model.get_input_embeddings().weight.device
    ids = torch.tensor([encoded["input_ids"]], dtype=torch.long, device=device)
    mask = torch.tensor([encoded["attention_mask"]], dtype=torch.long, device=device)
    positions = [i for i, label in enumerate(encoded["labels"][1:]) if label != -100]
    first = min(positions)
    keep = encoded["sequence_length"] - first
    tail = model(input_ids=ids, attention_mask=mask, logits_to_keep=keep, use_cache=False).logits
    require(tuple(tail.shape) == (1, keep, 262144), "Unexpected target-tail logits shape")
    indices = torch.tensor([i - first for i in positions], device=tail.device)
    logits = tail.index_select(1, indices)
    targets = torch.tensor([encoded["labels"][i + 1] for i in positions], device=tail.device)
    return torch.nn.functional.cross_entropy(logits[0].float(), targets, reduction="mean")


def validation_loss(model, entries):
    import torch
    require(entries and all(e["split"] == "validation" for e in entries), "Validation requires validation rows")
    model.eval()
    weighted_total, mass, raw_total, raw_tokens = 0.0, Fraction(), 0.0, 0
    with torch.no_grad():
        for entry in entries:
            value = float(selected_loss(model, entry["encoded"]).item())
            require(math.isfinite(value), "Nonfinite validation loss")
            tokens = entry["encoded"]["target_length"]
            n = weight(entry) * tokens
            weighted_total += float(n) * value
            mass += n
            raw_total += tokens * value
            raw_tokens += tokens
    return {"primary_unweighted_target_token_mean_loss": raw_total / raw_tokens,
            "auxiliary_weighted_target_token_mean_loss": weighted_total / float(mass)}


def train(args, splits, report):
    # Set offline flags before importing any model library. Existing caches are
    # never a substitute for the explicitly supplied, verified local assets.
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
    for package, version in REFERENCE_VERSIONS.items():
        require(importlib.metadata.version(package).split("+")[0] == version, f"Expected {package} {version}")
    import torch
    from transformers import Gemma4ForConditionalGeneration
    from peft import LoraConfig, PeftModel, get_peft_model, prepare_model_for_kbit_training
    require(torch.cuda.is_available(), "CUDA is required; CPU/MPS training is not supported")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.cuda.manual_seed_all(args.seed)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    model = Gemma4ForConditionalGeneration.from_pretrained(
        args.model, local_files_only=True, trust_remote_code=False, dtype=torch.bfloat16,
        attn_implementation="sdpa", device_map=args.device_map)
    require(getattr(model, "is_loaded_in_4bit", False), "Expected the pinned serialized NF4 base")
    require(all(p.device.type == "cuda" for p in model.parameters()), "CPU/disk offload is unsupported")
    model.config.use_cache = False
    model.config.get_text_config().use_cache = False
    model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False}, auto_clear_cache=False)
    if args.initial_adapter:
        model = PeftModel.from_pretrained(model, args.initial_adapter, is_trainable=True, local_files_only=True)
    else:
        model = get_peft_model(model, LoraConfig(r=args.rank, lora_alpha=args.rank,
            lora_dropout=0.0, bias="none", target_modules=TARGET_MODULES, task_type="CAUSAL_LM"))
    parameters = [p for p in model.parameters() if p.requires_grad]
    require(parameters and all("lora_" in n for n, p in model.named_parameters() if p.requires_grad),
            "Only LoRA parameters may be trained")
    optimizer = torch.optim.AdamW(parameters, lr=args.lr, weight_decay=0.01, foreach=False)
    report["baseline_validation"] = validation_loss(model, splits["validation"])
    report["epochs"] = []
    for epoch in range(args.epochs):
        windows, coefficients = make_plan(splits["train"], args.accumulation, args.seed + epoch)
        model.train()
        for window in windows:
            optimizer.zero_grad(set_to_none=True)
            for index in window:
                loss = selected_loss(model, splits["train"][index]["encoded"])
                require(bool(torch.isfinite(loss).item()), "Nonfinite training loss")
                # Fixed full-epoch normalization; do not divide by window size.
                (loss * float(coefficients[index])).backward()
            require(all(p.grad is not None and bool(torch.isfinite(p.grad).all().item()) for p in parameters),
                    "Missing or nonfinite adapter gradient")
            norm = torch.nn.utils.clip_grad_norm_(parameters, 1.0)
            require(bool(torch.isfinite(norm).item()), "Nonfinite gradient norm")
            optimizer.step()
        optimizer.zero_grad(set_to_none=True)
        model.save_pretrained(output / f"epoch-{epoch + 1:03d}", safe_serialization=True)
        result = {"epoch": epoch + 1, "optimizer_steps": len(windows),
                  "validation": validation_loss(model, splits["validation"])}
        require(all(p.grad is None for p in parameters), "Validation left gradients")
        report["epochs"].append(result)
        (output / "training-report.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps(result), flush=True)
    require(sha_file(args.entries) == report["entries_sha256"], "Input changed during training")
    check_assets(args.tokenizer, TOKENIZER_FILES)
    check_assets(args.model, {**TOKENIZER_FILES, **MODEL_FILES})
    report["status"] = "completed"
    (output / "training-report.json").write_text(json.dumps(report, indent=2) + "\n")


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--entries", required=True, help="Packaged JSONL token entries")
    p.add_argument("--task", required=True, choices=TASKS)
    p.add_argument("--tokenizer", required=True, help="Directory of the three pinned assets")
    p.add_argument("--model", help="Local original Gemma4-31B serialized NF4 directory")
    p.add_argument("--output", help="New directory for LoRA adapters and reports only")
    p.add_argument("--initial-adapter", help="Optional local LoRA directory; no optimizer resume")
    p.add_argument("--device-map", choices=("auto", "cuda:0"), default="auto")
    p.add_argument("--epochs", type=int, required=True)
    p.add_argument("--seed", type=int, required=True)
    p.add_argument("--accumulation", "--accumulation-steps", type=int, required=True)
    p.add_argument("--rank", type=int, required=True)
    p.add_argument("--lr", "--learning-rate", type=float, required=True)
    p.add_argument("--max-length", type=int, required=True)
    p.add_argument("--validate-only", action="store_true")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    validate_args(args)
    splits = read_entries(args.entries, args.task, args.max_length)
    windows, coefficients = make_plan(splits["train"], args.accumulation, args.seed)
    report = {"status": "validated_only" if args.validate_only else "training",
              "entries_sha256": sha_file(args.entries), "task": args.task,
              "rows": {s: len(rows) for s, rows in splits.items()},
              "optimizer_windows_per_epoch": len(windows),
              "normalization": "K*w*n/Z (no accumulation-window divisor)",
              "settings": vars(args), "reference_versions": REFERENCE_VERSIONS,
              "initialization": "local_adapter" if args.initial_adapter else "new_lora",
              "behavioral_quality_verified": False}
    if args.validate_only:
        print(json.dumps(report, indent=2))
    else:
        train(args, splits, report)
    return report


if __name__ == "__main__":
    main()

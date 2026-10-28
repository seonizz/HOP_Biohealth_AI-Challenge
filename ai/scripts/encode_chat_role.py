#!/usr/bin/env python3
"""Encode the Gemma 4 12B chat course on CPU with its pinned official template."""
from array import array
import argparse
from collections import deque
from concurrent.futures import ProcessPoolExecutor
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import sys

import role_dataset as dataset

PINS = {
    "tokenizer.json": "cc8d3a0ce36466ccc1278bf987df5f71db1719b9ca6b4118264f45cb627bfe0f",
    "tokenizer_config.json": "a62f4e85a47c0c136edaaa3a4f591fd6783717299a9def47e5ad03a49f6a5eb9",
    "chat_template.jinja": "ae53464bf3be25802b3a5b37def7fd89667067d7577049b3b2d74c4d8de4c6d4",
}
REVISION = "707f0a3b8a3c7ad586ed01e27eafbad8a27dd0f7"


def initialize(path):
    os.environ["TOKENIZERS_PARALLELISM"] = "false"
    from tokenizers import Tokenizer
    from jinja2.sandbox import ImmutableSandboxedEnvironment
    global tokenizer, template, special
    path = Path(path)
    for name, expected in PINS.items():
        dataset.require(dataset.file_hash(path / name) == expected, "Unrecognized 12B tokenizer artifact")
    tokenizer = Tokenizer.from_file(str(path / "tokenizer.json"))
    tokenizer.no_truncation()
    tokenizer.no_padding()
    env = ImmutableSandboxedEnvironment()
    def reject(message):
        raise ValueError(message)
    env.globals["raise_exception"] = reject
    template = env.from_string((path / "chat_template.jinja").read_text())
    raw = json.loads((path / "tokenizer.json").read_text())
    special = {item["content"] for item in raw["added_tokens"] if item["special"]}


def encode_batch(rows):
    result = []
    for row in rows:
        dataset.check_row(row)
        messages = row["messages"]
        dataset.require(not any(s in m["content"] for s in special for m in messages), "Control token in source")
        options = {"bos_token": "<bos>", "enable_thinking": False}
        prefix = template.render(messages=messages[:-1], add_generation_prompt=True, **options)
        native = template.render(messages=messages, add_generation_prompt=False, **options)
        base = template.render(messages=messages[:-1], add_generation_prompt=False, **options)
        header = base + "<|turn>model\n"
        completion = messages[-1]["content"].strip() + "<turn|>\n"
        dataset.require(prefix == header + "<|channel>thought\n<channel|>" and native == header + completion,
                        "Unsupported 12B text template boundary")
        full = prefix + completion
        tokens = tokenizer.encode(full, add_special_tokens=False).ids
        prefix_tokens = tokenizer.encode(prefix, add_special_tokens=False).ids
        boundary = len(prefix_tokens)
        dataset.require(0 < boundary < len(tokens) <= 32768 and tokens[:boundary] == prefix_tokens,
                        "Sequence over 32768 or unstable completion boundary; never truncate")
        dataset.require(tokenizer.decode(tokens, skip_special_tokens=False) == full
                        and tokenizer.decode(tokens[boundary:], skip_special_tokens=False) == completion,
                        "Token/text roundtrip failed")
        metadata = {k: row[k] for k in ("row_id", "task", "split", "weight", "source_group_ids", "source_root_ids", "target_sha256")}
        metadata.update(messages_sha256=dataset.digest(dataset.canonical(messages)),
                        prefix_length=boundary, sequence_length=len(tokens), target_length=len(tokens) - boundary,
                        target_boundary_whitespace_trimmed=messages[-1]["content"] != messages[-1]["content"].strip())
        result.append((metadata, tokens))
    return result


def ordered(pool, rows):
    pending, batch = deque(), []
    for row in rows:
        batch.append(row)
        if len(batch) == 16:
            pending.append(pool.submit(encode_batch, batch))
            batch = []
            if len(pending) >= 8:
                yield from pending.popleft().result()
    if batch:
        pending.append(pool.submit(encode_batch, batch))
    while pending:
        yield from pending.popleft().result()


def encode(root, tokenizer_path, workers=4):
    root, tokenizer_path = root.resolve(strict=True), tokenizer_path.resolve(strict=True)
    dataset.verify_bundle(root)
    role = root / "chat_12b"
    course_path = role / "COURSE.json"
    course = json.loads(course_path.read_text())
    dataset.require(not (role / "encoded").exists(), "Already encoded; use a new bundle")
    stats = {}
    with ProcessPoolExecutor(max_workers=workers, initializer=initialize, initargs=(str(tokenizer_path),),
                             mp_context=multiprocessing.get_context("spawn")) as pool:
        for phase in course["phases"]:
            for split in dataset.SPLITS:
                part = phase["data"][split]
                folder = role / "encoded" / phase["id"]
                folder.mkdir(parents=True, exist_ok=True)
                index_path, token_path = folder / (split + ".index.jsonl"), folder / (split + ".tokens.bin")
                count, offset, targets, maximum = 0, 0, 0, 0
                with index_path.open("x", encoding="utf-8") as index, token_path.open("xb") as binary:
                    for metadata, tokens in ordered(pool, dataset.read_rows(role / part["path"])):
                        data = array("I", tokens)
                        dataset.require(data.itemsize == 4, "uint32 unsupported")
                        if sys.byteorder != "little":
                            data.byteswap()
                        binary.write(data.tobytes())
                        metadata["offset_tokens"] = offset
                        index.write(dataset.canonical(metadata) + "\n")
                        count += 1
                        offset += metadata["sequence_length"]
                        targets += metadata["target_length"]
                        maximum = max(maximum, metadata["sequence_length"])
                part.update(token_index=str(index_path.relative_to(role)), token_binary=str(token_path.relative_to(role)))
                stats[phase["id"] + "/" + split] = {"rows": count, "sequence_tokens": offset,
                    "target_tokens": targets, "max_sequence_length": maximum}
                print(json.dumps({"completed": phase["id"] + "/" + split, **stats[phase["id"] + "/" + split]}), flush=True)
    course["model"].update(identity="google/gemma-4-12B-it", revision=REVISION,
                           tokenization="fresh_official_gemma4_12b_nonthinking", tokenizer_sha256=PINS,
                           max_encoded_sequence_length=32768)
    course["token_storage"] = "little_endian_uint32_contiguous_no_padding"
    course["label_rule"] = "[-100] * prefix_length + input_ids[prefix_length:]; no pre-shift"
    for name in PINS:
        (role / "tokenizer").mkdir(exist_ok=True)
        shutil.copyfile(tokenizer_path / name, role / "tokenizer" / name)
    dataset.save(course_path, course)
    dataset.save(role / "TOKENIZATION.json", {"partitions": stats, "model": "google/gemma-4-12B-it", "revision": REVISION,
        "tokenizer_sha256": PINS, "all_rows_roundtripped": True, "no_truncation": True,
        "last_assistant_only": True, "model_loaded": False, "gpu_used": False})
    gaps = json.loads((root / "COVERAGE_GAPS.json").read_text())
    gaps["chat_12b"] = [g for g in gaps["chat_12b"] if not g.startswith("Exact model tokenizer pending")]
    dataset.save(root / "COVERAGE_GAPS.json", gaps)
    shutil.copyfile(Path(__file__), root / "scripts/encode_chat_role.py")
    shutil.copyfile(Path(dataset.__file__), root / "scripts/role_dataset.py")
    dataset.refresh_manifest(root)
    report = dataset.verify_bundle(root)
    dataset.save(root / "VERIFICATION.json", report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--tokenizer", type=Path, required=True)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    print(json.dumps(encode(args.root, args.tokenizer, args.workers), ensure_ascii=False))

"""Offline native-token role evaluation. All writes are confined to ROOT/work.

No training, optimizer, remote calls, prompt reformatting, or target leakage into
generation. Heavy GPU dependencies are imported only inside run().
"""
import argparse
import contextlib
import hashlib
import inspect
import json
import math
import mmap
import os
from pathlib import Path
import signal
import struct
import threading
import time
import traceback

CE_COMPUTE_PROFILE = {"name": "adaptive_gpu_head_v1", "gpu_max_sequence": 12288,
                      "gpu_mlp_chunk": 512, "cpu_mlp_chunk": 512,
                      "no_offload_max_sequence": 8192, "direct_mlp_max_sequence": 12288}


def digest(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def object_hash(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def token_hash(tokens):
    return hashlib.sha256(struct.pack(f"<{len(tokens)}I", *tokens)).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp")
    with temp.open("w") as handle:
        handle.write(canonical(value) + "\n")
        handle.flush()
        os.fsync(handle.fileno())
    temp.replace(path)


def append(path, value):
    with Path(path).open("a") as handle:
        handle.write(canonical(value) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def confined(root, relative):
    root = Path(root).resolve()
    path = (root / relative).resolve()
    if not path.is_relative_to(root):
        raise ValueError("dataset path escaped root")
    return path


class NativeTokenRows:
    """Read-only encoded rows; validates the complete index/binary before use."""
    def __init__(self, root, part):
        self.root = Path(root)
        manifest = json.loads((self.root / "MANIFEST.json").read_text())["files"]
        self.binding = {}
        for key in ("token_index", "token_binary"):
            name = part[key]
            path = confined(self.root, name)
            actual = digest(path)
            if actual != manifest[name]["sha256"]:
                raise ValueError("token file manifest hash mismatch")
            self.binding[str(path)] = actual
        self.entries = [json.loads(line) for line in confined(self.root, part["token_index"]).read_text().splitlines() if line]
        self.file = confined(self.root, part["token_binary"]).open("rb")
        self.buffer = mmap.mmap(self.file.fileno(), 0, access=mmap.ACCESS_READ)
        offset = 0
        for row in self.entries:
            n, prefix = row["sequence_length"], row["prefix_length"]
            if not (type(n) is int and type(prefix) is int and 0 < prefix < n
                    and row["target_length"] == n - prefix and row["offset_tokens"] == offset
                    and row["split"] == "validation"):
                self.close()
                raise ValueError("invalid native row boundary/split")
            weight = row["weight"]
            if weight["denominator"] <= 0 or weight["numerator"] < 0:
                self.close()
                raise ValueError("invalid target weight")
            offset += n
        if offset * 4 != len(self.buffer) or len(self.entries) != part["rows"]:
            self.close()
            raise ValueError("native token inventory mismatch")

    def __getitem__(self, index):
        row = self.entries[index]
        n, offset = row["sequence_length"], row["offset_tokens"] * 4
        raw = self.buffer[offset:offset + n * 4]
        if row.get("token_sha256") and hashlib.sha256(raw).hexdigest() != row["token_sha256"]:
            raise ValueError("native row token hash mismatch")
        return row, list(struct.unpack(f"<{n}I", raw))

    def close(self):
        self.buffer.close()
        self.file.close()


def normalized(row):
    return {"sample_id": str(row["row_id"]), "task": row["task"], "split": row["split"],
            "source_group_id": "|".join(sorted(map(str, row.get("source_group_ids", [])))),
            "source_root_ids": row.get("source_root_ids", []),
            "prefix_length": row["prefix_length"], "target_length": row["target_length"]}


def build_assignments(protocol, suites, panel):
    """Suites contain (NativeTokenRows, index) pairs. Never hashes target text."""
    generation, ce = [], []
    selected = {}
    for suite, items in suites.items():
        metadata = [normalized(reader.entries[index]) for reader, index in items]
        choices = panel.build_generation_selection(metadata, protocol["generation"]["per_task_validation_sample"])
        selected[suite] = {index for indices in choices.values() for index in indices}
    for model in protocol["models"]:
        for suite in model["suites"]:
            for position, (reader, index) in enumerate(suites[suite]):
                row, tokens = reader[index]
                base = {"model": model["id"], "suite": suite, **normalized(row),
                        "row_index": index, "dataset_path": str(reader.root),
                        "prefix_token_sha256": token_hash(tokens[:row["prefix_length"]]),
                        "target_token_sha256": token_hash(tokens[row["prefix_length"]:]),
                        "token_sha256": token_hash(tokens)}
                base["assignment_id"] = object_hash([base["model"], suite, base["task"], base["sample_id"]])
                ce.append(base)
                if position in selected[suite]:
                    generation.append(dict(base))
    for collection in (generation, ce):
        if len({x["assignment_id"] for x in collection}) != len(collection):
            raise ValueError("duplicate assignment")
    if len(generation) != protocol["expected_generation_assigned"] or len(ce) != protocol["ce"]["expected_assigned"]:
        raise ValueError("frozen assignment count mismatch")
    return generation, ce


def finish_reason(new_tokens, eos_ids, timed_out, cap):
    if new_tokens and new_tokens[-1] in eos_ids:
        return "eos"
    if timed_out:
        return "timeout"
    if len(new_tokens) >= cap:
        return "length"
    raise RuntimeError("generation stopped without EOS, deadline or output cap")


def reconcile(assignments, records):
    observed = {r["assignment_id"] for r in records}
    if len(observed) != len(records) or not observed.issubset({a["assignment_id"] for a in assignments}):
        raise ValueError("unassigned/duplicate terminal outcome")
    return records + [{**a, "execution_status": "not_run", "reason": "worker interrupted before dispatch"}
                      for a in assignments if a["assignment_id"] not in observed]


def verify_files(binding):
    for name, expected in binding.items():
        if digest(name) != expected:
            raise ValueError("immutable input changed: " + name)


def validate_adapter_config(config, base_model_id):
    targets = {"q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"}
    if (config.get("r") != 8 or config.get("lora_alpha") != 16
            or config.get("base_model_name_or_path") != base_model_id
            or set(config.get("target_modules") or []) != targets
            or config.get("bias", "none") != "none"
            or config.get("fan_in_fan_out", False)
            or any(config.get(key) for key in ("use_dora", "use_rslora", "lora_bias", "alora_invocation_tokens",
                                               "rank_pattern", "alpha_pattern", "target_parameters", "modules_to_save"))):
        raise ValueError("unsupported adapter geometry/scaling/base contract")


def run(root):
    root = Path(root).resolve()
    protocol_path = root / "protocol.json"
    protocol = json.loads(protocol_path.read_text())
    if root != Path(protocol["remote_root"]).resolve():
        raise ValueError("protocol root mismatch")
    work = root / "work"
    work.mkdir(exist_ok=True)
    if work.is_symlink() or not work.resolve().is_relative_to(root):
        raise ValueError("work directory escaped task root")
    if any((work / name).exists() for name in ("generation-results.jsonl", "ce-results.jsonl", "RESULT.json")):
        raise ValueError("fresh run required; existing outcome files are preserved")
    save(work / "protocol.json", protocol)
    stop, heartbeat_stop = threading.Event(), threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    state = {"status": "initializing", "generation_completed": 0, "ce_completed": 0}
    def heartbeat():
        while not heartbeat_stop.wait(15):
            save(work / "HEARTBEAT.json", {**state, "pid": os.getpid(), "unix_time": time.time(), "stop_requested": stop.is_set()})
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    controlled_mode = protocol.get("evaluation_mode") == "controlled_v13_B_C"
    controlled_summary = None
    generation, ce, gen_records, ce_records, readers = [], [], [], [], []
    bindings = {str(protocol_path): digest(protocol_path)}
    failure = None
    try:
        import torch
        import training_core as core
        import ubuntu_role_panel as panel
        from transformers import AutoTokenizer, StoppingCriteria, StoppingCriteriaList
        from safetensors.torch import load_file
        from peft import get_peft_model_state_dict, set_peft_model_state_dict
        import peft
        import transformers

        for path in sorted((root / "code").glob("*.py")):
            bindings[str(path)] = digest(path)
        if digest(root / "code/training_core.py") != protocol["loader_source_sha256"]:
            raise ValueError("loader source binding mismatch")
        for entry in protocol["base_files"]:
            path = Path(protocol["base_snapshot"]) / entry["name"]
            if path.stat().st_size != entry["bytes"]:
                raise ValueError("base file size mismatch")
            actual = digest(path)
            if entry.get("sha256") and actual != entry["sha256"]:
                raise ValueError("base file hash mismatch")
            bindings[str(path)] = actual
        core.ROOTS = {k: Path(v["path"]) for k, v in protocol["datasets"].items()}
        core.MODEL_ID, core.REVISION = protocol["base_model_id"], protocol["base_revision"]
        courses, suites, lookup = {}, {"shared": [], **{k: [] for k in protocol["datasets"]}}, {}
        shared_binding = None
        for role, specification in protocol["datasets"].items():
            dataset = Path(specification["path"])
            for name, field in (("COURSE.json", "course_sha256"), ("MANIFEST.json", "manifest_sha256")):
                path = dataset / name
                if digest(path) != specification[field]:
                    raise ValueError("dataset metadata binding mismatch")
                bindings[str(path)] = specification[field]
            course = core.course(role)
            courses[role] = course
            if "A" in courses and course["model"]["tokenizer_sha256"] != courses["A"]["model"]["tokenizer_sha256"]:
                raise ValueError("role tokenizer differs from generation decoding tokenizer A")
            for name, expected in course["model"]["tokenizer_sha256"].items():
                bindings[str(confined(dataset / "tokenizer", name))] = expected
            for phase in course["phases"]:
                part = phase["data"]["validation"]
                reader = NativeTokenRows(dataset, part)
                readers.append(reader)
                bindings.update(reader.binding)
                inventory = next(x for x in specification["phases"] if x["id"] == phase["id"])
                if len(reader.entries) != inventory["rows"]:
                    raise ValueError("phase row count mismatch")
                actual_tasks = {}
                for row in reader.entries:
                    actual_tasks[row["task"]] = actual_tasks.get(row["task"], 0) + 1
                if actual_tasks != inventory["tasks"]:
                    raise ValueError("phase task inventory mismatch")
                if phase["id"] == "01_dialogue_warmup":
                    identity = [(r["row_id"], token_hash(reader[i][1])) for i, r in enumerate(reader.entries)]
                    if shared_binding is None:
                        shared_binding = identity
                        suites["shared"] = [(reader, i) for i in range(len(reader.entries))]
                    elif shared_binding != identity:
                        raise ValueError("shared validation is not identical; cannot deduplicate")
                else:
                    suites[role].extend((reader, i) for i in range(len(reader.entries)))
        for suite, items in suites.items():
            for reader, index in items:
                row = reader.entries[index]
                key = (suite, row["task"], str(row["row_id"]))
                if key in lookup:
                    raise ValueError("duplicate source row identity")
                lookup[key] = (reader, index)
        if not controlled_mode:
            generation, ce = build_assignments(protocol, suites, panel)
        for name, items in (("generation-assignments.jsonl", generation), ("ce-assignments.jsonl", ce)):
            path = work / name
            if path.exists():
                raise ValueError("existing assignment ledger")
            for item in items:
                append(path, item)
        # References stay private, separate from every model input payload.
        tokenizer = AutoTokenizer.from_pretrained(str(core.ROOTS["A"] / "tokenizer"), local_files_only=True)
        for assignment in generation:
            reader, index = lookup[(assignment["suite"], assignment["task"], assignment["sample_id"])]
            row, tokens = reader[index]
            prefix = row["prefix_length"]
            save(work / "generation-cases" / (assignment["assignment_id"] + ".json"), {
                "assignment": assignment, "input_token_ids": tokens[:prefix], "reference_token_ids": tokens[prefix:],
                "reference_text": tokenizer.decode(tokens[prefix:], skip_special_tokens=True)})
        for specification in protocol["models"]:
            if specification.get("adapter"):
                for name, field in (("adapter_model.safetensors", "adapter_sha256"), ("adapter_config.json", "adapter_config_sha256")):
                    path = Path(specification["adapter"]) / name
                    if digest(path) != specification[field]:
                        raise ValueError("adapter source hash mismatch")
                    bindings[str(path)] = specification[field]
                config = json.loads((Path(specification["adapter"]) / "adapter_config.json").read_text())
                validate_adapter_config(config, protocol["base_model_id"])
        save(work / "STARTUP_BINDINGS.json", bindings)
        common = next(m for m in protocol["models"] if m["id"] == "common")
        core.MODEL_ID = protocol["base_snapshot"]
        model = core.load_model(common["adapter"], attention=protocol["attention"], compute_profile=CE_COMPUTE_PROFILE)
        model.gradient_checkpointing_disable()
        model.eval()
        for parameter in model.parameters():
            parameter.requires_grad_(False)
        model.config.get_text_config().use_cache = True
        torch.manual_seed(protocol["generation"]["seed"])
        torch.cuda.manual_seed_all(protocol["generation"]["seed"])
        if any(p.requires_grad for p in model.parameters()):
            raise RuntimeError("gradient parameters remain enabled")
        if getattr(model, "is_gradient_checkpointing", False):
            raise RuntimeError("gradient checkpointing remains enabled")
        runtime_sources = {}
        for implementation in (get_peft_model_state_dict, set_peft_model_state_dict, type(model), type(model.get_base_model())):
            filename = inspect.getsourcefile(implementation)
            if filename:
                runtime_sources[filename] = digest(filename)
        save(work / "RUNTIME.json", {"torch": torch.__version__, "transformers": transformers.__version__,
            "peft": peft.__version__, "cuda_version": torch.version.cuda,
            "device_name": torch.cuda.get_device_name(0), "runtime_source_sha256": runtime_sources,
            "base_snapshot": protocol["base_snapshot"], "base_revision": protocol["base_revision"],
            "attention": protocol["attention"], "ce_compute_profile": CE_COMPUTE_PROFILE,
            "base_model_digest": object_hash({entry["name"]: bindings[str(Path(protocol["base_snapshot"]) / entry["name"])] for entry in protocol["base_files"]}),
            "protocol_sha256": bindings[str(protocol_path)],
            "generation_seed": protocol["generation"]["seed"], "trainable_parameters": 0})
        bindings.update(runtime_sources)

        def switch(spec):
            if not spec.get("adapter"):
                return {"model": spec["id"], "mode": "PEFT.disable_adapter"}
            path = Path(spec["adapter"]) / "adapter_model.safetensors"
            if digest(path) != spec["adapter_sha256"]:
                raise ValueError("adapter changed before activation")
            tensors = load_file(str(path), device="cpu")
            set_peft_model_state_dict(model, tensors, adapter_name="default")
            actual = get_peft_model_state_dict(model, adapter_name="default")
            if set(actual) != set(tensors):
                raise ValueError("loaded LoRA tensor key mismatch")
            for name, expected in tensors.items():
                if not torch.equal(actual[name].detach().cpu(), expected.to(actual[name].dtype)):
                    raise ValueError("loaded LoRA tensor mismatch")
            proof = {"model": spec["id"], "source_sha256": spec["adapter_sha256"], "tensor_count": len(tensors),
                     "all_named_lora_tensors_equal": True, "rank": 8, "alpha": 16}
            append(work / "adapter-activations.jsonl", proof)
            return proof

        def mode(spec):
            return contextlib.nullcontext() if spec.get("adapter") else model.disable_adapter()

        core.set_compute_layout(model, 512, "cuda", False)
        switch(common)
        prompt = tokenizer.encode("안녕하세요.", add_special_tokens=True)
        x = torch.tensor([prompt], dtype=torch.long, device="cuda")
        def two_steps():
            tokens, logits = x, []
            with torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                for _ in range(2):
                    scores = model(input_ids=tokens, use_cache=False, logits_to_keep=1, kernel_options=core.FLEX_OPTIONS).logits[:, -1].float()
                    if not torch.isfinite(scores).all():
                        raise RuntimeError("nonfinite qualification logits")
                    logits.append(scores.detach().cpu())
                    tokens = torch.cat([tokens, scores.argmax(-1, keepdim=True)], dim=-1)
            return logits
        with model.disable_adapter():
            disabled = two_steps()
        scales = [(module, dict(module.scaling)) for module in model.modules() if hasattr(module, "scaling") and isinstance(module.scaling, dict)]
        if not scales:
            raise RuntimeError("no LoRA scaling modules")
        try:
            for module, values in scales:
                for name in values:
                    module.scaling[name] = 0.0
            zero = two_steps()
        finally:
            for module, values in scales:
                module.scaling.update(values)
        enabled = two_steps()
        zero_diff = [float((a - b).abs().max()) for a, b in zip(disabled, zero)]
        effect = [float((a - b).abs().max()) for a, b in zip(disabled, enabled)]
        if any(v != 0 for v in zero_diff) or not any(v > 0 for v in effect):
            raise RuntimeError("baseline/adapter qualification failed")
        longest = max((item for items in suites.values() for item in items), key=lambda item: item[0].entries[item[1]]["prefix_length"])
        row, tokens = longest[0][longest[1]]
        with torch.no_grad():
            loss, _ = core.row_loss(model, (row, torch.tensor(tokens, dtype=torch.long)), offload=False)
        if not math.isfinite(float(loss)):
            raise RuntimeError("longest-row startup CE is not finite")
        save(work / "QUALIFICATION.json", {"status": "passed", "small_generated_tokens": 6,
            "disabled_vs_zero_max_abs_diff": zero_diff, "enabled_max_abs_effect": effect,
            "longest_prefix_tokens": row["prefix_length"], "longest_sequence_tokens": len(tokens),
            "longest_full_target_ce": float(loss), "startup_probe_not_in_scored_denominators": True,
            "gradients_enabled": False, "optimizer_steps": 0})

        if controlled_mode:
            from ubuntu_controlled_service import run_controlled
            state["status"] = "controlled_v13"
            controlled_summary = run_controlled(root, protocol, work, model, core, tokenizer, torch, switch, mode, stop=stop)
        else:
            class Deadline(StoppingCriteria):
                def __init__(self, seconds):
                    self.deadline = time.monotonic() + seconds
                    self.expired = False
                def __call__(self, input_ids, scores, **kwargs):
                    self.expired = time.monotonic() >= self.deadline
                    return self.expired

            specs = {m["id"]: m for m in protocol["models"]}
            active = None
            state["status"] = "generation"
            for assignment in generation:
                if stop.is_set():
                    break
                spec = specs[assignment["model"]]
                if active != spec["id"]:
                    switch(spec)
                    active = spec["id"]
                core.set_compute_layout(model, 512, "cuda", False)
                save(work / "ACTIVE_JOB.json", {"stage": "generation", **assignment, "started_unix": time.time()})
                started = time.monotonic()
                case = json.loads((work / "generation-cases" / (assignment["assignment_id"] + ".json")).read_text())
                prefix_ids = case["input_token_ids"]
                if token_hash(prefix_ids) != assignment["prefix_token_sha256"] or len(prefix_ids) + protocol["generation"]["max_new_tokens"] > protocol["generation"]["max_input_context"]:
                    raise ValueError("frozen input hash/context mismatch")
                deadline = Deadline(protocol["generation"]["max_seconds"])
                eos = model.generation_config.eos_token_id
                eos_ids = [eos] if isinstance(eos, int) else list(eos or [])
                try:
                    with mode(spec), torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
                        output = model.generate(input_ids=torch.tensor([prefix_ids], dtype=torch.long, device="cuda"),
                            attention_mask=torch.ones((1, len(prefix_ids)), dtype=torch.long, device="cuda"),
                            max_new_tokens=protocol["generation"]["max_new_tokens"], do_sample=False, use_cache=True,
                            logits_to_keep=1, kernel_options=core.FLEX_OPTIONS,
                            stopping_criteria=StoppingCriteriaList([deadline]), return_dict_in_generate=True,
                            pad_token_id=tokenizer.pad_token_id if tokenizer.pad_token_id is not None else eos_ids[0])
                    all_ids = output.sequences[0].detach().cpu().tolist()
                    if all_ids[:len(prefix_ids)] != prefix_ids:
                        raise RuntimeError("generate changed input token prefix")
                    new_ids = all_ids[len(prefix_ids):]
                    reason = finish_reason(new_ids, eos_ids, deadline.expired, protocol["generation"]["max_new_tokens"])
                    text = tokenizer.decode(new_ids, skip_special_tokens=True)
                    record = {**assignment, "execution_status": "failed" if reason == "timeout" else "output_received",
                              "finish_reason": reason, "output_token_ids": new_ids, "output_token_sha256": token_hash(new_ids),
                              "elapsed_seconds": time.monotonic() - started,
                              "generated_text": text, "generated_text_sha256": hashlib.sha256(text.encode()).hexdigest(),
                              "scores": panel.score_generation(assignment["task"], text, case["reference_text"])}
                    del output
                except Exception as error:
                    record = {**assignment, "execution_status": "failed", "finish_reason": "infrastructure_error",
                              "error_type": type(error).__name__, "error": str(error)}
                    append(work / "generation-results.jsonl", record)
                    gen_records.append(record)
                    raise
                append(work / "generation-results.jsonl", record)
                gen_records.append(record)
                state["generation_completed"] = len(gen_records)
                save(work / "generation-metrics.json", panel.aggregate(gen_records, generation))
            # Never start CE after a requested stop or an infrastructure exception.
            state["status"] = "ce"
            for assignment in ce:
                if stop.is_set():
                    break
                spec = specs[assignment["model"]]
                if active != spec["id"]:
                    switch(spec)
                    active = spec["id"]
                save(work / "ACTIVE_JOB.json", {"stage": "ce", **assignment, "started_unix": time.time()})
                started = time.monotonic()
                reader, index = lookup[(assignment["suite"], assignment["task"], assignment["sample_id"])]
                row, tokens = reader[index]
                try:
                    with mode(spec), torch.no_grad():
                        loss, weighted = core.row_loss(model, (row, torch.tensor(tokens, dtype=torch.long)), offload=False)
                    loss, weighted = float(loss), float(weighted)
                    if not math.isfinite(loss) or not math.isfinite(weighted):
                        raise RuntimeError("nonfinite full-target CE")
                    record = {**assignment, "execution_status": "output_received", "loss": loss, "weighted_loss": weighted,
                              "elapsed_seconds": time.monotonic() - started,
                              "target_length": row["target_length"], "full_target": True}
                except Exception as error:
                    record = {**assignment, "execution_status": "failed", "error_type": type(error).__name__, "error": str(error)}
                    append(work / "ce-results.jsonl", record)
                    ce_records.append(record)
                    raise
                append(work / "ce-results.jsonl", record)
                ce_records.append(record)
                state["ce_completed"] = len(ce_records)
                if len(ce_records) % 25 == 0:
                    save(work / "ce-metrics.json", panel.aggregate_ce(reconcile(ce, ce_records)))
    except BaseException as error:
        failure = {"type": type(error).__name__, "message": str(error), "traceback": traceback.format_exc()}
        save(work / "FAILURE.json", failure)
    finally:
        heartbeat_stop.set()
        thread.join(timeout=2)
        for reader in readers:
            reader.close()
        integrity_error = None
        try:
            verify_files(bindings)
        except Exception as error:
            integrity_error = str(error)
        if controlled_mode:
            complete = bool(controlled_summary and controlled_summary.get("completed") and not failure and not integrity_error)
        else:
            final_gen, final_ce = reconcile(generation, gen_records), reconcile(ce, ce_records)
            save(work / "generation-outcomes.json", final_gen)
            save(work / "ce-outcomes.json", final_ce)
            import ubuntu_role_panel as panel
            metrics = {"generation": panel.aggregate(final_gen, generation), "ce": panel.aggregate_ce(final_ce),
                       "human_judgment": None, "clinical_validity": None, "independent_test": False}
            save(work / "all-metrics.json", metrics)
            with (work / "REPORT.md").open("w") as handle:
                handle.write(panel.reportmarkdown(metrics)); handle.flush(); os.fsync(handle.fileno())
            complete = (not failure and not integrity_error and len(gen_records) == len(generation) == protocol["expected_generation_assigned"]
                        and len(ce_records) == len(ce) == protocol["ce"]["expected_assigned"])
        result = {"status": "completed" if complete else "infrastructure_interrupted" if failure or integrity_error else "stopped",
                  **state, "status_detail": state["status"], "completed": complete,
                  "generation_assigned": len(generation), "ce_assigned": len(ce),
                  "generation_terminal": len(gen_records), "ce_terminal": len(ce_records),
                  "generation_not_run": len(generation) - len(gen_records), "ce_not_run": len(ce) - len(ce_records),
                  "immutable_files_verified": integrity_error is None, "integrity_error": integrity_error,
                  "failure": failure, "protocol_sha256": bindings[str(protocol_path)], "optimizer_steps": 0,
                  "ce_compute_profile": CE_COMPUTE_PROFILE,
                  "source_and_input_bindings": bindings, "stop_requested": stop.is_set()}
        # state carries stage status; terminal status must take precedence.
        result["status"] = "completed" if complete else "infrastructure_interrupted" if failure or integrity_error else "stopped"
        result["generation_completed"] = len(gen_records)
        result["ce_completed"] = len(ce_records)
        if controlled_mode:
            for field in ("generation_assigned", "ce_assigned", "generation_terminal", "ce_terminal", "generation_not_run", "ce_not_run", "generation_completed", "ce_completed"):
                result.pop(field, None)
            result["evaluation_mode"] = "controlled_v13_B_C"
            result["controlled"] = controlled_summary
            if not complete and not stop.is_set():
                result["status"] = "infrastructure_interrupted"
        save(work / "RESULT.json", result)
        save(work / "STATUS.json", result)
    return 0 if complete else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    return run(parser.parse_args().root)


if __name__ == "__main__":
    raise SystemExit(main())

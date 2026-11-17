"""Single-owner inference for frozen v1.3 requests and an app filesystem queue.

This module opens no ports, imports no GPU packages at import time, and never
retries inference. Private request/output evidence is written only under work.
"""
import hashlib
import json
from pathlib import Path
import re
import time
import datetime

from ubuntu_role_worker import append, canonical, digest, object_hash, save, token_hash


class RequestError(Exception):
    def __init__(self, message, status=400, proof=None):
        super().__init__(message)
        self.status, self.proof = status, proof or {}


def greedy_loop(step, cap, eos_ids, expired, tokens, stop_at_eos=True):
    """Finite control loop; tokens is caller-owned for partial failure evidence."""
    for _ in range(cap):
        if expired():
            return "timeout"
        token = step(tokens)
        if type(token) is not int or token < 0:
            raise RuntimeError("decoder returned invalid token")
        tokens.append(token)
        if stop_at_eos and token in eos_ids:
            return "stop"
        if expired():
            return "timeout"
    return "length"


def decode_contract(config):
    eos = config.eos_token_id
    eos = [eos] if type(eos) is int else list(eos or [])
    suppress = list(getattr(config, "suppress_tokens", None) or [])
    if set(eos) != {1, 106, 50} or set(suppress) != {258883, 258882}:
        raise RuntimeError("frozen EOS/suppression contract changed")
    defaults = {"repetition_penalty": 1.0, "encoder_repetition_penalty": 1.0,
                "no_repeat_ngram_size": 0, "encoder_no_repeat_ngram_size": 0,
                "min_length": 0, "min_new_tokens": None, "forced_bos_token_id": None,
                "forced_eos_token_id": None, "bad_words_ids": None, "force_words_ids": None,
                "begin_suppress_tokens": None, "sequence_bias": None,
                "exponential_decay_length_penalty": None, "watermarking_config": None,
                "num_beams": 1, "penalty_alpha": None}
    for name, expected in defaults.items():
        value = getattr(config, name, expected)
        # Transformers 5.22 stores unset neutral generation options as None.
        if value is None and expected is not None:
            continue
        if value != expected:
            raise RuntimeError("unsupported nondefault generation processor: " + name)
    return eos, suppress


def forward_stepper(model, prefix, torch, kernel_options, suppress, cache_factory, use_cache=True, trace=None):
    """One fresh cache per request; Gemma derives positions from cache length.

    Installed Gemma4TextModel.forward constructs/updates DynamicCache and derives
    position_ids from past length. Its multimodal wrapper accepts a full growing
    attention mask and forwards kernel_options to the registered flex kernel.
    """
    cache = cache_factory() if use_cache else None
    first = True
    def step(generated):
        nonlocal cache, first
        full = prefix + generated
        current = full if first or not use_cache else [generated[-1]]
        output = model(input_ids=torch.tensor([current], dtype=torch.long, device="cuda"),
            attention_mask=torch.ones((1, len(full)), dtype=torch.long, device="cuda"),
            past_key_values=cache, use_cache=use_cache, logits_to_keep=1, kernel_options=kernel_options)
        scores = output.logits[:, -1].float()
        if not bool(torch.isfinite(scores).all()):
            raise RuntimeError("nonfinite direct-forward logits")
        if trace is not None:
            trace.append(scores.detach().cpu().clone())
        if use_cache:
            cache = output.past_key_values
            if cache is None:
                raise RuntimeError("cached forward returned no KV cache")
        first = False
        scores = scores.clone()
        scores[:, suppress] = -float("inf")
        if not bool(torch.isfinite(scores).any()):
            raise RuntimeError("suppression removed every finite token")
        token = int(scores.argmax(-1).item())
        del output
        return token
    return step


def validate_payload(payload, fixed=False):
    if not isinstance(payload, dict):
        raise RequestError("payload must be an object")
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages or any(
            not isinstance(m, dict) or m.get("role") not in ("system", "user", "assistant")
            or not isinstance(m.get("content"), str) for m in messages):
        raise RequestError("requires text chat messages")
    if payload.get("response_format") is not None:
        raise RequestError("response_format unsupported; frozen prompt transport required")
    if payload.get("stream", False) or payload.get("tools") or payload.get("n", 1) != 1:
        raise RequestError("stream, tools, and multiple choices unsupported")
    if payload.get("temperature", 0) != 0 or payload.get("seed", 3407) != 3407:
        raise RequestError("frozen temperature=0 seed=3407 required")
    if payload.get("reasoning_effort", "none") != "none":
        raise RequestError("nonthinking transport required")
    cap = payload.get("max_tokens", 1024 if fixed else 8192)
    if type(cap) is not int or not 1 <= cap <= (1024 if fixed else 8192):
        raise RequestError("output cap outside frozen bounds")
    return messages, cap


def terminal_records(assignments, records):
    expected = {(a["model"], a["request_id"]): a for a in assignments}
    if len(expected) != len(assignments):
        raise ValueError("duplicate fixed assignments")
    observed = set()
    for record in records:
        key = record["model"], record["request_id"]
        if key not in expected or key in observed:
            raise ValueError("duplicate or unassigned fixed outcome")
        observed.add(key)
    return records + [{**a, "execution_status": "not_run", "reason": "infrastructure interruption before dispatch"}
                      for key, a in expected.items() if key not in observed]


def fixed_batch(assignments, generate, ledger, stop=None):
    """No retries: model/request errors continue; infrastructure errors stop."""
    records, fatal = [], None
    terminal_records(assignments, [])  # validate entire ledger before any dispatch
    for assignment in assignments:
        if stop is not None and stop.is_set():
            break
        started_at = datetime.datetime.now(datetime.timezone.utc).isoformat()
        payload = assignment.get("request", assignment.get("payload"))
        try:
            result = generate(assignment["model"], payload, assignment["request_id"], fixed=True)
            record = {**assignment, **result}
        except RequestError as error:
            record = {**assignment, "execution_status": "failed", "status": error.status,
                      "text": error.proof.get("partial_text", ""), "error": str(error), "proof": error.proof}
        except Exception as error:
            record = {**assignment, "execution_status": "failed", "status": 503,
                      "text": "", "error_type": type(error).__name__, "error": str(error),
                      "infrastructure_fatal": True}
            fatal = {"type": type(error).__name__, "message": str(error)}
        record.update(started_at=started_at, completed_at=datetime.datetime.now(datetime.timezone.utc).isoformat())
        append(ledger, record)
        records.append(record)
        save(Path(ledger).parent / "PROGRESS.json", {"stage": "fixed", "assigned": len(assignments),
            "terminal": len(records), "fatal": fatal})
        if fatal:
            break
    return terminal_records(assignments, records), fatal


class NativeEngine:
    def __init__(self, protocol, model, core, tokenizer, torch, switch, mode):
        self.protocol, self.model, self.core = protocol, model, core
        self.tokenizer, self.torch, self.switch, self.mode = tokenizer, torch, switch, mode
        self.models = {m["id"]: m for m in protocol["models"]}
        self.runtime_path = Path(protocol["remote_root"]) / "work/RUNTIME.json"
        self.runtime = json.loads(self.runtime_path.read_text())
        self.runtime_sha256 = digest(self.runtime_path)
        from transformers import DynamicCache
        self.cache_factory = lambda: DynamicCache(config=self.model.config.get_text_config())
        self.eos_ids, self.suppress_tokens = decode_contract(self.model.generation_config)
        self.qualify_cached_decode()

    def qualify_cached_decode(self):
        spec = self.models["common"]
        self.switch(spec)
        self.core.set_compute_layout(self.model, 512, "cuda", False)
        prefix = self.tokenizer.apply_chat_template([{"role": "user", "content": "안녕하세요."}],
            tokenize=True, add_generation_prompt=True, enable_thinking=False, return_dict=False)
        traces, sequences = [], []
        torch = self.torch
        with self.mode(spec), torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            for cached in (True, False):
                trace, tokens = [], []
                step = forward_stepper(self.model, prefix, torch, self.core.FLEX_OPTIONS,
                    self.suppress_tokens, self.cache_factory, use_cache=cached, trace=trace)
                greedy_loop(step, 3, self.eos_ids, lambda: False, tokens, stop_at_eos=False)
                traces.append(trace)
                sequences.append(tokens)
        differences = [float((a - b).abs().max()) for a, b in zip(*traces)]
        passed = sequences[0] == sequences[1] and len(sequences[0]) == 3
        save(Path(self.protocol["remote_root"]) / "work/controlled/DECODE_QUALIFICATION.json", {
            "status": "passed" if passed else "failed", "cached_tokens": sequences[0], "uncached_tokens": sequences[1],
            "max_abs_logit_difference": differences, "argmax_equal_all_steps": passed,
            "all_raw_logits_finite": True, "suppress_tokens": self.suppress_tokens, "eos_token_ids": self.eos_ids,
            "adapter_sha256": spec["adapter_sha256"], "steps_per_mode": 3,
            "decode_implementation": "direct_forward_greedy_dynamic_cache_v1", "scored_assignment": False})
        if not passed:
            raise RuntimeError("cached versus uncached greedy qualification failed")

    def identity(self, model_id):
        spec = self.models.get(model_id, {})
        return {"model": model_id, "adapter_sha256": spec.get("adapter_sha256"), "adapter_source_sha256": spec.get("adapter_sha256"),
                "base_model_digest": self.runtime["base_model_digest"],
                "runtime_sha256": self.runtime_sha256, "protocol_sha256": self.runtime["protocol_sha256"]}

    def generate(self, model_id, payload, request_id, fixed=False):
        try:
            messages, cap = validate_payload(payload, fixed)
        except RequestError as error:
            error.proof.update(self.identity(model_id))
            raise
        if digest(self.runtime_path) != self.runtime_sha256:
            raise RuntimeError("frozen runtime identity changed")
        if digest(Path(self.protocol["remote_root"]) / "protocol.json") != self.runtime["protocol_sha256"]:
            raise RuntimeError("frozen protocol changed")
        if model_id not in ("baseline", "B_original", "C_user_provided") or model_id not in self.models:
            raise RequestError("unknown controlled model")
        spec = self.models[model_id]
        if payload.get("model", model_id) != model_id:
            raise RequestError("request model alias mismatch")
        ids = self.tokenizer.apply_chat_template(messages, tokenize=True, add_generation_prompt=True, enable_thinking=False, return_dict=False)
        if not isinstance(ids, list) or not ids or any(type(x) is not int for x in ids):
            raise RuntimeError("unexpected chat template token representation")
        if len(ids) + cap > 32768:
            raise RequestError("full input plus output exceeds context; no truncation")
        # Reload and verify all named tensors for each adapter request, including
        # repeated requests. Baseline identity comes from actual disabled layers.
        activation = self.switch(spec)
        self.core.set_compute_layout(self.model, 512, "cuda", False)
        torch = self.torch
        torch.manual_seed(3407)
        torch.cuda.manual_seed_all(3407)
        proof = {"request_id": request_id, "model": model_id,
                 "input_token_ids": ids, "input_token_sha256": token_hash(ids),
                 "messages_sha256": object_hash(messages), "payload_sha256": object_hash(payload),
                 "adapter_source_sha256": spec.get("adapter_sha256"), "activation": activation,
                 "adapter_sha256": spec.get("adapter_sha256"),
                 "base_model_digest": self.runtime["base_model_digest"],
                 "runtime_sha256": self.runtime_sha256,
                 "protocol_sha256": self.runtime["protocol_sha256"],
                 "enable_thinking": False, "response_format_enforced": False,
                 "max_new_tokens": cap, "seed": 3407, "do_sample": False,
                 "input_truncated": False, "fresh_kv_cache": True}
        proof.update(transport="filesystem_queue", actual_http_posts=0)
        proof.update(decode_implementation="direct_forward_greedy_dynamic_cache_v1",
                     suppress_tokens=self.suppress_tokens, eos_token_ids=self.eos_ids)
        started = time.monotonic()
        with self.mode(spec), torch.no_grad(), torch.autocast("cuda", dtype=torch.bfloat16):
            disabled = [getattr(m, "disable_adapters", None) for m in self.model.modules() if hasattr(m, "lora_A") and hasattr(m, "lora_B")]
            expected_disabled = spec.get("adapter") is None
            if not disabled or any(type(x) is not bool or x != expected_disabled for x in disabled):
                raise RuntimeError("actual LoRA disabled flags mismatch requested model")
            proof.update(actual_adapter_enabled=not expected_disabled, lora_layer_count=len(disabled), all_lora_flags_verified=True)
            append(Path(self.protocol["remote_root"]) / "work/controlled/inference-attempts.jsonl",
                   {"event": "started", "request_id": request_id, "proof": proof})
            new_ids = []
            try:
                step = forward_stepper(self.model, ids, torch, self.core.FLEX_OPTIONS,
                    self.suppress_tokens, self.cache_factory)
                finish = greedy_loop(step, cap, self.eos_ids, lambda: time.monotonic() - started >= 900, new_ids)
            except Exception as error:
                partial = {**proof, "partial_output_token_ids": new_ids,
                           "partial_output_token_sha256": token_hash(new_ids),
                           "error_type": type(error).__name__, "error": str(error)}
                append(Path(self.protocol["remote_root"]) / "work/controlled/inference-attempts.jsonl",
                       {"event": "failed", "request_id": request_id, "proof": partial})
                raise
            del step  # release this request's cache before the next activation
        text = self.tokenizer.decode(new_ids, skip_special_tokens=True)
        proof.update(output_token_ids=new_ids, output_token_sha256=token_hash(new_ids),
                     text_sha256=hashlib.sha256(text.encode()).hexdigest(), elapsed_seconds=time.monotonic() - started)
        if finish == "timeout":
            proof["partial_text"] = text
            raise RequestError("generation deadline reached", 504, proof)
        response = {"id": "chatcmpl-" + str(request_id), "object": "chat.completion", "model": model_id,
                    "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
                    "usage": {"prompt_tokens": len(ids), "completion_tokens": len(new_ids), "total_tokens": len(ids) + len(new_ids)}}
        return {"execution_status": "output_received", "status": 200, "text": text,
                "response": response, "proof": proof, "finish_reason": finish}


def serve_one(directory, generate):
    """Read one atomic request and persist its response; returns fatal diagnostic."""
    directory = Path(directory)
    request_path, response_path = directory / "request.json", directory / "response.json"
    if response_path.exists() or not request_path.exists():
        return None
    request_id, fatal = directory.name, None
    if directory.is_symlink() or request_path.is_symlink():
        return {"type": "UnsafeQueuePath", "request_id": request_id}
    proof = {"request_file_sha256": digest(request_path)}
    try:
        if directory.is_symlink() or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,200}", request_id):
            raise RequestError("invalid queue directory")
        try:
            request = json.loads(request_path.read_text())
        except (ValueError, TypeError) as error:
            raise RequestError("invalid queue request JSON") from error
        if not isinstance(request, dict) or request.get("request_id") != request_id:
            raise RequestError("queue request ID mismatch")
        if not isinstance(request.get("model"), str) or not isinstance(request.get("payload"), dict):
            raise RequestError("missing model/payload")
        if (directory / "cancelled.json").exists() or (directory / "cancel.json").exists():
            raise RequestError("client cancelled before inference dispatch", 499, {"model_called": False, "execution_status": "not_run"})
        result = generate(request["model"], request["payload"], request_id, fixed=False)
        envelope = {"request_id": request_id, "status": result["status"], "response": result["response"],
                    "proof": {**result["proof"], **proof}}
    except RequestError as error:
        status = error.status
        detail = error.proof
        owner = getattr(generate, "__self__", None)
        if hasattr(owner, "identity") and isinstance(locals().get("request"), dict):
            detail = {**owner.identity(request.get("model")), **detail}
        envelope = {"request_id": request_id, "status": status,
                    "response": {"error": {"type": "request_error", "message": str(error)}}, "proof": {**detail, **proof}}
    except Exception as error:
        fatal = {"type": type(error).__name__, "message": str(error), "request_id": request_id}
        envelope = {"request_id": request_id, "status": 503,
                    "response": {"error": {"type": "infrastructure_fatal", "message": str(error)}}, "proof": proof}
    save(response_path, envelope)
    return fatal


def run_controlled(root, protocol, work, model, core, tokenizer, torch, switch, mode, stop=None):
    import ubuntu_v13_panel as panel
    root, work = Path(root), Path(work)
    output = work / "controlled"
    output.mkdir(exist_ok=True)
    if any((output / name).exists() for name in ("fixed-responses.jsonl", "fixed-assignments.jsonl", "SUMMARY.json")):
        raise ValueError("fresh controlled output required; prior evidence preserved")
    settings = protocol.get("controlled", {})
    panel_root = Path(settings.get("panel_root", root / "panel"))
    fixed_root = output / "fixed-run"
    fixed_root.mkdir(exist_ok=True)
    assignments = panel.prepare_fixed(panel_root, fixed_root)
    expected = settings.get("expected_fixed_assigned", 720)
    if len(assignments) != expected:
        raise ValueError("controlled fixed assignment count mismatch")
    for item in assignments:
        append(output / "fixed-assignments.jsonl", item)
    engine = NativeEngine(protocol, model, core, tokenizer, torch, switch, mode)
    resume = settings.get("resume_fixed")
    if resume:
        source = root / resume["relative_path"]
        if source.resolve() != source or digest(source) != resume["sha256"]:
            raise ValueError("prior fixed raw bytes changed")
        records = [json.loads(line) for line in source.read_text().splitlines() if line.strip()]
        checked = terminal_records(assignments, records)
        if len(records) != expected or any(row["execution_status"] != "output_received" for row in checked):
            raise ValueError("resume requires the complete original fixed responses")
        (output / "fixed-responses.jsonl").write_bytes(source.read_bytes())
        save(output / "FIXED_REUSE.json", {"source": str(source), "sha256": digest(source),
             "reused_response_count": len(records), "new_fixed_inferences": 0})
        fatal = None
    else:
        records, fatal = fixed_batch(assignments, engine.generate, output / "fixed-responses.jsonl", stop)
    save(output / "fixed-outcomes.json", records)
    summary = {"evaluation_mode": "controlled_v13_B_C", "transport": "filesystem_queue", "actual_http_posts": 0,
               "fixed_assigned": expected,
               "fixed_terminal": sum(r["execution_status"] != "not_run" for r in records),
               "fixed_not_run": sum(r["execution_status"] == "not_run" for r in records),
               "fixed_assignment_sha256": object_hash(assignments), "fatal": fatal,
               "full_flow_assigned": settings.get("expected_full_flow_assigned", 18), "full_flow_terminal": 0}
    if not fatal and not summary["fixed_not_run"]:
        summary["fixed_metrics"] = panel.finalize_fixed(panel_root, fixed_root, records)
        queue = work / "fs-requests"
        queue.mkdir(exist_ok=True)
        flow = output / "full-flow"
        flow.mkdir(exist_ok=True)
        save(output / "FIXED_COMPLETE.json", {"status": "completed", "fixed_assigned": expected,
            "fixed_terminal": summary["fixed_terminal"], "fixed_responses_sha256": digest(output / "fixed-responses.jsonl"),
            "queue_directory": str(queue), "full_flow_directory": str(flow)})
        deadline = time.monotonic() + protocol.get("parent_job_deadline_hours", 96) * 3600
        done = output / "full-flow-done.json"
        served = 0
        while True:
            if stop is not None and stop.is_set():
                summary["stop_requested"] = True
                break
            if time.monotonic() >= deadline:
                summary["fatal"] = {"type": "CoordinatorDeadline", "message": "full-flow coordinator deadline reached"}
                break
            if done.exists():
                receipt = json.loads(done.read_text())
                path = flow / "summary.json"
                if receipt.get("summary_sha256") != digest(path):
                    raise ValueError("full-flow completion receipt summary hash mismatch")
                flow_summary = json.loads(path.read_text())
                if flow_summary.get("assigned", flow_summary.get("assigned_count")) != summary["full_flow_assigned"]:
                    raise ValueError("full-flow assigned denominator mismatch")
                summary["full_flow_summary"] = flow_summary
                summary["full_flow_terminal"] = flow_summary.get("completed", flow_summary.get("completed_case_count", 0))
                summary["full_flow_done_sha256"] = digest(done)
                break
            for directory in sorted(queue.iterdir()):
                if directory.is_dir():
                    pending = (directory / "request.json").exists() and not (directory / "response.json").exists()
                    fatal = serve_one(directory, engine.generate)
                    if pending:
                        served += 1
                        save(output / "PROGRESS.json", {"stage": "full_flow", "queue_responses": served})
                    if fatal:
                        summary["fatal"] = fatal
                        save(queue / "FATAL.json", fatal)
                        break
            if fatal:
                break
            time.sleep(.1)
    summary["completed"] = (not summary["fatal"] and not summary["fixed_not_run"]
                            and summary["full_flow_terminal"] == summary["full_flow_assigned"])
    save(output / "SUMMARY.json", summary)
    if hasattr(panel, "build_report"):
        panel.build_report(root, work, summary)
    return summary

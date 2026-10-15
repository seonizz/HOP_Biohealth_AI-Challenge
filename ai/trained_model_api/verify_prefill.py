"""One startup regression check for chunked text prefill; synthetic text only."""
import datetime
import json
from pathlib import Path

def verify_prefill(backend, report_path):
    tokenizer = backend.tokenizer
    target = 8193
    rows = [f"기록 {i}: 색상 {['초록','파랑','노랑','보라'][i % 4]}, 번호 {(i * 7919) % 10007}.\n" for i in range(1200)]
    prefix = "자료는 참고만 하고 마지막 지시에만 짧게 답하세요.\n"
    suffix = "\n마지막 지시: 확인 코드 AB-314만 그대로 출력하세요."
    def make(n, extra=0):
        return [{"role":"user","content":prefix + "".join(rows[:n]) + " a" * extra + suffix}]
    def count(messages):
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        return len(tokenizer(text, add_special_tokens=False, truncation=False)["input_ids"])
    lo, hi = 0, len(rows)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if count(make(mid)) <= target: lo = mid
        else: hi = mid - 1
    messages = None
    for extra in range(128):
        candidate = make(lo, extra)
        if count(candidate) == target:
            messages = candidate
            break
    if messages is None:
        raise RuntimeError("Could not build exact 8193-token synthetic prompt")
    configured_chunk = backend.config["prefill_chunk_size"]
    report = {"status":"running","input_tokens":target,"prefill_chunk_size":configured_chunk,
              "checkpoint_step":backend.config["checkpoint_step"],
              "checkpoint_sha256":backend.config["checkpoint_sha256"],
              "scope":"One diverse synthetic text response regression, including a 1-token final chunk; not bitwise logits equivalence"}
    def save():
        report["updated_utc"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        Path(report_path).write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
    save()
    hooks = []
    try:
        backend.config["prefill_chunk_size"] = None
        from transformers.modeling_utils import ALL_ATTENTION_FUNCTIONS
        grouped = ALL_ATTENTION_FUNCTIONS["sdpa"]
        original = getattr(grouped, "original_attention", grouped)
        try:
            ALL_ATTENTION_FUNCTIONS["sdpa"] = original
            full = backend.generate(messages, 16, 0, 1)
        finally:
            ALL_ATTENTION_FUNCTIONS["sdpa"] = grouped
        backend.config["prefill_chunk_size"] = configured_chunk
        trace = {"processed_input_tokens":0,"prefill_chunks":[],"cache_types":[]}
        def before(module,args,kwargs):
            value = kwargs.get("input_ids")
            if value is not None and trace["processed_input_tokens"] < target:
                n = int(value.shape[-1])
                trace["prefill_chunks"].append(n)
                trace["processed_input_tokens"] += n
        def after(module,args,kwargs,result):
            cache = getattr(result,"past_key_values",None)
            if cache is not None:
                name = type(cache).__name__
                if name not in trace["cache_types"]: trace["cache_types"].append(name)
        base = backend.model.get_base_model()
        hooks.append(base.register_forward_pre_hook(before,with_kwargs=True))
        hooks.append(base.register_forward_hook(after,with_kwargs=True))
        chunked = backend.generate(messages, 16, 0, 1)
        report.update(full=full,chunked=chunked,trace=trace)
        assert full == chunked, "Synthetic response changed under chunked prefill"
        assert "AB-314" in full["text"], "Synthetic instruction was not followed"
        assert trace["prefill_chunks"] == [4096,4096,1], trace
        assert trace["processed_input_tokens"] == target
        assert trace["cache_types"] == ["DynamicCache"], trace
        report["status"] = "passed"
    except BaseException as exc:
        report.update(status="failed",error_type=type(exc).__name__,error=str(exc))
        raise
    finally:
        backend.config["prefill_chunk_size"] = configured_chunk
        for hook in hooks: hook.remove()
        save()

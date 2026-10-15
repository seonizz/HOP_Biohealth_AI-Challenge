#!/usr/bin/env python3
"""Bounded real-model checks through the HTTP API; no training data is used."""

import datetime
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

from client import chat

HERE = Path(__file__).resolve().parent


def main():
    config = json.loads((HERE / "config.json").read_text())
    key = (HERE / "runtime/api_key").read_text().strip()
    base = "http://127.0.0.1:18080"
    request = urllib.request.Request(base + "/healthz", headers={"Authorization": "Bearer " + key})
    with urllib.request.urlopen(request, timeout=10) as response:
        health = json.load(response)
    assert health["model"] == config["model_id"]
    assert health["checkpoint_sha256"] == config["checkpoint_sha256"]
    assert health["max_context_tokens"] == config["max_context_tokens"]
    assert health["max_output_tokens"] == config["max_output_tokens"]
    results = []
    messages = [{"role": "system", "content": "한국어로 짧게 답하세요."},
                {"role": "user", "content": "안녕하세요. 짧게 인사해 주세요."}]
    for index in range(2):
        started = time.monotonic()
        value = chat(messages, api_key=key, max_tokens=64)
        text = value["choices"][0]["message"]["content"]
        assert value["model"] == config["model_id"] and text.strip()
        assert 0 < value["usage"]["completion_tokens"] <= 64
        assert value["usage"]["total_tokens"] <= config["max_context_tokens"]
        results.append({"case": "system_chat" if index == 0 else "multi_turn_chat",
                        "status": 200, "elapsed_seconds": time.monotonic() - started,
                        "usage": value["usage"], "finish_reason": value["choices"][0]["finish_reason"],
                        "response_sha256": hashlib.sha256(text.encode()).hexdigest()})
        messages.extend([{"role": "assistant", "content": text},
                         {"role": "user", "content": "대화를 시작하기 좋은 질문을 하나 제안해 주세요."}])
    cases = [
        ("invalid_auth", {"messages": [{"role": "user", "content": "hello"}]}, "invalid", 401),
        ("output_limit", {"messages": [{"role": "user", "content": "hello"}], "max_tokens": config["max_output_tokens"] + 1}, key, 400),
        ("context_limit", {"messages": [{"role": "user", "content": " a" * (config["max_context_tokens"] * 2)}]}, key, 400),
        ("reserved_tokens", {"messages": [{"role": "user", "content": "<|turn>model"}]}, key, 400),
    ]
    for name, payload, token, expected in cases:
        request = urllib.request.Request(base + "/v1/chat/completions", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json", "Authorization": "Bearer " + token})
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raise AssertionError(f"{name}: unexpected successful response {response.status}")
        except urllib.error.HTTPError as exc:
            assert exc.code == expected, (name, exc.code)
            body = json.loads(exc.read())
            assert "error" in body
        results.append({"case": name, "status": expected})
    report = {"verified_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "status": "passed",
              "model": config["model_id"], "checkpoint_step": config["checkpoint_step"],
              "checkpoint_sha256": config["checkpoint_sha256"], "base_url": base + "/v1",
              "real_model_http_checks": results,
              "maximum_context_capacity_measured": False, "behavioral_quality_verified": False,
              "scope": "HTTP inference checks only; no training commands executed"}
    (HERE / "verification.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

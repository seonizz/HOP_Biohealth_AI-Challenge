#!/usr/bin/env python3
"""Call the Gemma HTTPS endpoint without installing any Python dependencies."""

import argparse
import json
from pathlib import Path
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default="안녕하세요. 한국어로 짧게 자기소개해 주세요.")
    parser.add_argument("--local", action="store_true")
    args = parser.parse_args()
    config = json.loads((Path(__file__).parent / "runtime/config.json").read_text())
    base_url = f"http://127.0.0.1:{config['port']}" if args.local else config["public_url"]
    request = urllib.request.Request(
        base_url + "/v1/chat/completions",
        data=json.dumps({
            "model": config["model"],
            "messages": [{"role": "user", "content": args.prompt}],
            "stream": False,
            "max_tokens": 256,
            "reasoning_effort": "none",
        }, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + config["api_key"]},
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        result = json.load(response)
    print(result["choices"][0]["message"]["content"])


if __name__ == "__main__":
    main()

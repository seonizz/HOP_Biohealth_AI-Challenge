#!/usr/bin/env python3
"""Call the trained model through a local or SSH-forwarded HTTP connection."""

import argparse
import json
import os
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

HERE = Path(__file__).resolve().parent
LEGACY_MODEL = "malssi-gemma4-31b-step100"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        # A configured model endpoint must not forward credentials or prompts.
        return None


def selected_model(value=None):
    value = value if value is not None else os.environ.get("MALSSI_MODEL", LEGACY_MODEL)
    if not isinstance(value, str) or not value or any(c.isspace() or ord(c) < 32 for c in value):
        raise ValueError("A nonempty model ID without whitespace is required")
    return value


def chat(messages, *, base_url="http://127.0.0.1:18080/v1", api_key=None,
         model=None, max_tokens=256, temperature=0, timeout=1800):
    endpoint = urllib.parse.urlsplit(base_url)
    if (endpoint.scheme not in ("http", "https") or not endpoint.hostname or endpoint.username
            or endpoint.password or endpoint.query or endpoint.fragment):
        raise ValueError("Use an HTTP(S) model base URL without credentials, query or fragment")
    model = selected_model(model)
    api_key = api_key or os.environ.get("MALSSI_API_KEY")
    if not api_key:
        api_key = (HERE / "runtime/api_key").read_text().strip()
    request = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=json.dumps({"model": model, "messages": messages, "max_tokens": max_tokens,
                         "temperature": temperature, "stream": False}, ensure_ascii=False).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + api_key},
    )
    opener = urllib.request.build_opener(NoRedirect())
    with opener.open(request, timeout=timeout) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", nargs="?", default="안녕하세요. 한국어로 짧게 인사해 주세요.")
    parser.add_argument("--base-url", default=os.environ.get("MALSSI_BASE_URL", "http://127.0.0.1:18080/v1"))
    parser.add_argument("--model", default=None, help="Model ID; defaults to MALSSI_MODEL or the legacy step-100 model")
    parser.add_argument("--max-tokens", type=int, default=256)
    parser.add_argument("--temperature", type=float, default=0)
    parser.add_argument("--timeout", type=float, default=1800, help="Response wait in seconds")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        result = chat([{"role": "user", "content": args.prompt}], base_url=args.base_url,
                      model=args.model, max_tokens=args.max_tokens, temperature=args.temperature, timeout=args.timeout)
    except urllib.error.HTTPError as exc:
        parser.exit(1, "API error " + str(exc.code) + ". Check the configured model, credentials and token limits.\n")
    except (OSError, ValueError) as exc:
        parser.exit(1, "API connection/configuration error: " + str(exc) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2) if args.json else result["choices"][0]["message"]["content"])


if __name__ == "__main__":
    main()

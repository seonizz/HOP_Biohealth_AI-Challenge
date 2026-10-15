#!/usr/bin/env python3
"""Forward the server's private API over the existing authenticated SSH connection."""

import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import urllib.request

HERE = Path(__file__).resolve().parent
REMOTE_API = "/home/slim/choieram/model_Training/trained_model_api"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", default="/tmp/qwen38-slim-20522.sock")
    parser.add_argument("--port", type=int, default=18080)
    args = parser.parse_args()
    if not 1 <= args.port <= 65535:
        parser.error("port must be between 1 and 65535")
    ssh = ["ssh", "-S", args.socket, "-p", "20522", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
    host = "slim@165.194.161.61"
    try:
        # Capture the credential directly; never print it or put it in argv.
        result = subprocess.run(ssh + [host, "cd /home/slim/choieram && cat " + shlex.quote(REMOTE_API + "/runtime/api_key")],
                                check=True, capture_output=True, text=True)
        key = result.stdout.strip()
        if len(key) < 32 or not key.isascii() or any(c.isspace() for c in key):
            raise ValueError("Remote API key is missing or invalid")
        runtime = HERE / "runtime"
        if runtime != runtime.resolve():
            raise ValueError("Local runtime path must not traverse symlinks")
        runtime.mkdir(mode=0o700, exist_ok=True)
        fd = os.open(runtime / "api_key", os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "w") as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(key + "\n")
        base = f"http://127.0.0.1:{args.port}"
        def health():
            req = urllib.request.Request(base + "/healthz", headers={"Authorization": "Bearer " + key})
            with urllib.request.urlopen(req, timeout=10) as response:
                value = json.load(response)
            if value.get("model") != "malssi-gemma4-31b-step100" or value.get("checkpoint_step") != 100:
                raise ValueError("Unexpected model on the forwarded port")
            return value
        try:
            info = health()
        except OSError:
            subprocess.run(ssh + ["-o", "ExitOnForwardFailure=yes", "-O", "forward", "-L",
                                  f"127.0.0.1:{args.port}:127.0.0.1:18080", host], check=True, capture_output=True)
            info = health()
        print(json.dumps({"status": info["status"], "base_url": base + "/v1", "model": info["model"],
                          "key_file": str(runtime / "api_key")}, ensure_ascii=False, indent=2))
    except subprocess.CalledProcessError:
        parser.exit(1, "SSH connection failed. Check the existing SSH socket and that the remote API is running.\n")
    except (OSError, ValueError) as exc:
        parser.exit(1, "API connection failed: " + str(exc) + "\n")


if __name__ == "__main__":
    main()

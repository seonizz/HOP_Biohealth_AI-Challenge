#!/usr/bin/env python3
"""Fill missing local model settings without starting services or downloading models."""

import argparse
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile


MODEL_DEFAULTS = {
    "MODEL_BASE_URL": "http://127.0.0.1:11434/v1",
    "MODEL_DOCKER_BASE_URL": "http://host.docker.internal:11434/v1",
    "MODEL_NAME": "gemma4:12b",
    "MODEL_PROTOCOL": "relationship_agent",
    "MODEL_TIMEOUT_MS": "600000",
}
ENV_ASSIGNMENT = re.compile(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)$")


def package_root(override):
    candidates = [Path(override).expanduser().resolve()] if override else Path(__file__).resolve().parents
    for candidate in candidates:
        if (candidate / "app").is_dir() and (candidate / "ai").is_dir():
            return candidate
    raise RuntimeError("app과 ai가 함께 있는 패키지 루트를 --root로 지정하세요.")


def env_values(content):
    """Read single-line dotenv values; keep the original file bytes unchanged."""
    values = {}
    nonempty = {}
    for line in content.splitlines():
        match = ENV_ASSIGNMENT.match(line)
        if not match:
            continue
        key, raw = match.groups()
        raw = raw.strip()
        if raw[:1] in {"'", '"', "`"}:
            closing = raw.find(raw[0], 1)
            value = raw[1:closing] if closing != -1 else raw
        else:
            value = raw.split("#", 1)[0].rstrip()
        values[key] = value
        if value.strip():
            nonempty[key] = value
    return values, nonempty


def write_secure(path, content):
    """Replace one file atomically, with no world-readable temporary contents."""
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix="." + path.name + ".", delete=False) as handle:
            temporary = Path(handle.name)
            os.chmod(temporary, 0o600)
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        os.chmod(path, 0o600)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def configure(root):
    backend = root / "app"
    setup = backend / "scripts" / "setup.js"
    if not setup.is_file():
        raise RuntimeError("app/scripts/setup.js가 없습니다.")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js를 찾을 수 없습니다. 설치 후 다시 실행하세요.")
    # setup.js creates backend secrets only when .env is absent. Its output is
    # captured because a different setup script might print secret values.
    result = subprocess.run([node, str(setup)], cwd=backend, capture_output=True, timeout=60, check=False)
    if result.returncode:
        raise RuntimeError("backend setup.js 실행이 실패했습니다(종료 코드 " + str(result.returncode) + ").")
    env_path = backend / ".env"
    if not env_path.is_file():
        raise RuntimeError("backend setup.js가 .env를 생성하지 않았습니다.")
    os.chmod(env_path, 0o600)
    original = env_path.read_bytes()
    content = original.decode("utf-8")
    values, nonempty = env_values(content)
    defaults = {**MODEL_DEFAULTS, "MODEL_API_KEY": nonempty.get("MODEL_API_KEY") or secrets.token_urlsafe(48)}
    additions = {key: nonempty.get(key, fallback) for key, fallback in defaults.items() if not values.get(key, "").strip()}
    if additions:
        newline = "\r\n" if "\r\n" in content else "\n"
        separator = "" if not content or content.endswith(("\n", "\r")) else newline
        appended = separator + newline.join(key + "=" + value for key, value in additions.items()) + newline
        write_secure(env_path, original + appended.encode("utf-8"))
        values.update(additions)

    config_path = root / "ai" / "local_api" / "runtime" / "config.json"
    if config_path.exists():
        os.chmod(config_path, 0o600)
    else:
        config_path.parent.mkdir(parents=True, exist_ok=True)
        config = {
            "model": values["MODEL_NAME"],
            "ollama_url": "http://127.0.0.1:11434",
            "port": 18081,
            "public_url": "http://localhost:18081",
            "api_key": values["MODEL_API_KEY"],
        }
        write_secure(config_path, (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description="기존 설정을 보존하며 로컬 Gemma 연결 기본값을 채웁니다.")
    parser.add_argument("--root", help="app과 ai를 포함하는 패키지 루트")
    args = parser.parse_args(argv)
    try:
        configure(package_root(args.root))
    except RuntimeError as error:
        print("설정 실패: " + str(error), file=sys.stderr)
        return 1
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        # Do not include exception messages or captured subprocess output: they
        # can contain an existing key, password, or configuration contents.
        print("설정 실패: 파일 권한, UTF-8 형식 및 backend setup 실행 상태를 확인하세요.", file=sys.stderr)
        return 1
    print("로컬 설정 완료: backend .env와 runtime/config.json의 권한을 0600으로 설정했습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

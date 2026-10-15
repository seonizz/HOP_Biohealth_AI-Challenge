#!/usr/bin/env python3
"""Apply the reviewed local 12B patch to the user's specified backend."""

from datetime import datetime, timezone
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT.parent / "app"
PATCH = ROOT / "local_api/backend_patch"
FILES = [
    "src/model.js", "src/model-context.js", "src/server.js",
    "src/relationship-retrieval.js", "src/relationship-agent.js", "src/relationship-prompts.js", "src/intake.js",
    "public/js/components/GuideCards.js", "public/js/components/ResultScreen.js",
    "public/js/components/RecordsScreen.js", "public/js/core/conversation.js",
    "public/test-result.html", "public/js/test-result.js", "public/test-data/relationship-result.json",
    "tests/relationship-retrieval.test.js", "tests/relationship-agent.test.js", "tests/relationship-ui.test.js", "tests/api.test.js",
    "compose.yaml", ".env.example",
]


def main():
    backend = BACKEND.resolve(strict=True)
    for name in FILES:
        source = PATCH / name
        if not source.is_file():
            raise RuntimeError("The complete reviewed patch is required")
        target = backend / name
        if not target.resolve().is_relative_to(backend):
            raise RuntimeError("Patch destination escapes the backend")
    env = backend / ".env"
    if not env.resolve().is_relative_to(backend):
        raise RuntimeError("Environment destination escapes the backend")
    config = json.loads((ROOT / "local_api/runtime/config.json").read_text())
    if config["model"] != "gemma4:12b" or config["ollama_url"] != "http://127.0.0.1:11434":
        raise RuntimeError("Expected the verified local 12B model")
    key = config["api_key"]
    if not isinstance(key, str) or not key.isascii() or any(c in key for c in "\r\n"):
        raise RuntimeError("Invalid local API credential")
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = backend / "runtime" / ("before_relationship_agent_" + stamp)
    if not backup.resolve().is_relative_to(backend):
        raise RuntimeError("Backup destination escapes the backend")
    backup.mkdir(parents=True, mode=0o700)
    previous = env.read_text()
    (backup / ".env").write_text(previous)
    (backup / ".env").chmod(0o600)
    for name in FILES:
        target = backend / name
        if target.exists():
            old = backup / name
            old.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, old)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PATCH / name, target)
    values = {
        "MODEL_BASE_URL": "http://127.0.0.1:11434/v1",
        "MODEL_DOCKER_BASE_URL": "http://host.docker.internal:11434/v1",
        "MODEL_API_KEY": key,
        "MODEL_NAME": "gemma4:12b",
        "MODEL_PROTOCOL": "relationship_agent",
        "MODEL_TIMEOUT_MS": "600000",
    }
    lines = [line for line in previous.splitlines() if line.partition("=")[0] not in values]
    env.write_text("\n".join(lines + [k + "=" + v for k, v in values.items()]) + "\n")
    env.chmod(0o600)
    print(json.dumps({"backend": str(backend), "model": "gemma4:12b",
                      "protocol": "relationship_agent", "changed_files": FILES,
                      "private_backup": str(backup)}, ensure_ascii=False))


if __name__ == "__main__":
    main()

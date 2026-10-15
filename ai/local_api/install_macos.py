#!/usr/bin/env python3
"""Install this gateway as a macOS login service; preserve the existing API key."""

import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
LABEL = "com.chihun.gemma-api"


def main():
    if sys.platform != "darwin":
        raise SystemExit("This installer requires macOS")
    config = ROOT / "runtime/config.json"
    if not config.is_file():
        raise SystemExit("Missing runtime/config.json; configure a model and API key first")
    settings = json.loads(config.read_text())
    if settings.get("model") != "gemma4:12b" or len(settings.get("api_key", "")) < 32:
        raise SystemExit("Review the model and API key in runtime/config.json")
    # LaunchAgents use Application Support to avoid macOS Documents permissions.
    service_dir = Path.home() / "Library/Application Support/GemmaAPI"
    service_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    service_dir.chmod(0o700)
    shutil.copy2(ROOT / "ollama_gateway.py", service_dir / "ollama_gateway.py")
    shutil.copy2(config, service_dir / "config.json")
    (service_dir / "config.json").chmod(0o600)
    plist = {
        "Label": LABEL,
        "ProgramArguments": [sys.executable, "-u", str(service_dir / "ollama_gateway.py"),
                             "--config", str(service_dir / "config.json"), "--start-ollama"],
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 10,
        "WorkingDirectory": str(service_dir),
        "StandardOutPath": str(service_dir / "gateway.stdout.log"),
        "StandardErrorPath": str(service_dir / "gateway.stderr.log"),
        "EnvironmentVariables": {"PYTHONUNBUFFERED": "1"},
    }
    encoded = plistlib.dumps(plist)
    (ROOT / (LABEL + ".plist")).write_bytes(encoded)
    launch_dir = Path.home() / "Library/LaunchAgents"
    launch_dir.mkdir(parents=True, exist_ok=True)
    launch_path = launch_dir / (LABEL + ".plist")
    launch_path.write_bytes(encoded)
    launch_path.chmod(0o600)
    domain = f"gui/{os.getuid()}"
    subprocess.run(["/bin/launchctl", "bootout", domain + "/" + LABEL],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(["/bin/launchctl", "bootstrap", domain, str(launch_path)], check=True)
    print("Installed and started:", LABEL)
    print("Service files:", service_dir)
    print("API key preserved; no credentials printed")


if __name__ == "__main__":
    main()

#!/usr/bin/env bash
set -euo pipefail
API_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
MALSSI_PYTHON="${MALSSI_PYTHON:-/home/slim/choieram/malssi-validation-20261009/.venv/bin/python}"
cd /home/slim/choieram
exec "$MALSSI_PYTHON" -B "$API_DIR/server.py" --config "$API_DIR/config.json"

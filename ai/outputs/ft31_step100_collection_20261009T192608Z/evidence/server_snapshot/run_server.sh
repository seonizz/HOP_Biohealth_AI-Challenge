#!/usr/bin/env bash
set -euo pipefail
cd /home/slim/choieram
export PYTHONDONTWRITEBYTECODE=1
exec /home/slim/choieram/malssi-validation-20261009/.venv/bin/python -B /home/slim/choieram/model_Training/trained_model_api/active_cache_server.py --config /home/slim/choieram/model_Training/trained_model_api/config.json

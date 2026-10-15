#!/usr/bin/env bash
# No installation, downloads, GPU switching, or process termination.
set -euo pipefail
MALSSI_KIT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
case "$MALSSI_KIT" in /home/slim/choieram/*) ;; *) echo 'Extract inside /home/slim/choieram first.' >&2; exit 1;; esac
MALSSI_PYTHON=/home/slim/choieram/malssi-validation-20261009/.venv/bin/python
export PYTHONDONTWRITEBYTECODE=1
cd "$MALSSI_KIT"
# Resolve the output path before the shell writes its own logs.
"$MALSSI_PYTHON" -c 'from pathlib import Path; from counseling_pipeline.stage1_preparation import beneath; p=beneath(Path("work/logs"),Path.cwd()); p.mkdir(parents=True,exist_ok=True)'
run_stage() {
  "$MALSSI_PYTHON" scripts/malssi_stage1.py "$1" --kit "$MALSSI_KIT" 2>&1 | tee -a "work/logs/$1-$(date -u +%Y%m%dT%H%M%SZ).log"
}
check_preparation() {
  "$MALSSI_PYTHON" - "$MALSSI_KIT" <<'PY'
import sys
from pathlib import Path
from counseling_pipeline.stage1_preparation import bindings,load_config,verify_bundle
from scripts.malssi_stage1 import validate_preparation
kit=Path(sys.argv[1]);verify_bundle(kit)
validate_preparation(kit/'work',bindings(kit,load_config(kit)))
print('Existing qualification report verified.')
PY
}
case "${1:-help}" in
  prepare)
    run_stage prepare
    if [[ -f work/qualification.json ]]; then check_preparation; else run_stage qualify; fi
    ;;
  start)
    bash "$MALSSI_KIT/run.sh" prepare
    if [[ ! -f work/canary_gate.json ]]; then
      if [[ ! -f work/canary/RUN.json ]]; then run_stage canary; fi
      run_stage canary-resume
    fi
    # A failed or stale canary report is rejected by train, never silently waived.
    run_stage train
    ;;
  resume) run_stage resume ;;
  evaluate) run_stage evaluate ;;
  *) echo 'Usage: bash run.sh prepare | start | resume | evaluate'; exit 2 ;;
esac

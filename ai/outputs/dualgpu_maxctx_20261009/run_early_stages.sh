#!/usr/bin/env bash
set -euo pipefail
MALSSI_ROOT=/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009
MALSSI_KIT="$MALSSI_ROOT/training_kit"
MALSSI_PYTHON=/home/slim/choieram/malssi-validation-20261009/.venv/bin/python
cd "$MALSSI_KIT"
export PYTHONDONTWRITEBYTECODE=1
# Existing bound implementation: completes the already-running 2+fresh1 canary.
"$MALSSI_PYTHON" scripts/malssi_stage1.py canary-resume --kit "$MALSSI_KIT"
# Driver is outside the immutable kit; verify its pinned deployment before use.
"$MALSSI_PYTHON" - "$MALSSI_ROOT" <<'VERIFY'
from pathlib import Path
import hashlib,json,sys
root=Path(sys.argv[1]);manifest=json.loads((root/'work/collection/early_driver_deployment.json').read_text())
for relative,entry in manifest['files'].items():
 p=root/relative
 assert p==p.resolve() and p.is_relative_to(root)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==entry['sha256'],relative
print('External early driver deployment verified.',flush=True)
VERIFY
"$MALSSI_PYTHON" "$MALSSI_ROOT/scripts/early_training_driver.py" early --kit "$MALSSI_KIT"
# A new process recreates the original optimizer/scheduler signature before restore.
"$MALSSI_PYTHON" "$MALSSI_ROOT/scripts/early_training_driver.py" continue --kit "$MALSSI_KIT"
# Full B0 uses a fresh base model, after early results and the full epoch/B1.
"$MALSSI_PYTHON" "$MALSSI_ROOT/scripts/early_training_driver.py" full-baseline --kit "$MALSSI_KIT"

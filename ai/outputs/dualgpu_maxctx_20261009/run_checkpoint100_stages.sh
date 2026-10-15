#!/usr/bin/env bash
set -euo pipefail
MALSSI_ROOT=/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009
MALSSI_KIT="$MALSSI_ROOT/training_kit"
MALSSI_PYTHON=/home/slim/choieram/malssi-validation-20261009/.venv/bin/python
cd "$MALSSI_KIT"
export PYTHONDONTWRITEBYTECODE=1
"$MALSSI_PYTHON" - "$MALSSI_ROOT" <<'VERIFY'
from pathlib import Path
import hashlib,json,sys
root=Path(sys.argv[1]);manifest=json.loads((root/'work/collection/checkpoint100_deployment.json').read_text())
for relative,entry in manifest['files'].items():
 p=root/relative
 assert p==p.resolve() and p.is_relative_to(root)
 assert hashlib.sha256(p.read_bytes()).hexdigest()==entry['sha256'],relative
print('Checkpoint100 external deployment verified.',flush=True)
VERIFY
"$MALSSI_PYTHON" "$MALSSI_ROOT/scripts/checkpoint100_eval.py" --kit "$MALSSI_KIT" --early-driver "$MALSSI_ROOT/scripts/early_training_driver.py"
"$MALSSI_PYTHON" "$MALSSI_ROOT/scripts/early_training_driver.py" continue --kit "$MALSSI_KIT"
"$MALSSI_PYTHON" "$MALSSI_ROOT/scripts/early_training_driver.py" full-baseline --kit "$MALSSI_KIT"

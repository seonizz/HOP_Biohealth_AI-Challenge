#!/usr/bin/env bash
set -euo pipefail
MALSSI_KIT=/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009/training_kit
MALSSI_ACTION=${1:?prepare/start/resume/evaluate 필요}
case "$MALSSI_ACTION" in prepare|start|resume|evaluate) ;; *) exit 2;; esac
cd /home/slim/choieram
cd "$MALSSI_KIT"
export PYTHONDONTWRITEBYTECODE=1
if [[ "$MALSSI_ACTION" != prepare ]]; then
  /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - "$MALSSI_KIT" <<'PY'
import json, sys
from pathlib import Path
from counseling_pipeline.stage1_preparation import load_config, digest, sha_file, require, GPU_UUIDS
kit = Path(sys.argv[1]); config = load_config(kit)
gate = json.loads((kit / 'work/collection/training_capacity_gate.json').read_text())
require(gate['config_sha256'] == digest(config), 'Capacity gate does not match final training config')
path = Path(gate['probe_result'])
require(path == path.resolve() and path.is_relative_to(kit.parent / 'work/probes'), 'Capacity evidence outside this task')
require(sha_file(path) == gate['probe_result_sha256'], 'Capacity evidence hash changed')
result = json.loads(path.read_text()); args = result['arguments']
require(result['status'] == 'passed' and result['adapter_changed'] is True
        and result['gpu_uuids'] == list(GPU_UUIDS)
        and result['finite_gradient_devices'] == ['cuda:0', 'cuda:1'], 'Capacity backward/update evidence failed')
require(args['mode'] == 'train' and args['length'] == config['max_length']
        and args['layer_split'] == config['layer_split']
        and args['tiled_mlp'] is config['unsloth_tiled_mlp']
        and args['target_tokens'] == 3922 and args['microsteps'] == 8
        and args['optimizer_steps'] >= 2, 'Capacity workload differs from final training config')
require(result['microsteps_completed'] == args['microsteps'] * args['optimizer_steps']
        and result['optimizer_steps_completed'] == args['optimizer_steps'], 'Capacity repetition incomplete')
print('Repeated two-GPU training capacity evidence verified.', flush=True)
PY
fi
MALSSI_SEGMENT="$(date -u +%Y%m%dT%H%M%SZ)-${MALSSI_ACTION}-$$"
MALSSI_OUT="$MALSSI_KIT/work/collection/$MALSSI_SEGMENT"
mkdir "$MALSSI_OUT"
malssi_event() {
  /home/slim/choieram/malssi-validation-20261009/.venv/bin/python - \
    "$MALSSI_OUT/events.jsonl" "$1" "$2" "$MALSSI_ACTION" "$MALSSI_SEGMENT" "${3:-}" <<'PY'
import datetime, json, sys, time
with open(sys.argv[1], 'a') as f:
    f.write(json.dumps({'event': sys.argv[2], 'exit_code': int(sys.argv[3]) if sys.argv[3] else None,
        'action': sys.argv[4], 'segment_id': sys.argv[5],
        'log_exit_code': int(sys.argv[6]) if sys.argv[6] else None,
        'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'monotonic_seconds': time.monotonic()}) + '\n')
PY
}
malssi_event start ''
nvidia-smi --id=GPU-a2ee5fcb-8ff8-01ef-334a-8948dae2f79c,GPU-a2d3d60c-4eae-7e46-45bc-146e24457642 \
  --query-gpu=timestamp,uuid,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw \
  --format=csv -l 5 > "$MALSSI_OUT/gpu_samples.csv" 2> "$MALSSI_OUT/gpu_monitor.stderr" &
MALSSI_MONITOR_PID=$!
trap 'kill "$MALSSI_MONITOR_PID" 2>/dev/null || true; wait "$MALSSI_MONITOR_PID" 2>/dev/null || true' EXIT
set +e
bash "$MALSSI_KIT/run.sh" "$MALSSI_ACTION" 2>&1 | tee "$MALSSI_OUT/console.log"
MALSSI_PIPE=("${PIPESTATUS[@]}")
MALSSI_RC=${MALSSI_PIPE[0]}
MALSSI_LOG_RC=${MALSSI_PIPE[1]}
set -e
malssi_event end "$MALSSI_RC" "$MALSSI_LOG_RC"
if [ "$MALSSI_RC" -ne 0 ]; then exit "$MALSSI_RC"; fi
exit "$MALSSI_LOG_RC"

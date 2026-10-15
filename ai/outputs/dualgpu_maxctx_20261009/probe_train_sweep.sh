#!/usr/bin/env bash
set -euo pipefail
cd /home/slim/choieram
ROOT=/home/slim/choieram/model_Training/malssi_dualgpu_maxctx_20261009
PYTHON=/home/slim/choieram/malssi-validation-20261009/.venv/bin/python
cd "$ROOT"
export PYTHONDONTWRITEBYTECODE=1
OUT="work/collection/train-sweep-$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir "$OUT"
nvidia-smi --query-gpu=timestamp,index,uuid,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv -l 5 > "$OUT/gpu_samples.csv" 2> "$OUT/gpu_monitor.stderr" &
MONITOR_PID=$!
trap 'kill "$MONITOR_PID" 2>/dev/null || true; wait "$MONITOR_PID" 2>/dev/null || true' EXIT
for LENGTH in 16384 32768 65536 131072 262144; do
    sleep 5
    printf '{"event":"probe_start","length":%s,"utc":"%s"}\n' "$LENGTH" "$(date -u +%FT%TZ)" >> "$OUT/events.jsonl"
    set +e
    "$PYTHON" scripts/capacity_probe.py --mode train --length "$LENGTH" --target-tokens 3922 --microsteps 1 > "$OUT/train-$LENGTH.log" 2>&1
    PROBE_RC=$?
    set -e
    printf '{"event":"probe_end","length":%s,"exit_code":%s,"utc":"%s"}\n' "$LENGTH" "$PROBE_RC" "$(date -u +%FT%TZ)" >> "$OUT/events.jsonl"
    tail -n 1 "$OUT/train-$LENGTH.log"
    if [ "$PROBE_RC" -ne 0 ]; then
        printf '{"event":"sweep_stopped_at_failure","length":%s,"exit_code":%s}\n' "$LENGTH" "$PROBE_RC" >> "$OUT/events.jsonl"
        exit "$PROBE_RC"
    fi
done
printf '{"event":"sweep_completed"}\n' >> "$OUT/events.jsonl"

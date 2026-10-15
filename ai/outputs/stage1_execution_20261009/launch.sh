cd /home/slim/choieram || exit 1
set -euo pipefail
export MALSSI_KIT=/home/slim/choieram/model_Training/malssi_stage1_training_20261009
cd "$MALSSI_KIT"
MALSSI_LAUNCH="work/collection/launcher-$(date -u +%Y%m%dT%H%M%SZ)-$$"
nohup bash work/run_with_metrics.sh start > "$MALSSI_LAUNCH.log" 2>&1 < /dev/null &
printf '%s\n' "$!" > "$MALSSI_LAUNCH.pid"
printf "launcher=%s pid=%s\n" "$MALSSI_LAUNCH" "$(cat "$MALSSI_LAUNCH.pid")"

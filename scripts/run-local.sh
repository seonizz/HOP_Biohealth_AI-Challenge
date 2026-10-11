#!/usr/bin/env bash
set -euo pipefail
hop_backend_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$hop_backend_root"
hop_node="${HOP_NODE_BIN:-}"
if [[ -z "$hop_node" ]] && command -v node >/dev/null; then
  hop_node="$(command -v node)"
fi
if [[ -z "$hop_node" ]]; then
  hop_node="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
fi
if [[ ! -x "$hop_node" ]] || ! "$hop_node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a===24&&b>=14?0:1)'; then
  echo 'Node.js 24.14 이상 24.x가 필요합니다. HOP_NODE_BIN에 실행 파일 경로를 지정하세요.' >&2
  exit 1
fi
if [[ ! -f .env ]]; then
  echo '먼저 상위 폴더에서 python3 tools/configure_local.py를 실행하세요.' >&2
  exit 1
fi
docker compose -p hop-grounded-local up -d postgres
hop_ready=false
for ((hop_attempt=0; hop_attempt<30; hop_attempt++)); do
  if docker compose -p hop-grounded-local exec -T postgres pg_isready -U malssi -d malssi; then
    hop_ready=true
    break
  fi
  sleep 1
done
if [[ "$hop_ready" != true ]]; then
  echo 'PostgreSQL이 준비되지 않았습니다. Docker 로그를 확인하세요.' >&2
  exit 1
fi
exec "$hop_node" --env-file=.env src/server.js

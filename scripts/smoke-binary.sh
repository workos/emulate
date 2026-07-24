#!/usr/bin/env bash
set -euo pipefail

PORT="${SMOKE_PORT:-41999}"
BIN="./dist/workos-emulate"

bun run build:binary
"$BIN" --port "$PORT" &
PID=$!
trap 'kill "$PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 50); do
  if curl -sf "http://127.0.0.1:${PORT}/oauth2/jwks" > /tmp/jwks.json; then
    break
  fi
  sleep 0.2
done

jq -e '.keys | length >= 1' /tmp/jwks.json > /dev/null
echo "smoke-binary: OK (JWKS served with $(jq '.keys | length' /tmp/jwks.json) key(s))"

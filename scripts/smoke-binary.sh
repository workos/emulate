#!/usr/bin/env bash
set -euo pipefail

BIN="./dist/workos-emulate"

bun run build:binary
node scripts/smoke-binary.mjs "$BIN"

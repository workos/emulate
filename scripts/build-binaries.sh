#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: build-binaries.sh <version>}"
OUT="dist/binaries"
rm -rf "$OUT" && mkdir -p "$OUT"

# target:artifact pairs (plain array — macOS /bin/bash 3.2 has no associative arrays)
TARGETS=(
  "bun-darwin-arm64:workos-emulate-darwin-arm64"
  "bun-darwin-x64:workos-emulate-darwin-x64"
  "bun-linux-x64:workos-emulate-linux-x64"
  "bun-linux-arm64:workos-emulate-linux-arm64"
  "bun-windows-x64:workos-emulate-windows-x64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  artifact="${entry#*:}"
  bun build --compile --target="$target" ./src/cli.ts --outfile "$OUT/$artifact"
done

(cd "$OUT" && shasum -a 256 workos-emulate-* > checksums.txt)
echo "Built $(find "$OUT" -type f | wc -l | tr -d ' ') artifacts for $VERSION"

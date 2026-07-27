#!/usr/bin/env bash
set -euo pipefail

VERSION="${1:?usage: build-binaries.sh <version>}"
OUT="dist/binaries"
rm -rf "$OUT" && mkdir -p "$OUT"

# target:artifact pairs (plain array — macOS /bin/bash 3.2 has no associative arrays)
TARGETS=(
  "bun-darwin-arm64:workos-emulate-darwin-arm64"
  "bun-darwin-x64-baseline:workos-emulate-darwin-x64"
  "bun-linux-x64-baseline:workos-emulate-linux-x64"
  "bun-linux-arm64:workos-emulate-linux-arm64"
  "bun-linux-x64-musl-baseline:workos-emulate-linux-x64-musl"
  "bun-linux-arm64-musl:workos-emulate-linux-arm64-musl"
  "bun-windows-x64-baseline:workos-emulate-windows-x64.exe"
  "bun-windows-arm64:workos-emulate-windows-arm64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  artifact="${entry#*:}"
  bun build \
    --compile \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --target="$target" \
    ./src/cli.ts \
    --outfile "$OUT/$artifact"
done

(cd "$OUT" && shasum -a 256 workos-emulate-* > checksums.txt)
echo "Built ${#TARGETS[@]} binaries plus checksums for $VERSION"

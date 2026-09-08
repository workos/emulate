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

COMPILE_TARGETS_DIR="${BUN_COMPILE_TARGETS_DIR:-.bun-compile-targets}"
rm -rf "$COMPILE_TARGETS_DIR"
mkdir -p "$COMPILE_TARGETS_DIR"

compile_package_for_target() {
  case "$1" in
    bun-darwin-arm64) printf '%s\n' '@oven/bun-darwin-aarch64' ;;
    bun-darwin-x64-baseline) printf '%s\n' '@oven/bun-darwin-x64-baseline' ;;
    bun-linux-x64-baseline) printf '%s\n' '@oven/bun-linux-x64-baseline' ;;
    bun-linux-arm64) printf '%s\n' '@oven/bun-linux-aarch64' ;;
    bun-linux-x64-musl-baseline) printf '%s\n' '@oven/bun-linux-x64-musl-baseline' ;;
    bun-linux-arm64-musl) printf '%s\n' '@oven/bun-linux-aarch64-musl' ;;
    bun-windows-x64-baseline) printf '%s\n' '@oven/bun-windows-x64-baseline' ;;
    bun-windows-arm64) printf '%s\n' '@oven/bun-windows-aarch64' ;;
    *)
      echo "Unsupported Bun compile target: $1" >&2
      return 1
      ;;
  esac
}

compile_binary_for_target() {
  case "$1" in
    bun-windows-*) printf '%s\n' 'bun.exe' ;;
    *) printf '%s\n' 'bun' ;;
  esac
}

unpack_compile_target() {
  local target="$1"
  local package="$2"
  local destination="$COMPILE_TARGETS_DIR/$target"
  local tarball

  mkdir -p "$destination"
  npm pack --pack-destination "$destination" "${package}@$(bun --version)"
  tarball="$(find "$destination" -maxdepth 1 -name '*.tgz' -print -quit)"
  test -n "$tarball"
  tar -xzf "$tarball" -C "$destination"
}

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  artifact="${entry#*:}"
  compile_package="$(compile_package_for_target "$target")"
  compile_binary="$(compile_binary_for_target "$target")"
  compile_path="$COMPILE_TARGETS_DIR/$target/package/bin/$compile_binary"

  unpack_compile_target "$target" "$compile_package"
  test -f "$compile_path"
  bun build \
    --compile \
    --compile-executable-path "$compile_path" \
    --no-compile-autoload-dotenv \
    --no-compile-autoload-bunfig \
    --target="$target" \
    ./src/cli.ts \
    --outfile "$OUT/$artifact"
done

(cd "$OUT" && shasum -a 256 workos-emulate-* > checksums.txt)
echo "Built ${#TARGETS[@]} binaries plus checksums for $VERSION"

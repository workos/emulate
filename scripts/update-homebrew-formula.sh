#!/usr/bin/env bash
set -euo pipefail

USAGE="usage: update-homebrew-formula.sh <tag> <checksums.txt> <output-formula.rb>"
TAG="${1:?$USAGE}"
CHECKSUMS="${2:?$USAGE}"
OUTPUT="${3:?$USAGE}"

VERSION="${TAG#v}"

if [[ ! -f "$CHECKSUMS" ]]; then
  echo "error: checksums file not found: $CHECKSUMS" >&2
  exit 1
fi

sha_for() {
  local artifact="$1"
  local sha
  sha="$(awk -v artifact="$artifact" '$2 == artifact { print $1 }' "$CHECKSUMS")"
  if [[ -z "$sha" ]]; then
    echo "error: no checksum for $artifact in $CHECKSUMS" >&2
    exit 1
  fi
  printf '%s' "$sha"
}

SHA_DARWIN_ARM64="$(sha_for workos-emulate-darwin-arm64)"
SHA_DARWIN_X64="$(sha_for workos-emulate-darwin-x64)"
SHA_LINUX_ARM64="$(sha_for workos-emulate-linux-arm64)"
SHA_LINUX_X64="$(sha_for workos-emulate-linux-x64)"

mkdir -p "$(dirname "$OUTPUT")"

cat > "$OUTPUT" <<EOF
class WorkosEmulate < Formula
  desc "Local WorkOS API emulator for tests and development"
  homepage "https://github.com/workos/emulate"
  version "${VERSION}"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/workos/emulate/releases/download/v${VERSION}/workos-emulate-darwin-arm64"
      sha256 "${SHA_DARWIN_ARM64}"
    end
    on_intel do
      url "https://github.com/workos/emulate/releases/download/v${VERSION}/workos-emulate-darwin-x64"
      sha256 "${SHA_DARWIN_X64}"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/workos/emulate/releases/download/v${VERSION}/workos-emulate-linux-arm64"
      sha256 "${SHA_LINUX_ARM64}"
    end
    on_intel do
      url "https://github.com/workos/emulate/releases/download/v${VERSION}/workos-emulate-linux-x64"
      sha256 "${SHA_LINUX_X64}"
    end
  end

  def install
    binary = Dir["workos-emulate-*"].first
    bin.install binary => "workos-emulate"
  end

  test do
    assert_match "workos-emulate", shell_output("#{bin}/workos-emulate --help")
  end
end
EOF

echo "Rendered $OUTPUT for version ${VERSION}"

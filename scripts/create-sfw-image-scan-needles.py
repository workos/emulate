#!/usr/bin/env python3
"""Create a private needle file for Docker image leak scans.

The input is the temporary Bun config produced by the pinned Socket Firewall
setup action. The output may contain credentials and must stay in runner temp.
This script intentionally prints only counts, never paths or values.
"""

from __future__ import annotations

import base64
import json
import os
import re
import stat
import sys
from pathlib import Path

MIN_NEEDLE_LENGTH = 8
TOKEN_RE = re.compile(rb"[A-Za-z0-9][A-Za-z0-9+/_:.,=@%?&#$~-]{7,}")
SENSITIVE_KEY_RE = re.compile(
    rb"(?i)(auth|token|password|credential|secret|registry|socket|npm|bun)"
)


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def add_needle(needles: set[bytes], value: bytes) -> None:
    value = value.strip()
    if len(value) < MIN_NEEDLE_LENGTH:
        return
    if not any(byte > 0x20 for byte in value):
        return
    needles.add(value)


def derive_needles(config_bytes: bytes) -> list[bytes]:
    needles: set[bytes] = set()
    stripped_config = config_bytes.strip()
    add_needle(needles, stripped_config)

    for raw_line in config_bytes.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(b"#"):
            continue

        if SENSITIVE_KEY_RE.search(line):
            add_needle(needles, line)
            # Capture common key/value forms without needing to know the exact
            # config format emitted by the action.
            for separator in (b"=", b":"):
                if separator in line:
                    add_needle(needles, line.split(separator, 1)[1].strip().strip(b"'\""))

        for token in TOKEN_RE.findall(line):
            if b"socket" in token.lower() or SENSITIVE_KEY_RE.search(line):
                add_needle(needles, token.strip(b"'\""))

    return sorted(needles, key=lambda item: (len(item), item))


def main() -> int:
    config_path = os.environ.get("SFW_BUN_CONFIG_FILE")
    output_path = os.environ.get("SFW_IMAGE_SCAN_NEEDLES")
    if not config_path:
        fail("SFW_BUN_CONFIG_FILE is required")
    if not output_path:
        fail("SFW_IMAGE_SCAN_NEEDLES is required")

    config = Path(config_path)
    output = Path(output_path)
    try:
        config_bytes = config.read_bytes()
    except FileNotFoundError:
        fail("Socket Firewall config was not created")

    if not config_bytes.strip():
        fail("Socket Firewall config is empty")

    needles = derive_needles(config_bytes)
    if not needles:
        fail("no scan needles could be derived from the Socket Firewall config")

    payload = {
        "schemaVersion": 1,
        "needles": [base64.b64encode(needle).decode("ascii") for needle in needles],
    }

    output.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, separators=(",", ":"))
        handle.write("\n")
    os.chmod(output, stat.S_IRUSR | stat.S_IWUSR)

    print(f"created private Docker image scan needles: count={len(needles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

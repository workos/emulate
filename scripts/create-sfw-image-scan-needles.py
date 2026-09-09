#!/usr/bin/env python3
"""Create a private needle file for Docker image leak scans.

The input is the temporary Bun config produced by the pinned Socket Firewall
setup action. The output may contain credentials and must stay in runner temp.
This script intentionally prints only counts, never paths or values.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import stat
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

MIN_NEEDLE_LENGTH = 8
BUNFIG_BEGIN = "# >>> workos-sfw >>>"
BUNFIG_END = "# <<< workos-sfw <<<"
EXPECTED_SOCKET_REGISTRY = "https://socket-firewall.workos.dev/"
EXPECTED_SOCKET_HOST = "socket-firewall.workos.dev"


class ConfigError(RuntimeError):
    """Raised when the active Socket Firewall Bun config is unsupported."""


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


def strip_toml_comment(line: str) -> str:
    quote: str | None = None
    escaped = False
    for index, char in enumerate(line):
        if quote == '"':
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quote = None
            elif char in "\r\n":
                raise ConfigError("Socket Firewall Bun config is malformed")
            continue
        if quote == "'":
            if char == "'":
                quote = None
            elif char in "\r\n":
                raise ConfigError("Socket Firewall Bun config is malformed")
            continue
        if char == "#":
            return line[:index]
        if char in ("'", '"'):
            quote = char
    if quote is not None or escaped:
        raise ConfigError("Socket Firewall Bun config is malformed")
    return line


def extract_managed_block(config_bytes: bytes) -> str:
    try:
        text = config_bytes.decode("utf-8")
    except UnicodeDecodeError as error:
        raise ConfigError("Socket Firewall Bun config is not valid UTF-8") from error
    if "\x00" in text:
        raise ConfigError("Socket Firewall Bun config is malformed")

    block_lines: list[str] = []
    inside = False
    seen_block = False
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if stripped == BUNFIG_BEGIN:
            if inside or seen_block:
                raise ConfigError("Socket Firewall Bun config has an unsupported managed block")
            inside = True
            seen_block = True
            continue
        if stripped == BUNFIG_END:
            if not inside:
                raise ConfigError("Socket Firewall Bun config has an unsupported managed block")
            inside = False
            continue
        if inside:
            block_lines.append(raw_line)
            continue
        if stripped and not stripped.startswith("#"):
            raise ConfigError("Socket Firewall Bun config contains unsupported active content")

    if inside or not seen_block:
        raise ConfigError("Socket Firewall Bun config managed block is missing")
    return "\n".join(block_lines)


def parse_bare_key(text: str, index: int) -> tuple[str, int]:
    start = index
    while index < len(text) and (text[index].isalnum() or text[index] in "_-"):
        index += 1
    if index == start:
        raise ConfigError("Socket Firewall Bun config is malformed")
    return text[start:index], index


def skip_space(text: str, index: int) -> int:
    while index < len(text) and text[index] in " \t":
        index += 1
    return index


def expect_char(text: str, index: int, expected: str) -> int:
    index = skip_space(text, index)
    if index >= len(text) or text[index] != expected:
        raise ConfigError("Socket Firewall Bun config is malformed")
    return index + 1


def parse_toml_string(text: str, index: int) -> tuple[str, int]:
    index = skip_space(text, index)
    if index >= len(text) or text[index] not in ('"', "'"):
        raise ConfigError("Socket Firewall Bun config is malformed")

    quote = text[index]
    start = index
    index += 1
    escaped = False
    while index < len(text):
        char = text[index]
        if quote == '"':
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                raw = text[start : index + 1]
                try:
                    value = json.loads(raw)
                except Exception as error:  # noqa: BLE001 - redact config values
                    raise ConfigError("Socket Firewall Bun config is malformed") from error
                if not isinstance(value, str):
                    raise ConfigError("Socket Firewall Bun config is malformed")
                return value, index + 1
            elif char in "\r\n":
                raise ConfigError("Socket Firewall Bun config is malformed")
        else:
            if char == "'":
                return text[start + 1 : index], index + 1
            if char in "\r\n":
                raise ConfigError("Socket Firewall Bun config is malformed")
        index += 1
    raise ConfigError("Socket Firewall Bun config is malformed")


def parse_registry_inline_table(text: str, index: int) -> tuple[dict[str, str], int]:
    values: dict[str, str] = {}
    index = expect_char(text, index, "{")
    while True:
        index = skip_space(text, index)
        if index >= len(text):
            raise ConfigError("Socket Firewall Bun config is malformed")
        if text[index] == "}":
            return values, index + 1

        key, index = parse_bare_key(text, index)
        if key in values:
            raise ConfigError("Socket Firewall Bun config has duplicate registry fields")
        index = expect_char(text, index, "=")
        value, index = parse_toml_string(text, index)
        values[key] = value

        index = skip_space(text, index)
        if index >= len(text):
            raise ConfigError("Socket Firewall Bun config is malformed")
        if text[index] == ",":
            index += 1
            continue
        if text[index] == "}":
            return values, index + 1
        raise ConfigError("Socket Firewall Bun config is malformed")


def parse_registry_assignment(line: str) -> dict[str, str]:
    index = skip_space(line, 0)
    key, index = parse_bare_key(line, index)
    if key != "registry":
        raise ConfigError("Socket Firewall Bun config is malformed")
    index = expect_char(line, index, "=")
    values, index = parse_registry_inline_table(line, index)
    if strip_toml_comment(line[index:]).strip():
        raise ConfigError("Socket Firewall Bun config is malformed")
    if set(values) != {"url", "token"}:
        raise ConfigError("Socket Firewall Bun config is missing required registry auth")
    return values


def validate_toml_parser_agreement(managed_block: str, registry_url: str, token: str) -> None:
    try:
        import tomllib  # type: ignore[import-not-found]
    except ModuleNotFoundError:
        return

    try:
        parsed = tomllib.loads(managed_block)
    except Exception as error:  # noqa: BLE001 - redact config values
        raise ConfigError("Socket Firewall Bun config is malformed") from error

    expected = {"install": {"registry": {"url": registry_url, "token": token}}}
    if parsed != expected:
        raise ConfigError("Socket Firewall Bun config shape is unsupported")


def parse_canonical_bun_config(config_bytes: bytes) -> tuple[str, str, bytes]:
    managed_block = extract_managed_block(config_bytes)
    active_lines: list[str] = []
    for raw_line in managed_block.splitlines():
        line = strip_toml_comment(raw_line).strip()
        if line:
            active_lines.append(line)

    if len(active_lines) != 2 or active_lines[0] != "[install]":
        raise ConfigError("Socket Firewall Bun config shape is unsupported")

    registry_values = parse_registry_assignment(active_lines[1])
    registry_url = registry_values["url"]
    token = registry_values["token"]
    validate_toml_parser_agreement(managed_block, registry_url, token)
    validate_registry_values(registry_url, token)
    return registry_url, token, managed_block.strip().encode("utf-8")


def validate_registry_values(registry_url: str, token: str) -> None:
    parsed = urlparse(registry_url)
    if (
        registry_url != EXPECTED_SOCKET_REGISTRY
        or parsed.scheme != "https"
        or parsed.hostname != EXPECTED_SOCKET_HOST
        or parsed.path != "/"
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise ConfigError("Socket Firewall registry URL is unsupported")

    token_bytes = token.encode("utf-8")
    if len(token_bytes) < MIN_NEEDLE_LENGTH or token != token.strip():
        raise ConfigError("Socket Firewall registry auth token is unsupported")
    if any(ord(char) < 0x20 or char == "\x7f" for char in token):
        raise ConfigError("Socket Firewall registry auth token is unsupported")
    if '"' in token or "\\" in token:
        raise ConfigError("Socket Firewall registry auth token is unsupported")


def derive_needles(config_bytes: bytes) -> list[bytes]:
    registry_url, token, managed_block = parse_canonical_bun_config(config_bytes)
    token_bytes = token.encode("utf-8")
    url_bytes = registry_url.encode("utf-8")
    host_bytes = EXPECTED_SOCKET_HOST.encode("ascii")

    needles: set[bytes] = set()
    add_needle(needles, token_bytes)
    add_needle(needles, url_bytes)
    add_needle(needles, host_bytes)
    add_needle(needles, managed_block)
    add_needle(needles, f'url = "{registry_url}"'.encode("utf-8"))
    add_needle(needles, f'token = "{token}"'.encode("utf-8"))
    add_needle(needles, f'//{EXPECTED_SOCKET_HOST}/:_authToken={token}'.encode("utf-8"))
    add_needle(needles, f"BUN_CONFIG_REGISTRY={registry_url}".encode("utf-8"))
    add_needle(needles, f"NPM_CONFIG_REGISTRY={registry_url}".encode("utf-8"))
    add_needle(needles, f"PNPM_CONFIG_REGISTRY={registry_url}".encode("utf-8"))

    return sorted(needles, key=lambda item: (len(item), item))


def write_needle_file(output: Path, needles: list[bytes]) -> None:
    if not needles:
        raise ConfigError("no scan needles could be derived from the Socket Firewall config")

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


def create_needle_file(config: Path, output: Path) -> list[bytes]:
    try:
        config_bytes = config.read_bytes()
    except FileNotFoundError as error:
        raise ConfigError("Socket Firewall config was not created") from error

    if not config_bytes.strip():
        raise ConfigError("Socket Firewall config is empty")
    config_identity = config.resolve()
    output_identity = output.resolve() if output.exists() else output.absolute()
    if config_identity == output_identity:
        raise ConfigError("Socket Firewall scan needle output path is unsupported")

    needles = derive_needles(config_bytes)
    write_needle_file(output, needles)
    return needles


def canonical_config(token: str) -> bytes:
    return (
        f"\n{BUNFIG_BEGIN}\n"
        "[install]\n"
        f'registry = {{ url = "{EXPECTED_SOCKET_REGISTRY}", token = "{token}" }}\n'
        f"{BUNFIG_END}\n"
    ).encode("utf-8")


def decode_payload_needles(path: Path) -> set[bytes]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    return {base64.b64decode(item, validate=True) for item in payload["needles"]}


def run_self_test() -> None:
    token = "SYNTHETIC_SOCKET_TOKEN_GENERATOR_20260909"
    with tempfile.TemporaryDirectory(prefix="sfw-needle-generator-self-test.") as tmp:
        tmp_path = Path(tmp)
        config = tmp_path / ".bunfig.toml"
        output = tmp_path / "needles.json"
        config.write_bytes(canonical_config(token))
        needles = create_needle_file(config, output)
        decoded = decode_payload_needles(output)

        required = {
            token.encode("utf-8"),
            EXPECTED_SOCKET_REGISTRY.encode("utf-8"),
            EXPECTED_SOCKET_HOST.encode("ascii"),
        }
        if not required.issubset(decoded) or set(needles) != decoded:
            raise ConfigError("self-test did not preserve required private needles")
        if b"registry" in decoded or b"url" in decoded or b"token" in decoded:
            raise ConfigError("self-test produced an unsafe bare TOML key needle")
        if stat.S_IMODE(output.stat().st_mode) != 0o600:
            raise ConfigError("self-test needle file permissions are not private")

        bad_config = tmp_path / "bad.bunfig.toml"
        bad_output = tmp_path / "bad-needles.json"
        bad_config.write_bytes(
            (
                f"{BUNFIG_BEGIN}\n"
                "[install]\n"
                f'registry = {{ url = "{EXPECTED_SOCKET_REGISTRY}" }}\n'
                f"{BUNFIG_END}\n"
            ).encode("utf-8")
        )
        try:
            create_needle_file(bad_config, bad_output)
        except ConfigError:
            pass
        else:
            raise ConfigError("self-test unsupported active config did not fail closed")
        if bad_output.exists():
            raise ConfigError("self-test failure left a private needle file behind")

        unsupported = tmp_path / "unsupported.bunfig.toml"
        unsupported.write_bytes(
            (
                f"{BUNFIG_BEGIN}\n"
                "[install]\n"
                f'registry = {{ url = "{EXPECTED_SOCKET_REGISTRY}", token = "{token}" }}\n'
                "extra = true\n"
                f"{BUNFIG_END}\n"
            ).encode("utf-8")
        )
        try:
            derive_needles(unsupported.read_bytes())
        except ConfigError:
            pass
        else:
            raise ConfigError("self-test extra active config did not fail closed")

    print("SFW image scan needle generator self-test passed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Create private Docker image scan needles")
    parser.add_argument("--self-test", action="store_true", help="run generator controls and exit")
    args = parser.parse_args(argv)

    try:
        if args.self_test:
            run_self_test()
            return 0

        config_path = os.environ.get("SFW_BUN_CONFIG_FILE")
        output_path = os.environ.get("SFW_IMAGE_SCAN_NEEDLES")
        if not config_path:
            raise ConfigError("SFW_BUN_CONFIG_FILE is required")
        if not output_path:
            raise ConfigError("SFW_IMAGE_SCAN_NEEDLES is required")

        needles = create_needle_file(Path(config_path), Path(output_path))
    except ConfigError as error:
        fail(str(error))

    print(f"created private Docker image scan needles: count={len(needles)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

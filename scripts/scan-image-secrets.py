#!/usr/bin/env python3
"""Fail-closed Docker/OCI image scanner for ephemeral install config leaks.

The scanner inspects image config/history metadata and every layer tar member,
including deleted lower-layer files. Diagnostics intentionally redact matched
values, filenames, and archive member paths.
"""

from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

DOCKER_ARCHIVE_MANIFEST = "manifest.json"
OCI_LAYOUT = "oci-layout"
OCI_INDEX = "index.json"

INDEX_MEDIA_TYPES = {
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
}
MANIFEST_MEDIA_TYPES = {
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
}
CONFIG_MEDIA_TYPES = {
    "application/vnd.oci.image.config.v1+json",
    "application/vnd.docker.container.image.v1+json",
}
TAR_LAYER_MEDIA_TYPES = {
    "application/vnd.oci.image.layer.v1.tar",
    "application/vnd.oci.image.layer.v1.tar+gzip",
    "application/vnd.oci.image.layer.nondistributable.v1.tar",
    "application/vnd.oci.image.layer.nondistributable.v1.tar+gzip",
    "application/vnd.docker.image.rootfs.diff.tar",
    "application/vnd.docker.image.rootfs.diff.tar.gzip",
    "application/vnd.docker.image.rootfs.foreign.diff.tar",
    "application/vnd.docker.image.rootfs.foreign.diff.tar.gzip",
}
JSON_BLOB_MEDIA_TYPES = {
    "application/vnd.in-toto+json",
    "application/vnd.dsse.envelope.v1+json",
    "application/vnd.oci.empty.v1+json",
}

# These catch committed package-manager config files or credential declarations
# even if the dynamic credential value itself is transformed. They are not
# printed when matched.
FORBIDDEN_PATH_NAMES = {
    ".bunfig.toml",
    "bunfig.toml",
}
FORBIDDEN_CONTENT_MARKERS = [
    b"PUBLIC_SOCKET_FIREWALL_TOKEN",
    b"SOCKET_FIREWALL_TOKEN",
]


class ScanError(RuntimeError):
    """Raised when an archive cannot be fully inspected."""


@dataclass
class Stats:
    images: int = 0
    layers: int = 0
    paths: int = 0
    metadata: int = 0
    blobs: int = 0
    hits: dict[str, int] = field(default_factory=dict)

    def hit(self, kind: str) -> None:
        self.hits[kind] = self.hits.get(kind, 0) + 1

    @property
    def hit_count(self) -> int:
        return sum(self.hits.values())

    def merge(self, other: "Stats") -> None:
        self.images += other.images
        self.layers += other.layers
        self.paths += other.paths
        self.metadata += other.metadata
        self.blobs += other.blobs
        for kind, count in other.hits.items():
            self.hits[kind] = self.hits.get(kind, 0) + count


def load_needles(path: Path) -> list[bytes]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as error:  # noqa: BLE001 - fail closed with concise cause
        raise ScanError("needle file is not valid JSON") from error

    encoded = payload.get("needles")
    if payload.get("schemaVersion") != 1 or not isinstance(encoded, list):
        raise ScanError("needle file schema is invalid")

    needles: list[bytes] = []
    for item in encoded:
        if not isinstance(item, str):
            raise ScanError("needle file contains a non-string entry")
        try:
            value = base64.b64decode(item, validate=True)
        except Exception as error:  # noqa: BLE001
            raise ScanError("needle file contains invalid base64") from error
        if len(value) >= 8:
            needles.append(value)

    # Deduplicate while preserving deterministic order.
    seen: set[bytes] = set()
    unique = []
    for needle in needles:
        if needle not in seen:
            unique.append(needle)
            seen.add(needle)

    if not unique:
        raise ScanError("needle file contained no usable scan needles")
    return unique


def check_bytes(data: bytes, needles: Iterable[bytes], stats: Stats, location: str) -> None:
    del location  # Locations are intentionally redacted from diagnostics.
    lower_data = data.lower()
    for needle in needles:
        if needle and needle in data:
            stats.hit("dynamic-needle")
    for marker in FORBIDDEN_CONTENT_MARKERS:
        if marker.lower() in lower_data:
            stats.hit("credential-marker")


def check_path(name: str, needles: Iterable[bytes], stats: Stats) -> None:
    encoded = name.encode("utf-8", "surrogateescape")
    for part in name.replace("\\", "/").split("/"):
        normalized = part[4:] if part.startswith(".wh.") else part
        if normalized in FORBIDDEN_PATH_NAMES:
            stats.hit("forbidden-package-config-path")
    for needle in needles:
        if needle and needle in encoded:
            stats.hit("dynamic-needle-in-path")


def safe_tar_members(tar: tarfile.TarFile) -> dict[str, tarfile.TarInfo]:
    members: dict[str, tarfile.TarInfo] = {}
    for member in tar.getmembers():
        name = member.name
        normalized = Path(name)
        if normalized.is_absolute() or ".." in normalized.parts:
            raise ScanError("archive contains an unsafe member path")
        if name in members:
            raise ScanError("archive contains duplicate member paths")
        members[name] = member
    return members


def read_tar_member(tar: tarfile.TarFile, member: tarfile.TarInfo) -> bytes:
    if member.size > 1024 * 1024 * 1024:
        raise ScanError("archive member is too large to inspect")
    fileobj = tar.extractfile(member)
    if fileobj is None:
        raise ScanError("archive member could not be read")
    return fileobj.read()


def open_archive(path: Path) -> tuple[tarfile.TarFile, dict[str, tarfile.TarInfo]]:
    try:
        tar = tarfile.open(path, "r:*")
    except tarfile.TarError as error:
        raise ScanError("image archive is not a readable tar archive") from error
    return tar, safe_tar_members(tar)


def read_named_member(
    tar: tarfile.TarFile, members: dict[str, tarfile.TarInfo], name: str
) -> bytes:
    member = members.get(name)
    if member is None:
        raise ScanError("referenced archive member is missing")
    if not member.isfile():
        raise ScanError("referenced archive member is not a file")
    return read_tar_member(tar, member)


def parse_json(data: bytes, description: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except Exception as error:  # noqa: BLE001
        raise ScanError(f"{description} is not valid JSON") from error


def maybe_decompress_layer(data: bytes, media_type: str | None) -> bytes:
    if media_type and media_type.endswith("+zstd"):
        raise ScanError("zstd-compressed layers are not supported")
    if media_type and "gzip" in media_type:
        try:
            return gzip.decompress(data)
        except Exception as error:  # noqa: BLE001
            raise ScanError("gzip layer could not be decompressed") from error
    if data.startswith(b"\x1f\x8b"):
        try:
            return gzip.decompress(data)
        except Exception as error:  # noqa: BLE001
            raise ScanError("gzip layer could not be decompressed") from error
    return data


def scan_layer_bytes(
    data: bytes,
    needles: Iterable[bytes],
    stats: Stats,
    media_type: str | None = None,
) -> None:
    layer = maybe_decompress_layer(data, media_type)
    stats.layers += 1
    check_bytes(layer, needles, stats, "layer-tar")

    try:
        with tarfile.open(fileobj=io.BytesIO(layer), mode="r:") as layer_tar:
            for member in layer_tar:
                stats.paths += 1
                check_path(member.name, needles, stats)
                if member.linkname:
                    check_path(member.linkname, needles, stats)
                if member.isfile():
                    fileobj = layer_tar.extractfile(member)
                    if fileobj is None:
                        raise ScanError("layer file member could not be read")
                    check_bytes(fileobj.read(), needles, stats, "layer-file")
    except tarfile.TarError as error:
        raise ScanError("layer is not a readable tar archive") from error


def scan_metadata(data: bytes, needles: Iterable[bytes], stats: Stats) -> None:
    stats.metadata += 1
    check_bytes(data, needles, stats, "metadata")


def scan_docker_archive(path: Path, needles: Iterable[bytes]) -> Stats:
    stats = Stats()
    tar, members = open_archive(path)
    try:
        if DOCKER_ARCHIVE_MANIFEST not in members:
            raise ScanError("Docker archive manifest is missing")
        manifest_bytes = read_named_member(tar, members, DOCKER_ARCHIVE_MANIFEST)
        scan_metadata(manifest_bytes, needles, stats)
        manifest = parse_json(manifest_bytes, "Docker archive manifest")
        if not isinstance(manifest, list) or not manifest:
            raise ScanError("Docker archive manifest has no images")

        for image in manifest:
            if not isinstance(image, dict):
                raise ScanError("Docker archive image entry is invalid")
            config_name = image.get("Config")
            layers = image.get("Layers")
            if not isinstance(config_name, str) or not isinstance(layers, list) or not layers:
                raise ScanError("Docker archive image entry is incomplete")
            stats.images += 1
            config_bytes = read_named_member(tar, members, config_name)
            scan_metadata(config_bytes, needles, stats)
            parse_json(config_bytes, "Docker image config")
            for layer_name in layers:
                if not isinstance(layer_name, str):
                    raise ScanError("Docker archive layer reference is invalid")
                layer_bytes = read_named_member(tar, members, layer_name)
                scan_layer_bytes(layer_bytes, needles, stats)
    finally:
        tar.close()

    if stats.images == 0 or stats.layers == 0:
        raise ScanError("Docker archive did not contain any complete images")
    return stats


def blob_path_from_digest(digest: str) -> str:
    if not digest.startswith("sha256:"):
        raise ScanError("only sha256 OCI digests are supported")
    hex_digest = digest.split(":", 1)[1]
    if len(hex_digest) != 64 or any(ch not in "0123456789abcdef" for ch in hex_digest):
        raise ScanError("OCI digest is malformed")
    return f"blobs/sha256/{hex_digest}"


def verify_digest(data: bytes, digest: str) -> None:
    expected = digest.split(":", 1)[1]
    actual = hashlib.sha256(data).hexdigest()
    if actual != expected:
        raise ScanError("OCI blob digest mismatch")


def read_oci_blob(
    tar: tarfile.TarFile,
    members: dict[str, tarfile.TarInfo],
    descriptor: dict[str, Any],
) -> bytes:
    digest = descriptor.get("digest")
    if not isinstance(digest, str):
        raise ScanError("OCI descriptor is missing a digest")
    data = read_named_member(tar, members, blob_path_from_digest(digest))
    verify_digest(data, digest)
    expected_size = descriptor.get("size")
    if expected_size is not None and expected_size != len(data):
        raise ScanError("OCI descriptor size mismatch")
    return data


def scan_oci_descriptor(
    tar: tarfile.TarFile,
    members: dict[str, tarfile.TarInfo],
    descriptor: dict[str, Any],
    needles: Iterable[bytes],
    stats: Stats,
    visited: set[str],
) -> None:
    media_type = descriptor.get("mediaType")
    if not isinstance(media_type, str):
        raise ScanError("OCI descriptor mediaType is missing")
    data = read_oci_blob(tar, members, descriptor)
    stats.blobs += 1

    digest = descriptor["digest"]
    if digest in visited:
        return
    visited.add(digest)

    if media_type in INDEX_MEDIA_TYPES:
        scan_metadata(data, needles, stats)
        index = parse_json(data, "OCI image index")
        descriptors = index.get("manifests")
        if not isinstance(descriptors, list) or not descriptors:
            raise ScanError("OCI index contains no manifests")
        for child in descriptors:
            if not isinstance(child, dict):
                raise ScanError("OCI index child descriptor is invalid")
            scan_oci_descriptor(tar, members, child, needles, stats, visited)
        return

    if media_type in MANIFEST_MEDIA_TYPES:
        scan_metadata(data, needles, stats)
        manifest = parse_json(data, "OCI image manifest")
        config_desc = manifest.get("config")
        layer_descs = manifest.get("layers")
        if not isinstance(config_desc, dict) or not isinstance(layer_descs, list):
            raise ScanError("OCI manifest is incomplete")

        config_type = config_desc.get("mediaType")
        config_data = read_oci_blob(tar, members, config_desc)
        stats.blobs += 1
        if isinstance(config_type, str) and (config_type in CONFIG_MEDIA_TYPES or config_type.endswith("+json")):
            stats.images += 1 if config_type in CONFIG_MEDIA_TYPES else 0
            scan_metadata(config_data, needles, stats)
        else:
            raise ScanError("OCI config mediaType is unsupported")

        for layer_desc in layer_descs:
            if not isinstance(layer_desc, dict):
                raise ScanError("OCI layer descriptor is invalid")
            layer_type = layer_desc.get("mediaType")
            if not isinstance(layer_type, str):
                raise ScanError("OCI layer mediaType is missing")
            layer_data = read_oci_blob(tar, members, layer_desc)
            stats.blobs += 1
            if layer_type in TAR_LAYER_MEDIA_TYPES or ".tar" in layer_type:
                scan_layer_bytes(layer_data, needles, stats, layer_type)
            elif layer_type in JSON_BLOB_MEDIA_TYPES or layer_type.endswith("+json"):
                scan_metadata(layer_data, needles, stats)
            else:
                raise ScanError("OCI layer mediaType is unsupported")
        return

    if media_type in CONFIG_MEDIA_TYPES or media_type in JSON_BLOB_MEDIA_TYPES or media_type.endswith("+json"):
        scan_metadata(data, needles, stats)
        return

    raise ScanError("OCI descriptor mediaType is unsupported")


def scan_oci_archive(path: Path, needles: Iterable[bytes]) -> Stats:
    stats = Stats()
    tar, members = open_archive(path)
    try:
        if OCI_LAYOUT not in members or OCI_INDEX not in members:
            raise ScanError("OCI layout markers are missing")
        layout_bytes = read_named_member(tar, members, OCI_LAYOUT)
        scan_metadata(layout_bytes, needles, stats)
        index_bytes = read_named_member(tar, members, OCI_INDEX)
        scan_metadata(index_bytes, needles, stats)
        index = parse_json(index_bytes, "OCI root index")
        descriptors = index.get("manifests")
        if not isinstance(descriptors, list) or not descriptors:
            raise ScanError("OCI root index contains no manifests")
        visited: set[str] = set()
        for descriptor in descriptors:
            if not isinstance(descriptor, dict):
                raise ScanError("OCI root descriptor is invalid")
            scan_oci_descriptor(tar, members, descriptor, needles, stats, visited)
    finally:
        tar.close()

    if stats.images == 0 or stats.layers == 0:
        raise ScanError("OCI archive did not contain any complete image layers")
    return stats


def scan_auto_archive(path: Path, needles: Iterable[bytes]) -> Stats:
    tar, members = open_archive(path)
    try:
        member_names = set(members)
    finally:
        tar.close()
    if OCI_LAYOUT in member_names and OCI_INDEX in member_names:
        return scan_oci_archive(path, needles)
    if DOCKER_ARCHIVE_MANIFEST in member_names:
        return scan_docker_archive(path, needles)
    raise ScanError("archive is neither Docker save nor OCI layout format")


def scan_docker_image(image: str, needles: Iterable[bytes]) -> Stats:
    if shutil.which("docker") is None:
        raise ScanError("docker CLI is not available")
    with tempfile.TemporaryDirectory(prefix="image-secret-scan.") as tmp:
        archive = Path(tmp) / "image.tar"
        try:
            subprocess.run(
                ["docker", "image", "save", "--output", str(archive), image],
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                text=True,
            )
        except subprocess.CalledProcessError as error:
            raise ScanError("docker image could not be exported for scanning") from error
        return scan_docker_archive(archive, needles)


def add_blob(members: dict[str, bytes], payload: bytes) -> dict[str, Any]:
    digest = hashlib.sha256(payload).hexdigest()
    members[f"blobs/sha256/{digest}"] = payload
    return {"mediaType": "application/vnd.oci.image.manifest.v1+json", "digest": f"sha256:{digest}", "size": len(payload)}


def make_layer(files: dict[str, bytes]) -> bytes:
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        for name, payload in files.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(payload)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(payload))
    return gzip.compress(raw.getvalue())


def make_oci_fixture(path: Path, *, leak: bool, needle: bytes) -> None:
    blobs: dict[str, bytes] = {}

    config = json.dumps(
        {
            "architecture": "amd64",
            "os": "linux",
            "config": {"Env": ["PATH=/usr/local/bin"]},
            "rootfs": {"type": "layers", "diff_ids": []},
            "history": [{"created_by": "fixture"}],
        },
        separators=(",", ":"),
    ).encode()
    config_digest = hashlib.sha256(config).hexdigest()
    blobs[f"blobs/sha256/{config_digest}"] = config
    config_desc = {
        "mediaType": "application/vnd.oci.image.config.v1+json",
        "digest": f"sha256:{config_digest}",
        "size": len(config),
    }

    first_files = {"app/ok.txt": b"clean"}
    if leak:
        first_files["app/.bunfig.toml"] = b"registry=https://example.invalid/\n" + needle + b"\n"
    layer1 = make_layer(first_files)
    layer1_digest = hashlib.sha256(layer1).hexdigest()
    blobs[f"blobs/sha256/{layer1_digest}"] = layer1

    layer2 = make_layer({"app/.wh..bunfig.toml": b""} if leak else {"app/other.txt": b"clean"})
    layer2_digest = hashlib.sha256(layer2).hexdigest()
    blobs[f"blobs/sha256/{layer2_digest}"] = layer2

    manifest = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.manifest.v1+json",
            "config": config_desc,
            "layers": [
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": f"sha256:{layer1_digest}",
                    "size": len(layer1),
                },
                {
                    "mediaType": "application/vnd.oci.image.layer.v1.tar+gzip",
                    "digest": f"sha256:{layer2_digest}",
                    "size": len(layer2),
                },
            ],
        },
        separators=(",", ":"),
    ).encode()
    manifest_digest = hashlib.sha256(manifest).hexdigest()
    blobs[f"blobs/sha256/{manifest_digest}"] = manifest

    nested_index = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.manifest.v1+json",
                    "digest": f"sha256:{manifest_digest}",
                    "size": len(manifest),
                    "platform": {"os": "linux", "architecture": "amd64"},
                }
            ],
        },
        separators=(",", ":"),
    ).encode()
    nested_digest = hashlib.sha256(nested_index).hexdigest()
    blobs[f"blobs/sha256/{nested_digest}"] = nested_index

    root_index = json.dumps(
        {
            "schemaVersion": 2,
            "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [
                {
                    "mediaType": "application/vnd.oci.image.index.v1+json",
                    "digest": f"sha256:{nested_digest}",
                    "size": len(nested_index),
                }
            ],
        },
        separators=(",", ":"),
    ).encode()

    with tarfile.open(path, mode="w") as tar:
        for name, payload in {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}', "index.json": root_index, **blobs}.items():
            info = tarfile.TarInfo(name=name)
            info.size = len(payload)
            info.mode = 0o600
            tar.addfile(info, io.BytesIO(payload))


def run_self_test() -> None:
    needle = b"SCANNER_DELETED_LAYER_CANARY_20260909"
    with tempfile.TemporaryDirectory(prefix="image-secret-scan-self-test.") as tmp:
        tmp_path = Path(tmp)
        needle_file = tmp_path / "needles.json"
        needle_file.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "needles": [base64.b64encode(needle).decode("ascii")],
                }
            ),
            encoding="utf-8",
        )
        needles = load_needles(needle_file)

        clean = tmp_path / "clean.oci.tar"
        make_oci_fixture(clean, leak=False, needle=needle)
        clean_stats = scan_oci_archive(clean, needles)
        if clean_stats.hit_count:
            raise ScanError("self-test clean fixture produced a match")

        leaky = tmp_path / "leaky.oci.tar"
        make_oci_fixture(leaky, leak=True, needle=needle)
        leaky_stats = scan_oci_archive(leaky, needles)
        if leaky_stats.hit_count == 0:
            raise ScanError("self-test did not catch a deleted lower-layer leak")

        malformed = tmp_path / "malformed.oci.tar"
        with tarfile.open(malformed, mode="w") as tar:
            payload = b'{"schemaVersion":2,"manifests":[]}'
            for name, data in {"oci-layout": b'{"imageLayoutVersion":"1.0.0"}', "index.json": payload}.items():
                info = tarfile.TarInfo(name=name)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
        try:
            scan_oci_archive(malformed, needles)
        except ScanError:
            pass
        else:
            raise ScanError("self-test malformed OCI layout did not fail closed")

    print("image secret scanner self-test passed")


def print_success(stats: Stats) -> None:
    print(
        "image secret scan passed: "
        f"images={stats.images} layers={stats.layers} paths={stats.paths} "
        f"metadata={stats.metadata}"
    )


def print_failure(stats: Stats) -> None:
    categories = ",".join(f"{key}:{stats.hits[key]}" for key in sorted(stats.hits))
    print(
        "error: forbidden Docker image material detected; "
        f"hitCount={stats.hit_count}; categories={categories}; diagnostics=redacted",
        file=sys.stderr,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Scan Docker/OCI images for private install config leaks")
    parser.add_argument("--needles-file", type=Path, help="private JSON needle file created in runner temp")
    parser.add_argument("--docker-image", help="local Docker image tag to export and scan")
    parser.add_argument("--docker-archive", type=Path, help="docker save archive to scan")
    parser.add_argument("--oci-archive", type=Path, help="OCI image-layout archive to scan")
    parser.add_argument("--self-test", action="store_true", help="run scanner controls and exit")
    args = parser.parse_args()

    try:
        if args.self_test:
            run_self_test()
            return 0

        targets = [args.docker_image, args.docker_archive, args.oci_archive]
        if sum(value is not None for value in targets) != 1:
            raise ScanError("choose exactly one image/archive target")
        if args.needles_file is None:
            raise ScanError("--needles-file is required")
        needles = load_needles(args.needles_file)

        if args.docker_image:
            stats = scan_docker_image(args.docker_image, needles)
        elif args.docker_archive:
            stats = scan_docker_archive(args.docker_archive, needles)
        else:
            stats = scan_oci_archive(args.oci_archive, needles)

        if stats.hit_count:
            print_failure(stats)
            return 1
        print_success(stats)
        return 0
    except ScanError as error:
        print(f"error: image secret scan failed closed: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

"""Optional HAMi-core runtime, scoped to one GPUQ attempt."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
from typing import Any, Mapping


def validate_hami_request(
    enabled: Any, sm_percent: Any, share_gpu: bool, env: Mapping[str, str]
) -> tuple[bool, int | None]:
    if not isinstance(enabled, bool):
        raise ValueError("hami_core must be boolean")
    if not enabled:
        if sm_percent is not None:
            raise ValueError("sm_percent requires --hami")
        return False, None
    if not share_gpu:
        raise ValueError("--hami requires --share and an explicit GPU")
    if sm_percent is None:
        sm_percent = 100
    if (
        isinstance(sm_percent, bool)
        or not isinstance(sm_percent, int)
        or not 1 <= sm_percent <= 100
    ):
        raise ValueError("--sm-percent must be an integer from 1 to 100")
    controlled = {
        "LD_PRELOAD",
        "GPU_CORE_UTILIZATION_POLICY",
        "ACTIVE_OOM_KILLER",
        "CUDA_DISABLE_CONTROL",
        "CUDA_OVERSUBSCRIBE",
        "CUDA_TASK_PRIORITY",
        "RECORD_KERNEL_INTERVAL",
        "CONTAINER_VGPU_MOUNT",
        "POD_UID",
        "CONTAINER_NAME",
    }
    if any(
        key in controlled
        or key.startswith(
            ("CUDA_DEVICE_MEMORY_", "CUDA_DEVICE_SM_", "HAMI_", "GPUQ_HAMI_")
        )
        for key in env
    ):
        raise ValueError(
            "HAMi runtime environment is managed by gpuq; remove conflicting --env settings"
        )
    return True, sm_percent


def verify_library(path: Path, expected_sha: str) -> None:
    if not path.is_absolute() or any(c.isspace() or c == ":" for c in str(path)):
        raise ValueError(
            "HAMi library requires an absolute path without spaces or colons"
        )
    try:
        with path.open('rb') as stream:data = stream.read(4)
    except OSError as exc:
        raise ValueError("HAMi library is unavailable") from exc
    if not data.startswith(b"\x7fELF"):
        raise ValueError("HAMi library format mismatch")


def runtime_library(archive: Path, sm_percent: int) -> tuple[Path, str]:
    directory = archive.resolve().parent / "hami"
    try:
        meta = json.loads((directory / "manifest.json").read_text())
        sha = meta.get("sha256") or ""
        if sm_percent < 100 and meta.get("sm_supported") is not True:
            raise ValueError("SM limiting has not passed host validation")
        library = directory / "libvgpu.so"
        verify_library(library, sha)
        return library, sha
    except (OSError, KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ValueError("HAMi runtime is not installed in this release") from exc


def runtime_environment(
    archive: Path, attempt: Mapping[str, Any], job: Mapping[str, Any]
) -> dict[str, str]:
    if not job.get("hami_core"):
        return {}
    library, sha = runtime_library(archive, int(job["sm_percent"]))
    directory = Path(attempt["control_dir"]) / "hami"
    directory.mkdir(mode=0o700, exist_ok=True)
    return {
        "LD_PRELOAD": str(library),
        "GPUQ_HAMI_LIBRARY_SHA256": sha,
        "CUDA_DEVICE_MEMORY_LIMIT": f"{job['vram_mb']}m",
        "CUDA_DEVICE_MEMORY_LIMIT_0": f"{job['vram_mb']}m",
        "CUDA_DEVICE_SM_LIMIT": str(job["sm_percent"]),
        "CUDA_DEVICE_SM_LIMIT_0": str(job["sm_percent"]),
        "CUDA_DEVICE_MEMORY_SHARED_CACHE": str(directory / "usage.cache"),
        "GPU_CORE_UTILIZATION_POLICY": (
            "force" if int(job["sm_percent"]) < 100 else "disable"
        ),
        "HAMI_HOST_PID_MODE": "self",
        "ACTIVE_OOM_KILLER": "false",
        "LIBCUDA_LOG_LEVEL": "0",
    }


def verify_launch_environment(environment: Mapping[str, str]) -> None:
    sha = environment.get("GPUQ_HAMI_LIBRARY_SHA256")
    if environment.get("CUDA_DEVICE_MEMORY_LIMIT") is not None:
        verify_library(Path(environment.get("LD_PRELOAD", "")), sha)
        cache = Path(environment.get("CUDA_DEVICE_MEMORY_SHARED_CACHE", ""))
        expected = Path(environment["GPUQ_CONTROL_DIR"]) / "hami" / "usage.cache"
        if cache != expected or environment.get("ACTIVE_OOM_KILLER") != "false":
            raise ValueError("HAMi launch environment does not match attempt")

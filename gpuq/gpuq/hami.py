"""Optional HAMi-core runtime, scoped to one GPUQ attempt."""

from __future__ import annotations

from pathlib import Path
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


def runtime_library(archive: Path) -> Path:
    library = archive.resolve().parent / "hami" / "libvgpu.so"
    if not library.is_file():
        raise ValueError("HAMi runtime library is unavailable")
    return library


def runtime_environment(
    archive: Path, attempt: Mapping[str, Any], job: Mapping[str, Any]
) -> dict[str, str]:
    if not job.get("hami_core"):
        return {}
    library = runtime_library(archive)
    directory = Path(attempt["control_dir"]) / "hami"
    directory.mkdir(mode=0o700, exist_ok=True)
    return {
        "LD_PRELOAD": str(library),
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

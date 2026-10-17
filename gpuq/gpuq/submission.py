from __future__ import annotations

import os
import re
import uuid
from pathlib import Path
from typing import Any

from .constants import (
    CheckpointCapability,
    DispatchMode,
    MAX_PRIORITY,
    MIN_PRIORITY,
    RestartPolicy,
)
from .elastic import compatible_world_sizes
from .protocol import DEFAULT_MAX_REQUEST_BYTES, encode_request
from .util import validate_env, validate_label
from .sharing import validate_sharing
from .hami import validate_hami_request
from .policy import validate_yield_policy


RESERVED_ENV = {
    "CUDA_VISIBLE_DEVICES",
    "NVIDIA_VISIBLE_DEVICES",
    "GPUQ_JOB_ID",
    "GPUQ_ATTEMPT_ID",
    "GPUQ_CONTROL_DIR",
    "GPUQ_ASSIGNED_GPU_UUIDS",
    "GPUQ_ASSIGNED_GPU_INDICES",
    "GPUQ_ASSIGNED_GPU_COUNT",
    "GPUQ_ACTUAL_GPU_COUNT",
    "GPUQ_MIN_GPU_COUNT",
    "GPUQ_MAX_GPU_COUNT",
    "GPUQ_PREVIOUS_GPU_COUNT",
    "GPUQ_WORLD_SIZE",
    "GPUQ_MIN_WORLD_SIZE",
    "GPUQ_MAX_WORLD_SIZE",
    "GPUQ_PREVIOUS_WORLD_SIZE",
    "GPUQ_TARGET_GLOBAL_BATCH_SIZE",
    "GPUQ_PER_DEVICE_MICRO_BATCH_SIZE",
    "GPUQ_ALLOWED_GPU_COUNTS",
    "GPUQ_RESUME_CHECKPOINT",
}
UNSUPPORTED_EXECUTABLES = {
    "docker",
    "podman",
    "systemd-run",
    "tmux",
    "screen",
    "sudo",
    "su",
}
SUBMISSION_KEYS = {
    "after",
    "preempt_idle_only",
    "preempt_opt_in_only",
    "yield_policy",
    "hami_core",
    "sm_percent",
    "share_gpu",
    "vram_mb",
    "submit_key",
    "name",
    "owner",
    "priority",
    "dispatch_mode",
    "checkpoint_capability",
    "restart_policy",
    "gpu_count",
    "min_gpu_count",
    "elastic_gpu_count",
    "auto_scale_up",
    "target_global_batch_size",
    "per_device_micro_batch_size",
    "placement",
    "requested_gpu_uuids",
    "argv",
    "cwd",
    "env",
}
OPTIONAL_SUBMISSION_KEYS = {
    "after",
    "preempt_idle_only",
    "preempt_opt_in_only",
    "yield_policy",
    "hami_core",
    "sm_percent",
    "share_gpu",
    "vram_mb",
    "min_gpu_count",
    "elastic_gpu_count",
    "auto_scale_up",
    "target_global_batch_size",
    "per_device_micro_batch_size",
}
PLACEMENTS = frozenset({"any", "pinned"})
GPU_UUID_RE = re.compile(r"^GPU-[A-Za-z0-9][A-Za-z0-9-]*$")


def validate_submission(
    raw: dict[str, Any],
    pool_size: int,
    *,
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES,
    managed_gpu_uuids: tuple[str, ...] | None = None,
) -> dict[str, Any]:
    """Validate and canonicalize a submission, including its RPC wire size.

    The size check uses the same encoder as :class:`gpuq.protocol.Client`, so a
    returned submission is guaranteed to fit a client configured with the same
    ``max_request_bytes`` value.
    """

    if not isinstance(raw, dict):
        raise ValueError("submission must be an object")
    if (
        isinstance(max_request_bytes, bool)
        or not isinstance(max_request_bytes, int)
        or max_request_bytes < 1
    ):
        raise ValueError("max_request_bytes must be a positive integer")
    missing = sorted(SUBMISSION_KEYS - OPTIONAL_SUBMISSION_KEYS - set(raw))
    if missing:
        raise ValueError(f"missing submission fields: {', '.join(missing)}")
    try:
        submit_key = str(uuid.UUID(str(raw["submit_key"])))
    except (ValueError, AttributeError) as exc:
        raise ValueError("submit_key must be a UUID") from exc
    name = validate_label(raw["name"], "name")
    owner = validate_label(raw["owner"], "owner")
    priority = raw["priority"]
    preempt_idle_only = raw.get("preempt_idle_only", False)
    if not isinstance(preempt_idle_only, bool):
        raise ValueError("preempt_idle_only must be a boolean")
    preempt_opt_in_only = raw.get("preempt_opt_in_only", False)
    if not isinstance(preempt_opt_in_only, bool):
        raise ValueError("preempt_opt_in_only must be a boolean")
    if isinstance(priority, bool) or not isinstance(priority, int):
        raise ValueError("priority must be an integer P0..P4")
    if not MIN_PRIORITY <= priority <= MAX_PRIORITY:
        raise ValueError("priority must be P0..P4")
    try:
        dispatch_mode = DispatchMode(raw["dispatch_mode"]).value
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid dispatch_mode") from exc
    try:
        checkpoint_capability = CheckpointCapability(raw["checkpoint_capability"]).value
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid checkpoint_capability") from exc
    try:
        restart_policy = RestartPolicy(raw["restart_policy"]).value
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid restart_policy") from exc
    gpu_count = raw["gpu_count"]
    if isinstance(gpu_count, bool) or not isinstance(gpu_count, int):
        raise ValueError("gpu_count must be an integer")
    if not 1 <= gpu_count <= pool_size:
        raise ValueError(f"gpu_count must be between 1 and {pool_size}")
    min_gpu_count = raw.get("min_gpu_count", gpu_count)
    if isinstance(min_gpu_count, bool) or not isinstance(min_gpu_count, int):
        raise ValueError("min_gpu_count must be an integer")
    if not 1 <= min_gpu_count <= gpu_count:
        raise ValueError("min_gpu_count must be between 1 and gpu_count")
    elastic_gpu_count = raw.get("elastic_gpu_count", False)
    if not isinstance(elastic_gpu_count, bool):
        raise ValueError("elastic_gpu_count must be a boolean")
    auto_scale_up = raw.get("auto_scale_up", False)
    if not isinstance(auto_scale_up, bool):
        raise ValueError("auto_scale_up must be a boolean")
    placement = raw["placement"]
    if placement not in PLACEMENTS:
        raise ValueError("placement must be 'any' or 'pinned'")
    share_gpu, vram_mb = validate_sharing(
        raw.get("share_gpu", False),
        raw.get("vram_mb"),
        placement=placement,
        gpu_count=gpu_count,
        elastic=elastic_gpu_count,
        mode=dispatch_mode,
    )
    if elastic_gpu_count and placement != "any":
        raise ValueError("elastic GPU count requires 'any' placement")
    if not elastic_gpu_count and min_gpu_count != gpu_count:
        raise ValueError(
            "min_gpu_count must equal gpu_count unless elastic_gpu_count is true"
        )
    target_global_batch_size = raw.get("target_global_batch_size")
    per_device_micro_batch_size = raw.get("per_device_micro_batch_size")
    if (target_global_batch_size is None) != (per_device_micro_batch_size is None):
        raise ValueError(
            "target_global_batch_size and per_device_micro_batch_size "
            "must be provided together"
        )
    if target_global_batch_size is not None:
        assert per_device_micro_batch_size is not None
        if not elastic_gpu_count or placement != "any":
            raise ValueError(
                "batch metadata requires an elastic GPU count with 'any' placement"
            )
        compatible = compatible_world_sizes(
            target_global_batch_size,
            per_device_micro_batch_size,
            min_gpu_count,
            gpu_count,
        )
        if not compatible:
            raise ValueError(
                "batch metadata has no compatible GPU count between "
                "min_gpu_count and gpu_count"
            )
    else:
        compatible = tuple(range(min_gpu_count, gpu_count + 1))
    if auto_scale_up:
        if placement != "any":
            raise ValueError("auto_scale_up requires 'any' placement")
        if not elastic_gpu_count:
            raise ValueError("auto_scale_up requires an elastic GPU count")
        if checkpoint_capability != CheckpointCapability.EPOCH_V1.value:
            raise ValueError("auto_scale_up requires checkpoint capability epoch-v1")
        if restart_policy != RestartPolicy.ON_PREEMPT.value:
            raise ValueError("auto_scale_up requires restart policy on-preempt")
        if target_global_batch_size is None:
            raise ValueError(
                "auto_scale_up requires target_global_batch_size and "
                "per_device_micro_batch_size"
            )
        if len(compatible) < 2:
            raise ValueError("auto_scale_up requires at least two legal GPU counts")
    requested_raw = raw["requested_gpu_uuids"]
    if not isinstance(requested_raw, list) or any(
        not isinstance(item, str) or not GPU_UUID_RE.fullmatch(item)
        for item in requested_raw
    ):
        raise ValueError("requested_gpu_uuids must be an array of valid GPU UUIDs")
    requested_gpu_uuids = list(requested_raw)
    if len(set(requested_gpu_uuids)) != len(requested_gpu_uuids):
        raise ValueError("requested_gpu_uuids must not contain duplicates")
    if placement == "any" and requested_gpu_uuids:
        raise ValueError("any placement must not request specific GPUs")
    if placement == "pinned" and len(requested_gpu_uuids) != gpu_count:
        raise ValueError("pinned placement requires exactly gpu_count requested GPUs")
    if managed_gpu_uuids is not None:
        managed = set(managed_gpu_uuids)
        outside = sorted(set(requested_gpu_uuids) - managed)
        if outside:
            raise ValueError(
                "requested GPU UUIDs are outside the managed pool: "
                + ", ".join(outside)
            )
    cwd_raw = raw["cwd"]
    if (
        not isinstance(cwd_raw, str)
        or "\x00" in cwd_raw
        or "\n" in cwd_raw
        or "\r" in cwd_raw
    ):
        raise ValueError("cwd must be a path string")
    try:
        cwd = Path(cwd_raw).resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"cwd is not accessible: {cwd_raw}") from exc
    if not cwd.is_dir():
        raise ValueError(f"cwd is not a directory: {cwd}")
    if "\n" in str(cwd) or "\r" in str(cwd):
        raise ValueError("cwd contains unsupported characters")
    argv_raw = raw["argv"]
    if not isinstance(argv_raw, list) or not argv_raw:
        raise ValueError("argv must be a non-empty array")
    if len(argv_raw) > 4096:
        raise ValueError("argv has too many entries")
    argv: list[str] = []
    total_argv_bytes = 0
    for item in argv_raw:
        if not isinstance(item, str) or "\x00" in item:
            raise ValueError("argv entries must be strings without NUL")
        total_argv_bytes += len(item.encode("utf-8"))
        argv.append(item)
    if total_argv_bytes > 131_072:
        raise ValueError("argv is too large")
    executable = Path(argv[0])
    if not executable.is_absolute():
        raise ValueError("argv[0] must be an absolute executable path")
    try:
        executable_info = executable.stat()
    except OSError as exc:
        raise ValueError(f"executable is not accessible: {executable}") from exc
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise ValueError(f"argv[0] is not executable: {executable}")
    if executable.name in UNSUPPORTED_EXECUTABLES:
        raise ValueError(f"{executable.name} is not supported in gpuq v1")
    env_raw = raw["env"]
    if not isinstance(env_raw, dict):
        raise ValueError("env must be an object")
    if len(env_raw) > 256:
        raise ValueError("env contains too many variables")
    env = validate_env(env_raw, RESERVED_ENV)
    hami_core, sm_percent = validate_hami_request(
        raw.get("hami_core", False), raw.get("sm_percent"), share_gpu, env
    )
    if sum(len(k) + len(v) for k, v in env.items()) > 131_072:
        raise ValueError("env is too large")
    clean = {
        "after": list(dict.fromkeys(item for item in raw.get("after", []) if isinstance(item, str))),
        "preempt_idle_only": preempt_idle_only,
        **({"preempt_opt_in_only": True} if preempt_opt_in_only else {}),
        "yield_policy": validate_yield_policy(raw.get("yield_policy", "legacy"), checkpoint_capability, share_gpu),
        "hami_core": hami_core,
        "sm_percent": sm_percent,
        "share_gpu": share_gpu,
        "vram_mb": vram_mb,
        "submit_key": submit_key,
        "name": name,
        "owner": owner,
        "priority": priority,
        "dispatch_mode": dispatch_mode,
        "checkpoint_capability": checkpoint_capability,
        "restart_policy": restart_policy,
        "gpu_count": gpu_count,
        "min_gpu_count": min_gpu_count,
        "elastic_gpu_count": elastic_gpu_count,
        "auto_scale_up": auto_scale_up,
        "target_global_batch_size": target_global_batch_size,
        "per_device_micro_batch_size": per_device_micro_batch_size,
        "placement": placement,
        "requested_gpu_uuids": requested_gpu_uuids,
        "argv": argv,
        "cwd": str(cwd),
        "env": env,
    }
    wire_size = len(encode_request("submit", clean, submit_key))
    if wire_size > max_request_bytes:
        raise ValueError(
            f"submission request is too large ({wire_size} bytes; "
            f"limit {max_request_bytes})"
        )
    return clean

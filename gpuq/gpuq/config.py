from __future__ import annotations

import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


_GPU_UUID_RE = re.compile(r"^GPU-[A-Za-z0-9][A-Za-z0-9-]*$")


@dataclass(frozen=True)
class Config:
    root: Path
    db_path: Path
    log_dir: Path
    control_dir: Path
    socket_path: Path
    managed_gpu_uuids: tuple[str, ...]
    allowed_uid: int
    tick_seconds: float = 1.0
    nvidia_timeout_seconds: float = 5.0
    idle_confirmations: int = 2
    release_confirmations: int = 2
    max_idle_memory_mb: int = 128
    term_grace_seconds: float = 5.0
    checkpoint_exit_grace_seconds: float = 30.0
    preempt_ack_timeout_seconds: float = 21_600.0
    scale_up_cooldown_seconds: float = 300.0
    scale_up_restart_timeout_seconds: float = 300.0
    max_request_bytes: int = 262_144
    observe_only: bool = True
    archive_path: Path = Path("/data1/gpu-scheduler/current/gpuq.pyz")

    @classmethod
    def from_json(cls, path: str | Path) -> "Config":
        config_path = Path(path)
        raw = json.loads(config_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("config must be a JSON object")
        allowed = {
            "root",
            "db_path",
            "log_dir",
            "control_dir",
            "socket_path",
            "managed_gpu_uuids",
            "allowed_uid",
            "tick_seconds",
            "nvidia_timeout_seconds",
            "idle_confirmations",
            "release_confirmations",
            "max_idle_memory_mb",
            "term_grace_seconds",
            "checkpoint_exit_grace_seconds",
            "preempt_ack_timeout_seconds",
            "scale_up_cooldown_seconds",
            "scale_up_restart_timeout_seconds",
            "max_request_bytes",
            "observe_only",
            "archive_path",
        }
        required = {
            "root",
            "db_path",
            "log_dir",
            "control_dir",
            "socket_path",
            "managed_gpu_uuids",
            "allowed_uid",
        }
        missing = sorted(required - set(raw))
        if missing:
            raise ValueError(f"missing config keys: {', '.join(missing)}")
        values: dict[str, Any] = {key: value for key, value in raw.items() if key in allowed}
        for key in (
            "root",
            "db_path",
            "log_dir",
            "control_dir",
            "socket_path",
            "archive_path",
        ):
            if key in values:
                if not isinstance(values[key], str):
                    raise ValueError(f"{key} must be a path string")
                values[key] = Path(values[key])
        raw_uuids = values["managed_gpu_uuids"]
        if not isinstance(raw_uuids, list) or any(
            not isinstance(item, str) for item in raw_uuids
        ):
            raise ValueError("managed_gpu_uuids must be an array of strings")
        values["managed_gpu_uuids"] = tuple(raw_uuids)
        try:
            config = cls(**values)
        except TypeError as exc:
            raise ValueError(f"invalid config values: {exc}") from exc
        config.validate()
        return config

    def validate(self) -> None:
        for path in (
            self.root,
            self.db_path,
            self.log_dir,
            self.control_dir,
            self.archive_path,
        ):
            if not path.is_absolute():
                raise ValueError(f"path must be absolute: {path}")
        if not self.socket_path.is_absolute():
            raise ValueError("socket_path must be absolute")
        runtime = Path(f"/run/user/{self.allowed_uid}")
        try:
            self.socket_path.relative_to(runtime)
        except ValueError as exc:
            raise ValueError(f"socket_path must be inside {runtime}") from exc
        if not self.managed_gpu_uuids:
            raise ValueError("managed_gpu_uuids must not be empty")
        if len(set(self.managed_gpu_uuids)) != len(self.managed_gpu_uuids):
            raise ValueError("managed_gpu_uuids contains duplicates")
        if any(
            not isinstance(value, str) or not _GPU_UUID_RE.fullmatch(value)
            for value in self.managed_gpu_uuids
        ):
            raise ValueError("managed_gpu_uuids contains an invalid UUID")
        if isinstance(self.allowed_uid, bool) or not isinstance(self.allowed_uid, int):
            raise ValueError("allowed_uid must be an integer")
        if self.allowed_uid < 1:
            raise ValueError("allowed_uid must be a non-root uid")
        numeric_fields = {
            "tick_seconds": self.tick_seconds,
            "nvidia_timeout_seconds": self.nvidia_timeout_seconds,
            "term_grace_seconds": self.term_grace_seconds,
            "checkpoint_exit_grace_seconds": self.checkpoint_exit_grace_seconds,
            "preempt_ack_timeout_seconds": self.preempt_ack_timeout_seconds,
            "scale_up_cooldown_seconds": self.scale_up_cooldown_seconds,
            "scale_up_restart_timeout_seconds": (self.scale_up_restart_timeout_seconds),
        }
        for name, value in numeric_fields.items():
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise ValueError(f"{name} must be positive and finite")
            try:
                numeric_value = float(value)
            except (ValueError, OverflowError):
                raise ValueError(f"{name} must be positive and finite") from None
            if not math.isfinite(numeric_value) or numeric_value <= 0:
                raise ValueError(f"{name} must be positive and finite")
        if self.tick_seconds < 0.1:
            raise ValueError("tick_seconds must be at least 0.1")
        for name, value in {
            "idle_confirmations": self.idle_confirmations,
            "release_confirmations": self.release_confirmations,
            "max_idle_memory_mb": self.max_idle_memory_mb,
            "max_request_bytes": self.max_request_bytes,
        }.items():
            if isinstance(value, bool) or not isinstance(value, int):
                raise ValueError(f"{name} must be an integer")
        if self.idle_confirmations < 2 or self.release_confirmations < 2:
            raise ValueError("idle/release confirmations must be at least 2")
        if self.max_idle_memory_mb < 0:
            raise ValueError("max_idle_memory_mb must be non-negative")
        if self.max_request_bytes < 4096:
            raise ValueError("max_request_bytes is too small")
        if not isinstance(self.observe_only, bool):
            raise ValueError("observe_only must be boolean")
        for path in (self.archive_path, self.control_dir, self.log_dir):
            if "$" in str(path) or "%" in str(path):
                raise ValueError(
                    f"systemd-facing path contains unsupported $ or %: {path}"
                )
        if not self.archive_path.is_file() or not os.access(self.archive_path, os.R_OK):
            raise ValueError(
                f"archive_path must be a readable regular file: {self.archive_path}"
            )

    def ensure_layout(self) -> None:
        old_umask = os.umask(0o077)
        try:
            self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.db_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.log_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
            self.control_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        finally:
            os.umask(old_umask)

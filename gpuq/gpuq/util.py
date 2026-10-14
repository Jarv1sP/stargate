from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path
from typing import Any, Iterable


ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
SAFE_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.@:+-]{0,63}$")




def json_dumps(value: Any) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def reject_duplicate_json(raw: str) -> Any:
    def hook(pairs: Iterable[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key: {key}")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=hook)


def validate_label(value: str, field: str) -> str:
    if not isinstance(value, str) or not SAFE_LABEL_RE.fullmatch(value):
        raise ValueError(
            f"{field} must be 1-64 characters using letters, digits, . _ @ : + -"
        )
    return value


def validate_env(env: dict[str, str], reserved: set[str]) -> dict[str, str]:
    clean: dict[str, str] = {}
    for key, value in env.items():
        if not isinstance(key, str) or not ENV_NAME_RE.fullmatch(key):
            raise ValueError(f"invalid environment variable name: {key!r}")
        # The trusted console adapter explicitly submits this single launch
        # hint. All allocation variables remain scheduler-managed.
        console_oci = key == "GPUQ_CONSOLE_OCI" and value == "1"
        if key in reserved or (key.startswith("GPUQ_") and not console_oci):
            raise ValueError(f"environment variable is managed by gpuq: {key}")
        if (
            not isinstance(value, str)
            or "\x00" in value
            or "\n" in value
            or "\r" in value
        ):
            raise ValueError(f"invalid value for environment variable: {key}")
        clean[key] = value
    return clean


def atomic_write_json(path: Path, payload: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    temp_path = Path(temporary)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(json_dumps(payload))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        directory_fd = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    except BaseException:
        try:
            temp_path.unlink()
        except FileNotFoundError:
            pass
        raise


def secure_create_empty(path: Path, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    fd = os.open(path, flags, mode)
    os.close(fd)




def read_boot_id() -> str:
    return Path("/proc/sys/kernel/random/boot_id").read_text(encoding="ascii").strip()


def process_start_ticks(pid: int) -> int | None:
    try:
        raw = Path(f"/proc/{pid}/stat").read_text(encoding="ascii")
    except (FileNotFoundError, ProcessLookupError, PermissionError):
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    fields = raw[close + 2 :].split()
    if len(fields) <= 19:
        return None
    try:
        return int(fields[19])
    except ValueError:
        return None




def read_cgroup_tree_processes(control_group: str) -> list[int]:
    """Return processes in a cgroup and every descendant cgroup.

    Failure to inspect any existing ``cgroup.procs`` file is fail-closed.
    Callers must distinguish a missing already-removed cgroup from an
    unreadable existing tree before releasing resources.
    """

    relative = control_group.lstrip("/")
    root = Path("/sys/fs/cgroup") / relative
    if not root.exists():
        return []
    paths = [root / "cgroup.procs", *sorted(root.rglob("cgroup.procs"))]
    result: set[int] = set()
    for path in paths:
        try:
            raw = path.read_text(encoding="ascii")
        except (FileNotFoundError, PermissionError, OSError) as exc:
            raise RuntimeError(f"cannot inspect cgroup process file: {path}") from exc
        for line in raw.splitlines():
            value = line.strip()
            if not value or not value.isascii() or not value.isdecimal():
                raise RuntimeError(f"invalid cgroup process data: {path}")
            pid = int(value)
            if pid <= 0:
                raise RuntimeError(f"invalid cgroup PID: {path}")
            result.add(pid)
    return sorted(result)


def pid_control_group(pid: int) -> str | None:
    try:
        lines = Path(f"/proc/{pid}/cgroup").read_text(encoding="ascii").splitlines()
    except (FileNotFoundError, PermissionError, ProcessLookupError):
        return None
    for line in lines:
        parts = line.split(":", 2)
        if len(parts) == 3 and parts[0] == "0":
            return parts[2]
    return None

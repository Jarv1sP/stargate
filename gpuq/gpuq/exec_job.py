from __future__ import annotations

import json

import os
import stat
import sys
from pathlib import Path
from typing import Any, Sequence



MAX_LAUNCH_SPEC_BYTES = 512 * 1024


def _load_spec(path: Path) -> dict[str, Any]:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("launch specification is not a regular file")
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise RuntimeError("launch specification ownership/mode is unsafe")
        if info.st_size > MAX_LAUNCH_SPEC_BYTES:
            raise RuntimeError("launch specification is too large")
        raw = os.read(descriptor, MAX_LAUNCH_SPEC_BYTES + 1)
    finally:
        os.close(descriptor)
    if len(raw) > MAX_LAUNCH_SPEC_BYTES:
        raise RuntimeError("launch specification is too large")
    value = json.loads(raw.decode("utf-8", errors="strict"))
    if not isinstance(value, dict):
        raise RuntimeError("launch specification must be a JSON object")
    return value


def execute_launch_spec(path: str | os.PathLike[str]) -> None:
    """Replace this helper with the exact argv/environment from a safe file."""

    spec = _load_spec(Path(path))
    argv = spec["argv"]
    cwd = spec["cwd"]
    environment = spec["env"]
    if (
        not isinstance(argv, list)
        or not argv
        or any(not isinstance(item, str) or "\x00" in item for item in argv)
    ):
        raise RuntimeError("launch argv is invalid")
    if not isinstance(cwd, str) or not Path(cwd).is_absolute() or "\x00" in cwd:
        raise RuntimeError("launch cwd is invalid")
    if not isinstance(environment, dict) or any(
        not isinstance(key, str)
        or not isinstance(value, str)
        or "\x00" in key
        or "=" in key
        or "\x00" in value
        for key, value in environment.items()
    ):
        raise RuntimeError("launch environment is invalid")
    executable = argv[0]
    if not Path(executable).is_absolute():
        raise RuntimeError("launch executable must be absolute")
    os.chdir(cwd)
    os.execve(executable, argv, environment)


def main(argv: Sequence[str] | None = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if len(arguments) != 1:
        print("gpuq exec helper requires exactly one launch spec", file=sys.stderr)
        return 126
    try:
        execute_launch_spec(arguments[0])
    except BaseException as exc:
        print(f"gpuq exec helper failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 126
    return 126


if __name__ == "__main__":
    raise SystemExit(main())

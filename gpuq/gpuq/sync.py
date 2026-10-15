"""Explicit, additive LAN synchronization; never mirrors deletions/overwrites.

Rsync owns binary transfer, partial files and atomic publication. Explicit
dry runs show the pending copy; transfer metadata never blocks training.
"""
from __future__ import annotations

import base64
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
from typing import Any, Iterator

from .config import Config
from .fleet import host_paths, load_inventory, ssh_command

PARTIAL = ".gpuq-sync-partial"
IGNORED = {PARTIAL, ".git", ".venv", "__pycache__", ".env", ".ssh"}
BROAD = {"/", "/home", "/Users", "/root", "/data1", "/data2", "/tmp", "/var/tmp"}
PROTECTED = ("/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev", "/run", "/var/lib")


def related(first: Path, second: Path) -> bool:
    return first == second or first in second.parents or second in first.parents


def valid_path(value: str, protected_root: Path | None = None) -> Path:
    if not isinstance(value, str) or not value.startswith("/") or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError("sync path must be absolute without control characters")
    path = Path(os.path.normpath(value))
    whole_home = path == Path.home() or path.parent in (Path("/home"), Path("/Users"))
    if ".." in Path(value).parts or str(path) in BROAD or whole_home:
        raise ValueError("refusing broad/parent-traversal sync path")
    if any(p in path.parts for p in (".ssh", "anaconda3", "miniconda3", ".conda")):
        raise ValueError("credential and environment directories are not sync targets")
    if protected_root is not None and related(path, protected_root):
        raise ValueError("cannot sync scheduler state or release directories")
    if any(path == Path(p) or Path(p) in path.parents for p in PROTECTED):
        raise ValueError("cannot sync system directories")
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ValueError("symlink path component is not supported: " + str(component))
    if path.exists() and not path.is_dir():
        raise ValueError("sync destination/source must be a directory")
    return path


def exclusions(values: list[str]) -> list[str]:
    result = []
    for value in values:
        if not isinstance(value, str) or not value or value.startswith("/") or ".." in Path(value).parts or any(c in value for c in "*?[]\n\r\0"):
            raise ValueError("--exclude takes an exact relative path, not a glob")
        result.append(value.rstrip("/"))
    return sorted(set(result))


def scan(path: Path, excluded: list[str]) -> dict[str, Any]:
    count = total = 0
    if not path.exists():
        return {"files": 0, "bytes": 0}
    for directory, dirs, files in os.walk(path, followlinks=False):
        parent = Path(directory)
        def skipped(name: str) -> bool:
            relative = (parent / name).relative_to(path).as_posix()
            return name in IGNORED or any(relative == e or relative.startswith(e + "/") for e in excluded)
        dirs[:] = sorted(name for name in dirs if not skipped(name))
        for name in sorted([*dirs, *(n for n in files if not skipped(n))]):
            entry = parent / name
            info = entry.lstat()
            if any(ord(c) < 32 or ord(c) == 127 for c in name):
                raise ValueError("control characters in filenames are not supported")
            if not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)):
                raise ValueError("symlink/special file requires explicit exclusion: " + str(entry))
            if stat.S_ISREG(info.st_mode):
                count += 1
                total += info.st_size
    return {"files": count, "bytes": total}


def guard_path(root: Path, dest: str) -> Path:
    return root / "sync" / "guards" / (hashlib.sha256(dest.encode()).hexdigest() + ".json")


@contextlib.contextmanager
def destination_lock(root: Path, dest: str) -> Iterator[int]:
    path = guard_path(root, dest).with_suffix(".lock")
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise ValueError("another transfer is using this destination") from exc
        yield descriptor
    finally:
        os.close(descriptor)


def decode_header(encoded: str) -> dict[str, Any]:
    if len(encoded) > 16000:
        raise ValueError("sync header too large")
    meta = json.loads(base64.urlsafe_b64decode(encoded.encode()))
    if not isinstance(meta, dict):
        raise ValueError("sync header must be an object")
    if meta["phase"] not in {"plan", "copy"} or type(meta["required_bytes"]) is not int or meta["required_bytes"] < 0:
        raise ValueError("invalid sync phase/size")
    meta["exclude"] = exclusions(meta["exclude"])
    return meta


def receiver(encoded: str, server_args: list[str], config_path: str) -> int:
    meta = decode_header(encoded)
    config = Config.from_json(config_path)
    dest = valid_path(meta["dest"], config.root)
    # These are rsync 3.2.x receiver arguments, never a sender, arbitrary
    # command or deletion-enabled receiver. Destination comes from the header.
    plan = meta["phase"] == "plan"
    expected = ["--server", "-nOre.iLsfxCIvu", "--log-format=%i", ".", str(dest) + "/"] if plan else ["--server", "-Otre.iLsfxCIvu", "--partial-dir", PARTIAL, "--ignore-existing", ".", str(dest) + "/"]
    if server_args != expected:
        raise ValueError("unsupported rsync receiver options/version; refusing unsafe fallback")
    if not dest.parent.is_dir():
        raise ValueError("destination parent directory must already exist")
    if plan:
        return subprocess.run(["rsync", *expected], check=False).returncode
    with destination_lock(config.root, str(dest)) as descriptor:
        free = shutil.disk_usage(dest.parent).free
        if free < meta["required_bytes"] + 64 * 1024**3:
            raise ValueError("insufficient disk space (including 64 GiB reserve)")
        process = subprocess.Popen(["rsync", *expected], pass_fds=(descriptor,))
        try:
            return process.wait()
        except BaseException:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
            raise


def forced_receiver(config_path: str) -> int | None:
    original = os.environ.get("SSH_ORIGINAL_COMMAND", "")
    words = shlex.split(original)
    if len(words) >= 5 and words[1] == "--config" and words[3] == "_sync-rsync":
        return receiver(words[4], words[5:], config_path)
    if "_sync-rsync" in words:
        raise ValueError("unsupported sync receiver command layout")
    return None


def rsync_command(source: Path, dest: str, host: dict[str, Any], meta: dict[str, Any]) -> list[str]:
    encoded = base64.urlsafe_b64encode(json.dumps(meta, separators=(",", ":")).encode()).decode()
    binary, config = host_paths(host)
    remote = shlex.join([binary, "--config", config, "_sync-rsync", encoded])
    base = ["rsync", "-rn", "--omit-dir-times", "--itemize-changes", "--out-format=%i|%l|%n"] if meta["phase"] == "plan" else ["rsync", "-rt", "--omit-dir-times", "--ignore-existing", "--partial-dir=" + PARTIAL, "--info=progress2"]
    for value in sorted(IGNORED):
        base += ["--exclude=" + value]
    for value in meta["exclude"]:
        base += ["--exclude=/" + value]
    return [*base, "--rsync-path=" + remote, "-e", shlex.join(ssh_command(host)[:-2]), "--", str(source) + "/", host["ssh"] + ":" + dest + "/"]


def preview(command: list[str]) -> dict[str, Any]:
    count = size = conflicts = 0
    examples: list[str] = []
    with tempfile.TemporaryFile() as errors:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=errors, text=True)
        try:
            assert process.stdout is not None
            for line in process.stdout:
                fields = line.rstrip("\n").split("|", 2)
                if len(fields) != 3 or len(fields[0]) != 11:
                    continue
                changes, length, name = fields
                if changes[1] == "f":
                    if changes[2:] != "+" * 9:
                        conflicts += 1
                    else:
                        count += 1
                        size += int(length)
                if len(examples) < 50:
                    examples.append(changes + " " + name)
            code = process.wait()
            if code:
                errors.seek(0)
                raise ValueError("rsync preview failed: " + errors.read(8192).decode(errors="replace"))
        except BaseException:
            process.terminate()
            process.wait()
            raise
        finally:
            if process.stdout is not None:
                process.stdout.close()
    return {"new_files": count, "new_bytes": size, "conflicts": conflicts, "examples": examples}


def transfer(source: Path, dest: str, host: dict[str, Any], excluded: list[str], *, dry_run: bool, as_json: bool) -> dict[str, Any]:
    size = scan(source, excluded)
    meta = {"dest": dest, "phase": "plan", "required_bytes": size["bytes"], "exclude": excluded}
    pending = preview(rsync_command(source, dest, host, meta))
    if dry_run:
        return {**pending, "source": str(source), "destination": dest, "dry_run": True}
    copying = {**meta, "phase": "copy", "required_bytes": pending["new_bytes"]}
    code = subprocess.run(rsync_command(source, dest, host, copying), stdout=sys.stderr if as_json else None, check=False).returncode
    if code:
        raise ValueError(f"rsync interrupted/failed ({code}); rerun the same command to resume its partial files")
    return {**size, "source": str(source), "destination": dest, "dry_run": False, "ready": True}


def cmd_sync(args: Any) -> int:
    if args.host:
        raise ValueError("use sync --to HOST, not the global --host option")
    inventory = load_inventory(args.fleet_config)
    if args.to not in inventory["hosts"] or args.to == inventory.get("local_host"):
        raise ValueError("--to must name a different configured fleet host")
    source = valid_path(str(Path(args.source).absolute()))
    if not source.is_dir():
        raise ValueError("source directory does not exist")
    dest = str(valid_path(args.dest))
    excluded = exclusions(args.exclude)
    host = {"ssh": args.to, **inventory["hosts"][args.to]}
    try:
        result = transfer(source, dest, host, excluded, dry_run=args.dry_run, as_json=args.json)
    except KeyboardInterrupt:
        print("同步已中断；未覆盖或删除原文件。重跑相同命令可继续。", file=sys.stderr)
        return 130
    except subprocess.SubprocessError as exc:
        raise ValueError("sync subprocess failed: " + str(exc)) from exc
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0

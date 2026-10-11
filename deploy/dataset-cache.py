#!/usr/bin/env python3
"""Controlled, immutable node-local dataset replicas (Python standard library).

The service constructs Principal from its authenticated identity, NEVER from a
request's role/user fields. Source IDs and paths are trusted administrator config.
This module executes no external commands. All replicas live under /data2/datasets
by default; tests may explicitly supply an isolated root.

Lifecycle: register_source / register_manifest -> plan -> put_chunk or trusted
transport -> publish -> acquire_lease -> scheduler-confirmed release_lease.
Only the final atomic rename makes a version READY. A staging directory, even one
containing READY.json after a crash, is not a published version. Leases never age
out automatically. The executor MUST bind the returned data path read-only and
release a lease only after confirming that its job and all steps have stopped.

Like gpuq/sync.py this uses a durable not-ready fence, safe paths, resume and
source stability checks, rather than an overwrite/delete mirror. Unlike its
rsync receiver, this library deliberately has no shell/command transport. An
administrator can obtain prepare_transfer's target for a trusted rsync process;
that process MUST exit and close every writer before publish. Do not expose that
host path or an arbitrary rsync endpoint to ordinary users. A service-owned cache
and trusted transport are assumptions, not protection from a compromised root.

Local root-only CLI (JSON request on stdin, JSON result on stdout):
  sudo python3 dataset-cache.py --config /etc/gpuq/datasets.json
Config: {"root":"/data2/datasets", "mountPoint":"/data2", "sources":{"tiny":"/data2/imports/tiny"},
         "reserveBytes":10737418240, "serviceUid":1000, "serviceGid":1000}
Requests use {"op":"register_source", "dataset":"tiny", "sourceId":"tiny",
              "owners":["demo-user-1"]}, then {"op":"materialize", ...}.
This is a privileged operator CLI, not a setuid program or a user-facing API.
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import contextvars
import ctypes
import errno
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import time
import uuid
from typing import NamedTuple


SCHEMA = 1
_RETIREMENT_SCOPE = contextvars.ContextVar('dataset_retirement_scope', default=None)
_REGISTRATION_SCOPE = contextvars.ContextVar('dataset_new_registration_scope', default=None)
CHUNK_BYTES = 1024 * 1024
MAX_JSON_BYTES = 64 * 1024 * 1024
MAX_ENTRIES = 500000
CATALOG_SUMMARY_BYTES = 4096
CATALOG_SUMMARY_ROWS = 256
TRANSFER_BATCH_BYTES = 64 * 1024 * 1024
TRANSFER_BATCH_FILES = 256
TRANSFER_BATCH_SECONDS = 1.0
DEFAULT_RESERVE = 10 * 1024**3
ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z")
USER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")
HASH_RE = re.compile(r"[a-f0-9]{64}\Z")
UNSAFE_RELATIVE_RE = re.compile(r"[\x00-\x1f\x7f\\]")
FORBIDDEN = {".ssh", ".env", ".git", ".venv", "anaconda3", "miniconda3", ".conda"}
BROAD = {"/", "/home", "/Users", "/root", "/data1", "/data2", "/tmp", "/var/tmp"}
SYSTEM = ("/etc", "/usr", "/bin", "/sbin", "/proc", "/sys", "/dev", "/run", "/var/lib")


class CacheError(ValueError):
    """A request cannot safely proceed; no version should be consumed."""


class CacheMetadataIncomplete(CacheError):
    """Missing required parent is unknown, never an absence proof."""


class CacheBusy(CacheError):
    """Another operation holds a lock; callers may retry without assuming readiness."""

    def __init__(self, message, *, lock_wait=None):
        super().__init__(message)
        self.lock_wait = lock_wait


_LOCK_WAIT = contextvars.ContextVar("dataset_lock_wait", default=None)


@contextlib.contextmanager
def wait_for_locks(*, timeout=30.0, total=120.0, canceled=None):
    """Trusted worker/read scope: wait for acquisition, never replay mutations.

    The total budget counts only time spent contending, not scanning/copying or
    time holding a lock. Nested helpers share it; unrelated request threads do
    not. No client can supply these bounds through a dataset operation.
    """
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not 0 <= v <= limit
           for v, limit in ((timeout, 60), (total, 300))) or (canceled is not None and not callable(canceled)):
        raise CacheError("invalid dataset lock wait policy")
    if _LOCK_WAIT.get() is not None:
        yield  # A helper must not reset its caller's finite wait budget.
        return
    token = _LOCK_WAIT.set({"timeout": timeout, "remaining": total, "canceled": canceled})
    try:
        yield
    finally:
        _LOCK_WAIT.reset(token)


class Principal(NamedTuple):
    user_id: str
    is_admin: bool = False


def _identifier(value, pattern=ID_RE):
    if not isinstance(value, str) or not pattern.fullmatch(value):
        raise CacheError("invalid identifier")
    return value


def _relative(value):
    if (not isinstance(value, str) or not value or len(value.encode()) > 4096
            or value.startswith("/") or UNSAFE_RELATIVE_RE.search(value)):
        raise CacheError("invalid relative dataset path")
    parts = value.split("/")
    if any(p in {"", ".", ".."} or p in FORBIDDEN for p in parts):
        raise CacheError("unsafe or credential/environment dataset path")
    return value


def _absolute(value):
    value = os.fspath(value)
    if (not value.startswith("/") or ".." in Path(value).parts or "\\" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise CacheError("expected an absolute path without traversal")
    return Path(value)


@contextlib.contextmanager
def _directory(path):
    """Open every component without following symlinks, including ancestors."""
    path = _absolute(path)
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _mkdir(path):
    with _directory(path.parent) as parent:
        try:
            os.mkdir(path.name, 0o700, dir_fd=parent)
            os.fsync(parent)
        except FileExistsError:
            pass
        fd = os.open(path.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise CacheError("cache directory must be owned by the service and not writable by others")
        finally:
            os.close(fd)


def _existing_owned_directory(path):
    """Validate an existing service directory without creating or repairing it."""
    with _directory(path) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise CacheError("cache directory must be owned by the service and not writable by others")


def _json_bytes(value):
    data = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    if len(data) > MAX_JSON_BYTES:
        raise CacheError("manifest/metadata too large")
    return data


def _regular(fd):
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise CacheError("dataset files must be regular files with a single link")
    return info


def _read_json(path):
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = _regular(fd)
            if info.st_size > MAX_JSON_BYTES:
                raise CacheError("metadata too large")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                return json.loads(stream.read(MAX_JSON_BYTES + 1))
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise CacheError("corrupt dataset metadata; refusing to proceed") from exc
        finally:
            os.close(fd)


def _write_json(path, value, mode=0o600):
    data = _json_bytes(value)
    temporary = ".write-" + uuid.uuid4().hex
    with _directory(path.parent) as parent:
        # An interrupted atomic metadata write may leave a private temporary
        # file. No data files live in metadata directories; remove only this
        # helper's exact naming pattern, after nofollow/owner/single-link checks.
        for name in os.listdir(parent):
            if not re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                continue
            stale = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                if _regular(stale).st_uid != os.geteuid():
                    raise CacheError("unexpected owner of interrupted metadata write")
            finally:
                os.close(stale)
            os.unlink(name, dir_fd=parent)
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
        try:
            with os.fdopen(fd, "wb", closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(fd)
            os.replace(temporary, path.name, src_dir_fd=parent, dst_dir_fd=parent)
            os.fsync(parent)
        finally:
            os.close(fd)
            try:
                os.unlink(temporary, dir_fd=parent)
            except FileNotFoundError:
                pass


def _stamp(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def _digest_fd(fd, length=None):
    before = _regular(fd)
    digest = hashlib.sha256()
    remaining = before.st_size if length is None else length
    if remaining > before.st_size:
        raise CacheError("file shorter than expected")
    os.lseek(fd, 0, os.SEEK_SET)
    while remaining:
        data = os.read(fd, min(CHUNK_BYTES, remaining))
        if not data:
            raise CacheError("file changed while being read")
        digest.update(data)
        remaining -= len(data)
    if _stamp(before) != _stamp(_regular(fd)):
        raise CacheError("file changed while being read")
    return digest.hexdigest(), before.st_size


def _canonical_json_matches(path, digest):
    """Check published canonical bytes, bounded and stable, without JSON parse.

    READY manifests are written by _write_json after full tree verification.
    Their canonical bytes hash is the immutable version already validated from
    the registry. A semantically equivalent but noncanonical replacement fails
    closed; this helper never accepts a cached readiness flag or user digest.
    """
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            before = _regular(fd)
            if before.st_size > MAX_JSON_BYTES:
                raise CacheError("metadata too large")
            actual, size = _digest_fd(fd, before.st_size)
            if size != before.st_size or _stamp(before) != _stamp(_regular(fd)):
                raise CacheError("file changed while being read")
            return actual == digest
        finally:
            os.close(fd)


def _manifest_bytes(value):
    if not isinstance(value, dict) or set(value) != {"schema", "directories", "files"} or value["schema"] != SCHEMA:
        raise CacheError("unsupported manifest schema")
    dirs, files = value["directories"], value["files"]
    if not isinstance(dirs, list) or not isinstance(files, list) or len(dirs) + len(files) > MAX_ENTRIES:
        raise CacheError("invalid manifest entries")
    directories = sorted(_relative(p) for p in dirs)
    normalized, seen = [], set(directories)
    if len(seen) != len(directories):
        raise CacheError("duplicate manifest directory")
    for item in files:
        if not isinstance(item, dict) or set(item) != {"path", "size", "sha256"}:
            raise CacheError("invalid manifest file")
        path = _relative(item["path"])
        if path in seen or type(item["size"]) is not int or not 0 <= item["size"] <= 2**63 - 1:
            raise CacheError("duplicate path or invalid file size")
        _identifier(item["sha256"], HASH_RE)
        seen.add(path)
        normalized.append(dict(path=path, size=item["size"], sha256=item["sha256"]))
    directory_set = set(directories)
    # Direct-parent closure is sufficient because directories are entries too;
    # _relative has already rejected empty, dot and traversal components.
    for path in seen:
        parent = path.rpartition("/")[0]
        if parent and parent not in directory_set:
            raise CacheError("manifest missing parent directory or conflicting file path")
    result = dict(schema=SCHEMA, directories=directories, files=sorted(normalized, key=lambda f: f["path"]))
    return result, _json_bytes(result)


def _manifest(value):
    return _manifest_bytes(value)[0]


def _scan(path):
    directories, files = [], []
    def visit(fd, prefix):
        before = os.fstat(fd)
        for name in sorted(os.listdir(fd)):
            relative = _relative(prefix + name)
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    directories.append(relative)
                    visit(child, relative + "/")
                finally:
                    os.close(child)
            elif stat.S_ISREG(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    digest, size = _digest_fd(child)
                    files.append(dict(path=relative, size=size, sha256=digest))
                finally:
                    os.close(child)
            else:
                raise CacheError("symlinks and special files are not supported")
            if len(files) + len(directories) > MAX_ENTRIES:
                raise CacheError("too many dataset entries")
        if _stamp(before) != _stamp(os.fstat(fd)):
            raise CacheError("directory changed while being scanned")
    with _directory(path) as fd:
        visit(fd, "")
    return _manifest(dict(schema=SCHEMA, directories=directories, files=files))


def _version(manifest):
    return hashlib.sha256(_json_bytes(manifest)).hexdigest()


def _rename_new(source, destination):
    """Atomic no-replace publication, Linux and macOS; unsupported OS fails closed."""
    with _directory(source.parent) as source_fd, _directory(destination.parent) as destination_fd:
        if os.fstat(source_fd).st_dev != os.fstat(destination_fd).st_dev:
            raise CacheError("staging and published version must be on the same filesystem")
        libc = ctypes.CDLL(None, use_errno=True)
        if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
            fn = libc.renameat2
            flags = 1  # RENAME_NOREPLACE
        elif sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
            fn = libc.renameatx_np
            flags = 4  # RENAME_EXCL
        else:
            raise CacheError("atomic no-replace rename unavailable on this platform")
        fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        fn.restype = ctypes.c_int
        # Moving a directory between parents may require write permission to
        # update '..'. Only the private wrapper is temporarily writable; the
        # immutable data subtree stays unchanged. API readers use the same lock.
        with _directory(source) as moved_fd:
            mode = stat.S_IMODE(os.fstat(moved_fd).st_mode)
            try:
                os.fchmod(moved_fd, mode | stat.S_IWUSR)
                result = fn(source_fd, os.fsencode(source.name), destination_fd, os.fsencode(destination.name), flags)
                saved_errno = ctypes.get_errno()
            finally:
                os.fchmod(moved_fd, mode)
                os.fsync(moved_fd)
            ctypes.set_errno(saved_errno)
        if result:
            code = ctypes.get_errno()
            if code == errno.EXDEV:
                raise CacheError("cross-filesystem publication is forbidden")
            raise OSError(code, os.strerror(code))
        os.fsync(destination_fd)
        os.fsync(source_fd)


def _linux_syncfs():
    """Resolve bulk durability before changing modes; absence keeps fsync."""
    if not sys.platform.startswith("linux"):
        return None
    try:
        fn = ctypes.CDLL(None, use_errno=True).syncfs
    except (AttributeError, OSError):
        return None
    fn.argtypes = [ctypes.c_int]
    fn.restype = ctypes.c_int

    def flush(fd):
        ctypes.set_errno(0)
        if fn(fd):
            code = ctypes.get_errno() or errno.EIO
            # An available syscall reporting an error is NOT a durability
            # proof. Keep staging unpublished, rather than retrying as success.
            raise OSError(code, os.strerror(code))
    return flush


def _modes(path, readonly, *, bulk_durability=False):
    # Only immutable publication opts in. Recovery and eviction retain their
    # original per-file/directory fsync behavior on every platform.
    syncfs = _linux_syncfs() if bulk_durability else None
    device = None

    def visit(fd):
        if syncfs is not None and os.fstat(fd).st_dev != device:
            raise CacheError("bulk durability cannot cross filesystems")
        for name in os.listdir(fd):
            info = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    visit(child)
                finally:
                    os.close(child)
            else:
                child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    info = _regular(child)
                    if syncfs is not None and info.st_dev != device:
                        raise CacheError("bulk durability cannot cross filesystems")
                    os.fchmod(child, 0o444 if readonly else 0o600)
                    if syncfs is None:
                        os.fsync(child)
                finally:
                    os.close(child)
        os.fchmod(fd, 0o555 if readonly else 0o700)
        if syncfs is None:
            os.fsync(fd)
    with _directory(path) as fd:
        device = os.fstat(fd).st_dev
        visit(fd)
        if syncfs is not None:
            # The same no-follow root descriptor covers the verified tree.
            # Publish still fsyncs final metadata and both rename parents.
            syncfs(fd)


def _storage_mount(mount_point, cache_root):
    """Verify an exact local data mount and reject nested cache mounts.

    A configurable cache root must not weaken the /data2 safety properties:
    failed mounts cannot redirect writes to /, and a child mount cannot silently
    put only some of a replica or workspace on another filesystem.
    """
    point, cache = _absolute(mount_point), _absolute(cache_root)
    if (str(point) != os.fspath(mount_point) or str(cache) != os.fspath(cache_root)
            or point == Path("/") or point not in cache.parents):
        raise CacheError("cache root must be below its exact required data mount")
    rows = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        left, separator, right = line.partition(" - ")
        before, after = left.split(), right.split()
        if not separator or len(before) < 6 or len(after) < 3:
            raise CacheError("invalid mount table; refusing dataset access")
        target = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), before[4])
        rows.append(dict(id=before[0], device=before[2], target=target, filesystem=after[0],
                         options=before[5].split(",") + after[2].split(",")))
    data = [r for r in rows if r["target"] == str(point)]
    root = [r for r in rows if r["target"] == "/"]
    local = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "f2fs", "bcachefs"}
    if (not data or not root or data[-1]["device"] == root[-1]["device"]
            or data[-1]["filesystem"] not in local or "ro" in data[-1]["options"]
            or "rw" not in data[-1]["options"]):
        raise CacheError("required data mount must be an exact writable local non-root filesystem mount")
    if any(Path(r["target"]) != point and (Path(r["target"]) == cache
               or cache in Path(r["target"]).parents
               or (point in Path(r["target"]).parents and Path(r["target"]) in cache.parents))
           for r in rows):
        raise CacheError("dataset cache submounts are not supported")
    with _directory(point) as fd:
        device = os.fstat(fd).st_dev
    if str(os.major(device)) + ":" + str(os.minor(device)) != data[-1]["device"]:
        raise CacheError("data mount changed during inspection")
    return data[-1]["id"], data[-1]["device"], device


def _data2_mount():
    """Compatibility entry point for the original default storage layout."""
    return _storage_mount("/data2", "/data2/datasets")


class DatasetCache:
    def __init__(self, root="/data2/datasets", *, sources=None, reserve_bytes=DEFAULT_RESERVE,
                 lock_timeout=2.0, mount_point=None, budget_bytes=None, initialize=True):
        if type(initialize) is not bool:
            raise CacheError("invalid cache initialization mode")
        self.initialize = initialize
        self.root = _absolute(root)
        if str(self.root) in BROAD or type(reserve_bytes) is not int or reserve_bytes < 0:
            raise CacheError("unsafe cache root or reserve")
        self.reserve_bytes = reserve_bytes
        if budget_bytes is not None and (type(budget_bytes) is not int or not 0 < budget_bytes <= 2**63 - 1):
            raise CacheError("invalid trusted dataset cache budget")
        # Trusted node policy only. It limits registered dataset copies, not
        # personal projects, environments, outputs, or the filesystem itself.
        self.budget_bytes = budget_bytes
        if not isinstance(lock_timeout, (int, float)) or isinstance(lock_timeout, bool) or not 0 <= lock_timeout <= 60:
            raise CacheError("invalid dataset lock timeout")
        self.lock_timeout = lock_timeout
        # Explicit mountPoint is mandatory for non-/data2 production layouts.
        # Isolated temporary roots remain available to unprivileged unit tests.
        self.mount_point = (_absolute(mount_point) if mount_point is not None
                            else Path("/data2") if Path("/data2") in self.root.parents else None)
        if mount_point is not None and str(self.mount_point) != os.fspath(mount_point):
            raise CacheError("required data mount must be an exact absolute path")
        self.mount = self._current_mount() if self.mount_point is not None else None
        self.sources = dict(sources or {})
        for key, value in self.sources.items():
            _identifier(key)
            path = _absolute(value)
            if (str(path) in BROAD or path.parent in (Path("/home"), Path("/Users"))
                    or any(p in FORBIDDEN for p in path.parts)
                    or any(path == Path(p) or Path(p) in path.parents for p in SYSTEM)
                    or path == self.root or path in self.root.parents or self.root in path.parents):
                raise CacheError("unsafe approved source directory")
            self.sources[key] = path
        prepare_directory = _mkdir if initialize else _existing_owned_directory
        prepare_directory(self.root)
        with _directory(self.root) as fd:
            info = os.fstat(fd)
            if self.mount is not None and info.st_dev != self.mount[2]:
                raise CacheError("cache no longer resides on the verified data mount")
            self._root_identity = info.st_dev, info.st_ino
        for name in (".registry", ".staging", "ready", ".leases", ".trash", ".locks", ".upload-reservations", ".tiers", ".provenance", ".retirements", ".reopens"):
            prepare_directory(self.root / name)

    def _retirement_fence(self, dataset, version):
        """Private persistent generation fence; missing is the only open case."""
        self._paths(dataset, version)
        path = self.root / '.retirements' / dataset / (version + '.json')
        try:
            with _directory(path.parent) as parent:
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    info = _regular(fd)
                    if info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 65536:
                        raise CacheError('unsafe version deletion fence')
                    with os.fdopen(fd, 'rb', closefd=False) as stream:
                        row = json.loads(stream.read(65537))
                finally:
                    os.close(fd)
        except FileNotFoundError:
            return None
        except (ValueError, UnicodeError) as error:
            raise CacheError('corrupt version deletion fence') from error
        fields = {'schema', 'protocol', 'rootIdentity', 'dataset', 'version', 'operationId',
                  'actor', 'admin', 'snapshotSha256', 'generation', 'state', 'createdAt', 'restoredRegistration'}
        if (not isinstance(row, dict) or set(row) != fields or type(row['schema']) is not int or row['schema'] != 1
                or row['protocol'] != 'dataset-version-fence-v1' or row['rootIdentity'] != list(self._root_identity)
                or row['dataset'] != dataset or row['version'] != version or type(row['admin']) is not bool
                or row['state'] not in {'FENCED', 'ISOLATED', 'RESTORING', 'RESTORED', 'PURGED', 'RELEASED'}
                or type(row['createdAt']) not in (int, float) or not math.isfinite(row['createdAt']) or row['createdAt'] < 0
                or not isinstance(row['operationId'], str)
                or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}', row['operationId'])):
            raise CacheError('corrupt version deletion fence')
        _identifier(row['actor'], USER_RE)
        _identifier(row['snapshotSha256'], HASH_RE)
        _identifier(row['generation'], HASH_RE)
        restored = row['restoredRegistration']
        if ((row['state'] == 'RESTORED') != (restored is not None)
                or restored is not None and (not isinstance(restored, list) or len(restored) != 5
                    or any(type(item) is not int or item < 0 for item in restored))):
            raise CacheError('corrupt restored deletion generation')
        return row

    def _check_retirement(self, dataset, version, *, _read_only=False):
        row = self._retirement_fence(dataset, version)
        if row is None or row['state'] in {'RESTORED', 'RELEASED'} or _read_only:
            return row
        scope = (tuple(self._root_identity), row['operationId'], row['actor'], row['admin'], dataset, version, row['snapshotSha256'])
        if _RETIREMENT_SCOPE.get() != scope:
            raise CacheError('数据删除已锁定此版本，请查询删除任务；不可重新准备或重建')
        return row

    @contextlib.contextmanager
    def _retirement_scope(self, actor, operation_id, dataset, version, snapshot_sha256):
        """Private exact-operation override, deliberately absent from dispatch."""
        self._actor(actor)
        self._paths(dataset, version)
        _identifier(snapshot_sha256, HASH_RE)
        token = _RETIREMENT_SCOPE.set((tuple(self._root_identity), operation_id, actor.user_id,
                                       actor.is_admin, dataset, version, snapshot_sha256))
        try:
            self._check_retirement(dataset, version)
            yield
        finally:
            _RETIREMENT_SCOPE.reset(token)

    def _check_dataset_retirement(self, dataset):
        folder = self.root / '.retirements' / dataset
        try:
            with _directory(folder) as fd:
                names = os.listdir(fd)
        except FileNotFoundError:
            return
        for name in names:
            if not re.fullmatch(r'[a-f0-9]{64}\.json', name):
                raise CacheError('unknown version deletion fence')
            self._check_retirement(dataset, name[:-5])

    @staticmethod
    def _retirement_module():
        spec=importlib.util.spec_from_file_location('explicit_dataset_registration',Path(__file__).with_name('dataset-retirement.py'))
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module

    def _reopen_path(self,dataset,version,operation_id=None):
        self._paths(dataset,version)
        R=self._retirement_module()
        if operation_id is None:
            fence=self._retirement_fence(dataset,version)
            if fence is None:raise FileNotFoundError('No explicit deleted generation')
            operation_id=fence['operationId']
        _identifier(operation_id,R.GRANT_UUID)
        path=self.root/'.reopens'/dataset/version/(operation_id+'.json')
        # Existing draft-format records stay immutable. Only the current
        # operation can resume one; an older operation is superseded.
        legacy=self.root/'.reopens'/dataset/(version+'.json')
        if not os.path.lexists(path) and os.path.lexists(legacy):
            old=R.private_read(legacy)
            if old.get('operationId')==operation_id:return legacy
        return path

    def discard_new_registration(self,actor,dataset,version,operation_id,request_key=None):
        """Audited admin withdrawal of a prepared inode that was never installed.

        A fixed request key resumes only its own metadata moves. No dataset
        payload, deletion journal, grant or generation fence is changed.
        """
        self._actor(actor,admin=True);self._paths(dataset,version)
        R=self._retirement_module();_identifier(operation_id,R.GRANT_UUID)
        request_key=str(uuid.uuid4()) if request_key is None else request_key;R.operation(request_key)
        binding=dict(schema=1,protocol='dataset-registration-discard-v1',rootIdentity=list(self._root_identity),
            dataset=dataset,version=version,operationId=operation_id,requestKey=request_key,requestedBy=actor.user_id)
        folder=self.root/'.reopens'/'.discarded'/request_key;receipt=folder/'DISCARD.json'
        with self._lock_file('.locks/'+dataset+'.'+version+'.lock'),self._locked():
            try:audit=R.private_read(receipt)
            except FileNotFoundError:audit=None
            if audit is not None:
                if (set(audit)!=set(binding)|{'state','generation','intentSha256','registrationIdentity'}
                        or any(audit[k]!=v for k,v in binding.items())
                        or audit['state'] not in {'PREPARED','DISCARDED'}):
                    raise CacheError('Discard request differs from its durable operation identity')
                _identifier(audit['generation'],HASH_RE);_identifier(audit['intentSha256'],HASH_RE)
                if (not isinstance(audit['registrationIdentity'],list) or len(audit['registrationIdentity'])!=5
                        or any(type(v) is not int or v<0 for v in audit['registrationIdentity'])):
                    raise CacheError('Discard registration identity is corrupt')
                if audit['state']=='DISCARDED':return {k:audit[k] for k in ('protocol','operationId','requestKey','dataset','version','generation','state')}
            fence=self._retirement_fence(dataset,version)
            if fence is None or fence['operationId']!=operation_id:
                raise CacheError('Discard operation does not match the current deletion generation')
            paths=self._paths(dataset,version);registered=self._paths(dataset)['.registry']/(version+'.json')
            if (fence['state']!='PURGED' or any(R.exists(p) for p in (registered,paths['ready'],paths['.staging'],self.root/'.provenance'/dataset/(version+'.json')))
                    or self._leases(dataset,version)):
                raise CacheError('Discard refuses an installed or live registration')
            path=self._reopen_path(dataset,version,operation_id);prepared=path.with_suffix('.registration.json')
            intent_locations=[p for p in (path,folder/'INTENT.json') if R.exists(p)]
            prepared_locations=[p for p in (prepared,folder/'registration.json') if R.exists(p)]
            if len(intent_locations)!=1 or len(prepared_locations)!=1:
                raise CacheError('Discard refuses missing or ambiguous uninstalled intent')
            intent=R.private_read(intent_locations[0]);record=R.private_read(prepared_locations[0])
            fields={'schema','protocol','rootIdentity','dataset','version','operationId','generation','snapshotSha256',
                    'actor','owners','origin','receipt','sourceId','registrationIdentity'}
            if (set(intent)!=fields or intent['schema']!=1 or intent['protocol']!='dataset-new-registration-v1'
                    or intent['rootIdentity']!=list(self._root_identity)
                    or any(intent[k]!=fence[k] for k in ('dataset','version','operationId','generation','snapshotSha256'))
                    or intent['owners']!=self._dataset(actor,dataset)['owners']
                    or not isinstance(intent['registrationIdentity'],list) or len(intent['registrationIdentity'])!=5
                    or any(type(v) is not int or v<0 for v in intent['registrationIdentity'])
                    or set(record)!={'schema','manifest','sourceId'} or record['schema']!=SCHEMA
                    or _version(_manifest(record['manifest']))!=version or record['sourceId']!=intent['sourceId']
                    or R.identity(prepared_locations[0])[:4]!=intent['registrationIdentity'][:4]):
                raise CacheError('Discard uninstalled inode or fixed generation is unconfirmed')
            if self._tier(dataset,version)!=self._default_tier():
                raise CacheError('Discard refuses live or unconfirmed tier protection')
            if audit is None:
                R.private_directory(folder.parent);R.private_directory(folder)
                audit={**binding,'state':'PREPARED','generation':fence['generation'],
                    'intentSha256':R.sha(intent),'registrationIdentity':intent['registrationIdentity']}
                _write_json(receipt,audit)  # audit before the first metadata move
            elif (audit['generation']!=fence['generation'] or audit['intentSha256']!=R.sha(intent)
                    or audit['registrationIdentity']!=intent['registrationIdentity']):
                raise CacheError('Discard attempt cannot adopt a different prepared inode')
            for source,target in ((prepared,folder/'registration.json'),(path,folder/'INTENT.json')):
                if R.exists(source):self._unregister_move_record(source,target)
            tier=self.root/'.tiers'/dataset/(version+'.json')
            if R.exists(tier):self._unregister_move_record(tier,folder/'tier.json')
            audit['state']='DISCARDED';_write_json(receipt,audit)
            return {k:audit[k] for k in ('protocol','operationId','requestKey','dataset','version','generation','state')}

    @contextlib.contextmanager
    def _new_registration(self,actor,dataset,manifest,owners,source_id,*,origin='admin',receipt=None,explicit=False):
        """Trusted explicit admission only; background imports keep the tombstone.

        The new registry inode is prepared and persisted before any mutation.
        Retrying the same admission can finish that inode, never adopt another
        actor's registration. No public request accepts this private override.
        Version lock precedes metadata lock, as in publish and retirement.
        """
        owners=self._provenance_actor(actor,owners,origin,receipt)
        version=_version(_manifest(manifest));self._paths(dataset,version)
        # Ordinary registration keeps its original metadata-only behavior;
        # it creates no version lock, particularly before an ACL refusal.
        # _register rechecks the fence under the caller's metadata lock.
        with self._locked():
            initial=self._retirement_fence(dataset,version)
            normal=initial is None or initial['state'] in {'RESTORED','RELEASED'}
            if not normal:
                if initial['state']!='PURGED' or not explicit or origin=='replica':
                    self._check_retirement(dataset,version)
                if self._dataset(actor,dataset)['owners']!=owners:
                    raise PermissionError('Explicit registration must preserve authenticated dataset owners')
        if normal:
            yield False
            return
        with self._lock_file('.locks/'+dataset+'.'+version+'.lock'):
            with self._locked():
                fence=self._retirement_fence(dataset,version)
                if fence is None or fence['state'] in {'RESTORED','RELEASED'}:
                    reopening=None
                elif fence['state']!='PURGED' or not explicit or origin=='replica':
                    self._check_retirement(dataset,version)
                    reopening=None
                else:
                    R=self._retirement_module()
                    raw=R.private_read(self.root/'.trash'/('retire-'+fence['operationId'].replace('-',''))/'RETIREMENT.json')
                    old=R.DatasetRetirement(self,raw.get('machine'))._journal(fence['operationId'])
                    if (old['state']!='PURGED' or old['dataset']!=dataset or old['version']!=version
                            or R.sha(old['snapshot'])!=fence['snapshotSha256']
                            or old['actor']!=fence['actor'] or old['admin']!=fence['admin']
                            or R.exists(R.DatasetRetirement(self,old['machine'])._folder(fence['operationId'])/'payload/ready')):
                        raise CacheError('The old generation has not been proven purged')
                    current=self._dataset(actor,dataset)['owners']
                    if current!=owners:
                        raise PermissionError('Explicit registration must preserve authenticated dataset owners')
                    if origin!='admin' and owners!=[actor.user_id]:
                        raise PermissionError('Explicit personal registration belongs to another owner')
                    path=self._reopen_path(dataset,version)
                    _mkdir(self.root/'.reopens'/dataset)
                    folder=path.parent;_mkdir(folder)
                    binding=dict(schema=1,protocol='dataset-new-registration-v1',rootIdentity=list(self._root_identity),
                        dataset=dataset,version=version,operationId=fence['operationId'],generation=fence['generation'],
                        snapshotSha256=fence['snapshotSha256'],actor=actor.user_id,owners=owners,
                        origin=origin,receipt=receipt,sourceId=source_id)
                    try:reopening=R.private_read(path)
                    except FileNotFoundError:reopening=None
                    prepared=path.with_suffix('.registration.json')
                    record=dict(schema=SCHEMA,manifest=_manifest(manifest),sourceId=source_id)
                    if reopening is None:
                        paths=self._paths(dataset,version)
                        if (any(R.exists(p) for p in (paths['ready'],paths['.staging'],
                                self._paths(dataset)['.registry']/(version+'.json'),
                                self.root/'.tiers'/dataset/(version+'.json'),self.root/'.provenance'/dataset/(version+'.json')))
                                or self._leases(dataset,version)):
                            raise CacheError('Old generation still has live or unconfirmed metadata')
                        if R.exists(prepared):
                            raise CacheError('Unconfirmed new registration intent requires administrator reconciliation')
                        _write_json(prepared,record)
                        reopening={**binding,'registrationIdentity':list(_stamp(prepared.stat(follow_symlinks=False)))}
                        _write_json(path,reopening)
                    elif (not isinstance(reopening,dict) or set(reopening)!=set(binding)|{'registrationIdentity'}
                            or any(reopening[k]!=v for k,v in binding.items())
                            or not isinstance(reopening['registrationIdentity'],list) or len(reopening['registrationIdentity'])!=5
                            or any(type(v) is not int or v<0 for v in reopening['registrationIdentity'])):
                        raise CacheError('New registration admission differs from its durable immutable intent')
                    registration=self._paths(dataset)['.registry']/(version+'.json')
                    candidates=[p for p in (prepared,registration) if R.exists(p)]
                    if (len(candidates)!=1 or R.identity(candidates[0])[:4]!=reopening['registrationIdentity'][:4]
                            or R.private_read(candidates[0])!=record):
                        raise CacheError('New registration inode changed; no overwrite or adoption permitted')
                    if any(R.exists(p) for p in (self._paths(dataset,version)['ready'],self._paths(dataset,version)['.staging'])) or self._leases(dataset,version):
                        raise CacheError('New registration admission has unexpected live data')
            if reopening is None:
                yield False
            else:
                original=Principal(fence['actor'],fence['admin'])
                token=_REGISTRATION_SCOPE.set((tuple(self._root_identity),reopening))
                try:
                    with self._retirement_scope(original,fence['operationId'],dataset,version,fence['snapshotSha256']):
                        yield True
                finally:_REGISTRATION_SCOPE.reset(token)

    def new_registration_proof(self,actor,dataset,version):
        """Read-only private projection of the explicit replacement generation."""
        with self._locked():
            self._actor(actor);self._dataset(actor,dataset)
            R=self._retirement_module();row=R.private_read(self._reopen_path(dataset,version))
            fence=self._retirement_fence(dataset,version)
            registered=list(self._record_identity(dataset,version))
            provenance=self._provenance(dataset,version)
            if (fence is None or fence['state']!='RESTORED' or row.get('protocol')!='dataset-new-registration-v1'
                    or row.get('rootIdentity')!=list(self._root_identity)
                    or any(row.get(k)!=fence[k] for k in ('operationId','generation','snapshotSha256','dataset','version'))
                    or row.get('registrationIdentity')!=registered or fence['restoredRegistration']!=registered
                    or provenance is None or any(provenance[k]!=row.get(k) for k in ('owners','origin','receipt'))
                    or provenance['owners']!=self._dataset(actor,dataset)['owners']):
                raise CacheError('Explicit new registration proof is unconfirmed')
            return dict(protocol='dataset-new-registration-proof-v1',dataset=dataset,version=version,
                operationId=row['operationId'],generation=row['generation'],snapshotSha256=row['snapshotSha256'],
                registrationSha256=R.sha(registered),state='REGISTERED')

    def _current_mount(self):
        if self.mount_point is None or (self.mount_point == Path("/data2") and self.root == Path("/data2/datasets")):
            return _data2_mount()
        return _storage_mount(self.mount_point, self.root)

    @contextlib.contextmanager
    def _lock_file(self, name):
        if self.mount is not None and self._current_mount() != self.mount:
            raise CacheError("data mount identity changed; reopen cache after administrator verification")
        with _directory(self.root) as root, _directory(self.root / Path(name).parent) as parent:
            if (os.fstat(root).st_dev, os.fstat(root).st_ino) != self._root_identity:
                raise CacheError("cache directory identity changed; reopen after administrator verification")
            if self.mount is not None and os.fstat(root).st_dev != self.mount[2]:
                raise CacheError("cache no longer resides on the verified data mount")
            if os.fstat(parent).st_dev != os.fstat(root).st_dev:
                raise CacheError("cache lock directory is on a different filesystem")
            access = os.O_CREAT | os.O_RDWR if self.initialize else os.O_RDONLY
            fd = os.open(Path(name).name, access | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
            try:
                _regular(fd)
                policy = _LOCK_WAIT.get()
                remaining = policy["remaining"] if policy else None
                timeout = min(policy["timeout"], policy["remaining"]) if policy else self.lock_timeout
                deadline = time.monotonic() + timeout
                pause = 0.025
                while True:
                    if policy and policy["canceled"] and policy["canceled"]():
                        raise InterruptedError("dataset lock wait canceled")
                    try:
                        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        if time.monotonic() >= deadline:
                            raise CacheBusy("dataset cache is busy; retry later without assuming READY", lock_wait={
                                "scope": "CACHE" if name == ".lock" else "VERSION",
                                "limit": "TOTAL_BUDGET" if remaining is not None and remaining <= policy["timeout"] else "SINGLE_WAIT",
                                "timeoutSeconds": timeout})
                        started = time.monotonic()
                        try:
                            # This fd has NOT acquired the requested lock. Do
                            # not catch I/O, ACL, mount, or body exceptions.
                            time.sleep(min(pause, max(0, deadline - started)))
                        finally:
                            if policy:
                                policy["remaining"] = max(0, policy["remaining"] - (time.monotonic() - started))
                        pause = min(0.25, pause * 1.5)
                yield
            finally:
                os.close(fd)

    def _locked(self):
        return self._lock_file(".lock")

    @contextlib.contextmanager
    def _version_locked(self, actor, dataset, version, *, snapshot=False):
        _identifier(dataset)
        _identifier(version, HASH_RE)
        # Authenticate before creating lock files; guessed IDs must not consume
        # arbitrary filesystem entries. Recheck authorization inside the caller.
        record, identity = self._record_snapshot(actor, dataset, version)
        with self._lock_file(".locks/" + dataset + "." + version + ".lock"):
            with self._locked():
                self._check_snapshot(actor, dataset, version, identity)
            if not snapshot:
                record = None  # Do not retain a second large manifest in legacy callers.
            yield (record, identity) if snapshot else None

    def _actor(self, actor, admin=False):
        if not isinstance(actor, Principal) or type(actor.is_admin) is not bool:
            raise CacheError("trusted Principal required")
        _identifier(actor.user_id, USER_RE)
        if admin and not actor.is_admin:
            raise PermissionError("administrator authorization required")

    def _paths(self, dataset, version=None):
        _identifier(dataset)
        if version is not None:
            _identifier(version, HASH_RE)
        return {name: self.root / name / dataset / version if version else self.root / name / dataset
                for name in (".registry", ".staging", "ready", ".leases")}

    def _dataset(self, actor, dataset):
        self._actor(actor)
        metadata = _read_json(self._paths(dataset)[".registry"] / "dataset.json")
        if (not isinstance(metadata, dict) or set(metadata) != {"schema", "owners"}
                or metadata["schema"] != SCHEMA):
            raise CacheError("corrupt dataset authorization metadata")
        self._owners(metadata["owners"])
        if not actor.is_admin and actor.user_id not in metadata["owners"]:
            raise PermissionError("dataset owner authorization required")
        return metadata

    @staticmethod
    def _owners(owners):
        if not isinstance(owners, list) or not owners or len(owners) > 10000:
            raise CacheError("at least one dataset owner is required")
        return sorted(set(_identifier(owner, USER_RE) for owner in owners))

    def _record(self, actor, dataset, version, *, _read_only=False):
        self._dataset(actor, dataset)
        self._check_retirement(dataset, version, _read_only=_read_only)
        record = _read_json(self._paths(dataset)[".registry"] / (version + ".json")) if _identifier(version, HASH_RE) else None
        if (not isinstance(record, dict) or set(record) != {"schema", "manifest", "sourceId"}
                or record["schema"] != SCHEMA):
            raise CacheError("corrupt version registration")
        _, canonical = _manifest_bytes(record["manifest"])
        if hashlib.sha256(canonical).hexdigest() != version:
            raise CacheError("corrupt version registration")
        if record["sourceId"] is not None:
            _identifier(record["sourceId"])
        return record

    def _record_identity(self, dataset, version, *, _read_only=False):
        self._check_retirement(dataset, version, _read_only=_read_only)
        filename = self._paths(dataset)[".registry"] / (_identifier(version, HASH_RE) + ".json")
        with _directory(filename.parent) as parent:
            fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                return _stamp(_regular(fd))
            finally:
                os.close(fd)

    def _check_snapshot(self, actor, dataset, version, identity, *, _read_only=False):
        # Authorization may be revoked while a long copy owns the version lock.
        # Revalidate the small owner record and immutable registration identity,
        # not a potentially 64 MiB manifest, under the global lock each batch.
        self._dataset(actor, dataset)
        if self._record_identity(dataset, version, _read_only=_read_only) != identity:
            raise CacheError("version registration changed; retry the operation")

    def _record_snapshot(self, actor, dataset, version, *, _read_only=False):
        """Validate a full immutable manifest without owning the global lock.

        The service-owned registration can only be accepted if the same no-follow
        regular file still exists at the final locked authorization check. Nothing
        is persisted or trusted from an unvalidated summary. A replacement, even
        byte-identical, invalidates this operation rather than silently switching
        an in-flight reader or materializer to a different registration.
        """
        with self._locked():
            self._dataset(actor, dataset)
            identity = self._record_identity(dataset, version, _read_only=_read_only)
        record = self._record(actor, dataset, version, _read_only=_read_only)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity, _read_only=_read_only)
        return record, identity

    def _version_entry_exists(self, path):
        """Inspect a required dataset parent without recreating or following it.

        A missing version is normal; a missing parent is incomplete storage
        metadata, not proof that a registered replica is safe to prepare.
        """
        try:
            with _directory(path.parent) as fd:
                return path.name in os.listdir(fd)
        except FileNotFoundError:
            raise CacheMetadataIncomplete("dataset storage metadata is incomplete; administrator verification required") from None

    def _ready_identity(self, paths):
        """Small no-follow identities only; never parse a READY manifest here."""
        try:
            with _directory(paths["ready"]) as fd:
                wrapper = _stamp(os.fstat(fd))
                files = []
                for name in ("READY.json", "manifest.json"):
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        files.append(_stamp(_regular(child)))
                    finally:
                        os.close(child)
            with _directory(paths["ready"] / "data") as fd:
                return wrapper, tuple(files), _stamp(os.fstat(fd))
        except FileNotFoundError:
            if self._version_entry_exists(paths["ready"]):
                raise CacheError("published directory has no valid READY metadata")
            return None

    def _ready_snapshot(self, paths, manifest, version):
        # Every caller has just obtained this manifest from _record_snapshot or
        # a version-locked validated registration. Keep that full validation;
        # compare READY canonical bytes to its version rather than parse a
        # second large object. Identity checks still bracket the complete read.
        identity = self._ready_identity(paths)
        ready = self._ready(paths, manifest, version, _canonical=True)
        if self._ready_identity(paths) != identity:
            raise CacheError("published version metadata changed; retry the operation")
        return ready, identity

    def _check_ready_snapshot(self, paths, identity):
        if self._ready_identity(paths) != identity:
            raise CacheError("published version metadata changed; retry the operation")

    def _free(self, needed=0, needed_inodes=0):
        with _directory(self.root) as fd:
            info = os.fstatvfs(fd)
        if info.f_bavail * info.f_frsize < self.reserve_bytes + needed:
            raise CacheError("insufficient free space including safety reserve; no publication allowed")
        if getattr(info, 'f_files', 0) > 0 and info.f_favail < 1024 + needed_inodes + self._upload_reserved()[1]:
            raise CacheError("insufficient free inodes including upload reservations")

    @staticmethod
    def _footprint(manifest):
        """Conservative admission footprint, never promised reclaimed bytes."""
        return (sum(entry["size"] for entry in manifest["files"])
                + 4096 * (len(manifest["files"]) + len(manifest["directories"])) + 8192)

    def _budget(self, needed=0, *, except_stage=None, reservation_credit=0):
        """Caller owns the cache lock; account READY, whole staging and uploads.

        A staging reservation counts its complete immutable dataset footprint,
        not just remaining bytes: data already written must not become free
        budget for another transfer. Corrupt/orphaned lifecycle metadata fails
        closed. This is invoked only at admission/resume, never per file chunk.
        No authority check, recursive payload scan or deletion occurs here.
        """
        if self.budget_bytes is None:
            return
        if type(needed) is not int or not 0 <= needed <= 2**63 - 1:
            raise CacheError("invalid upcoming dataset cache reservation")
        if type(reservation_credit) is not int or not 0 <= reservation_credit <= needed:
            raise CacheError("invalid dataset cache reservation conversion")
        if needed > self.budget_bytes:
            raise CacheError(f"dataset exceeds cache budget: requestedBytes={needed}, "
                             f"budgetBytes={self.budget_bytes}; keep the original in the data warehouse")
        usage = self._budget_usage(except_stage=except_stage)
        if usage + needed - reservation_credit > self.budget_bytes:
            raise CacheError(f"dataset cache budget reached: usedOrReservedBytes={usage}, "
                             f"requestedBytes={needed}, budgetBytes={self.budget_bytes}; "
                             "active or unverified copies are retained")

    def _budget_usage(self, *, except_stage=None):
        """Trusted whole-copy commitments, caller holds the cache lock."""
        actor = Principal("builtin-admin", True)
        usage = self._upload_reserved(budget=True)[0]
        for section in ("ready", ".staging"):
            with _directory(self.root / section) as parent:
                datasets = os.listdir(parent)
            for dataset in datasets:
                _identifier(dataset)
                with _directory(self.root / section / dataset) as parent:
                    versions = os.listdir(parent)
                for version in versions:
                    _identifier(version, HASH_RE)
                    paths = self._paths(dataset, version)
                    if section == ".staging" and paths[section] == except_stage:
                        continue
                    record = self._record(actor, dataset, version)
                    if section == "ready":
                        if not self._ready(paths, record["manifest"], version):
                            raise CacheError("unknown published cache state; admission forbidden")
                        if self._version_entry_exists(paths[".staging"]):
                            raise CacheError("READY with staging has unknown lifecycle; admission forbidden")
                    else:
                        transfer = self._transfer(paths[section])
                        if transfer["totalBytes"] != sum(entry["size"] for entry in record["manifest"]["files"]):
                            raise CacheError("staging cache reservation differs from immutable manifest")
                    usage += self._footprint(record["manifest"])
        return usage

    def _provenance(self, dataset, version, *, _read_only=False):
        """Private version provenance, bound to this exact registration.

        Missing historical records are UNKNOWN. Never infer personal origin
        from an owner list, an upload binding or the dataset's spelling.
        Caller holds the metadata lock; this does not grant authorization.
        """
        self._paths(dataset, version)
        try:
            value = _read_json(self.root / ".provenance" / dataset / (version + ".json"))
        except FileNotFoundError:
            return None
        fields = {"schema", "dataset", "version", "owners", "origin", "receipt",
                  "rootIdentity", "registrationIdentity", "createdAt"}
        if (not isinstance(value, dict) or set(value) != fields or type(value["schema"]) is not int or value["schema"] != 1
                or value["dataset"] != dataset or value["version"] != version
                or value["origin"] not in {"admin", "upload", "workspace", "replica"}
                or not isinstance(value["rootIdentity"], list) or len(value["rootIdentity"]) != 2
                or any(type(item) is not int or item < 0 for item in value["rootIdentity"])
                or not isinstance(value["registrationIdentity"], list)
                or len(value["registrationIdentity"]) != 5
                or any(type(item) is not int or item < 0 for item in value["registrationIdentity"])
                or type(value["createdAt"]) not in (int, float)
                or not math.isfinite(value["createdAt"]) or value["createdAt"] < 0):
            raise CacheError("corrupt version provenance; member deletion forbidden")
        if self._owners(value["owners"]) != value["owners"]:
            raise CacheError("corrupt version provenance owner binding")
        if value["origin"] == "admin":
            if value["receipt"] is not None:
                raise CacheError("corrupt administrator provenance")
        else:
            _identifier(value["receipt"])
            if len(value["owners"]) != 1:
                raise CacheError("personal provenance requires one authenticated owner")
        if (value["rootIdentity"] != list(self._root_identity)
                or value["registrationIdentity"] != list(self._record_identity(dataset, version, _read_only=_read_only))):
            return None  # Replaced registration/restore must acquire new proof.
        return value

    def _provenance_actor(self, actor, owners, origin, receipt):
        self._actor(actor, admin=True)
        owners = self._owners(owners)
        if origin not in {"admin", "upload", "workspace", "replica"}:
            raise CacheError("invalid trusted provenance origin")
        if origin == "admin":
            if receipt is not None:
                raise CacheError("administrator registration has no personal receipt")
        else:
            _identifier(receipt)
            if owners != [actor.user_id]:
                raise PermissionError("personal provenance must bind the authenticated owner")
        return owners

    def _write_provenance(self, actor, dataset, version, owners, origin, receipt):
        """Trusted creation adapters only; deliberately absent from dispatch.

        Write personal proof only at NEW registration creation. A retry or an
        administrator changing sources cannot upgrade old/unknown provenance.
        """
        owners = self._provenance_actor(actor, owners, origin, receipt)
        folder = self.root / ".provenance" / dataset
        _mkdir(folder)
        _write_json(folder / (version + ".json"), dict(
            schema=1, dataset=dataset, version=version, owners=owners, origin=origin,
            receipt=receipt, rootIdentity=list(self._root_identity),
            registrationIdentity=list(self._record_identity(dataset, version)), createdAt=time.time()))

    def deletion_permissions(self, actor, dataset, version):
        """Safe permission projection; never expose private proof or paths."""
        with self._catalog_read(actor, dataset):
            self._actor(actor)
            owners = self._dataset(actor, dataset)["owners"]
            identity = self._record_identity(dataset, version, _read_only=True)
            fence = self._retirement_fence(dataset, version)
            original_fence = fence
            if fence is not None and fence['state'] != 'RESTORED':
                if fence['state'] == 'RELEASED':
                    fence = None
                else:
                    return dict(allowed=False, memberAllowed=False, reason='DELETION_ACTIVE')
            path = self.root / '.provenance' / dataset / (version + '.json')
            def proof_stamp():
                try:
                    with _directory(path.parent) as parent:
                        fd = os.open(path.name, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=parent)
                        try:return _stamp(_regular(fd))
                        finally:os.close(fd)
                except FileNotFoundError:return None
            proof_identity = proof_stamp()
            key = (dataset, version, actor.user_id, actor.is_admin, tuple(owners), identity, proof_identity)
            cache = getattr(self, '_deletion_permission_cache', None)
            if cache is None:
                cache = self._deletion_permission_cache = {}
            if key in cache:
                result = dict(cache[key])
            else:
                proof = self._provenance(dataset, version, _read_only=True)
                personal = (owners == [actor.user_id] and proof is not None
                            and proof["owners"] == owners
                            and proof["origin"] in {"upload", "workspace", "replica"})
                result = dict(allowed=actor.is_admin or personal, memberAllowed=personal,
                              reason=None if actor.is_admin or personal else "ADMIN_ONLY")
                if len(cache) >= 1024:
                    cache.pop(next(iter(cache)))
                cache[key] = result
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            if proof_stamp() != proof_identity or self._retirement_fence(dataset, version) != original_fence:
                raise CacheError('catalog permission metadata changed; retry the operation')
            return dict(result)

    def _delete_actor_locked(self, actor, dataset, version):
        """Node-side permission check after every mutable-identity boundary."""
        self._actor(actor, admin=version is None)
        owners = self._dataset(actor, dataset)["owners"]
        if not actor.is_admin:
            proof = self._provenance(dataset, version)
            if (owners != [actor.user_id] or proof is None or proof["owners"] != owners
                    or proof["origin"] not in {"upload", "workspace", "replica"}):
                raise PermissionError("这份数据只能由管理员删除")

    @contextlib.contextmanager
    def _retention_guard(self, actor, dataset, version, *, _confirm_only=False, _portal_proved=False):
        """Only a live protected READY authority makes complete data disposable.

        sourceId, ownership, an old recovery JSON, and successful transfer alone
        are not evidence. The trusted node installs the same sealed authority
        adapter used by tier collection; its guard spans target quarantine.
        """
        try:
            record, registered = self._record_snapshot(actor, dataset, version)
        except FileNotFoundError:
            # Whole-dataset removal also finds unpublished orphan staging.
            # Missing registration is never evidence that an orphan READY tree
            # is disposable. Preserve it for explicit administrator recovery.
            with self._locked():
                self._dataset(actor, dataset)
                if os.path.lexists(self._paths(dataset, version)["ready"]):
                    raise CacheError("这是最后一份数据，请用彻底删除（7 天内可恢复）")
            yield False
            return
        with self._locked():
            self._check_snapshot(actor, dataset, version, registered)
            if self._leases(dataset, version):
                raise CacheError("active leases prevent removal; leases never expire automatically")
            if self._tier(dataset, version)["pins"]:
                if self._authority_pins(dataset, version):
                    raise CacheError("authority pin protects this original; 这是数据库原件，请用彻底删除")
                raise CacheError("persistent pins prevent removal")
            complete = self._ready(self._paths(dataset, version), record["manifest"], version)
            # A retry after quarantine must still protect its complete data.
            # Otherwise disappearance of the original between two attempts
            # could make the retry erase the only remaining copy in .trash.
            with _directory(self.root / ".trash") as fd:
                transactions = sorted(os.listdir(fd))
            for name in transactions:
                if not re.fullmatch(r"unregister-[a-f0-9]{32}", name):
                    continue
                folder = self.root / ".trash" / name
                receipt = _read_json(folder / "REMOVAL.json")
                if receipt.get("dataset") != dataset or receipt.get("unregistered") is True:
                    continue
                if version in receipt.get("versions", []):
                    retained = folder / "replicas" / "ready" / version
                    if os.path.lexists(retained):
                        with _directory(retained):
                            pass
                        # An interrupted cleanup may have made directories
                        # writable, or deleted some files. Never dispose of its
                        # remaining bytes without the original's live guard.
                        complete = True
        if _portal_proved:
            self._actor(actor,admin=True)
            yield True
            return
        if not complete:
            yield False
            return
        if _confirm_only:
            # A publisher won the target version lock after incomplete
            # preflight. Fail closed rather than acquire a source lock in
            # reverse order or dispose of newly complete data without it.
            raise CacheError("这是最后一份数据，请重新核对后用彻底删除（7 天内可恢复）")
        guard = getattr(self, "rebuild_guard", None)
        if not callable(guard):
            raise CacheError("这是最后一份数据，请用彻底删除（7 天内可恢复）")
        with guard(actor, dataset, version):
            with self._locked():
                self._check_snapshot(actor, dataset, version, registered)
            yield True

    def _register(self, actor, dataset, manifest, owners, source_id, *, _origin="admin", _receipt=None):
        self._actor(actor, admin=True)
        owners = self._provenance_actor(actor, owners, _origin, _receipt)
        manifest = _manifest(manifest)
        version = _version(manifest)
        self._check_retirement(dataset, version)
        paths = self._paths(dataset)
        self._free(self._reserved() + len(_json_bytes(manifest)) + 8192)
        for path in paths.values():
            _mkdir(path)
        try:
            current = self._dataset(actor, dataset)
            if current["owners"] != owners:
                raise CacheError("use set_owners explicitly to change dataset authorization")
        except FileNotFoundError:
            _write_json(paths[".registry"] / "dataset.json", dict(schema=SCHEMA, owners=owners))
        filename = paths[".registry"] / (version + ".json")
        record = dict(schema=SCHEMA, manifest=manifest, sourceId=source_id)
        scope=_REGISTRATION_SCOPE.get()
        admission=scope[1] if scope is not None and scope[0]==tuple(self._root_identity) else None
        if admission is not None and (admission['dataset']!=dataset or admission['version']!=version
                or admission['actor']!=actor.user_id or admission['owners']!=owners
                or admission['origin']!=_origin or admission['receipt']!=_receipt or admission['sourceId']!=source_id):
            raise CacheError('Explicit registration differs from its admitted generation')
        try:
            existing = self._record(actor, dataset, version)
        except FileNotFoundError:
            # New/re-registered content is never implicitly disposable, even
            # when an earlier registration left a recovery receipt behind.
            if self._tier(dataset, version)["pins"]:
                raise CacheError("orphan persistent pins require administrator reconciliation")
            self._write_tier(dataset, version, self._default_tier())
            if admission is None:_write_json(filename, record)
            else:
                self._unregister_move_record(self._reopen_path(dataset,version,admission['operationId']).with_suffix('.registration.json'),filename)
                admission['registrationIdentity']=list(self._record_identity(dataset,version))
                _write_json(self._reopen_path(dataset,version),admission)
            self._write_provenance(actor, dataset, version, owners, _origin, _receipt)
        else:
            if existing["manifest"] != manifest:
                raise CacheError("registered version is immutable")
            if existing["sourceId"] is None and source_id is not None:
                if self._authority_pins(dataset, version):
                    raise CacheError("authority retention prevents source changes; reconcile dependents first")
                _write_json(filename, record)
            elif source_id is not None and existing["sourceId"] != source_id:
                raise CacheError("registered source is immutable")
            if admission is not None:
                registered=list(self._record_identity(dataset,version))
                if registered[:4]!=admission['registrationIdentity'][:4]:
                    raise CacheError('Explicit registration cannot adopt another inode')
                admission['registrationIdentity']=registered
                _write_json(self._reopen_path(dataset,version),admission)
                self._write_provenance(actor,dataset,version,owners,_origin,_receipt)
        if admission is not None:
            fence=self._retirement_fence(dataset,version)
            if (fence['state']!='PURGED' or any(fence[k]!=admission[k] for k in ('operationId','generation','snapshotSha256'))):
                raise CacheError('Explicit registration deletion generation changed')
            _write_json(self.root/'.retirements'/dataset/(version+'.json'),
                {**fence,'state':'RESTORED','restoredRegistration':admission['registrationIdentity']})
        return dict(dataset=dataset, version=version, bytes=sum(f["size"] for f in manifest["files"]), files=len(manifest["files"]))

    def register_source(self, actor, dataset, source_id, owners):
        self._actor(actor, admin=True)
        _identifier(dataset)
        self._owners(owners)
        _identifier(source_id)
        if source_id not in self.sources:
            raise PermissionError("source ID has not been approved in administrator configuration")
        manifest = _scan(self.sources[source_id])
        with self._new_registration(actor,dataset,manifest,owners,source_id,explicit=True),self._locked():
            return self._register(actor, dataset, manifest, owners, source_id)

    def register_manifest(self, actor, dataset, manifest, owners, *, _explicit=False):
        """Administrator imports a manifest delivered by a trusted source node."""
        if not _explicit:
            with self._locked():return self._register(actor,dataset,manifest,owners,None)
        with self._new_registration(actor,dataset,manifest,owners,None,explicit=_explicit),self._locked():
            return self._register(actor, dataset, manifest, owners, None)

    def attach_source(self, actor, dataset, version, source_id):
        """Bind an admin-trusted manifest to an approved source, without a tree scan.

        The caller authenticates the exported manifest. Materialization reads only
        its registered files and verifies the complete local result before READY.
        This supports a read-only LAN/NFS source without hashing it a second time.
        """
        self._actor(actor, admin=True)
        _identifier(source_id)
        if source_id not in self.sources:
            raise PermissionError("source ID has not been approved in administrator configuration")
        with self._locked():
            record = self._record(actor, dataset, version)
            if record["sourceId"] not in (None, source_id):
                raise CacheError("registered source is immutable")
            if self._authority_pins(dataset, version):
                if record["sourceId"] == source_id:
                    return dict(dataset=dataset, version=version, attached=True)
                raise CacheError("authority retention prevents source changes; reconcile dependents first")
            record["sourceId"] = source_id
            _write_json(self._paths(dataset)[".registry"] / (version + ".json"), record)
            return dict(dataset=dataset, version=version, attached=True)

    def set_owners(self, actor, dataset, owners):
        with self._locked():
            self._actor(actor, admin=True)
            existing = self._dataset(actor, dataset)
            owners = self._owners(owners)
            self._check_dataset_retirement(dataset)
            if existing["owners"] == owners:
                return {"updated": True}
            if self._authority_pins(dataset):
                raise CacheError("authority retention prevents ACL changes; reconcile dependents first")
            _write_json(self._paths(dataset)[".registry"] / "dataset.json", dict(schema=SCHEMA, owners=owners))
            return {"updated": True}

    def export_manifest(self, actor, dataset, version):
        record, identity = self._record_snapshot(actor, dataset, version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            return dict(dataset=dataset, version=version, manifest=record["manifest"])

    def capacity(self, actor):
        """Constant-time filesystem snapshot, not a per-user hard quota.

        No manifests or data trees are scanned. usableBytes subtracts the
        configured safety reserve only; admission still checks in-flight
        reservations under its own lock when a transfer actually begins.
        """
        self._actor(actor)
        with self._locked(), _directory(self.root) as fd:
            info = os.fstatvfs(fd)
            block = info.f_frsize or info.f_bsize
            available = max(0, info.f_bavail) * block
            inodes_known = info.f_files > 0 and 0 <= info.f_favail <= info.f_files
            collected = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
            return dict(filesystemBytes=info.f_blocks * block,
                        usedBytes=max(0, info.f_blocks - info.f_bfree) * block,
                        availableBytes=available, reserveBytes=self.reserve_bytes,
                        usableBytes=max(0, available - self.reserve_bytes),
                        # Node-scoped opaque device identity lets observers
                        # deduplicate bind aliases without exposing host paths.
                        volumeDeviceId=hashlib.sha256(str(os.fstat(fd).st_dev).encode()).hexdigest(),
                        checkedAt=collected, collectedAt=collected,
                        readOnly=bool(info.f_flag & getattr(os, 'ST_RDONLY', 1)) if hasattr(info, 'f_flag') else None,
                        totalInodes=info.f_files if inodes_known else None,
                        availableInodes=info.f_favail if inodes_known else None,
                        inodeUsageKnown=inodes_known, guarded=self.mount is not None,
                        scope="filesystem", activeReservationsIncluded=False,
                        datasetBudgetBytes=self.budget_bytes)

    def list_datasets(self, actor):
        """Authorized catalog and bounded ACL owner IDs, never source IDs/paths."""
        return self._list_datasets_snapshot(actor)[0]

    def _catalog_binding(self, dataset, version):
        """Metadata-only key for a display summary, never an admission proof."""
        def stamp(info):
            return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                    info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
        paths = self._paths(dataset, version)
        filename = paths['.registry'].parent / (version + '.json')
        with _directory(filename.parent) as parent:
            folder = stamp(os.fstat(parent))
            fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                record = stamp(_regular(fd))
            finally:
                os.close(fd)
        ready = None
        try:
            with _directory(paths['ready']) as fd:
                ready = [stamp(os.fstat(fd))]
                for name in ('READY.json', 'manifest.json'):
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        ready.append(stamp(_regular(child)))
                    finally:
                        os.close(child)
            with _directory(paths['ready'] / 'data') as fd:
                ready.append(stamp(os.fstat(fd)))
        except FileNotFoundError:
            if self._version_entry_exists(paths['ready']):
                raise CacheError('published directory has no valid READY metadata')
            ready = None
        return dict(root=list(self._root_identity), dataset=dataset, version=version,
                    folder=folder, record=record, ready=ready)

    def _catalog_directory(self):
        path = self.root / '.catalog'
        _mkdir(path)
        with _directory(path) as fd:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise CacheError('unsafe derived catalog directory')
        return path

    @contextlib.contextmanager
    def _catalog_read(self, actor=None, dataset=None):
        """Display metadata only: never wait behind a payload durability lock.

        Atomic service-owned records and immutable READY identities are checked
        before/after each read. This scope cannot authorize a mutation or lease;
        those callers retain their existing global/version locks and validation.
        """
        def root():
            if self.mount is not None and self._current_mount() != self.mount:
                raise CacheError('data mount identity changed; reopen cache after administrator verification')
            with _directory(self.root) as fd:
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) != self._root_identity:
                    raise CacheError('cache directory identity changed; reopen after administrator verification')
        def owner():
            self._dataset(actor, dataset)
            return self._catalog_owner_stamp(dataset)
        root()
        ownership = owner() if actor is not None else None
        yield
        if actor is not None and owner() != ownership:
            raise CacheError('catalog authorization metadata changed; retry the operation')
        root()

    def _catalog_owner_stamp(self, dataset):
        path = self._paths(dataset)['.registry'] / 'dataset.json'
        with _directory(path.parent) as parent:
            fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:return _stamp(_regular(fd))
            finally:os.close(fd)

    def _catalog_record_snapshot(self, actor, dataset, version):
        """Full display validation without the unrelated global write lock."""
        with self._catalog_read(actor, dataset):
            identity = self._record_identity(dataset, version, _read_only=True)
            record = self._record(actor, dataset, version, _read_only=True)
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
        return record, identity

    @contextlib.contextmanager
    def _catalog_version_locked(self, actor, dataset, version):
        """Read-only metadata pages retain the real exclusive version lock.

        Full registration validation and live ACL/root/retirement checks remain;
        only the unrelated payload writer's global lock is not acquired. No
        mutation, public status or lease may use this display-only scope.
        """
        _identifier(dataset); _identifier(version, HASH_RE)
        record, identity = self._catalog_record_snapshot(actor, dataset, version)
        with self._lock_file('.locks/' + dataset + '.' + version + '.lock'):
            with self._catalog_read(actor, dataset):
                self._check_snapshot(actor, dataset, version, identity)
                yield record, identity
                self._check_snapshot(actor, dataset, version, identity)

    def _catalog_status_snapshot(self, actor, dataset, version, snapshot):
        """Display overlay only; strict status/lease never call this method."""
        identity, ready_identity, ready, remaining = snapshot
        paths = self._paths(dataset, version)
        with self._catalog_read(actor, dataset):
            binding = self._catalog_binding(dataset, version)
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            self._check_ready_snapshot(paths, ready_identity)
            state, remaining = ('READY', 0) if ready else ('REGISTERED', remaining)
            if not ready and self._version_entry_exists(paths['.staging']):
                state = 'STAGING'
                remaining = self._transfer(paths['.staging'])['remainingBytes']
            fence = self._retirement_fence(dataset, version)
            result = dict(dataset=dataset, version=version, state=state, remainingBytes=remaining)
            if fence is not None and fence['state'] != 'RESTORED':
                result.update(state='UNKNOWN', deletionBlocked=True,
                              error='数据删除已锁定此版本，请查询删除任务。')
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            self._check_ready_snapshot(paths, ready_identity)
            if self._catalog_binding(dataset, version) != binding or self._retirement_fence(dataset, version) != fence:
                raise CacheError('catalog metadata changed; retry the operation')
            return result

    def _catalog_summary(self, binding, value=None):
        """Bounded service-private, disposable display cache; failure is a miss.

        No manifest or source path is retained. Source capability is recomputed
        from the current configuration. Leases, status and all data operations
        never consume these summaries.
        """
        try:
            directory = self._catalog_directory()
            name = hashlib.sha256((binding['dataset'] + '\0' + binding['version']).encode()).hexdigest() + '.json'
            path = directory / name
            if value is not None:
                with _directory(directory) as parent:
                    # Serialize this disposable cache's writers, not dataset
                    # writers. A reader can use the previous atomic summary;
                    # another summary writer is simply a cache-store miss.
                    try:fcntl.flock(parent, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    except BlockingIOError:return None
                    names = os.listdir(parent)
                    if any(not re.fullmatch(r'[a-f0-9]{64}\.json', item) for item in names):
                        return None
                    if name not in names and len(names) >= CATALOG_SUMMARY_ROWS:
                        return None
                    _write_json(path, dict(schema=SCHEMA, binding=binding, summary=value))
                return None
            with _directory(directory) as parent:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    before = _regular(fd)
                    if (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o600
                            or before.st_size > CATALOG_SUMMARY_BYTES):
                        return None
                    raw = os.read(fd, CATALOG_SUMMARY_BYTES + 1)
                    if (len(raw) != before.st_size or _stamp(before) != _stamp(_regular(fd))
                            or _stamp(before) != _stamp(os.stat(name, dir_fd=parent, follow_symlinks=False))):
                        return None
                    value = json.loads(raw)
                finally:
                    os.close(fd)
            if (not isinstance(value, dict) or set(value) != {'schema', 'binding', 'summary'}
                    or type(value['schema']) is not int or value['schema'] != SCHEMA
                    or _json_bytes(value['binding']) != _json_bytes(binding)):
                return None
            row = value['summary']
            if (not isinstance(row, dict) or set(row) != {'bytes', 'files', 'ready', 'sourceId'}
                    or type(row['bytes']) is not int or not 0 <= row['bytes'] <= MAX_ENTRIES * (2**63 - 1)
                    or type(row['files']) is not int or not 0 <= row['files'] <= MAX_ENTRIES
                    or type(row['ready']) is not bool or row['ready'] != (binding['ready'] is not None)):
                return None
            if row['sourceId'] is not None:
                _identifier(row['sourceId'])
            return row
        except (OSError, CacheError, ValueError, TypeError, KeyError):
            return None

    def _catalog_version(self, actor, dataset, version):
        with self._catalog_read(actor, dataset):
            self._dataset(actor, dataset)
            binding = self._catalog_binding(dataset, version)
            summary = self._catalog_summary(binding)
            if summary is not None:
                identity = self._record_identity(dataset, version, _read_only=True)
                ready_identity = self._ready_identity(self._paths(dataset, version))
                if self._catalog_binding(dataset, version) != binding:
                    raise CacheError('catalog metadata changed; retry the operation')
                return summary, identity, ready_identity, binding
        record, identity = self._catalog_record_snapshot(actor, dataset, version)
        ready, ready_identity = self._ready_snapshot(self._paths(dataset, version), record['manifest'], version)
        summary = dict(bytes=sum(f['size'] for f in record['manifest']['files']),
                       files=len(record['manifest']['files']), ready=ready, sourceId=record['sourceId'])
        with self._catalog_read(actor, dataset):
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            self._check_ready_snapshot(self._paths(dataset, version), ready_identity)
            if self._catalog_binding(dataset, version) != binding:
                raise CacheError('catalog metadata changed; retry the operation')
            self._catalog_summary(binding, summary)
        return summary, identity, ready_identity, binding

    @staticmethod
    def _catalog_incomplete(row):
        return dict(**{k:v for k,v in row.items() if k not in ('state','canPrepare')},
                    state='UNKNOWN', canPrepare=False, deletionBlocked=True,
                    errorCode='CACHE_METADATA_INCOMPLETE',
                    error='数据缓存元数据不完整；请管理员核验。')

    def _catalog_incomplete_binding(self, dataset, version):
        """Exact missing-parent display boundary, never a READY/absence proof."""
        def stamp(info):
            return [info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
                    info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
        paths = self._paths(dataset, version)
        filename = paths['.registry'].parent / (version + '.json')
        with _directory(filename.parent) as parent:
            folder = stamp(os.fstat(parent))
            fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:record = stamp(_regular(fd))
            finally:os.close(fd)
        parents, missing = [], False
        for path in (paths['ready'].parent, paths['.staging'].parent):
            components, boundary = path.relative_to(self.root).parts, []
            with _directory(self.root) as root:
                fd = os.dup(root)
                try:
                    for component in components:
                        try:
                            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                        except FileNotFoundError:
                            boundary.append(dict(component=component, parent=stamp(os.fstat(fd)), missing=True))
                            missing = True
                            break
                        os.close(fd); fd = child
                        boundary.append(dict(component=component, identity=stamp(os.fstat(fd))))
                finally:os.close(fd)
            parents.append(boundary)
        if not missing:
            raise CacheError('incomplete catalog parents changed; retry the operation')
        return dict(root=list(self._root_identity), dataset=dataset, version=version,
                    folder=folder, record=record, ready=None, metadataIncomplete=True,
                    parents=parents, fence=self._retirement_fence(dataset, version))

    def _catalog_incomplete_version(self, actor, dataset, version):
        # The existing bounded private summary is reusable only for counts.
        # No sourceId, canPrepare, worker identity or READY evidence is cached.
        try:self._catalog_directory()
        except (OSError, CacheError):pass  # Disposable cache failure remains a miss.
        with self._catalog_read(actor, dataset):
            binding = self._catalog_incomplete_binding(dataset, version)
            summary = self._catalog_summary(binding)
            cached = summary is not None
            if summary is None:
                record, identity = self._catalog_record_snapshot(actor, dataset, version)
                summary = dict(bytes=sum(f['size'] for f in record['manifest']['files']),
                               files=len(record['manifest']['files']), ready=False, sourceId=None)
            else:
                identity = self._record_identity(dataset, version, _read_only=True)
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            if self._catalog_incomplete_binding(dataset, version) != binding:
                raise CacheError('incomplete catalog metadata changed; retry the operation')
            if not cached:self._catalog_summary(binding, summary)
        return summary, identity, binding

    def _list_datasets_snapshot(self, actor):
        """Private per-request identities for a detached-worker status overlay.

        A bounded service-owned display summary may avoid reparsing unchanged
        manifests. Each call checks live ACL and all registration/READY stamps;
        a miss uses the original full validation. Data admission never uses it.
        """
        self._actor(actor)
        snapshots = []
        folders, access, ownership, fences = {}, {}, {}, {}
        with self._catalog_read():
            with _directory(self.root / ".registry") as fd:
                registry = _stamp(os.fstat(fd))
                datasets = sorted(os.listdir(fd))
        for dataset in datasets:
            with self._catalog_read():
                try:
                    access[dataset] = tuple(self._dataset(actor, dataset)['owners'])
                except PermissionError:
                    continue
                ownership[dataset] = self._catalog_owner_stamp(dataset)
                folder = self._paths(dataset)[".registry"]
                with _directory(folder) as fd:
                    folders[dataset] = _stamp(os.fstat(fd))
                    names = sorted(os.listdir(fd))
            versions = []
            for name in names:
                if name == "dataset.json" or re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                    continue
                if not name.endswith(".json"):
                    raise CacheError("corrupt registry directory")
                version = name[:-5]
                try:
                    summary, identity, ready_identity, binding = self._catalog_version(actor, dataset, version)
                except CacheMetadataIncomplete:
                    # Only this typed parent absence becomes a display row.
                    # Validate the exact registration and live ACL again; do
                    # not catch corrupt metadata, I/O errors or unsafe links.
                    summary, identity, binding = self._catalog_incomplete_version(actor, dataset, version)
                    row = self._catalog_incomplete(dict(version=version,
                        bytes=summary['bytes'], files=summary['files']))
                    versions.append((row, identity, None, binding))
                    continue
                # Summation and parsing scale with the manifest; they must not
                # delay unrelated publication/lease admission under global lock.
                row = dict(version=version, state="READY" if summary['ready'] else "REGISTERED",
                           canPrepare=summary['sourceId'] in self.sources,
                           bytes=summary['bytes'], files=summary['files'])
                versions.append((row, identity, ready_identity, binding))
            snapshots.append((dataset, versions))
        result, current = [], {}
        with self._catalog_read():
            for dataset, versions in snapshots:
                # Recheck every ACL before any catalog leaves the service. ACL
                # revocation or metadata replacement during parsing is rejected.
                metadata = self._dataset(actor, dataset)
                rows = []
                for row, identity, ready_identity, binding in versions:
                    version = row['version']
                    self._check_snapshot(actor, dataset, version, identity, _read_only=True)
                    paths = self._paths(dataset, version)
                    if binding is None or binding.get('metadataIncomplete') is True:
                        # UNKNOWN rows intentionally have no trusted snapshot
                        # for worker/admission overlays. No parents are made.
                        if binding is not None and self._catalog_incomplete_binding(dataset, version) != binding:
                            raise CacheError('incomplete catalog metadata changed; retry the operation')
                        rows.append(row)
                        continue
                    try:
                        self._check_ready_snapshot(paths, ready_identity)
                        if self._catalog_binding(dataset, version) != binding:
                            raise CacheError('catalog metadata changed; retry the operation')
                        staging = row['state'] != "READY" and self._version_entry_exists(paths[".staging"])
                    except CacheMetadataIncomplete:
                        rows.append(self._catalog_incomplete(row))
                        continue
                    current[(dataset, version)] = (identity, ready_identity,
                                                  row['state'] == 'READY', row['bytes'])
                    if staging:
                        row['state'] = "STAGING"
                    fence = self._retirement_fence(dataset, version)
                    fences[(dataset, version)] = fence
                    if fence is not None and fence['state'] != 'RESTORED':
                        row.update(state='UNKNOWN', canPrepare=False, deletionBlocked=True,
                                   error='数据删除已锁定此版本，请查询删除任务。')
                    rows.append(row)
                owners = self._owners(metadata["owners"])
                # A display bound, not an ACL limit. Never return a truncated
                # list that could be mistaken for the complete authorization.
                result.append(dict(dataset=dataset, versions=rows,
                                   ownerIds=owners if len(owners) <= 64 else None))
            # An unlocked directory enumeration is never an absence proof if
            # registrations/ACLs changed during the read. Recheck all returned
            # dataset folders and the top-level inventory.
            for dataset, expected in folders.items():
                with _directory(self._paths(dataset)['.registry']) as fd:
                    if _stamp(os.fstat(fd)) != expected:
                        raise CacheError('catalog registration inventory changed; retry the operation')
            for dataset, versions in snapshots:
                if tuple(self._dataset(actor, dataset)['owners']) != access[dataset]:
                    raise CacheError('catalog authorization metadata changed; retry the operation')
                if self._catalog_owner_stamp(dataset) != ownership[dataset]:
                    raise CacheError('catalog authorization metadata changed; retry the operation')
                for row, identity, ready_identity, binding in versions:
                    version = row['version']
                    self._check_snapshot(actor, dataset, version, identity, _read_only=True)
                    if binding is not None and binding.get('metadataIncomplete') is True:
                        if self._catalog_incomplete_binding(dataset, version) != binding:
                            raise CacheError('incomplete catalog metadata changed; retry the operation')
                        continue
                    if binding is not None and (dataset, version) in fences:
                        try:
                            self._check_ready_snapshot(self._paths(dataset, version), ready_identity)
                            if self._catalog_binding(dataset, version) != binding:
                                raise CacheError('catalog metadata changed; retry the operation')
                        except CacheMetadataIncomplete:
                            row.update(self._catalog_incomplete(row))
                            current.pop((dataset, version), None)
                        if self._retirement_fence(dataset, version) != fences[(dataset, version)]:
                            raise CacheError('catalog deletion metadata changed; retry the operation')
            with _directory(self.root / '.registry') as fd:
                if _stamp(os.fstat(fd)) != registry:
                    raise CacheError('catalog registration inventory changed; retry the operation')
        return {"datasets": result}, current

    def status(self, actor, dataset, version):
        """Lightweight metadata only: no data hashing or staging modifications."""
        return self._status_snapshot(actor, dataset, version)[0]

    def _status_snapshot(self, actor, dataset, version, *, require_protected=False):
        """Trusted adapter also receives the validated registration identity."""
        try:
            record, identity = self._record_snapshot(actor, dataset, version, _read_only=True)
        except FileNotFoundError:
            # Keep the missing-registration type for internal lifecycle callers,
            # but never expose an OS path as the user's status explanation.
            raise FileNotFoundError("dataset registration or version does not exist or was removed; refresh the dataset list") from None
        paths = self._paths(dataset, version)
        ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
        remaining = 0 if ready else sum(f["size"] for f in record["manifest"]["files"])
        return self._status_catalog_snapshot(actor, dataset, version,
                                             (identity, ready_identity, ready, remaining), require_protected=require_protected), identity

    def _status_catalog_snapshot(self, actor, dataset, version, snapshot, *, require_protected=False):
        """Trusted same-call catalog snapshot; never a public request field."""
        identity, ready_identity, ready, remaining = snapshot
        paths = self._paths(dataset, version)
        state = "READY" if ready else "REGISTERED"
        remaining = 0 if ready else remaining
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            self._check_ready_snapshot(paths, ready_identity)
            if state != "READY" and self._version_entry_exists(paths[".staging"]):
                state = "STAGING"
                remaining = self._transfer(paths[".staging"])["remainingBytes"]
            fence = self._retirement_fence(dataset, version)
            if fence is not None and fence['state'] != 'RESTORED':
                return dict(dataset=dataset, version=version, state='UNKNOWN', remainingBytes=remaining,
                            deletionBlocked=True, error='数据删除已锁定此版本，请查询删除任务。')
            if require_protected and self._tier(dataset, version)['role'] != 'protected':
                raise CacheError('warehouse inspection requires a protected original')
            return dict(dataset=dataset, version=version, state=state, remainingBytes=remaining)

    def _transfer(self, stage):
        value = _read_json(stage / "TRANSFER.json")
        if (not isinstance(value, dict) or set(value) != {"schema", "owner", "token", "remainingBytes", "totalBytes"}
                or value["schema"] != SCHEMA or type(value["remainingBytes"]) is not int
                or type(value["totalBytes"]) is not int or not 0 <= value["remainingBytes"] <= value["totalBytes"]):
            raise CacheError("corrupt transfer fence; administrator repair required")
        _identifier(value["owner"], USER_RE)
        if not isinstance(value["token"], str) or str(uuid.UUID(value["token"])) != value["token"]:
            raise CacheError("invalid transfer token")
        return value

    def _upload_reserved(self, *, budget=False):
        total = inodes = 0
        # Member uploads reserve future payload before their large manifest is
        # sealed. Public-source materialization must see those reservations too.
        with _directory(self.root / ".upload-reservations") as fd:
            reservations = os.listdir(fd)
        for name in reservations:
            if re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                continue
            if not re.fullmatch(r"[a-f0-9]{64}\.json", name):
                raise CacheError("corrupt upload reservation directory")
            value = _read_json(self.root / ".upload-reservations" / name)
            if (not isinstance(value, dict) or set(value) not in ({"bytes"}, {"bytes", "inodes"}, {"bytes", "inodes", "budgetBytes"})
                    or any(type(number) is not int or not 0 <= number <= 2**63-1 for number in value.values())):
                raise CacheError("corrupt upload reservation")
            # bytes/inodes retain the physical future-write reservation. New
            # uploads separately track logical commitments across staging;
            # legacy records remain conservatively charged by physical bytes.
            total += value.get("budgetBytes", value["bytes"]) if budget else value["bytes"]
            inodes += value.get('inodes', 0)
        return total, inodes

    def _reserved(self, except_stage=None):
        total = self._upload_reserved()[0]
        with _directory(self.root / ".staging") as fd:
            datasets = os.listdir(fd)
        for dataset in datasets:
            _identifier(dataset)
            parent = self._paths(dataset)[".staging"]
            with _directory(parent) as fd:
                versions = os.listdir(fd)
            for version in versions:
                stage = self._paths(dataset, version)[".staging"]
                if stage != except_stage:
                    total += self._transfer(stage)["remainingBytes"]
        return total

    def _reserved_inodes(self):
        """Caller holds the cache lock; conservative immutable staging demand.

        Created staging entries may be counted again, deliberately retaining an
        upper bound without scanning mutable payload trees. Upload reservations
        are counted once, and no caller may spend predicted reclaimed inodes.
        """
        total = self._upload_reserved()[1]
        actor = Principal("builtin-admin", True)
        with _directory(self.root / ".staging") as fd:
            datasets = os.listdir(fd)
        for dataset in datasets:
            _identifier(dataset)
            with _directory(self.root / ".staging" / dataset) as fd:
                versions = os.listdir(fd)
            for version in versions:
                _identifier(version, HASH_RE)
                record = self._record(actor, dataset, version)
                transfer = self._transfer(self._paths(dataset, version)[".staging"])
                manifest = record["manifest"]
                if transfer["totalBytes"] != sum(item["size"] for item in manifest["files"]):
                    raise CacheError("staging inode reservation differs from immutable manifest")
                total += len(manifest["files"]) + len(manifest["directories"]) + 16
        return total

    def _ready(self, paths, manifest, version, *, _canonical=False):
        try:
            marker = _read_json(paths["ready"] / "READY.json")
        except FileNotFoundError:
            if self._version_entry_exists(paths["ready"]):
                raise CacheError("published directory has no valid READY marker")
            return False
        if marker != {"schema": SCHEMA, "version": version}:
            raise CacheError("published version metadata is corrupt")
        matches = (_canonical_json_matches(paths["ready"] / "manifest.json", version)
                   if _canonical else _read_json(paths["ready"] / "manifest.json") == manifest)
        if not matches:
            raise CacheError("published version metadata is corrupt")
        with _directory(paths["ready"]) as fd:
            if os.fstat(fd).st_mode & 0o222:
                raise CacheError("published version wrapper is not read-only")
        with _directory(paths["ready"] / "data") as fd:
            if os.fstat(fd).st_mode & 0o222:
                raise CacheError("published data is not read-only")
        return True

    def _stage_files(self, stage, manifest, *, hashes=True, index=None):
        wanted = index if index is not None else {f["path"]: f for f in manifest["files"]}
        expected_dirs = set(manifest["directories"])
        found = {}
        def visit(fd, prefix):
            for name in os.listdir(fd):
                relative = _relative(prefix + name)
                info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    if relative not in expected_dirs:
                        raise CacheError("unexpected staging directory")
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        visit(child, relative + "/")
                    finally:
                        os.close(child)
                else:
                    if relative not in wanted:
                        raise CacheError("unexpected staging file")
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        size = _regular(child).st_size
                        if size > wanted[relative]["size"]:
                            raise CacheError("staging file exceeds registered size")
                        digest = _digest_fd(child)[0] if hashes else None
                        if hashes and size == wanted[relative]["size"] and digest != wanted[relative]["sha256"]:
                            raise CacheError("completed staging file checksum mismatch")
                        found[relative] = (size, digest)
                    finally:
                        os.close(child)
        with _directory(stage / "data") as fd:
            visit(fd, "")
        result = []
        empty_digest = hashlib.sha256(b"").hexdigest() if hashes else None
        for entry in manifest["files"]:
            size, digest = found.get(entry["path"], (0, empty_digest))
            result.append(dict(**entry, offset=size, prefixSha256=digest, complete=entry["path"] in found and size == entry["size"]))
        return result

    def _plan(self, actor, dataset, version, *, record=None, index=None, reservation_credit=0):
        record = self._record(actor, dataset, version) if record is None else record
        paths = self._paths(dataset, version)
        manifest = record["manifest"]
        if self._ready(paths, manifest, version):
            return dict(dataset=dataset, version=version, state="READY", files=[], remainingBytes=0)
        stage = paths[".staging"]
        total = sum(f["size"] for f in manifest["files"])
        # Check before creating a stage or rewriting its accounting. Excluding
        # this exact stage and adding its full footprint makes resume idempotent
        # while still counting every concurrent prepared copy and upload.
        # Only the trusted uploader converts its already-held complete logical
        # reservation while owning this same global lock. It lowers the durable
        # upload commitment only after the whole stage has been created.
        self._budget(self._footprint(manifest), except_stage=stage, reservation_credit=reservation_credit)
        try:
            transfer = self._transfer(stage)
        except FileNotFoundError:
            with _directory(stage.parent) as fd:
                if stage.name in os.listdir(fd):
                    raise CacheError("incomplete transfer fence; administrator repair required")
            self._free(self._reserved() + total + 8192)
            _mkdir(stage)
            if getattr(self, 'quota_guard', None):
                try:
                    self.quota_guard(actor, dataset, stage)
                except Exception:
                    # No payload/fence has been written. Remove only our empty
                    # directory, never an unknown or retained transfer tree.
                    try: stage.rmdir()
                    except OSError: pass
                    raise
            _mkdir(stage / "data")
            transfer = dict(schema=SCHEMA, owner=actor.user_id, token=str(uuid.uuid4()), remainingBytes=total, totalBytes=total)
            _write_json(stage / "TRANSFER.json", transfer)
        if not actor.is_admin and transfer["owner"] != actor.user_id:
            raise PermissionError("unfinished transfer belongs to another owner")
        if getattr(self, 'quota_guard', None):
            self.quota_guard(actor, dataset, stage)
        if transfer["totalBytes"] != total:
            raise CacheError("transfer size differs from registered manifest")
        # Recover a crash between fsync of data and accounting update conservatively.
        files = self._stage_files(stage, manifest, hashes=False, index=index)
        remaining = sum(f["size"] - f["offset"] for f in files)
        self._free(self._reserved(except_stage=stage) + remaining + 8192)
        with _directory(stage) as fd:
            os.fchmod(fd, 0o700)
        transfer["remainingBytes"] = remaining
        _write_json(stage / "TRANSFER.json", transfer)
        return dict(dataset=dataset, version=version, state="STAGING", token=transfer["token"],
                    remainingBytes=remaining, chunkBytes=CHUNK_BYTES, files=files)

    def plan(self, actor, dataset, version):
        with self._version_locked(actor, dataset, version):
            with self._locked():
                result = self._plan(actor, dataset, version)
                manifest = self._record(actor, dataset, version)["manifest"]
            if result["state"] == "STAGING":
                result["files"] = self._stage_files(self._paths(dataset, version)[".staging"], manifest)
            return result

    def prepare_transfer(self, actor, dataset, version):
        """Privileged rsync integration only; stop/join writers before publish."""
        self._actor(actor, admin=True)
        plan = self.plan(actor, dataset, version)
        if plan["state"] == "STAGING":
            plan["stagingPath"] = str(self._paths(dataset, version)[".staging"] / "data")
            plan["transportRequirement"] = "trusted exclusive writer; no symlinks/devices/specials; exit before publish"
        return plan

    def _authorize_transfer(self, actor, dataset, version, token, *, snapshot=None):
        if snapshot is None:
            record = self._record(actor, dataset, version)
        else:
            record, identity = snapshot
            self._check_snapshot(actor, dataset, version, identity)
        paths = self._paths(dataset, version)
        if self._ready(paths, record["manifest"], version):
            raise CacheError("published version cannot be modified")
        transfer = self._transfer(paths[".staging"])
        if transfer["token"] != token or (not actor.is_admin and transfer["owner"] != actor.user_id):
            raise PermissionError("transfer owner/token mismatch")
        return record, paths, transfer

    def put_chunk(self, actor, dataset, version, path, offset, data, token):
        if type(offset) is not int or offset < 0 or not isinstance(data, bytes) or len(data) > CHUNK_BYTES:
            raise CacheError("invalid chunk offset/data/size")
        _relative(path)
        with self._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            with self._locked():
                record, paths, transfer = self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
                entry = next((f for f in record["manifest"]["files"] if f["path"] == path), None)
                if entry is None:
                    raise CacheError("chunk outside registered file")
                self._free(self._reserved() + 8192)
                result, written = self._put_chunk_data(paths[".staging"], entry, offset, data, transfer["remainingBytes"])
                if written:
                    transfer["remainingBytes"] -= written
                    _write_json(paths[".staging"] / "TRANSFER.json", transfer)
                return result

    def _put_chunk_data(self, stage, entry, offset, data, remaining):
        """Validated manifest entry, exclusive version lock, reserved capacity.

        Data and directory entries reach disk before callers reduce accounting.
        A crash before the batched fence update thus only over-reserves space;
        _plan recovers from actual file sizes and verifies prefixes before resume.
        """
        if offset + len(data) > entry["size"]:
            raise CacheError("chunk outside registered file")
        path = entry["path"]
        parent = stage / "data"
        for part in Path(path).parts[:-1]:
            parent = parent / part
            _mkdir(parent)
        with _directory(parent) as fd:
            target = os.open(Path(path).name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
            try:
                size = _regular(target).st_size
                if offset < size and offset + len(data) <= size:
                    os.lseek(target, offset, os.SEEK_SET)
                    if os.read(target, len(data)) != data:
                        raise CacheError("retry would overwrite existing bytes")
                    return dict(offset=size, complete=size == entry["size"]), 0
                if offset != size:
                    raise CacheError("chunk offset must match current file length")
                if remaining < len(data):
                    raise CacheError("invalid transfer space accounting")
                os.lseek(target, offset, os.SEEK_SET)
                view = memoryview(data)
                while view:
                    written = os.write(target, view)
                    if not written:
                        raise OSError("short dataset write")
                    view = view[written:]
                os.fsync(target)
                os.fsync(fd)
            finally:
                os.close(target)
        return dict(offset=offset + len(data), complete=offset + len(data) == entry["size"]), len(data)

    def read_chunk(self, actor, dataset, version, path, offset=0, length=CHUNK_BYTES):
        """Only registered paths from a published replica, never arbitrary host files."""
        _relative(path)
        if type(offset) is not int or offset < 0 or type(length) is not int or not 1 <= length <= CHUNK_BYTES:
            raise CacheError("invalid read range")
        with self._locked():
            record = self._record(actor, dataset, version)
            paths = self._paths(dataset, version)
            if not self._ready(paths, record["manifest"], version):
                raise CacheError("dataset version is not READY")
            entry = next((f for f in record["manifest"]["files"] if f["path"] == path), None)
            if entry is None or offset > entry["size"]:
                raise CacheError("read outside registered file")
            filename = paths["ready"] / "data" / path
            with _directory(filename.parent) as parent:
                fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                try:
                    if _regular(fd).st_size != entry["size"]:
                        raise CacheError("published file size changed")
                    os.lseek(fd, offset, os.SEEK_SET)
                    data = os.read(fd, length)
                finally:
                    os.close(fd)
            return dict(data=base64.b64encode(data).decode(), offset=offset + len(data), eof=offset + len(data) == entry["size"])

    def publish(self, actor, dataset, version, token):
        with self._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            return self._publish_locked(actor, dataset, version, token, snapshot)

    def _publish_locked(self, actor, dataset, version, token, snapshot, *, _guard=None):
        """Publish with the same exclusively locked, validated registration."""
        record, identity = snapshot
        paths = self._paths(dataset, version)
        ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
        with self._locked():
            if _guard is not None:
                _guard()
            self._check_snapshot(actor, dataset, version, identity)
            self._check_ready_snapshot(paths, ready_identity)
            if ready:
                return dict(dataset=dataset, version=version, state="READY")
            record, paths, transfer = self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
            # Empty directories are real disk/inode allocations too. Reserve
            # their worst-case metadata before creating a large empty tree.
            self._free(self._reserved()+8192*len(record['manifest']['directories'])+8192,
                       needed_inodes=len(record['manifest']['directories']))
        stage = paths[".staging"]
        for directory in record["manifest"]["directories"]:
            _mkdir(stage / "data" / directory)
        actual = _scan(stage / "data")
        if actual != record["manifest"]:
            raise CacheError("staging checksum/tree does not match registered version")
        with self._locked():
            if _guard is not None:
                _guard()
            self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
            self._free(self._reserved(except_stage=stage) + len(_json_bytes(actual)) + 8192)
            with _directory(stage) as fd:
                os.fchmod(fd, 0o700)
                names = set(os.listdir(fd))
            if not names <= {"data", "TRANSFER.json", "manifest.json", "READY.json"}:
                raise CacheError("unexpected staging metadata")
            _write_json(stage / "manifest.json", actual)
            _write_json(stage / "READY.json", dict(schema=SCHEMA, version=version))
        try:
            # Hashing and chmod/fsync hold only the version lock. Other versions
            # and lightweight status remain available throughout a long copy.
            _modes(stage, True, bulk_durability=True)
            with self._locked():
                if _guard is not None:
                    _guard()
                self._authorize_transfer(actor, dataset, version, token, snapshot=snapshot)
                self._free(self._reserved(except_stage=stage) + 8192)
                with _directory(stage) as fd:
                    os.fchmod(fd, 0o700)
                    os.unlink("TRANSFER.json", dir_fd=fd)
                    os.fchmod(fd, 0o555)
                    os.fsync(fd)
                _rename_new(stage, paths["ready"])
        except BaseException:
            try:
                _modes(stage, False)
                _write_json(stage / "TRANSFER.json", transfer)
            except OSError:
                pass
            raise
        return dict(dataset=dataset, version=version, state="READY")

    def materialize(self, actor, dataset, version, *, _source=None, _guard=None):
        """Copy an approved source. Private overrides are trusted tier hooks only.

        dispatch never accepts _source/_guard; callers must not derive them from
        a user request. The tier adapter supplies a protected fixed READY path
        and checks its receipt while this method owns the destination version.
        """
        self._actor(actor)
        if _source is not None or _guard is not None:
            self._actor(actor, admin=True)
        with self._version_locked(actor, dataset, version, snapshot=True) as snapshot:
            record, identity = snapshot
            index = {entry["path"]: entry for entry in record["manifest"]["files"]}
            paths = self._paths(dataset, version)
            ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
            with self._locked():
                if _guard is not None:
                    _guard()
                self._check_snapshot(actor, dataset, version, identity)
                self._check_ready_snapshot(paths, ready_identity)
                if ready:
                    return dict(dataset=dataset, version=version, state="READY")
                source = _absolute(_source) if _source is not None else self.sources.get(record["sourceId"])
                if source is None:
                    raise CacheError("version has no approved local source")
                plan = self._plan(actor, dataset, version, record=record, index=index)
                fence = self._transfer(paths[".staging"])
                del plan["files"]
            stage = paths[".staging"]
            files = self._stage_files(stage, record["manifest"], index=index)
            # The on-disk remainingBytes intentionally stays an upper bound
            # until fsynced chunks are checkpointed. Other versions can never
            # spend unaccounted capacity; a killed copy remains resumable.
            remaining = plan["remainingBytes"]
            batch_bytes = batch_files = 0
            checked_at = time.monotonic()

            def checkpoint():
                nonlocal fence, batch_bytes, batch_files, checked_at
                with self._locked():
                    if _guard is not None:
                        _guard()
                    _, _, current = self._authorize_transfer(actor, dataset, version, plan["token"], snapshot=snapshot)
                    if current != fence:
                        raise CacheError("transfer accounting changed during exclusive copy")
                    self._free(self._reserved(except_stage=stage) + remaining + 8192)
                    if current["remainingBytes"] != remaining:
                        fence = dict(current, remainingBytes=remaining)
                        _write_json(stage / "TRANSFER.json", fence)
                batch_bytes = batch_files = 0
                checked_at = time.monotonic()

            def put_reserved(entry, offset, data):
                # Keep live free-space/owner checks at chunk granularity. The
                # durable fence reserves this version's entire future write,
                # so releasing the global lock before local I/O cannot let
                # another admission spend this capacity. Avoid counting our
                # already-fsynced but not-yet-checkpointed bytes twice.
                with self._locked():
                    if _guard is not None:
                        _guard()
                    self._check_snapshot(actor, dataset, version, identity)
                    self._free(self._reserved(except_stage=stage) + remaining + 8192)
                return self._put_chunk_data(stage, entry, offset, data, remaining)

            checkpoint()
            for entry in files:
                filename = source / entry["path"]
                with _directory(filename.parent) as parent:
                    fd = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    try:
                        before = _regular(fd)
                        if before.st_size != entry["size"]:
                            raise CacheError("approved source size changed since registration")
                        if _digest_fd(fd, entry["offset"])[0] != entry["prefixSha256"]:
                            raise CacheError("partial transfer is not a prefix of the registered source")
                        offset = entry["offset"]
                        os.lseek(fd, offset, os.SEEK_SET)
                        if entry["size"] == 0 and not entry["complete"]:
                            put_reserved(index[entry["path"]], 0, b"")
                        while offset < entry["size"]:
                            data = os.read(fd, min(CHUNK_BYTES, entry["size"] - offset))
                            if not data:
                                raise CacheError("source changed during copy")
                            _, written = put_reserved(index[entry["path"]], offset, data)
                            remaining -= written
                            batch_bytes += written
                            offset += len(data)
                            if batch_bytes >= TRANSFER_BATCH_BYTES or time.monotonic() - checked_at >= TRANSFER_BATCH_SECONDS:
                                checkpoint()
                        if _stamp(before) != _stamp(_regular(fd)):
                            raise CacheError("source changed during copy")
                    finally:
                        os.close(fd)
                batch_files += 1
                if batch_files >= TRANSFER_BATCH_FILES or time.monotonic() - checked_at >= TRANSFER_BATCH_SECONDS:
                    checkpoint()
            checkpoint()
            # Full destination hashing is still mandatory before atomic READY;
            # source identity and resumed-prefix checks above remain unchanged.
            # The scan builds its own tree; do not retain a second full resume
            # plan and path index while hashing up to half a million files.
            del files, index
            return self._publish_locked(actor, dataset, version, plan["token"], snapshot, _guard=_guard)

    def prepare(self, actor, dataset, version):
        """Materialize an approved local source, or return a resumable replica plan."""
        record, identity = self._record_snapshot(actor, dataset, version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            local = record["sourceId"] in self.sources
        del record
        return self.materialize(actor, dataset, version) if local else self.plan(actor, dataset, version)

    def verify(self, actor, dataset, version):
        with self._version_locked(actor, dataset, version):
            with self._locked():
                record = self._record(actor, dataset, version)
                paths = self._paths(dataset, version)
                if not self._ready(paths, record["manifest"], version):
                    raise CacheError("dataset version is not READY")
            if _scan(paths["ready"] / "data") != record["manifest"]:
                raise CacheError("dataset is not READY or integrity verification failed")
            return dict(dataset=dataset, version=version, state="READY", verified=True)

    def _leases(self, dataset, version):
        folder = self._paths(dataset, version)[".leases"]
        try:
            with _directory(folder) as fd:
                names = os.listdir(fd)
        except FileNotFoundError:
            return []
        leases = []
        for name in names:
            if not name.endswith(".json") or str(uuid.UUID(name[:-5])) != name[:-5]:
                raise CacheError("corrupt lease directory; eviction forbidden")
            lease = _read_json(folder / name)
            if (not isinstance(lease, dict) or set(lease) != {"schema", "id", "owner", "jobId", "createdAt"}
                    or lease["schema"] != SCHEMA or lease["id"] != name[:-5]):
                raise CacheError("corrupt lease; eviction forbidden")
            _identifier(lease["owner"], USER_RE)
            _identifier(lease["jobId"], USER_RE)
            leases.append(lease)
        return leases

    def acquire_lease(self, actor, dataset, version, job_id):
        """Executor must validate job ownership before invoking this method."""
        _identifier(job_id, USER_RE)
        record, identity = self._record_snapshot(actor, dataset, version)
        paths = self._paths(dataset, version)
        ready, ready_identity = self._ready_snapshot(paths, record["manifest"], version)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity)
            self._check_ready_snapshot(paths, ready_identity)
            if not ready:
                raise CacheError("cannot lease an unready version")
            leases = self._leases(dataset, version)
            lease = next((l for l in leases if l["jobId"] == job_id and l["owner"] == actor.user_id), None)
            if lease is None:
                # Existing READY reads do not consume copy/publication capacity.
                # The small atomic lease write still has to succeed; real
                # metadata I/O errors must never become a protected-read reply.
                _mkdir(paths[".leases"])
                lease = dict(schema=SCHEMA, id=str(uuid.uuid4()), owner=actor.user_id, jobId=job_id, createdAt=time.time())
                _write_json(paths[".leases"] / (lease["id"] + ".json"), lease)
            self._touch_locked(dataset, version)
            return dict(leaseId=lease["id"], dataset=dataset, version=version, path=str(paths["ready"] / "data"), readOnly=True)

    def release_lease(self, actor, dataset, version, lease_id):
        """Trusted scheduler/admin only, AFTER confirming the job has stopped."""
        self._actor(actor, admin=True)
        if not isinstance(lease_id, str) or str(uuid.UUID(lease_id)) != lease_id:
            raise CacheError("invalid lease ID")
        _, identity = self._record_snapshot(actor, dataset, version, _read_only=True)
        with self._locked():
            self._check_snapshot(actor, dataset, version, identity, _read_only=True)
            leases = self._leases(dataset, version)
            if not any(l["id"] == lease_id for l in leases):
                return {"released": False}
            folder = self._paths(dataset, version)[".leases"]
            with _directory(folder) as fd:
                os.unlink(lease_id + ".json", dir_fd=fd)
                os.fsync(fd)
            return {"released": True}

    @staticmethod
    def _default_tier():
        return dict(schema=1, role="protected", lastUsedAt=0, pins={}, recovery=None)

    def _tier(self, dataset, version):
        """Private metadata; absence on an older registration means protected.

        Caller holds the global cache lock. This is separate from immutable
        manifests, so installing this feature never mutates their identity.
        """
        self._paths(dataset, version)
        try:
            value = _read_json(self.root / ".tiers" / dataset / (version + ".json"))
        except FileNotFoundError:
            return self._default_tier()
        if (not isinstance(value, dict) or set(value) != {"schema", "role", "lastUsedAt", "pins", "recovery"}
                or value["schema"] != 1 or value["role"] not in {"protected", "cache"}
                or type(value["lastUsedAt"]) not in (int, float)
                or not math.isfinite(value["lastUsedAt"]) or value["lastUsedAt"] < 0
                or not isinstance(value["pins"], dict)
                or (value["recovery"] is not None and not isinstance(value["recovery"], dict))):
            raise CacheError("corrupt tier metadata; cleanup forbidden")
        for key, pin in value["pins"].items():
            _identifier(key)
            if (not isinstance(pin, dict) or set(pin) != {"owner", "createdAt"}
                    or type(pin["createdAt"]) not in (int, float)
                    or not math.isfinite(pin["createdAt"]) or pin["createdAt"] < 0):
                raise CacheError("corrupt persistent pin; cleanup forbidden")
            _identifier(pin["owner"], USER_RE)
        return value

    def _write_tier(self, dataset, version, value):
        self._paths(dataset, version)
        folder = self.root / ".tiers" / dataset
        _mkdir(folder)
        _write_json(folder / (version + ".json"), value)

    def _authority_pins(self, dataset, version=None):
        """Permanent recovery retention freezes ACL/source identity as well.

        Caller holds global lock. These pins cannot be removed through ordinary
        unpin: decommission needs a separate trusted dependency reconciliation.
        Include orphan metadata so broken registration cannot erase retention.
        """
        self._paths(dataset, version)
        if version is None:
            try:
                with _directory(self.root / ".tiers" / dataset) as fd:
                    names = os.listdir(fd)
            except FileNotFoundError:
                return False
            versions = []
            for name in names:
                if re.fullmatch(r"\.write-[a-f0-9]{32}", name):
                    continue
                if not name.endswith(".json"):
                    raise CacheError("unknown tier metadata; retention reconciliation required")
                versions.append(_identifier(name[:-5], HASH_RE))
        else:
            versions = [version]
        return any(any(pin.startswith("authority-") for pin in self._tier(dataset, item)["pins"])
                   for item in versions)

    def _touch_locked(self, dataset, version):
        value = self._tier(dataset, version)
        value["lastUsedAt"] = max(value["lastUsedAt"], time.time())
        self._write_tier(dataset, version, value)

    def touch(self, actor, dataset, version):
        """Record a real authorized use; catalog/status polls do not refresh LRU."""
        with self._locked():
            record = self._record(actor, dataset, version)
            if not self._ready(self._paths(dataset, version), record["manifest"], version):
                raise CacheError("cannot touch an unready version")
            self._touch_locked(dataset, version)
            return dict(touched=True)

    def pin(self, actor, dataset, version, pin_id, *, own_only=False):
        """Trusted operator/worker protection, with no age-based expiry."""
        self._actor(actor, admin=True)
        _identifier(pin_id)
        if own_only and pin_id.startswith("authority-"):
            raise CacheError("authority retention pins require explicit dependency reconciliation")
        with self._locked():
            record = self._record(actor, dataset, version)
            if not self._ready(self._paths(dataset, version), record["manifest"], version):
                raise CacheError("cannot pin an unready version")
            tier = self._tier(dataset, version)
            existing = tier["pins"].get(pin_id)
            if own_only and existing is not None and existing.get("owner") != actor.user_id:
                raise CacheError("manual pin is not owned by this principal")
            tier["pins"].setdefault(pin_id, dict(owner=actor.user_id, createdAt=time.time()))
            self._write_tier(dataset, version, tier)
            return dict(pinned=True, pinId=pin_id)

    def unpin(self, actor, dataset, version, pin_id, *, own_only=False):
        """Only after the trusted caller has confirmed the protected use ended."""
        self._actor(actor, admin=True)
        _identifier(pin_id)
        if pin_id.startswith("authority-"):
            raise CacheError("authority retention pins require explicit dependency reconciliation")
        with self._locked():
            self._record(actor, dataset, version)
            tier = self._tier(dataset, version)
            existing = tier["pins"].get(pin_id)
            if own_only and existing is not None and existing.get("owner") != actor.user_id:
                raise CacheError("manual pin is not owned by this principal")
            removed = tier["pins"].pop(pin_id, None) is not None
            self._write_tier(dataset, version, tier)
            return dict(unpinned=removed)

    def _quarantine_locked(self, dataset, version, *, ready_only=False):
        """Caller owns version + global locks; lease/pin admission is atomic."""
        if self._leases(dataset, version):
            raise CacheError("active leases prevent eviction; leases never expire automatically")
        if self._tier(dataset, version)["pins"]:
            raise CacheError("persistent pins prevent eviction; pins never expire automatically")
        quarantined = []
        for name in (("ready",) if ready_only else ("ready", ".staging")):
            path = self._paths(dataset, version)[name]
            with _directory(path.parent) as fd:
                if path.name not in os.listdir(fd):
                    continue
            with _directory(path):
                pass
            trash = self.root / ".trash" / uuid.uuid4().hex
            _rename_new(path, trash)
            quarantined.append(trash)
        return quarantined

    def _remove_quarantined(self, quarantined):
        for trash in quarantined:
            _modes(trash, False)
            shutil.rmtree(trash)
            with _directory(trash.parent) as fd:
                os.fsync(fd)

    def evict(self, actor, dataset, version):
        """Administrator cleanup only. Registration remains for later recreation."""
        self._actor(actor, admin=True)
        with self._retention_guard(actor, dataset, version) as protected, self._version_locked(actor, dataset, version):
            if not protected:
                with self._retention_guard(actor, dataset, version, _confirm_only=True):
                    pass
            with self._locked():
                self._record(actor, dataset, version)
                quarantined = self._quarantine_locked(dataset, version)
            # Once quarantined atomically, no new lease can see these paths.
            # Large recursive cleanup need not block status/other dataset jobs.
            self._remove_quarantined(quarantined)
            return dict(evicted=bool(quarantined), registrationRetained=True)

    def _unregister_snapshot(self, actor, dataset, version):
        """Small, no-follow metadata snapshot; caller holds the global lock."""
        paths = self._paths(dataset)
        copies = set()
        for name in ("ready", ".staging", ".leases"):
            try:
                with _directory(paths[name]) as fd:
                    names = os.listdir(fd)
                    info = os.fstat(fd)
                    if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                        raise CacheError("unsafe dataset cleanup directory")
            except FileNotFoundError:
                continue
            for item in names:
                _identifier(item, HASH_RE)
                if version is None or item == version:
                    with _directory(paths[name] / item) as fd:
                        info = os.fstat(fd)
                        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                            raise CacheError("unsafe dataset cleanup directory")
                    # Empty lease folders survive release_lease; they are not
                    # consumers and must not turn an idempotent retry into an
                    # orphan-data error after the registration was archived.
                    if name != ".leases" or self._leases(dataset, item):
                        copies.add(item)
        try:
            with _directory(paths[".registry"]) as fd:
                info = os.fstat(fd)
                if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                    raise CacheError("unsafe dataset registration directory")
                names = sorted(os.listdir(fd))
                stamps, registered = [], []
                for name in names:
                    temporary = re.fullmatch(r"\.write-[a-f0-9]{32}", name)
                    if name != "dataset.json" and not temporary:
                        if not name.endswith(".json"):
                            raise CacheError("corrupt registry directory")
                        registered.append(_identifier(name[:-5], HASH_RE))
                    child = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        child_info = _regular(child)
                        if child_info.st_uid != os.geteuid() or child_info.st_mode & 0o022:
                            raise CacheError("unsafe dataset registration file")
                        if version is None or name in ("dataset.json", version + ".json"):
                            stamps.append((name, _stamp(child_info)))
                    finally:
                        os.close(child)
        except FileNotFoundError:
            if copies:
                raise CacheError("unregistered local replicas or leases require administrator repair")
            return None
        metadata = self._dataset(actor, dataset)
        if version is not None and version not in registered:
            if copies:
                raise CacheError("unregistered local replicas or leases require administrator repair")
            return None
        versions = sorted(copies | (set(registered) if version is None else {version}))
        return dict(registry=stamps, metadata=metadata, versions=versions)

    def _preserve_purged_owners_locked(self, dataset):
        """A purged version still needs dataset owners to release its name.

        It has no version registration, so the ordinary removal snapshot cannot
        see it. Check the fence directory under the same metadata lock as the
        final dataset.json move; source recovery uses that lock as well.
        """
        try:
            with _directory(self.root / '.retirements' / dataset) as fd:
                names = sorted(os.listdir(fd))
        except FileNotFoundError:
            return
        for name in names:
            if re.fullmatch(r'\.write-[a-f0-9]{32}', name):
                continue
            if not name.endswith('.json'):
                raise CacheError('corrupt version deletion fence directory')
            version = _identifier(name[:-5], HASH_RE)
            fence = self._retirement_fence(dataset, version)
            if fence is None:
                raise CacheBusy('version deletion fence changed during whole-dataset removal')
            if fence['state'] == 'PURGED':
                raise CacheError('仍有已清除副本的删除围栏，请先恢复源并释放名称，或显式重新登记；暂不能注销整个数据集')

    def _empty_unregister_snapshot(self, actor, dataset):
        """Prove a personal registration shell, never an absent data version.

        Caller holds the cache lock. Immutable stamps bind the admission to
        every final rename checkpoint. Default orphan tiers are retained, not
        deleted; any protection, unfinished upload or unknown metadata refuses.
        """
        self._actor(actor, admin=True)
        row = self._unregister_snapshot(actor, dataset, None)
        if row is None or row['versions'] or [name for name, _ in row['registry']] != ['dataset.json']:
            raise CacheError('empty personal registration proof requires no versions')
        owners = row['metadata']['owners']
        if len(owners) != 1:
            raise CacheError('empty personal registration requires one confirmed owner')
        owner = owners[0]
        prefix = 'u-'+hashlib.sha256(owner.encode()).hexdigest()[:16]+'-'
        if not dataset.startswith(prefix) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', dataset[len(prefix):]):
            raise CacheError('empty personal registration owner namespace differs')
        evidence = []

        def names(path):
            try:
                with _directory(path) as fd:
                    info = os.fstat(fd)
                    if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                        raise CacheError('unsafe empty-registration dependency directory')
                    result = sorted(os.listdir(fd))
                    if len(result) > 10000:
                        raise CacheError('empty-registration dependency proof exceeds its entry budget')
                    return result
            except FileNotFoundError:
                return []

        def read(path):
            with _directory(path.parent) as fd:
                child = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                try:
                    info = _regular(child)
                    if info.st_uid != os.geteuid() or info.st_mode & 0o077 or info.st_size > 65536:
                        raise CacheError('unsafe empty-registration dependency metadata')
                    with os.fdopen(child, 'rb', closefd=False) as stream:
                        raw = stream.read(65537)
                    value = json.loads(raw)
                    evidence.append([str(path.relative_to(self.root)), list(_stamp(info)), hashlib.sha256(raw).hexdigest()])
                    return value
                finally:
                    os.close(child)

        for area in ('ready', '.staging', '.leases', '.provenance', '.retirements', '.reopens'):
            if names(self.root / area / dataset):
                raise CacheError('empty registration still has payload or protected dependencies')
        # Reservation bodies have no owner/name. Only a bounded reverse proof
        # through service-private session identities may exclude another
        # dataset's reservation. Never refund or repair any upload here.
        reservations = names(self.root / '.upload-reservations')
        if reservations:
            wanted = set(reservations)
            uploads = self.root / '.uploads'
            parents = names(uploads)
            members, matched, scanned = {}, {}, 0
            before = len(evidence)
            for parent in parents:
                if parent == 'bindings':
                    continue
                _identifier(parent, HASH_RE)
                members[parent] = names(uploads / parent)
                for upload in members[parent]:
                    scanned += 1
                    if scanned > 10000:
                        raise CacheError('upload reservation proof exceeds its session budget')
                    if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', upload):
                        raise CacheError('unconfirmed upload reservation session identity')
                    try:
                        session = read(uploads / parent / upload / 'session.json')
                    except FileNotFoundError:
                        raise CacheError('unconfirmed upload reservation session is missing') from None
                    user = session.get('userId') if isinstance(session, dict) else None
                    if (not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', user)
                            or parent != hashlib.sha256(user.encode()).hexdigest()
                            or session.get('uploadId') != upload):
                        raise CacheError('unconfirmed upload reservation session ownership')
                    key = hashlib.sha256(json.dumps([user, upload], separators=(',', ':')).encode()).hexdigest()+'.json'
                    if key not in wanted:
                        del evidence[before:]
                        continue
                    # Same immutable identity and resource formula as upload
                    # load(), without its workspace/quota/effective side effects.
                    if (type(session.get('schema')) is not int or session['schema'] != 1
                            or not isinstance(session.get('name'), str)
                            or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', session['name'])
                            or session.get('state') not in {'RECEIVING_MANIFEST', 'SEALING', 'UPLOADING', 'PUBLISHING', 'READY', 'DISCARDING', 'DISCARDED', 'FAILED'}
                            or any(type(session.get(k)) is not int or session[k] < 0 for k in ('manifestBytes', 'totalBytes', 'entries', 'reserveBytes'))
                            or not 1 <= session['manifestBytes'] <= MAX_JSON_BYTES
                            or session['entries'] > MAX_ENTRIES or session['totalBytes'] > 2**63-1
                            or session['reserveBytes'] != session['totalBytes']+session['manifestBytes']*4+session['entries']*8192+65536
                            or not isinstance(session.get('manifestSha256'), str) or not HASH_RE.fullmatch(session['manifestSha256'])):
                        raise CacheError('unconfirmed upload reservation resource identity')
                    lane = session.get('archiveAdmission')
                    if lane is not None and (not isinstance(lane, dict)
                            or set(lane) != {'schema', 'transferId', 'targetMachine', 'authority', 'sourceMachine', 'reference'}
                            or type(lane.get('schema')) is not int or lane['schema'] != 1 or lane['transferId'] != upload
                            or any(not isinstance(lane.get(k), str) or not ID_RE.fullmatch(lane[k]) for k in ('targetMachine', 'authority', 'sourceMachine'))
                            or lane['sourceMachine'] == lane['targetMachine']
                            or not isinstance(lane['reference'], dict) or set(lane['reference']) != {'kind', 'dataset', 'version'}
                            or lane['reference']['kind'] != 'datasets'
                            or not isinstance(lane['reference']['dataset'], str) or not ID_RE.fullmatch(lane['reference']['dataset'])
                            or not isinstance(lane['reference']['version'], str) or not HASH_RE.fullmatch(lane['reference']['version'])):
                        raise CacheError('unconfirmed upload reservation archive identity')
                    target = 'u-'+hashlib.sha256(user.encode()).hexdigest()[:16]+'-'+session['name']
                    if session.get('dataset', target) != target or ('version' in session and
                            (not isinstance(session['version'], str) or not HASH_RE.fullmatch(session['version']))):
                        raise CacheError('unconfirmed upload reservation namespace')
                    if key in matched:
                        raise CacheError('duplicate upload reservation session identity')
                    value = read(self.root / '.upload-reservations' / key)
                    full = {'bytes': session['reserveBytes'], 'inodes': session['entries']+16}
                    sealed = {'bytes': session['reserveBytes']-session['totalBytes'], 'inodes': session['entries']+16}
                    footprint = session['totalBytes'] + 4096 * session['entries'] + 8192
                    variants = (full, sealed, {**full, 'budgetBytes': session['reserveBytes']},
                                {**sealed, 'budgetBytes': session['reserveBytes']},
                                {**sealed, 'budgetBytes': session['reserveBytes']-footprint})
                    if (not isinstance(value, dict) or set(value) not in ({'bytes', 'inodes'}, {'bytes', 'inodes', 'budgetBytes'})
                            or any(type(v) is not int or not 0 <= v <= 2**63-1 for v in value.values())
                            or value not in variants):
                        raise CacheError('unconfirmed upload reservation budget')
                    if target == dataset:
                        raise CacheError('upload reservation prevents empty registration removal')
                    matched[key] = target
                    del evidence[before:]  # Unrelated progress is not a static CAS dependency.
            if (set(matched) != set(reservations) or names(uploads) != parents
                    or any(names(uploads / parent) != items for parent, items in members.items())
                    or names(self.root / '.upload-reservations') != reservations):
                raise CacheError('unconfirmed upload reservations prevent empty registration removal')
        for name in names(self.root / '.tiers' / dataset):
            if not name.endswith('.json'):
                raise CacheError('empty registration has unknown tier metadata')
            _identifier(name[:-5], HASH_RE)
            value = read(self.root / '.tiers' / dataset / name)
            if (value != self._default_tier() or type(value.get('schema')) is not int
                    or type(value.get('lastUsedAt')) not in (int, float)):
                raise CacheError('empty registration has retained pins or recovery metadata')
        uploads = self.root / '.uploads'
        parent = uploads / hashlib.sha256(owner.encode()).hexdigest()
        sessions = {}
        for upload in names(parent):
            if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', upload):
                raise CacheError('empty registration has unknown upload identity')
            # Do not call effective()/retire_unregistered(): this proof is read
            # only and must not refund reservations or mutate session history.
            path = parent / upload / 'session.json'
            before = len(evidence)
            session = read(path)
            if (not isinstance(session, dict) or session.get('schema') != 1
                    or session.get('userId') != owner or session.get('uploadId') != upload
                    or not isinstance(session.get('name'), str)
                    or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', session['name'])):
                raise CacheError('empty registration upload ownership is unconfirmed')
            target = prefix + session['name']
            if session.get('dataset', target) != target:
                raise CacheError('empty registration upload namespace changed')
            sessions[upload] = (target, session)
            if target != dataset:
                del evidence[before:]
                continue
            if session.get('state') != 'DISCARDED':
                raise CacheError('unfinished upload prevents empty registration removal')
            reservation = hashlib.sha256(json.dumps([owner, upload], separators=(',', ':')).encode()).hexdigest()+'.json'
            if reservation in names(self.root / '.upload-reservations'):
                raise CacheError('upload reservation prevents empty registration removal')
            if 'version' in session:
                _identifier(session['version'], HASH_RE)
                binding = hashlib.sha256((dataset+'@'+session['version']).encode()).hexdigest()+'.json'
                if binding in names(uploads / 'bindings'):
                    raise CacheError('upload binding prevents empty registration removal')
        # Bindings can outlive a missing session or lose its version. Prove
        # same-owner bindings through the already verified session map rather
        # than assuming an absent session is unrelated to this registration.
        for name in names(uploads / 'bindings'):
            if not name.endswith('.json'):
                raise CacheError('empty registration has unknown upload binding metadata')
            _identifier(name[:-5], HASH_RE)
            before = len(evidence)
            binding = read(uploads / 'bindings' / name)
            if (not isinstance(binding, dict) or set(binding) != {'userId', 'uploadId'}
                    or not isinstance(binding['userId'], str)
                    or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', binding['userId'])
                    or not isinstance(binding['uploadId'], str)
                    or not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', binding['uploadId'])):
                raise CacheError('empty registration upload binding identity is unconfirmed')
            if binding['userId'] == owner:
                matched = sessions.get(binding['uploadId'])
                if matched is None:
                    raise CacheError('upload binding session or version is unconfirmed')
                target, session = matched
            else:
                foreign = uploads/hashlib.sha256(binding['userId'].encode()).hexdigest()/binding['uploadId']
                try: session = read(foreign/'session.json')
                except FileNotFoundError:
                    raise CacheError('upload binding session or version is unconfirmed') from None
                if (not isinstance(session, dict) or session.get('schema') != 1
                        or session.get('userId') != binding['userId'] or session.get('uploadId') != binding['uploadId']
                        or not isinstance(session.get('name'), str)
                        or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}', session['name'])):
                    raise CacheError('upload binding session ownership is unconfirmed')
                target = 'u-'+hashlib.sha256(binding['userId'].encode()).hexdigest()[:16]+'-'+session['name']
                if session.get('dataset', target) != target:
                    raise CacheError('upload binding namespace is unconfirmed')
            if not isinstance(session.get('version'), str):
                raise CacheError('upload binding session or version is unconfirmed')
            _identifier(session['version'], HASH_RE)
            if name != hashlib.sha256((target+'@'+session['version']).encode()).hexdigest()+'.json':
                raise CacheError('upload binding namespace is unconfirmed')
            if target == dataset:
                raise CacheError('upload binding prevents empty registration removal')
            del evidence[before:]  # Only confirmed unrelated binding identities remain.
        return dict(registry=[[name, list(stamp)] for name, stamp in row['registry']],
                    owners=owners, dependencies=evidence)

    @staticmethod
    def _unregister_move_record(source, destination):
        """Atomic no-replace move for one registration file, never source data."""
        with _directory(source.parent) as source_fd, _directory(destination.parent) as destination_fd:
            child = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=source_fd)
            try:
                _regular(child)
                if os.fstat(source_fd).st_dev != os.fstat(destination_fd).st_dev:
                    raise CacheError("registration recovery must remain on the same filesystem")
                libc = ctypes.CDLL(None, use_errno=True)
                if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
                    fn, flags = libc.renameat2, 1
                elif sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
                    fn, flags = libc.renameatx_np, 4
                else:
                    raise CacheError("atomic no-replace rename unavailable on this platform")
                fn.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
                fn.restype = ctypes.c_int
                if fn(source_fd, os.fsencode(source.name), destination_fd, os.fsencode(destination.name), flags):
                    code = ctypes.get_errno()
                    raise OSError(code, os.strerror(code))
                os.fsync(destination_fd)
                os.fsync(source_fd)
            finally:
                os.close(child)

    def _unregister_transaction(self, dataset, version, snapshot):
        """Reuse interrupted cleanup, but never overwrite an archived registration."""
        parent = self.root / ".trash"
        with _directory(parent) as fd:
            names = sorted(os.listdir(fd))
        transaction, receipt = None, None
        for name in names:
            if not re.fullmatch(r"unregister-[a-f0-9]{32}", name):
                continue
            candidate = parent / name
            _mkdir(candidate)  # Also checks ownership, mode and symlinks.
            try:
                previous = _read_json(candidate / "REMOVAL.json")
            except FileNotFoundError:
                continue  # Crash before recording intent; never adopt unknown data.
            if (not isinstance(previous, dict) or previous.get("schema") != SCHEMA
                    or type(previous.get("unregistered")) is not bool):
                raise CacheError("corrupt dataset removal journal")
            if previous.get("dataset") != dataset or previous.get("version") != version or previous["unregistered"]:
                continue
            archived = candidate / "registration"
            try:
                with _directory(archived) as fd:
                    # A crash after the final rename already committed removal,
                    # even if updating REMOVAL.json did not complete.
                    committed = version is None or version + ".json" in os.listdir(fd)
            except FileNotFoundError:
                committed = False
            if not committed:
                transaction, receipt = candidate, previous
                break
        if transaction is None:
            transaction = parent / ("unregister-" + uuid.uuid4().hex)
            _mkdir(transaction)
            receipt = dict(schema=SCHEMA, dataset=dataset, version=version,
                           versions=[], createdAt=time.time(), unregistered=False)
        previous_versions = receipt.get("versions")
        if not isinstance(previous_versions, list):
            raise CacheError("corrupt dataset removal journal")
        receipt["versions"] = sorted(set(_identifier(v, HASH_RE) for v in previous_versions) | set(snapshot["versions"]))
        receipt["owners"] = snapshot["metadata"]["owners"]
        _write_json(transaction / "REMOVAL.json", receipt)
        _mkdir(transaction / "replicas")
        for name in ("ready", "staging"):
            _mkdir(transaction / "replicas" / name)
        if version is not None:
            _mkdir(transaction / "registration")
            _write_json(transaction / "registration" / "dataset.json", snapshot["metadata"])
        return transaction, receipt

    def _unregister_cleanup(self, transaction):
        """Remove only already-quarantined replicas; keep recovery metadata."""
        if not shutil.rmtree.avoids_symlink_attacks:
            raise CacheError("descriptor-safe recursive cleanup unavailable on this platform")

        def writable_directories(fd):
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                raise CacheError("unsafe quarantined dataset directory")
            for name in os.listdir(fd):
                child_info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(child_info.st_mode):
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                    try:
                        writable_directories(child)
                    finally:
                        os.close(child)
                elif not stat.S_ISREG(child_info.st_mode) or child_info.st_nlink != 1:
                    raise CacheError("quarantined files must be regular files with a single link")
            # Unlink needs a writable parent, not writable files. This private
            # tree is already fenced off and locked; syncing/chmodding every
            # soon-to-be-deleted file adds no recovery guarantee. A crash can
            # safely repeat this directory-only preparation on the next retry.
            os.fchmod(fd, stat.S_IMODE(info.st_mode) | stat.S_IWUSR)

        for name in ("ready", "staging"):
            parent = transaction / "replicas" / name
            with _directory(parent) as fd:
                versions = sorted(os.listdir(fd))
            for version in versions:
                _identifier(version, HASH_RE)
                trash = parent / version
                with _directory(trash) as fd:
                    writable_directories(fd)
                shutil.rmtree(trash)
                with _directory(parent) as fd:
                    os.fsync(fd)

    def unregister(self, actor, dataset, version=None, *, _guard=None, _expected_registration=None, _expected_owners=None, _portal_proved_versions=None, _expected_empty_registration=None):
        """Source-proven personal or administrator registration removal.

        Internal transfers and leases share these locks. As with evict/publish,
        administrators MUST stop/join any external trusted rsync writer first.
        Cleanup failures leave registration in place; retries resume the private
        cleanup journal. Original configured source directories are never touched.
        """
        self._actor(actor, admin=version is None)
        if _portal_proved_versions is not None:
            self._actor(actor,admin=True)
            if (not isinstance(_portal_proved_versions,list)
                    or len(_portal_proved_versions)>10000 or any(not isinstance(v,str) or not HASH_RE.fullmatch(v) for v in _portal_proved_versions)
                    or len(set(_portal_proved_versions))!=len(_portal_proved_versions)):
                raise CacheError('invalid exact Portal-proved complete-copy versions')
        empty_proof = _portal_proved_versions == []
        if empty_proof and (version is not None or not isinstance(_expected_empty_registration, dict)):
            raise CacheError('empty Portal proof requires a fixed whole personal registration snapshot')
        if _expected_empty_registration is not None and not empty_proof:
            raise CacheError('empty registration snapshot cannot authorize version removal')
        self._paths(dataset, version)
        if _expected_registration is not None and (version is None or not isinstance(_expected_registration, list)
                or len(_expected_registration) != 5 or any(type(item) is not int or item < 0 for item in _expected_registration)):
            raise CacheError("invalid private unregister registration identity")
        if _expected_owners is not None and (_expected_registration is None or not isinstance(_expected_owners,list)
                or not _expected_owners or any(not isinstance(item,str) or not USER_RE.fullmatch(item) for item in _expected_owners)):
            raise CacheError("invalid private unregister ownership identity")
        with self._locked():
            if _guard is not None:
                _guard()
            if version is None:
                self._preserve_purged_owners_locked(dataset)
            initial = self._unregister_snapshot(actor, dataset, version)
            if _expected_registration is not None and (initial is None or
                    dict(initial['registry']).get(version + '.json') != tuple(_expected_registration)):
                raise CacheBusy("dataset registration differs from the original retirement identity")
            if _expected_owners is not None and initial['metadata']['owners'] != _expected_owners:
                raise CacheBusy("dataset ownership differs from the original retirement identity")
            if initial is not None:
                self._delete_actor_locked(actor, dataset, version)
            if empty_proof and self._empty_unregister_snapshot(actor, dataset) != _expected_empty_registration:
                raise CacheBusy('empty registration changed since admission')
        if initial is None:
            return dict(dataset=dataset, version=version, versions=[], unregistered=False,
                        registrationRetained=False, recoveryId=None)
        if _portal_proved_versions is not None and not set(initial['versions'])<=set(_portal_proved_versions):
            raise CacheError('Portal proof does not cover every current version; no removal permitted')

        def recheck():
            if _guard is not None:
                _guard()
            if version is None:
                self._preserve_purged_owners_locked(dataset)
            if empty_proof and self._empty_unregister_snapshot(actor, dataset) != _expected_empty_registration:
                raise CacheBusy('empty registration changed during removal')
            current = self._unregister_snapshot(actor, dataset, version)
            if current is not None:
                self._delete_actor_locked(actor, dataset, version)
            if (current is None or current["registry"] != initial["registry"]
                    or set(current["versions"]) - set(initial["versions"])):
                raise CacheBusy("dataset registration changed during removal; retry after checking the catalog")
            for item in initial["versions"]:
                if self._leases(dataset, item):
                    raise CacheError("active leases prevent unregister; leases never expire automatically")
                if self._tier(dataset, item)["pins"]:
                    raise CacheError("persistent pins prevent unregister")

        with contextlib.ExitStack() as locks:
            with self._locked():
                recheck()  # Reject active uses before contacting any original.
            # Source guards first, matching tier GC's lock order. A sourceId or
            # cached receipt must never make the last complete copy disposable.
            protected = {}
            for item in initial["versions"]:
                protected[item] = locks.enter_context(self._retention_guard(actor, dataset, item,_portal_proved=_portal_proved_versions is not None))
            # Never wait on a version lock while holding the global lock: active
            # materialize/publish need global metadata access before releasing it.
            for item in initial["versions"]:
                locks.enter_context(self._lock_file(".locks/" + dataset + "." + item + ".lock"))
            for item in initial["versions"]:
                if not protected[item]:
                    with self._retention_guard(actor, dataset, item, _confirm_only=True):
                        pass
            with self._locked():
                recheck()  # All leases checked before the first filesystem move.
                transaction, receipt = self._unregister_transaction(dataset, version, initial)
                if empty_proof:
                    receipt['emptyRegistrationProof'] = _expected_empty_registration
                    _write_json(transaction / 'REMOVAL.json', receipt)
            self._unregister_cleanup(transaction)
            with self._locked():
                recheck()  # A lease may have arrived while cleaning an old journal.
                for item in initial["versions"]:
                    for name, bucket in (("ready", "ready"), (".staging", "staging")):
                        path = self._paths(dataset, item)[name]
                        try:
                            with _directory(path):
                                pass
                        except FileNotFoundError:
                            continue
                        _rename_new(path, transaction / "replicas" / bucket / item)
            # Recursive deletion never blocks unrelated dataset metadata calls.
            # Version locks keep these paths absent until the final registry move.
            self._unregister_cleanup(transaction)
            with self._locked():
                recheck()
                registry = self._paths(dataset)[".registry"]
                if version is None:
                    _rename_new(registry, transaction / "registration")
                else:
                    self._unregister_move_record(registry / (version + ".json"),
                                                 transaction / "registration" / (version + ".json"))
                receipt["unregistered"] = True
                _write_json(transaction / "REMOVAL.json", receipt)
            return dict(dataset=dataset, version=version, versions=receipt["versions"], unregistered=True,
                        registrationRetained=False, recoveryId=transaction.name)

    def dispatch(self, actor, request):
        """Strict JSON adapter; caller supplies the trusted Principal separately."""
        if not isinstance(request, dict) or not isinstance(request.get("op"), str):
            raise CacheError("invalid dataset request")
        definitions = {
            "list": (self.list_datasets, set()),
            "capacity": (self.capacity, set()),
            "register_source": (self.register_source, {"dataset", "sourceId", "owners"}),
            "register_manifest": (self.register_manifest, {"dataset", "manifest", "owners"}),
            "attach_source": (self.attach_source, {"dataset", "version", "sourceId"}),
            "set_owners": (self.set_owners, {"dataset", "owners"}),
            "export_manifest": (self.export_manifest, {"dataset", "version"}),
            "plan": (self.plan, {"dataset", "version"}),
            "status": (self.status, {"dataset", "version"}),
            "prepare": (self.prepare, {"dataset", "version"}),
            "prepare_transfer": (self.prepare_transfer, {"dataset", "version"}),
            "put_chunk": (self.put_chunk, {"dataset", "version", "path", "offset", "data", "token"}),
            "read_chunk": (self.read_chunk, {"dataset", "version", "path", "offset", "length"}),
            "publish": (self.publish, {"dataset", "version", "token"}),
            "materialize": (self.materialize, {"dataset", "version"}),
            "verify": (self.verify, {"dataset", "version"}),
            "acquire_lease": (self.acquire_lease, {"dataset", "version", "jobId"}),
            "release_lease": (self.release_lease, {"dataset", "version", "leaseId"}),
            "evict": (self.evict, {"dataset", "version"}),
            "unregister": (self.unregister, {"dataset", "version"} if "version" in request else {"dataset"}),
        }
        if request["op"] not in definitions:
            raise CacheError("unsupported dataset operation")
        function, fields = definitions[request["op"]]
        if set(request) != fields | {"op"}:
            raise CacheError("missing or unrecognized dataset request fields")
        args = {key: request[key] for key in fields}
        if request['op']=='register_manifest':args['_explicit']=True  # privileged local CLI, never a peer import
        for key, replacement in (("sourceId", "source_id"), ("jobId", "job_id"), ("leaseId", "lease_id")):
            if key in args:
                args[replacement] = args.pop(key)
        if request["op"] == "put_chunk":
            if not isinstance(args["data"], str) or len(args["data"]) > ((CHUNK_BYTES + 2) // 3) * 4:
                raise CacheError("invalid encoded chunk size")
            try:
                args["data"] = base64.b64decode(args["data"], validate=True)
            except (ValueError, UnicodeError) as exc:
                raise CacheError("invalid base64 chunk") from exc
        return function(actor, **args)


def _operator_config(filename):
    if os.geteuid() != 0:
        raise PermissionError("dataset-cache CLI is root-only; use authenticated executor APIs for member operations")
    path = _absolute(filename)
    with _directory(path.parent) as parent:
        fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = _regular(fd)
            if info.st_uid != 0 or info.st_mode & 0o077:
                raise PermissionError("dataset config must be root-owned mode 0600")
            if info.st_size > MAX_JSON_BYTES:
                raise CacheError("administrator dataset config too large")
            with os.fdopen(fd, "rb", closefd=False) as stream:
                config = json.loads(stream.read(MAX_JSON_BYTES + 1))
        finally:
            os.close(fd)
    if not isinstance(config, dict) or set(config) - {"root", "mountPoint", "sources", "reserveBytes", "serviceUid", "serviceGid"}:
        raise CacheError("invalid administrator dataset config")
    if ("serviceUid" in config) != ("serviceGid" in config):
        raise CacheError("serviceUid and serviceGid must be supplied together")
    for key in ("serviceUid", "serviceGid"):
        if key in config and (type(config[key]) is not int or not 0 <= config[key] < 2**31):
            raise CacheError("invalid cache service identity")
    return config


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--config", required=True, help="root-owned mode-0600 administrator config")
    args = parser.parse_args(argv)
    try:
        config = _operator_config(args.config)
        raw = sys.stdin.buffer.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise CacheError("request too large")
        request = json.loads(raw)
        if "serviceUid" in config:
            os.setgroups([])
            os.setgid(config["serviceGid"])
            os.setuid(config["serviceUid"])
        cache = DatasetCache(config.get("root", "/data2/datasets"), sources=config.get("sources", {}),
                             reserve_bytes=config.get("reserveBytes", DEFAULT_RESERVE),
                             mount_point=config.get("mountPoint", "/data2"))
        result = cache.dispatch(Principal("local-admin", True), request)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except (OSError, ValueError, TypeError, KeyError) as exc:
        # OSError filenames may contain private source paths; keep them out of output.
        message = os.strerror(exc.errno) if isinstance(exc, OSError) and exc.errno else str(exc)
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

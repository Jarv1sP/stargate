#!/usr/bin/env python3
"""Service-private, local project worktrees and immutable starting snapshots.

This module never executes uploaded code, creates a host environment, mounts a
filesystem, migrates legacy users/, or accepts client-supplied host paths.
Callers must authenticate user IDs, stop project development terminals before
publish, and hold locked() across upload commits / terminal-start decisions.
Snapshot consistency is checked, not magically guaranteed against host root.
The base fingerprint covers interpreter + package metadata, NOT all base bits;
this is a same-machine venv release, not a portable/hermetic OCI image.
"""
import contextlib
import functools
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
import stat
import time
import threading
import uuid


SLUG = re.compile(r'^[a-z][a-z0-9_-]{0,47}$')
VERSION = re.compile(r'^[a-f0-9]{64}$')
JOB_ID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
_ROOT_GUARD = None
DEFAULT_WORKSPACE_RESERVE = 10 * 1024**3
PROJECT_LOCK_WAIT_SECONDS = 2.0


def project_lifetime(function):
    """Drain readers/writers before a project directory can be retired."""
    @functools.wraps(function)
    def wrapped(self, user, slug, *args, **kwargs):
        with self.lifetime(user, slug):
            return function(self, user, slug, *args, **kwargs)
    return wrapped


def check_platform_root(root):
    global _ROOT_GUARD
    if _ROOT_GUARD is None:
        spec = importlib.util.spec_from_file_location('gpuq_project_root_guard', Path(__file__).resolve().parent/'platform-root-guard.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        _ROOT_GUARD = module
    return _ROOT_GUARD.check(root)


class ProjectError(ValueError):
    def __init__(self, code, message, details=None):
        self.code = code
        self.details = details or {}
        super().__init__(message)


def fail(code, message):
    raise ProjectError(code, message)


def wait_project_lock(fd, mode, message):
    """Wait only to acquire the same checked descriptor, never replay a body."""
    deadline = time.monotonic() + PROJECT_LOCK_WAIT_SECONDS
    while True:
        try:
            fcntl.flock(fd, mode | fcntl.LOCK_NB)
            return
        except BlockingIOError:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                fail('project_busy', message)
            time.sleep(min(0.05, remaining))


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def absolute(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts or path == Path('/'):
        fail('unsafe_path', 'An absolute, non-root storage path is required')
    return path


@contextlib.contextmanager
def directory(path):
    """Open every ancestor without following links, including the final one."""
    path = absolute(path)
    fd = os.open('/', DIR_FLAGS)
    try:
        for name in path.parts[1:]:
            child = os.open(name, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def workspace_reserve_bytes(config):
    """Optional node policy; absent keeps the historical 10 GiB write reserve."""
    value = config.get('workspaceReserveBytes', DEFAULT_WORKSPACE_RESERVE)
    if type(value) is not int or not 0 <= value <= 2**63 - 1:
        fail('invalid_input', 'workspaceReserveBytes must be a nonnegative integer byte count')
    return value


def workspace_start_reserve(config):
    """Opening existing files is not a bulk upload or image-copy admission."""
    return min(workspace_reserve_bytes(config), 16*1024**2)


def require_workspace_space(root, reserve_bytes, needed=0, *, target_fd=None):
    """Admission, not a quota. Pin the guarded root and use ordinary-user space.

    No directories are created. A supplied descriptor must be on the same
    filesystem; it is a trusted local caller argument, never an RPC field.
    Concurrent writers can consume space after this check; running work is
    never killed by this policy.
    """
    if any(type(v) is not int or not 0 <= v <= 2**63 - 1 for v in (reserve_bytes, needed)):
        fail('invalid_input', 'Workspace space requirements must be nonnegative integer byte counts')
    with directory(root) as fd:
        identity = os.fstat(fd)
        check_platform_root(root)
        with directory(root) as current:
            now = os.fstat(current)
            if (identity.st_dev, identity.st_ino) != (now.st_dev, now.st_ino):
                fail('unsafe_path', 'Console storage root changed during space admission')
        if target_fd is not None and os.fstat(target_fd).st_dev != identity.st_dev:
            fail('unsafe_path', 'Workspace write target is on another filesystem')
        space = os.fstatvfs(fd if target_fd is None else target_fd)
        available = space.f_bavail * space.f_frsize
        if available < reserve_bytes + needed:
            fail('insufficient_space',
                 f'Personal workspace free-space reserve reached: availableBytes={available}, '
                 f'reserveBytes={reserve_bytes}, requestedBytes={needed}.')


def stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def private_dir(path, create=False):
    if create:
        try:
            path.mkdir(mode=0o700)
        except FileExistsError:
            pass
    with directory(path) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            fail('unsafe_path', 'Project control directories must be service-owned mode 0700')
    return path


def read_json(path, limit=4 * 1024 * 1024):
    fd = os.open(path, FILE_FLAGS)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size > limit:
            fail('unsafe_path', 'Unsafe or oversized project metadata')
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(fd, min(remaining, 1024 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        if not remaining or stamp(info) != stamp(os.fstat(fd)):
            fail('changed', 'Project metadata changed while reading')
        return json.loads(b''.join(chunks))
    finally:
        os.close(fd)


def atomic_json(path, value):
    """Control metadata only; the parent is service-private and already checked."""
    tmp = path.parent / ('.write-' + uuid.uuid4().hex)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(canonical(value))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        with directory(path.parent) as parent:
            os.fsync(parent)
    finally:
        tmp.unlink(missing_ok=True)


class ProjectStore:
    # JSON clients must represent byte counts exactly. This is a numeric
    # protocol bound, not a project/container storage quota.
    MAX_BYTES = 2**53 - 1
    FILE_WARNING_BYTES = 4 * 1024**3

    def __init__(self, root, base_path, reserve_bytes=10 * 1024**3, *,
                 max_entries=200000, warning_bytes=50 * 1024**3,
                 max_projects=64, max_releases=64, config=None):
        self.root = absolute(root)
        self.config = config or {'root': str(self.root)}
        check_platform_root(self.root)
        self.base = absolute(base_path)
        self.path = self.root / 'projects-v2'
        self.reserve_bytes = reserve_bytes
        self.max_entries, self.warning_bytes = max_entries, warning_bytes
        self.max_projects, self.max_releases = max_projects, max_releases
        self._lifetime_state = threading.local()
        if any(type(number) is not int or number < 0 for number in (reserve_bytes, max_entries, warning_bytes, max_projects, max_releases)):
            fail('invalid_input', 'Project limits must be nonnegative integers')
        with directory(self.root) as fd:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                fail('unsafe_path', 'Console root must be service-owned and not group/world writable')
            self.root_identity = (info.st_dev, info.st_ino)
        # The configured base is an operator-approved installation. Read only.
        with directory(self.base):
            pass
        private_dir(self.path, create=True)
        private_dir(self.path / '.run-claims', create=True)

    def _check_root(self):
        check_platform_root(self.root)
        with directory(self.root) as fd:
            info = os.fstat(fd)
            if ((info.st_dev, info.st_ino) != self.root_identity or
                    info.st_uid != os.geteuid() or info.st_mode & 0o022):
                fail('unsafe_path', 'Console storage root was replaced')
        private_dir(self.path)

    def _identity(self, user, slug=None):
        if not isinstance(user, str) or not user or len(user) > 128 or any(ord(char) < 32 for char in user):
            fail('invalid_input', 'Invalid authenticated user ID')
        if slug is not None and (not isinstance(slug, str) or not SLUG.fullmatch(slug)):
            fail('invalid_input', 'Project must start with a lowercase letter and use at most 48 lowercase letters, digits, hyphens or underscores')
        return hashlib.sha256(user.encode()).hexdigest()

    def _quota(self, user, path):
        if 'storageQuota' not in self.config:
            return
        spec = importlib.util.spec_from_file_location('gpuq_project_quota', Path(__file__).with_name('storage-quota.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        module.ensure(self.config, user, path)

    def _oci(self, user):
        spec = importlib.util.spec_from_file_location('gpuq_project_oci', Path(__file__).with_name('personal-oci.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.PersonalOCI(self.config, user)

    def _project(self, user, slug):
        self._check_root()
        owner = self._identity(user, slug)
        lifecycle = self.lifecycle(user, slug)
        if lifecycle['state'] in ('RETIRING', 'RETIRED'):
            fail('project_retired', 'Project retirement is fenced; inspect the original operation, never reuse this project ID')
        path = self.path / owner / slug
        try:
            private_dir(self.path / owner)
            private_dir(path)
            meta = read_json(path / 'project.json')
        except FileNotFoundError:
            fail('not_found', 'Project not found for this user')
        if meta.get('schema') != 2 or meta.get('owner') != owner or meta.get('project') != slug:
            fail('unsafe_path', 'Project ownership metadata does not match')
        if meta.get('environmentMode', 'shared') not in ('shared', 'isolated', 'oci'):
            fail('unsafe_path', 'Invalid project environment mode')
        if 'projectUUID' in meta and (not isinstance(meta['projectUUID'], str) or not JOB_ID.fullmatch(meta['projectUUID'])):
            fail('unsafe_path', 'Invalid persistent project UUID')
        return path, meta

    def lifecycle_folder(self, user, slug):
        self._check_root()
        owner = self._identity(user, slug)
        parent = private_dir(self.path / owner, create=True)
        return private_dir(parent / '.lifecycle', create=True)

    def lifecycle(self, user, slug):
        owner = self._identity(user, slug)
        try:
            value = read_json(self.lifecycle_folder(user, slug) / (slug + '.json'))
        except FileNotFoundError:
            return {'schema': 1, 'owner': owner, 'project': slug, 'state': 'ACTIVE', 'revision': 0}
        if (value.get('schema') != 1 or value.get('owner') != owner or value.get('project') != slug
                or value.get('state') not in ('ACTIVE', 'ARCHIVED', 'RETIRING', 'RETIRED')
                or type(value.get('revision')) is not int or value['revision'] < 1):
            fail('unsafe_path', 'Invalid project lifecycle receipt; access remains fenced')
        return value

    def admit(self, user, slug):
        if self.lifecycle(user, slug)['state'] != 'ACTIVE':
            fail('project_archived', 'Project is archived or retired; unarchive it before new work')

    @contextlib.contextmanager
    def lifetime(self, user, slug, *, exclusive=False):
        folder = self.lifecycle_folder(user, slug)
        key = str(folder / (slug + '.lock'))
        held = getattr(self._lifetime_state, 'held', {})
        if key in held:
            if exclusive and not held[key]:
                fail('project_busy', 'Cannot upgrade an active project reader to retirement')
            yield
            return
        fd = os.open(key, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                fail('unsafe_path', 'Unsafe project lifecycle lock')
            wait_project_lock(fd, fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH,
                              'Project has an active reader or lifecycle operation; retry after it finishes')
            self._lifetime_state.held = {**held, key: exclusive}
            yield
        finally:
            self._lifetime_state.held = held
            os.close(fd)

    def environment_mode(self, user, slug):
        return self._project(user, slug)[1].get('environmentMode', 'shared')

    @project_lifetime
    def project_uuid(self, user, slug, *, create=False):
        """Read identity without mutation; migrate only at explicit publication."""
        path, meta = self._project(user, slug)
        if meta.get('projectUUID') is not None or not create:
            return meta.get('projectUUID')
        with self._file_lock(path / '.identity.lock'):
            path, meta = self._project(user, slug)
            if meta.get('projectUUID') is None:
                meta = {**meta, 'projectUUID': str(uuid.uuid4())}
                atomic_json(path / 'project.json', meta)
            return meta['projectUUID']

    @project_lifetime
    def generation(self, user, slug):
        """Local incarnation identity; a same-name replacement is not this project."""
        path, meta = self._project(user, slug)
        with directory(path) as fd:
            info = os.fstat(fd)
            current = read_json(path / 'project.json')
            if current != meta:
                fail('changed', 'Project metadata changed while identifying its generation')
            with directory(path) as current_fd:
                now = os.fstat(current_fd)
                if (info.st_dev, info.st_ino) != (now.st_dev, now.st_ino):
                    fail('changed', 'Project directory changed while identifying its generation')
            return digest({'device': info.st_dev, 'inode': info.st_ino,
                           'createdAt': meta['createdAt']})

    @contextlib.contextmanager
    def _file_lock(self, path, blocking=False):
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                fail('unsafe_path', 'Unsafe project lock')
            if blocking:
                fcntl.flock(fd, fcntl.LOCK_EX)
            else:
                wait_project_lock(fd, fcntl.LOCK_EX,
                                  'Project is being published or changed; retry after it finishes')
            yield
        finally:
            os.close(fd)

    @contextlib.contextmanager
    def locked(self, user, slug, blocking=False):
        with self.lifetime(user, slug):
            path, _ = self._project(user, slug)
            with self._file_lock(path / '.lock', blocking=blocking):
                yield

    def fail_if_publishing(self, user, slug):
        with self.locked(user, slug):
            pass

    @project_lifetime
    def create(self, user, slug, environment_mode=None):
        self.admit(user, slug)
        if environment_mode is not None and environment_mode not in ('shared', 'isolated', 'oci'):
            fail('invalid_input', 'Environment mode must be shared, isolated or oci')
        self._check_root()
        if environment_mode == 'oci':
            self._oci(user).verify_host()
        owner = self._identity(user, slug)
        parent = private_dir(self.path / owner, create=True)
        self._quota(user, parent)
        with self._file_lock(parent / '.create.lock'):
            project = parent / slug
            if project.exists() or project.is_symlink():
                _, existing = self._project(user, slug)
                if environment_mode is not None and existing.get('environmentMode', 'shared') != environment_mode:
                    fail('environment_conflict', 'Existing project environment mode cannot be changed; create a new project')
                return self.status(user, slug)
            count = sum(1 for name in os.listdir(parent) if SLUG.fullmatch(name))
            if count >= self.max_projects:
                fail('limit_exceeded', 'Maximum projects per user reached')
            stage = private_dir(parent / ('.creating-' + uuid.uuid4().hex), create=True)
            try:
                for name in ('dev', 'releases', '.staging', 'runs'):
                    private_dir(stage / name, create=True)
                for name in ('code', 'env', 'home', 'scratch'):
                    private_dir(stage / 'dev' / name, create=True)
                atomic_json(stage / 'project.json', {'schema': 2, 'owner': owner,
                            'project': slug, 'environmentMode': environment_mode or 'shared',
                            'createdAt': int(time.time()), 'projectUUID': str(uuid.uuid4())})
                os.rename(stage, project)
                with directory(parent) as fd:
                    os.fsync(fd)
            finally:
                if stage.exists():
                    self._remove_stage(stage)
        return self.status(user, slug)

    def list(self, user):
        self._check_root()
        owner = self._identity(user)
        path = self.path / owner
        if not path.exists() and not path.is_symlink():
            return []
        private_dir(path)
        return [self.status(user, name) for name in sorted(os.listdir(path)) if SLUG.fullmatch(name)]

    @project_lifetime
    def status(self, user, slug):
        path, project = self._project(user, slug)
        if project.get('runtime') == 'workspace':
            return {'project': slug, 'state': 'AVAILABLE', 'createdAt': project['createdAt'],
                    'environmentMode': project.get('environmentMode', 'shared'),
                    'workspace': {'protocol': 1, 'persistent': True, 'codeWritable': True,
                                  'homeShared': True, 'outputsShared': True},
                    'offlineAssetsPath': '/workspace/offline'}
        releases = []
        private_dir(path / 'releases')
        for name in os.listdir(path / 'releases'):
            if VERSION.fullmatch(name):
                summary = self._release_summary(path / 'releases' / name, name)
                if summary['owner'] != project['owner'] or summary['project'] != slug:
                    fail('unsafe_path', 'Release summary belongs to another project')
                releases.append({'release': name, 'state': 'READY', 'createdAt': summary['createdAt'],
                                 'bytes': summary['bytes'], 'entries': summary['entries'],
                                 'warnings': self.size_warnings(summary['bytes'])})
        releases.sort(key=lambda item: (item['createdAt'], item['release']))
        state = 'READY' if releases else 'DRAFT'
        try:
            with self._file_lock(path / '.lock'):
                pass
        except ProjectError as error:
            if error.code != 'project_busy':
                raise
            if (path / '.publishing.json').exists():
                state = 'PUBLISHING'
        latest = read_json(path / 'latest.json').get('release') if (path / 'latest.json').exists() else None
        if latest is not None and latest not in {item['release'] for item in releases}:
            fail('unsafe_path', 'Latest release does not refer to a READY snapshot')
        return {'project': slug, 'state': state, 'createdAt': project['createdAt'],
                'releases': releases, 'latestReadyRelease': latest,
                'warnings': next((item['warnings'] for item in releases if item['release']==latest), []),
                'environmentMode': project.get('environmentMode', 'shared'),
                'offlineAssetsPath': '/workspace/offline'}

    @project_lifetime
    def dev_paths(self, user, slug):
        path, _ = self._project(user, slug)
        self._quota(user, path.parent)
        private_dir(path / 'dev')
        return {name: private_dir(path / 'dev' / name) for name in ('code', 'env', 'home', 'scratch')}

    @project_lifetime
    def activate_workspace(self, user, slug):
        """Adopt existing mutable files in place; never migrate user data."""
        self.admit(user, slug)
        with self.locked(user, slug):
            path, project = self._project(user, slug)
            if project.get('runtime') != 'workspace':
                project['runtime'] = 'workspace'
                atomic_json(path/'project.json', project)
        return self.workspace_paths(user, slug)

    def _safe_base_target(self, value):
        """Resolve only within the approved base, including its internal links."""
        path = PurePosixPath(value)
        aliases = [PurePosixPath('/opt/conda'), PurePosixPath(str(self.base))]
        relative = None
        for alias in aliases:
            try:
                relative = path.relative_to(alias)
                break
            except ValueError:
                pass
        if relative is None or '..' in relative.parts:
            fail('unsafe_path', 'Environment link escapes its approved base')
        parts = list(relative.parts)
        for _ in range(40):
            with directory(self.base) as base_fd:
                fd = os.dup(base_fd)
                restart = False
                try:
                    for index, part in enumerate(parts):
                        info = os.stat(part, dir_fd=fd, follow_symlinks=False)
                        if stat.S_ISLNK(info.st_mode):
                            target = os.readlink(part, dir_fd=fd)
                            if target.startswith('/'):
                                for alias in aliases:
                                    try:
                                        new = str(PurePosixPath(target).relative_to(alias))
                                        break
                                    except ValueError:
                                        new = None
                                if new is None:
                                    fail('unsafe_path', 'Base link escapes the approved installation')
                            else:
                                new = posixpath.normpath('/'.join(parts[:index] + [target]))
                            new = posixpath.normpath(new)
                            if new == '..' or new.startswith('../'):
                                fail('unsafe_path', 'Base link escapes the approved installation')
                            parts = list(PurePosixPath(new).parts) + parts[index + 1:]
                            restart = True
                            break
                        if index != len(parts) - 1:
                            child = os.open(part, DIR_FLAGS, dir_fd=fd)
                            os.close(fd)
                            fd = child
                        elif not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                            fail('unsafe_path', 'Base target is not a file or directory')
                    if not restart:
                        return self.base.joinpath(*parts)
                finally:
                    os.close(fd)
        fail('unsafe_path', 'Too many environment/base symbolic links')

    def _hash_base_file(self, path, maximum=64 * 1024 * 1024):
        fd = os.open(path, FILE_FLAGS)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > maximum:
                fail('unsafe_path', 'Invalid base fingerprint metadata')
            value = hashlib.sha256()
            while True:
                chunk = os.read(fd, 1024 * 1024)
                if not chunk:
                    break
                value.update(chunk)
            if stamp(before) != stamp(os.fstat(fd)):
                fail('base_changed', 'Base environment changed while fingerprinting')
            return value.hexdigest()
        finally:
            os.close(fd)

    def base_fingerprint(self):
        python = self._safe_base_target(str(self.base / 'bin/python'))
        records = {'bin/python': self._hash_base_file(python)}
        version = None
        metadata = self._safe_base_target(str(self.base / 'conda-meta'))
        with directory(metadata):
            for name in sorted(os.listdir(metadata)):
                if not name.endswith('.json'):
                    continue
                if len(records) > 20000:
                    fail('limit_exceeded', 'Too many base package metadata records')
                path = self._safe_base_target(str(metadata / name))
                records['conda-meta/' + name] = self._hash_base_file(path, 4 * 1024 * 1024)
                if name.startswith('python-'):
                    data = json.loads(path.read_text())
                    if data.get('name') == 'python':
                        version = data.get('version')
        # pip-installed distributions are not necessarily in conda-meta.
        # Conda installations may contain e.g. lib/python3.1 -> python3.10,
        # or an internal lib alias. Resolve each through the approved-base
        # resolver, then resume no-follow traversal of its canonical path.
        # Do not use resolve()/glob-following that could escape the base.
        library = self._safe_base_target(str(self.base / 'lib'))
        with directory(library):
            python_dirs = sorted(name for name in os.listdir(library) if re.fullmatch(r'python[0-9]+\.[0-9]+', name))
        seen_packages, seen_distributions = set(), set()
        for name in python_dirs:
            try:
                python_library = self._safe_base_target(str(library / name))
                packages = self._safe_base_target(str(python_library / 'site-packages'))
            except FileNotFoundError:
                continue
            with directory(packages) as fd:
                info = os.fstat(fd)
                identity = (info.st_dev, info.st_ino)
                if identity in seen_packages:
                    continue
                seen_packages.add(identity)
                for entry in sorted(os.listdir(packages)):
                    if not entry.endswith('.dist-info'):
                        continue
                    distribution = self._safe_base_target(str(packages / entry))
                    with directory(distribution) as distribution_fd:
                        info = os.fstat(distribution_fd)
                        identity = (info.st_dev, info.st_ino)
                        if identity in seen_distributions:
                            continue
                        seen_distributions.add(identity)
                        for leaf in ('METADATA', 'RECORD'):
                            try:
                                file = self._safe_base_target(str(distribution / leaf))
                            except FileNotFoundError:
                                continue
                            records[str(file.relative_to(self.base))] = self._hash_base_file(file)
                            if len(records) > 20000:
                                fail('limit_exceeded', 'Too many base package metadata records')
        return {'schema': 1, 'sha256': digest({'path': str(self.base), 'records': records}),
                'pythonVersion': version, 'basePath': str(self.base),
                'coverage': 'interpreter-and-package-metadata; not all base files or host libraries; same-machine validation only'}

    def _space(self, needed=0):
        self._check_root()
        with directory(self.path) as target:
            require_workspace_space(self.root, self.reserve_bytes, needed, target_fd=target)

    def _publication_location(self, section, relative, info=None):
        # Only project-relative paths, never host paths or file contents.
        self._publication_context = {'path': section + '/' + (relative or '.')}
        if info is not None:
            kind = ('directory' if stat.S_ISDIR(info.st_mode) else
                    'symlink' if stat.S_ISLNK(info.st_mode) else
                    'file' if stat.S_ISREG(info.st_mode) else 'special')
            self._publication_context.update(kind=kind, mode=oct(stat.S_IMODE(info.st_mode)),
                                             uid=info.st_uid, gid=info.st_gid, links=info.st_nlink)

    def _scan_totals(self, paths, report):
        totals = {'entries': 0, 'bytes': 0}
        for section, source in paths.items():
            with directory(source) as root_fd:
                def visit(fd, relative):
                    for name in sorted(os.listdir(fd)):
                        rel = relative + '/' + name if relative else name
                        self._publication_location(section, rel)
                        if '/' in name or '\\' in name or any(ord(c) < 32 for c in name):
                            fail('unsafe_path', 'Unsupported filename in project snapshot')
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        self._publication_location(section, rel, info)
                        totals['entries'] += 1
                        if stat.S_ISREG(info.st_mode): totals['bytes'] += info.st_size
                        if totals['entries'] > self.max_entries:
                            fail('limit_exceeded', 'Snapshot exceeds its entry limit')
                        self.size_warnings(totals['bytes'])
                        report('scanning', totals['entries'], totals['bytes'])
                        if stat.S_ISDIR(info.st_mode):
                            child = os.open(name, DIR_FLAGS, dir_fd=fd)
                            try:
                                if stamp(info) != stamp(os.fstat(child)):
                                    fail('changed', 'Project changed during scan')
                                visit(child, rel)
                            finally: os.close(child)
                visit(root_fd, '')
        return totals

    def _walk(self, source, section, destination=None, budget=None):
        """Hash with descriptor-relative no-follow reads; optionally copy once."""
        budget = budget if budget is not None else {'entries': 0, 'bytes': 0}
        records, versions = [], {}

        def record(value):
            budget['manifestBytes'] = budget.get('manifestBytes', 0) + len(canonical(value)) + 1
            if budget['manifestBytes'] > 48 * 1024 * 1024:
                fail('limit_exceeded', 'Snapshot manifest size limit exceeded')
            records.append(value)

        with directory(source) as root_fd:
            root_dev = os.fstat(root_fd).st_dev

            def visit(fd, relative):
                before = os.fstat(fd)
                self._publication_location(section, relative, before)
                self._check_tree_stat(before, root_dev, directory=True)
                versions[relative] = stamp(before)
                names = sorted(os.listdir(fd))
                for name in names:
                    if name in ('.', '..') or '/' in name or '\\' in name or any(ord(char) < 32 for char in name):
                        fail('unsafe_path', 'Unsupported filename in project snapshot')
                    rel = relative + '/' + name if relative else name
                    self._publication_location(section, rel)
                    if len(rel.encode()) > 4096:
                        fail('limit_exceeded', 'Snapshot path is too long')
                    info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    self._publication_location(section, rel, info)
                    budget['entries'] += 1
                    if budget['entries'] > self.max_entries:
                        fail('limit_exceeded', 'Snapshot entry limit exceeded')
                    versions[rel] = stamp(info)
                    target = destination / rel if destination else None
                    if stat.S_ISDIR(info.st_mode):
                        self._check_tree_stat(info, root_dev, directory=True)
                        child = os.open(name, DIR_FLAGS, dir_fd=fd)
                        try:
                            if stamp(info) != stamp(os.fstat(child)):
                                fail('changed', 'Project directory changed during publication')
                            if target:
                                target.mkdir(mode=0o700)
                            record({'path': rel, 'type': 'directory'})
                            visit(child, rel)
                        finally:
                            os.close(child)
                    elif stat.S_ISREG(info.st_mode):
                        self._check_tree_stat(info, root_dev)
                        budget['bytes'] += info.st_size
                        self.size_warnings(budget['bytes'])
                        if target:
                            self._space(info.st_size)
                        file = os.open(name, FILE_FLAGS, dir_fd=fd)
                        out = None
                        try:
                            if stamp(info) != stamp(os.fstat(file)):
                                fail('changed', 'Project file changed during publication')
                            if target:
                                out = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                            checksum, size = hashlib.sha256(), 0
                            while True:
                                block = os.read(file, 1024 * 1024)
                                if not block:
                                    break
                                size += len(block)
                                if size > info.st_size:
                                    fail('changed', 'Project file grew during publication')
                                checksum.update(block)
                                notify = getattr(self, '_publication_chunk', None)
                                if notify: notify(len(block))
                                if out is not None:
                                    view = memoryview(block)
                                    while view:
                                        written = os.write(out, view)
                                        view = view[written:]
                            if size != info.st_size or stamp(info) != stamp(os.fstat(file)):
                                fail('changed', 'Project file changed during publication')
                            if out is not None:
                                os.fsync(out)
                                os.fchmod(out, 0o444 | (info.st_mode & 0o111))
                            record({'path': rel, 'type': 'file', 'bytes': size,
                                    'executable': bool(info.st_mode & 0o111), 'sha256': checksum.hexdigest()})
                        finally:
                            os.close(file)
                            if out is not None:
                                os.close(out)
                    elif stat.S_ISLNK(info.st_mode) and section == 'env':
                        if info.st_uid != os.geteuid() or info.st_nlink != 1:
                            fail('unsafe_path', 'Unsafe environment symbolic link')
                        value = os.readlink(name, dir_fd=fd)
                        if '\\' in value or any(ord(char) < 32 for char in value):
                            fail('unsafe_path', 'Invalid environment symbolic link')
                        record({'path': rel, 'type': 'symlink', 'target': value})
                        if target:
                            os.symlink(value, target)
                    else:
                        fail('unsafe_path', 'Only ordinary files/directories and approved environment links may be published')
                    self._publication_location(section, rel, info)
                    if stamp(info) != stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)):
                        fail('changed', 'Project entry changed during publication')
                    notify = getattr(self, '_publication_entry', None)
                    if notify: notify()
                if names != sorted(os.listdir(fd)) or stamp(before) != stamp(os.fstat(fd)):
                    fail('changed', 'Project directory changed during publication')

            visit(root_fd, '')
        if section == 'env':
            self._validate_env_links(records)
        return records, versions

    def _check_tree_stat(self, info, device, directory=False):
        # publish() enters through dev_paths(), which verifies every enclosing
        # control directory and each dev tree root is service-owned mode 0700.
        # Conda's venv install_scripts copies some activate templates as 0664
        # regardless of the caller's umask. A service-group write bit inside
        # that private tree is not outside access; never chmod the user's tree.
        # Foreign-group/world writes and set-ID bits remain forbidden, and
        # snapshot files/directories are normalized to 0444/0555 separately.
        foreign_group_write = bool(info.st_mode & 0o020) and info.st_gid != os.getegid()
        if (info.st_dev != device or info.st_uid != os.geteuid() or
                info.st_mode & 0o002 or foreign_group_write or info.st_mode & 0o6000):
            fail('unsafe_path', 'Project entries must be service-owned, same-filesystem, without external writes or set-ID bits')
        if not directory and info.st_nlink != 1:
            fail('unsafe_path', 'Hard-linked files cannot be published')

    def _validate_env_links(self, records):
        entries = {item['path']: item for item in records}
        if entries.get('pyvenv.cfg', {}).get('type') != 'file' or 'bin/python' not in entries:
            fail('environment_not_ready', 'Initialize a project Python venv before publishing')
        for item in records:
            if item['type'] != 'symlink':
                continue
            self._publication_context = {'path': 'env/' + item['path'], 'kind': 'symlink',
                                         'linkTarget': item['target'][:4096]}
            rel = item['path']
            for _ in range(40):
                current = entries.get(rel)
                if current is None:
                    fail('unsafe_path', 'Environment link is dangling or escapes the project')
                if current['type'] != 'symlink':
                    break
                value = current['target']
                if value.startswith('/'):
                    try:
                        rel = str(PurePosixPath(value).relative_to('/opt/project-env'))
                    except ValueError:
                        self._safe_base_target(value)
                        break
                else:
                    rel = posixpath.normpath(posixpath.join(posixpath.dirname(rel), value))
                if rel == '..' or rel.startswith('../') or rel.startswith('/'):
                    fail('unsafe_path', 'Environment link escapes the project')
                if rel == '.':
                    break
            else:
                fail('unsafe_path', 'Environment symbolic-link cycle')

    def _validate_environment_mode(self, environment, mode):
        # Read the already copied private snapshot, never race a mutable dev
        # config or rewrite the user's environment. This is dependency hygiene,
        # not a security boundary against project code deliberately importing.
        if mode != 'isolated':
            return
        self._publication_context = {'path': 'env/pyvenv.cfg', 'kind': 'file'}
        fd = os.open(environment / 'pyvenv.cfg', FILE_FLAGS)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                fail('environment_conflict', 'Invalid isolated environment configuration')
            config = os.read(fd, 65537).decode('utf-8')
        finally:
            os.close(fd)
        values = [line.split('=', 1)[1].strip().lower() for line in config.splitlines()
                  if '=' in line and line.split('=', 1)[0].strip().lower() == 'include-system-site-packages']
        if values != ['false']:
            fail('environment_conflict', 'Isolated project requires include-system-site-packages = false; do not reuse a shared venv')

    @project_lifetime
    def publish(self, user, slug, progress=None):
        self.admit(user, slug)
        path, project = self._project(user, slug)
        if project.get('runtime') == 'workspace':
            fail('environment_conflict', 'Workspace projects run directly; publication is no longer required or supported')
        self._quota(user, path.parent)
        environment_mode = project.get('environmentMode', 'shared')
        sections = ('code',) if environment_mode == 'oci' else ('code', 'env')
        self._publication_context = {}
        started = int(time.time())
        last_emit, last_phase = [0.0], [None]
        totals, completed = {}, {'entries': 0, 'bytes': 0}
        def report(phase, entries=0, size=0, force=False):
            now = time.monotonic()
            if progress and (force or phase != last_phase[0] or now-last_emit[0] >= 1):
                value = {'phase':phase,'completedEntries':entries,'completedBytes':size,
                         'totalEntries':totals.get('entries'),'totalBytes':totals.get('bytes'),
                         'startedAt':started,'updatedAt':int(time.time())}
                progress(value)
                last_emit[0], last_phase[0] = now, phase
        def chunk(size):
            completed['bytes'] += size
            report(last_phase[0] or 'copying', completed['entries'], completed['bytes'])
        def entry():
            completed['entries'] += 1
            report(last_phase[0] or 'copying', completed['entries'], completed['bytes'])
        with self.locked(user, slug):
            private_dir(path / '.staging')
            private_dir(path / 'releases')
            atomic_json(path / '.publishing.json', {'startedAt': int(time.time())})
            stage = path / '.staging' / uuid.uuid4().hex
            stage.mkdir(mode=0o700)
            try:
                report('scanning', force=True)
                self._space()
                oci = self._oci(user).publish(slug) if environment_mode == 'oci' else None
                base = {'kind': 'oci', 'image': oci['image']} if oci else self.base_fingerprint()
                dev = self.dev_paths(user, slug)
                totals.update(self._scan_totals({name:dev[name] for name in sections},report))
                self._publication_chunk, self._publication_entry = chunk, entry
                report('copying', force=True)
                content, stamps = {}, {}
                budget = {'entries': 0, 'bytes': 0}
                for name in ('code', 'env'):
                    (stage / name).mkdir(mode=0o700)
                for name in sections:
                    content[name], stamps[name] = self._walk(dev[name], name, stage / name, budget)
                self._validate_environment_mode(stage / 'env', environment_mode)
                # A second full hash pass detects changes even if size/mtime are
                # preserved. Writers must still be stopped by the caller.
                completed.update(entries=0, bytes=0)
                report('verifying', force=True)
                second_budget = {'entries': 0, 'bytes': 0}
                for name in sections:
                    manifest, observed = self._walk(dev[name], name, budget=second_budget)
                    if manifest != content[name] or observed != stamps[name]:
                        fail('changed', 'Project changed while publishing; stop writers and retry')
                if not oci and base != self.base_fingerprint():
                    fail('base_changed', 'Base environment changed while publishing')
                report('publishing', completed['entries'], completed['bytes'], force=True)
                payload = {'schema': 2, 'base': base, 'content': content}
                # Preserve historical shared release hashes byte-for-byte.
                if environment_mode in ('isolated', 'oci'):
                    payload['environmentMode'] = environment_mode
                if oci:
                    payload['oci'] = oci
                version = digest(payload)
                meta = {**payload, 'release': version, 'project': slug, 'owner': project['owner'],
                        'createdAt': int(time.time()), **budget}
                atomic_json(stage / 'meta.json', meta)
                atomic_json(stage / 'READY.json', self._ready_marker(meta))
                for current, dirs, _ in os.walk(stage, followlinks=False, topdown=False):
                    for name in dirs:
                        child = Path(current) / name
                        if not child.is_symlink():
                            child.chmod(0o555)
                target = path / 'releases' / version
                if target.exists() or target.is_symlink():
                    old = self._release_meta(target, version)
                    if any(old.get(key) != meta.get(key) for key in ('content', 'base', 'owner', 'project')):
                        fail('unsafe_path', 'Existing release metadata does not match its digest')
                    meta = old
                else:
                    existing = [name for name in os.listdir(path / 'releases') if VERSION.fullmatch(name)]
                    if len(existing) >= self.max_releases:
                        fail('limit_exceeded', 'Maximum releases per project reached')
                    # All writers use the per-project lock. Never replace a
                    # release, and expose READY + both trees in one rename.
                    os.rename(stage, target)
                    with directory(path / 'releases') as fd:
                        os.fsync(fd)
                atomic_json(path / 'latest.json', {'release': version})
                # The durable release/latest commit is authoritative. A failed
                # final UI progress write must not turn a committed release
                # into a false publication failure or encourage a duplicate.
                try: report('complete', meta['entries'], meta['bytes'], force=True)
                except Exception: pass
                return {'project': slug, 'release': version, 'state': 'READY',
                        'environmentMode': environment_mode, 'offlineAssetsPath': '/workspace/offline',
                        'baseFingerprint': {key: value for key, value in meta['base'].items() if key != 'basePath'}, 'bytes': meta['bytes'],
                        'entries': meta['entries'], 'createdAt': meta['createdAt'],
                        'warnings': self.size_warnings(meta['bytes'])}
            except (ProjectError, OSError) as error:
                context = dict(self._publication_context)
                if isinstance(error, OSError): context['errno'] = error.errno
                code = error.code if isinstance(error,ProjectError) else 'filesystem_error'
                message = str(error) if isinstance(error,ProjectError) else 'Project filesystem operation failed'
                remedies = {
                    'insufficient_space':'Free space on this project volume; do not remove another user’s data.',
                    'changed':'Stop all writers to this project, then retry publication.',
                    'base_changed':'Rebuild and publish the project environment against the current approved base.',
                    'environment_not_ready':'Open the project terminal to initialize its environment before publishing.',
                    'environment_conflict':'Keep this project venv in its original mode; create a new project to change modes. Do not overwrite an existing environment.',
                    'limit_exceeded':'Remove unnecessary entries or shorten paths; project weights stay in the project. Dataset inputs use the dataset channel.'}
                remedy = remedies.get(code, 'Check the reported project-relative file owner and permissions; remove external writes/set-ID bits or replace unsupported links with an independent regular copy inside this project. Do not recursively chmod system or other user paths.')
                context['remediation'] = remedy
                context['reason'] = message
                raise ProjectError(code, message + (' ['+context['path']+']' if context.get('path') else ''), context) from error
            finally:
                self._publication_chunk = self._publication_entry = None
                if stage.exists():
                    self._remove_stage(stage)
                (path / '.publishing.json').unlink(missing_ok=True)

    def size_warnings(self, size, *, file=False):
        if type(size) is not int or not 0 <= size <= self.MAX_BYTES:
            fail('invalid_input', 'Byte count cannot be represented exactly by the transfer protocol')
        threshold = self.FILE_WARNING_BYTES if file else self.warning_bytes
        return ([{'code': 'LARGE_FILE' if file else 'LARGE_PROJECT',
                  'bytes': size, 'warningBytes': threshold, 'blocking': False}]
                if size > threshold else [])

    @staticmethod
    def _remove_stage(path):
        # Only this invocation's private staging UUID; never user/old data.
        for current, dirs, _ in os.walk(path, followlinks=False):
            Path(current).chmod(0o700)
            for name in dirs:
                child = Path(current) / name
                if not child.is_symlink():
                    child.chmod(0o700)
        shutil.rmtree(path)

    @staticmethod
    def _ready_marker(meta):
        return {'schema': 2, 'release': meta['release'], 'metaSha256': digest(meta),
                **{key: meta[key] for key in ('owner', 'project', 'createdAt', 'bytes', 'entries')}}

    def _release_summary(self, path, version):
        with directory(path) as fd:
            info = os.fstat(fd)
            if info.st_uid != os.geteuid() or info.st_mode & 0o022:
                fail('unsafe_path', 'Unsafe release directory')
        ready = read_json(path / 'READY.json')
        if (set(ready) != {'schema', 'release', 'metaSha256', 'owner', 'project', 'createdAt', 'bytes', 'entries'} or
                ready.get('schema') != 2 or ready.get('release') != version or
                not isinstance(ready.get('metaSha256'), str) or not VERSION.fullmatch(ready['metaSha256']) or
                any(type(ready.get(key)) is not int or ready[key] < 0 for key in ('createdAt', 'bytes', 'entries'))):
            fail('unsafe_path', 'Release READY summary is invalid')
        return ready

    def _release_meta(self, path, version):
        ready = self._release_summary(path, version)
        meta = read_json(path / 'meta.json', 64 * 1024 * 1024)
        payload = {key: meta.get(key) for key in ('schema', 'base', 'content')}
        if 'environmentMode' in meta:
            if meta['environmentMode'] not in ('isolated', 'oci'):
                fail('unsafe_path', 'Invalid release environment mode')
            payload['environmentMode'] = meta['environmentMode']
            if meta['environmentMode'] == 'oci':
                payload['oci'] = meta.get('oci')
        if ready != self._ready_marker(meta) or meta.get('release') != version or digest(payload) != version:
            fail('unsafe_path', 'Release is incomplete or metadata is inconsistent')
        return meta

    @project_lifetime
    def release(self, user, slug, version):
        path, project = self._project(user, slug)
        if not isinstance(version, str) or not VERSION.fullmatch(version):
            fail('invalid_input', 'Invalid immutable project release')
        target = path / 'releases' / version
        try:
            meta = self._release_meta(target, version)
        except FileNotFoundError:
            fail('not_found', 'READY project release not found')
        if meta.get('owner') != project['owner'] or meta.get('project') != slug:
            fail('unsafe_path', 'Release belongs to another project')
        if meta.get('environmentMode') == 'oci':
            self._oci(user).verify_image(slug, meta.get('oci'))
        elif meta['base'] != self.base_fingerprint():
            fail('base_changed', 'Approved base changed; rebuild and publish a new project environment')
        for name in ('code', 'env'):
            with directory(target / name) as fd:
                info = os.fstat(fd)
                if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o555:
                    fail('unsafe_path', 'Published project trees must remain service-owned and read-only')
        return {'code': target / 'code', 'env': target / 'env', 'meta': meta}

    @contextlib.contextmanager
    def _claimed_run(self, claim):
        jobid = claim['jobId']
        if not isinstance(jobid, str) or not JOB_ID.fullmatch(jobid):
            fail('invalid_input', 'Invalid project job ID')
        claims = private_dir(self.path / '.run-claims')
        with self._file_lock(claims / '.lock'):
            claim_file = claims / (jobid + '.json')
            if claim_file.exists() or claim_file.is_symlink():
                if read_json(claim_file) != claim:
                    fail('job_conflict', 'Job ID already belongs to another user, project, or release')
            else:
                atomic_json(claim_file, claim)
            yield

    @project_lifetime
    def workspace_paths(self, user, slug, jobid=None):
        """The same mutable project for terminals and all subsequent jobs.

        A job claim records ownership only. It creates no code/image snapshot,
        task HOME, or task output tree. Historical run_paths stays independent.
        """
        path, project = self._project(user, slug)
        self._quota(user, path.parent)
        paths = self.dev_paths(user, slug)
        if jobid is not None:
            with self._claimed_run({'owner': project['owner'], 'project': slug,
                                    'jobId': jobid, 'workspace': True}):
                pass
        return {'code': paths['code'], 'env': paths['env'], 'home': paths['home'],
                'output': paths['scratch'], 'readonly': False,
                'environmentMode': project.get('environmentMode', 'shared'),
                'workspace': True}

    def runtime_paths(self, spec, jobid, terminal=False):
        """Development and training use the same persistent project paths."""
        user, slug = spec['userId'], spec['project']
        self.admit(user, slug)
        return self.workspace_paths(user, slug, None if terminal else jobid)

    @project_lifetime
    def run_paths(self, user, slug, version, jobid):
        if not isinstance(jobid, str) or not JOB_ID.fullmatch(jobid):
            fail('invalid_input', 'Invalid project job ID')
        self.release(user, slug, version)
        path, project = self._project(user, slug)
        self._quota(user, path.parent)
        claim = {'owner': project['owner'], 'project': slug, 'release': version, 'jobId': jobid}
        with self._claimed_run(claim):
            runs = private_dir(path / 'runs')
            run = private_dir(runs / jobid, create=True)
            result = {name: private_dir(run / name, create=True) for name in ('home', 'output')}
        return result

    @project_lifetime
    def existing_run_paths(self, user, slug, version, jobid):
        """Read an existing run even after the shared base has been upgraded.

        No directories/claims are created and no present-day environment is
        required to download historical outputs. Authentication belongs to the
        caller; the durable claim still binds all four supplied identifiers.
        """
        if not isinstance(jobid, str) or not JOB_ID.fullmatch(jobid) or version is not None and (not isinstance(version, str) or not VERSION.fullmatch(version)):
            fail('invalid_input', 'Invalid project run reference')
        path, project = self._project(user, slug)
        claims = private_dir(self.path / '.run-claims')
        expected = {'owner': project['owner'], 'project': slug, 'jobId': jobid,
                    **({'workspace': True} if version is None else {'release': version})}
        try:
            if read_json(claims / (jobid + '.json')) != expected:
                fail('job_conflict', 'Job ID belongs to another user, project, or release')
            if version is None:
                return {'home': private_dir(path/'dev'/'home'), 'output': private_dir(path/'dev'/'scratch')}
            runs = private_dir(path / 'runs')
            run = private_dir(runs / jobid)
            return {name: private_dir(run / name) for name in ('home', 'output')}
        except FileNotFoundError:
            fail('not_found', 'Existing project run not found')

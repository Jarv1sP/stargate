"""Local, read-only team data exports; never materialize or register datasets.

Only administrator configuration supplies host paths. Project metadata records
the selected directory identities. Locks live outside exports and survive for
the whole container lifetime, so maintenance cannot race a new mount.
"""
from contextlib import ExitStack, contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import uuid

TARGETS = {'data': '/data', 'fast': '/fast-data'}
LOCAL_FS = {'ext4', 'xfs', 'btrfs', 'zfs'}
FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW


def absolute(value):
    if not isinstance(value, str) or not value.startswith('/') or value == '/' or str(Path(value)) != value or '..' in Path(value).parts:
        raise ValueError('Public data roots require a fixed absolute non-root directory')
    return Path(value)


@contextmanager
def directory(path):
    path = absolute(str(path))
    fd = os.open('/', FLAGS)
    try:
        for part in path.parts[1:]:
            child = os.open(part, FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def mount(path):
    for line in reversed(Path('/proc/self/mountinfo').read_text().splitlines()):
        left, right = line.split(' - ', 1)
        fields, kind = left.split(), right.split()[0]
        target = re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), fields[4])
        if target == str(path):
            if kind not in LOCAL_FS:
                raise ValueError('Public data must be on a local data filesystem')
            return
    raise ValueError('Configured public data volume is not mounted')


def configured(config):
    value = config.get('publicDataRoots')
    if value is None or value == {'enabled': False}:
        return None
    if not isinstance(value, dict) or set(value) != {'enabled', 'roots'} or value['enabled'] is not True:
        raise ValueError('Invalid public data root configuration')
    roots = value['roots']
    if not isinstance(roots, dict) or 'data' not in roots or set(roots) - set(TARGETS):
        raise ValueError('A main public data root is required')
    protected = [absolute(config['root'])]
    for key in ('datasets', 'storageWarehouse'):
        if isinstance(config.get(key), dict) and config[key].get('root'):
            protected.append(absolute(config[key]['root']))
    paths = []
    for name, item in roots.items():
        if not isinstance(item, dict) or set(item) != {'path', 'mountPoint'}:
            raise ValueError('Public data root requires path and mountPoint')
        path, point = absolute(item['path']), absolute(item['mountPoint'])
        if point not in path.parents:
            raise ValueError('Public data export must be below its data mount')
        if any(path == p or path in p.parents or p in path.parents for p in protected):
            raise ValueError('Public exports must be separate from platform metadata and private storage')
        if any(path == p or path in p.parents or p in path.parents for p in paths):
            raise ValueError('Public data exports must not overlap')
        paths.append(path)
    return roots


def validate_snapshot(value):
    if not isinstance(value, dict) or set(value) != {'protocol', 'mode', 'workspaceMode', 'roots', 'unavailable'} or type(value['protocol']) is not int or value['protocol'] != 1 or value['mode'] != 'local-roots' or value['workspaceMode'] not in ('project', 'task') or not isinstance(value['roots'], list):
        raise ValueError('Invalid saved public data layout')
    seen = set()
    for root in value['roots']:
        if not isinstance(root, dict) or set(root) != {'name', 'path', 'mountPoint', 'device', 'inode'} or root['name'] not in TARGETS or root['name'] in seen:
            raise ValueError('Invalid saved public data root')
        absolute(root['path']); absolute(root['mountPoint'])
        if any(type(root[k]) is not int or root[k] < 0 for k in ('device', 'inode')):
            raise ValueError('Invalid public directory identity')
        seen.add(root['name'])
    if 'data' not in seen or not isinstance(value['unavailable'], list) or any(x != 'fast' for x in value['unavailable']) or len(value['unavailable']) > 1 or seen.intersection(value['unavailable']):
        raise ValueError('Incomplete saved public data layout')
    return value


def capture(config, workspace_mode='project'):
    roots = configured(config)
    if roots is None:
        raise ValueError('Local public data roots are not enabled on this node')
    if workspace_mode not in ('project', 'task'):
        raise ValueError('Workspace mode must be project or task')
    saved, unavailable = [], []
    for name, item in roots.items():
        try:
            mount(item['mountPoint'])
            with directory(item['path']) as fd, directory(item['mountPoint']) as volume:
                info = os.fstat(fd)
                if info.st_dev != os.fstat(volume).st_dev:
                    raise ValueError('Public export is not on its configured volume')
                saved.append({'name': name, **item, 'device': info.st_dev, 'inode': info.st_ino})
        except (OSError, ValueError):
            if name == 'data':
                raise ValueError('Main local data root is unavailable') from None
            unavailable.append(name)
    return validate_snapshot({'protocol': 1, 'mode': 'local-roots', 'workspaceMode': workspace_mode, 'roots': saved, 'unavailable': unavailable})


def public(value):
    validate_snapshot(value)
    return {'protocol': 1, 'mode': value['mode'], 'workspaceMode': value['workspaceMode'],
            'roots': [{'path': TARGETS[r['name']], 'readOnly': True} for r in value['roots']],
            'unavailable': [TARGETS[name] for name in value['unavailable']]}


def capabilities(config):
    try:
        value = capture(config)
        return {'available': True, **public(value)}
    except (OSError, ValueError):
        return {'protocol': 1, 'available': False, 'mode': 'local-roots'}


def consumer_quiet(value):
    if not isinstance(value, dict) or set(value) != {'cgroup', 'unit', 'boot'}:
        raise ValueError('Public root consumer state is unconfirmed')
    group = value['cgroup']
    if not isinstance(group, str) or not group.startswith('/') or '..' in Path(group).parts or Path(group).name != value['unit'] or not re.fullmatch(r'(?:amax-term-|gpuq-)[A-Za-z0-9_.-]+\.service', value['unit']):
        raise ValueError('Public root consumer identity is invalid')
    if value['boot'] != Path('/proc/sys/kernel/random/boot_id').read_text().strip():
        return True
    path = Path('/sys/fs/cgroup')/group.lstrip('/')
    try:
        events = dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
    except FileNotFoundError:
        return not path.exists()
    return events.get('populated') == '0'


def consumer_folder(config, root):
    return Path(config['root'])/'public-data-locks'/(root_key(root)+'.consumers')


def root_key(root):
    # Bind aliases of the same directory share protection, not just capacity.
    return hashlib.sha256(f"{root['device']}:{root['inode']}".encode()).hexdigest()


def register_consumer(config, root, consumer):
    value = {**consumer, 'boot': Path('/proc/sys/kernel/random/boot_id').read_text().strip()}
    consumer_quiet(value)  # Validate the trusted runner's cgroup identity.
    folder = consumer_folder(config, root); folder.mkdir(mode=0o700, exist_ok=True)
    path = folder/(uuid.uuid4().hex+'.json')
    with directory(folder) as parent:
        fd = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream); stream.flush(); os.fsync(stream.fileno())
        os.fsync(parent)
    return path


@contextmanager
def root_lock(config, root, exclusive=False):
    folder = Path(config['root'])/'public-data-locks'
    folder.mkdir(mode=0o700, exist_ok=True)
    key = root_key(root)+'.lock'
    with directory(folder) as parent:
        fd = os.open(key, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
            raise ValueError('Invalid public data maintenance lock')
        try:
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError('Public data is in use or under maintenance; retry after it is released') from None
        if exclusive:
            folder = consumer_folder(config, root)
            if folder.exists():
                with directory(folder) as parent:
                    for name in os.listdir(parent):
                        if not re.fullmatch(r'[a-f0-9]{32}\.json', name):
                            raise ValueError('Public root consumer record is unconfirmed')
                        reader = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                        with os.fdopen(reader) as stream:
                            value = json.loads(stream.read(8193))
                        if not consumer_quiet(value):
                            raise ValueError('Public data consumer cgroup is still active')
                        os.unlink(name, dir_fd=parent)
        yield
    finally:
        os.close(fd)


@contextmanager
def opened(config, value, *, consumer=None):
    validate_snapshot(value)
    current = configured(config)
    if current is None:
        raise ValueError('Local public data access is disabled')
    with ExitStack() as stack:
        result, unavailable, receipts = [], list(value['unavailable']), []
        for root in value['roots']:
            name = root['name']
            if current.get(name) != {k: root[k] for k in ('path', 'mountPoint')}:
                raise ValueError('Saved public data configuration changed; project migration is required')
            try:
                stack.enter_context(root_lock(config, root))
            except (OSError, ValueError):
                if name == 'data':raise
                unavailable.append(name)
                continue
            try:
                mount(root['mountPoint'])
                fd = stack.enter_context(directory(root['path']))
                info = os.fstat(fd)
                if (info.st_dev, info.st_ino) != (root['device'], root['inode']):
                    raise ValueError('Saved public directory changed')
            except (OSError, ValueError):
                if name == 'data':
                    raise ValueError('Saved main public data root is unavailable') from None
                unavailable.append(name)
            else:
                if consumer is not None:
                    receipts.append(register_consumer(config, root, consumer))
                result.append((fd, TARGETS[name]))
        yield result, [TARGETS[name] for name in unavailable]
        # Normal return means the attached payload finished. On a runner crash
        # the receipts stay; maintenance must also prove its cgroup empty.
        for receipt in receipts:
            try:receipt.unlink()
            except OSError:
                # A stale receipt is checked against the real cgroup later;
                # optional cleanup must not replace the training exit result.
                pass

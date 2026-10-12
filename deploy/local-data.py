"""Mount node-owned local data directories directly, without a cache workflow.

localDataDirectories maps container names to host directories. The node
administrator chooses these shared exports; jobs cannot supply host paths.
No scan, version registration, copying, free-space test or lease is needed.
"""
from contextlib import ExitStack
import hashlib
import os
from pathlib import Path
import re


def directories(config):
    result = config.get('localDataDirectories', {})
    if not isinstance(result, dict):
        raise ValueError('localDataDirectories must map names to local directories')
    for name, path in result.items():
        if name == 'mine' or not isinstance(name, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}', name):
            raise ValueError('Invalid local data mount name')
        if (not isinstance(path, str) or not path.startswith('/') or '\0' in path
                or '..' in Path(path).parts or str(Path(path)) != path or path == '/'):
            raise ValueError('Local data exports require absolute directory paths')
        private = config.get('personalDataRoot')
        if private and (Path(private).is_relative_to(path) or Path(path).is_relative_to(private)):
            raise ValueError('Shared data exports must not overlap personal data')
    return result


def open_directory(path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    try:
        for part in Path(path).parts[1:]:
            child = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = child
        return fd
    except BaseException:
        os.close(fd)
        raise


def open_mounts(config):
    # FDs are transferred to the runner, which closes them after execution.
    with ExitStack() as cleanup:
        mounts = []
        for name, path in sorted(directories(config).items()):
            fd = open_directory(path)
            cleanup.callback(os.close, fd)
            mounts.append((fd, '/data/'+name))
        cleanup.pop_all()
        return mounts


def describe(config):
    return {'directories': [{'name': name, 'path': '/data/'+name, 'readOnly': True}
                            for name in sorted(directories(config))],
            'personal': {'path': '/data/mine', 'readOnly': False}}


def personal_directory(config, user, *, create=True):
    """Private writable files on the explicitly configured data disk."""
    if not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', user):
        raise ValueError('Invalid personal data owner')
    root = config['personalDataRoot']
    directories({'localDataDirectories': {'personal': root}})
    owner = hashlib.sha256(user.encode()).hexdigest()
    fd = open_directory(root)
    try:
        for name in (owner, 'data'):
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        return Path(root)/owner/'data'
    finally:
        os.close(fd)


def project_output(config, user, project, *, create=True):
    if not isinstance(project, str) or not re.fullmatch(r'[a-z][a-z0-9_-]{0,47}', project):
        raise ValueError('Invalid project output directory')
    root = personal_directory(config, user, create=create)
    fd = open_directory(root)
    try:
        for name in ('outputs', project):
            if create:
                try: os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        return root/'outputs'/project
    finally:
        os.close(fd)


def require_write_space(needed, *, target_fd):
    # Only the actual destination volume matters, not an unrelated SSD/cache.
    space = os.fstatvfs(target_fd)
    if space.f_bavail * space.f_frsize < needed:
        raise OSError('Personal data disk has insufficient free space')


def process(config, operation, args, file_op):
    action = operation.removeprefix('datasets.workspace.')
    fields = {'list': {'path'}, 'get': {'path', 'offset', 'fingerprint'},
              'put': {'path', 'offset', 'data', 'truncate'}, 'status': set()}
    if (action not in fields or set(args) - fields[action] - {'userId', 'hostAdmin'}
            or args.get('hostAdmin') is not False):
        raise ValueError('Invalid personal data request')
    root = personal_directory(config, args['userId'])
    if action == 'status':
        return {'state': 'EDITABLE', 'mountPath': '/data/mine'}
    return file_op('files.'+action, args, root=root, space_check=require_write_space)

"""Default read-only views of existing shared data; never copy or publish it.

Node configuration supplies sharedDataDirectories: {name: absolute_path}.
These directories are shared with accounts authorized on this node. They
remain externally maintained inputs, not immutable managed dataset versions.
"""
import os
import ast
from pathlib import Path
import re

PROTOCOL = 'shared-data-directories-v1'
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')


def configured(config):
    rows = config.get('sharedDataDirectories', {})
    if not isinstance(rows, dict) or len(rows) > 32:
        raise ValueError('Invalid shared data directories')
    for name, path in rows.items():
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError('Invalid shared data directory name')
        if (not isinstance(path, str) or not path.startswith('/') or '\x00' in path
                or str(Path(path)) != path or '..' in Path(path).parts
                or len(Path(path).parts) < 3 or Path(path).parts[1] in ('proc', 'sys', 'dev', 'etc', 'run')):
            raise ValueError('Invalid shared data directory: '+name)
        for policy_name in ('datasets', 'storageWarehouse'):
            policy=config.get(policy_name,{})
            root=policy.get('root') if isinstance(policy,dict) else None
            if not isinstance(root,str):continue
            try:relative=Path(path).relative_to(Path(root)).parts
            except ValueError:continue
            # Managed READY/staging/cache trees need their version leases.
            # A private workspace's raw data is not evicted by cache GC.
            if not (len(relative)>=3 and relative[0]=='.workspaces'
                    and re.fullmatch(r'[a-f0-9]{64}',relative[1]) and relative[2]=='data'):
                raise ValueError('Managed dataset storage requires its normal dataset reader: '+name)
    return rows


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
    """Pin source directories for the runner's existing read-only mounts."""
    mounts = []
    try:
        for name, path in sorted(configured(config).items()):
            try:
                fd = open_directory(path)
            except OSError:
                raise ValueError('Shared data directory is unavailable: '+name) from None
            mounts.append((fd, '/datasets/'+name))
        return mounts
    except BaseException:
        for fd, _ in mounts:
            os.close(fd)
        raise


def describe(config):
    try:
        tree=ast.parse(Path(__file__).with_name('sandbox-runner.py').read_bytes())
        ready=any(isinstance(node,ast.Assign) and isinstance(node.value,ast.Constant)
                  and node.value.value==1 and any(isinstance(target,ast.Name)
                  and target.id=='SHARED_DATA_DIRECTORIES_PROTOCOL' for target in node.targets) for node in tree.body)
    except (OSError,SyntaxError):ready=False
    if not ready:return {'protocol':PROTOCOL,'available':False,'directories':[]}
    rows = []
    for name, path in sorted(configured(config).items()):
        try:
            fd = open_directory(path)
            os.close(fd)
            state = 'READABLE'
        except OSError:
            state = 'UNAVAILABLE'
        rows.append({'name': name, 'path': '/datasets/'+name, 'readOnly': True, 'state': state})
    return {'protocol': PROTOCOL, 'available': True, 'directories': rows}

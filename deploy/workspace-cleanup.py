"""Explicit owner-only removal, independent of an interactive terminal.

A worker takes the existing workspace lifetime lock, detaches the exact target
into its private operation directory, and removes it there. Retries only touch
that original object, never a newly recreated directory at the old name.
"""
import hashlib
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

UUID = re.compile(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\Z')


class WorkspaceCleanup:
    def __init__(self, workspace):
        self.w = workspace
        self.n = workspace.n

    def location(self, user, key):
        if not isinstance(key, str) or not UUID.fullmatch(key):
            raise ValueError('Cleanup requires the original UUID key')
        module, _, owner = self.w.storage(user)
        folder = owner/'cleanups'
        module._mkdir(folder)
        return module, owner, folder/(key+'.json'), folder/(key+'.payload')

    @staticmethod
    def public(task):
        return {'protocol': 1, **{k: task[k] for k in ('key', 'path', 'recursive', 'state', 'phase', 'files', 'logicalBytes', 'error') if k in task}, 'freedBytes': None}

    def load(self, user, key):
        module, owner, record, payload = self.location(user, key)
        task = module._read_json(record)
        if task.get('userId') != user or task.get('key') != key:
            raise ValueError('Cleanup does not belong to this account')
        self.w.relative(task.get('path'))
        if type(task.get('recursive')) is not bool or task.get('state') not in ('QUEUED', 'RUNNING', 'FAILED', 'SUCCEEDED'):
            raise ValueError('Cleanup state is unconfirmed')
        return module, owner, record, payload, task

    def status(self, user, key):
        task = self.load(user, key)[-1]
        result = self.public(task)
        if task['state'] in ('QUEUED', 'RUNNING', 'FAILED'):
            try:quiet = self.w.unit_stopped(self.unit(user, key))
            except (OSError, ValueError, subprocess.SubprocessError):quiet = None
            result['retryable'] = quiet is True
            if task['state'] != 'FAILED' and (quiet is not False or not self.active(user, key)):
                result.update(state='UNKNOWN', error='Cleanup worker is not confirmed active; keep this operation key and query or resume it')
        return result

    def active(self, user, key):
        # unit_stopped(False) can also mean that systemd was unreachable.
        # Require positive activity evidence before presenting a live worker.
        try:
            result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', self.unit(user, key),
                '--property=LoadState,ActiveState,SubState,MainPID'], env=self.n.ENV, text=True, capture_output=True, timeout=5)
            props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
            return (result.returncode == 0 and props.get('LoadState') == 'loaded'
                    and props.get('ActiveState') == 'active' and props.get('SubState') == 'running'
                    and props.get('MainPID', '').isdigit() and int(props['MainPID']) > 0)
        except (OSError, ValueError, subprocess.SubprocessError):return False

    def target(self, module, owner, path):
        parts = self.w.relative(path)
        parent = owner/'data'
        for part in parts[:-1]:parent /= part
        with module._directory(parent) as fd:
            info = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode) or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
                raise ValueError('Choose an ordinary private file or directory, not a link or special file')
            if info.st_uid != os.geteuid() or info.st_dev != os.fstat(fd).st_dev:
                raise ValueError('Private cleanup target ownership or filesystem differs')
        return parent/parts[-1], info

    def plan(self, user, path, recursive=False):
        if type(recursive) is not bool:raise ValueError('recursive must be a boolean')
        module, cache, owner = self.w.storage(user)
        target, info = self.target(module, owner, path)
        if stat.S_ISDIR(info.st_mode) and not recursive:
            raise ValueError('Directory cleanup requires --recursive')
        space = os.statvfs(target.parent)
        return {'protocol': 1, 'path': path, 'recursive': recursive, 'state': 'PREVIEW',
                'type': 'directory' if stat.S_ISDIR(info.st_mode) else 'file',
                'logicalBytes': info.st_size if stat.S_ISREG(info.st_mode) else None,
                'freedBytes': None, 'requiresStoppedDataTerminals': True,
                'volume': {'volumeDeviceId': hashlib.sha256(str(info.st_dev).encode()).hexdigest(),
                           'filesystemBytes': space.f_blocks*space.f_frsize,
                           'availableBytes': space.f_bavail*space.f_frsize, 'reserveBytes': cache.reserve_bytes}}

    def unit(self, user, key):
        return 'gpuq-workspace-cleanup-'+hashlib.sha256((user+key).encode()).hexdigest()[:32]+'.service'

    def remove(self, args):
        user, key, path = args['userId'], args.get('key'), args.get('path')
        recursive = args.get('recursive', False)
        if type(recursive) is not bool:raise ValueError('recursive must be a boolean')
        module, owner, record, payload = self.location(user, key)
        with self.w.guard(args):
            if record.exists():
                task = self.load(user, key)[-1]
                if task['path'] != path or task['recursive'] != recursive:
                    raise ValueError('Cleanup key belongs to another target')
                if task['state'] == 'SUCCEEDED' or not self.w.unit_stopped(self.unit(user, key)):
                    return self.public(task)
            else:
                self.plan(user, path, recursive)
                self.w.writable(args)
                self.w.no_terminals(user)
                lock = self.w.lifetime(user, exclusive=True)
                try:
                    _, info = self.target(module, owner, path)
                    task = {'key': key, 'userId': user, 'path': path, 'recursive': recursive,
                            'identity': [info.st_dev, info.st_ino], 'state': 'QUEUED', 'phase': 'WAITING',
                            'files': 0, 'logicalBytes': 0, 'createdAt': time.time()}
                    module._write_json(record, task)
                finally:os.close(lock)
            try:
                self.n.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+self.unit(user, key),
                    '--property=KillMode=control-group', '--property=UMask=0077', '--property=CPUQuota=100%',
                    '--property=MemoryMax=512M', '--property=IOWeight=10', '--property=RuntimeMaxSec=14400',
                    '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--workspace-cleanup-worker', user, key], timeout=8)
            except (OSError, ValueError, subprocess.SubprocessError):
                return {**self.public(task), 'launchUnconfirmed': True}
            return self.public(task)

    def scan(self, target, device):
        files = size = 0
        pending = [target]
        # lstat only: no file contents are loaded and links are never followed.
        while pending:
            path = pending.pop();info = path.lstat()
            if info.st_dev != device or info.st_uid != os.geteuid():
                raise ValueError('Cleanup tree crosses a filesystem or ownership boundary')
            if stat.S_ISDIR(info.st_mode):
                if os.path.ismount(path):raise ValueError('Cleanup cannot remove a mounted directory')
                pending.extend(path.iterdir())
            elif stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
                files += 1;size += info.st_size
            else:raise ValueError('Cleanup tree contains unsupported special files')
        return files, size

    def worker(self, user, key):
        module, _, record, _ = self.location(user, key)
        with module._directory(record.parent) as parent:
            fd = os.open(key+'.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            module._regular(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return self._worker(user, key)
        finally:os.close(fd)

    def _worker(self, user, key):
        module, owner, record, payload, task = self.load(user, key)
        if task['state'] == 'SUCCEEDED':return 0
        args = {'userId': user}
        try:
            with self.w.guard(args, blocking=True):
                self.w.writable(args)
                self.w.no_terminals(user)
                lock = self.w.lifetime(user, exclusive=True)
                try:
                    if payload.exists():
                        info = payload.lstat()
                        if [info.st_dev, info.st_ino] != task['identity']:
                            raise ValueError('Original cleanup payload identity changed')
                    elif task.get('phase') == 'DELETING':
                        # An interrupted final receipt never adopts a new object
                        # that was created at the original path in the meantime.
                        module._write_json(record, {**task, 'state': 'SUCCEEDED', 'phase': 'COMPLETE', 'completedAt': time.time()});return 0
                    else:
                        target, info = self.target(module, owner, task['path'])
                        if [info.st_dev, info.st_ino] != task['identity']:
                            raise ValueError('Original cleanup target changed; no replacement was removed')
                        task.update(state='RUNNING', phase='SCANNING');task.pop('error', None)
                        module._write_json(record, task)
                        task['files'], task['logicalBytes'] = self.scan(target, info.st_dev)
                        task['phase'] = 'CLAIMING';module._write_json(record, task)
                        os.rename(target, payload)
                        with module._directory(target.parent) as fd:os.fsync(fd)
                        with module._directory(payload.parent) as fd:os.fsync(fd)
                    task.update(state='RUNNING', phase='DELETING');task.pop('error', None)
                    module._write_json(record, task)
                finally:os.close(lock)
            if payload.is_dir():shutil.rmtree(payload)
            else:payload.unlink()
            module._write_json(record, {**task, 'state': 'SUCCEEDED', 'phase': 'COMPLETE', 'completedAt': time.time()})
            return 0
        except Exception as error:
            detail = str(error) if isinstance(error, ValueError) else type(error).__name__+(' errno='+str(error.errno) if isinstance(error, OSError) else '')
            task.update(state='FAILED', error=detail[:400])
            module._write_json(record, task)
            return 1

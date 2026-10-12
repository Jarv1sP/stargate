"""Resumable personal files on the destination disk; no dataset publication."""
import base64
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import uuid


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name+'.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def save(path, value):
    pending = path.with_name('.'+uuid.uuid4().hex)
    with open(pending, 'x') as stream:
        os.chmod(pending, 0o600)
        json.dump(value, stream)
        stream.flush(); os.fsync(stream.fileno())
    os.replace(pending, path)


def relative(path):
    if (not isinstance(path, str) or not path or len(path.encode()) > 1024
            or re.search(r'[\\\x00-\x1f\x7f]', path)
            or any(p in ('', '.', '..') or len(p.encode()) > 255 for p in path.split('/'))):
        raise ValueError('Use a relative personal data file path')
    return path


@contextmanager
def parent(root, path, create=False):
    fd = module('local-data').open_directory(root)
    try:
        for part in relative(path).split('/')[:-1]:
            if create:
                try: os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError: pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        yield fd
    finally:
        os.close(fd)


def stamp(info):
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        raise ValueError('Upload destination must be a regular file')
    return [info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns]


def target(root, path):
    try:
        with parent(root, path) as fd:
            return stamp(os.stat(Path(path).name, dir_fd=fd, follow_symlinks=False))
    except FileNotFoundError:
        return None


def unit(user, key):
    return 'gpuq-file-verify-'+hashlib.sha256((user+'\0'+key).encode()).hexdigest()[:32]+'.service'


def active(user, key):
    result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit(user, key),
        '--property=ActiveState,MainPID'], capture_output=True, text=True, check=True, timeout=10)
    state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if set(state) != {'ActiveState', 'MainPID'}:
        raise ValueError('Upload verification state is unconfirmed')
    return state['ActiveState'] not in ('inactive', 'failed') or state['MainPID'] != '0'


class Uploads:
    def __init__(self, config, user, *, root=None, config_path=None):
        self.config, self.user = config, user
        self.config_path = config_path or Path(__file__).with_name('node-config.json')
        self.root = Path(root) if root is not None else module('local-data').personal_directory(config, user)
        self.folder = self.root.parent/'uploads'
        self.folder.mkdir(mode=0o700, exist_ok=True)
        fd = module('local-data').open_directory(self.folder); os.close(fd)

    def record(self, key):
        if not isinstance(key, str) or str(uuid.UUID(key)) != key:
            raise ValueError('Upload requires its original UUID')
        return self.folder/(key+'.json')

    def read(self, key):
        return json.loads(self.record(key).read_text())

    def part(self, row):
        return self.folder/(row['key']+'.part')

    def view(self, row):
        state = row['state']
        if (row.get('targetStamp') and not self.part(row).exists()
                and target(self.root, row['path']) == row['targetStamp']):
            state = 'COMPLETE'  # Rename finished before its last reply/record.
        if state == 'COMPLETE' and target(self.root, row['path']) != row['targetStamp']:
            state = 'CONFLICT'
        size = row['totalSize'] if state == 'COMPLETE' else self.part(row).stat().st_size if self.part(row).exists() else 0
        return {k: row[k] for k in ('key', 'path', 'totalSize', 'sha256')} | {'state': state, 'receivedBytes': size}

    def process(self, action, args):
        fields = {'status': {'path'}, 'begin': {'path', 'key', 'totalSize', 'sha256', 'overwrite'},
                  'chunk': {'key', 'offset', 'data'}, 'finish': {'key'}}
        by_key = action == 'status' and set(args) == {'key'}
        if action not in fields or not by_key and set(args) != fields[action]:
            raise ValueError('Invalid personal upload request')
        with open(self.folder/'metadata.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if by_key:
                return self.view(self.read(args['key']))
            if action in ('status', 'begin'):
                path = relative(args['path'])
                pointer = self.folder/(hashlib.sha256(path.encode()).hexdigest()+'.current')
                previous = self.read(pointer.read_text()) if pointer.exists() else None
                if action == 'status':
                    return self.view(previous) if previous else {'state': 'ABSENT', 'path': path, 'receivedBytes': 0}
                self.record(args['key'])
                if (type(args['totalSize']) is not int or not 0 <= args['totalSize'] <= 2**53-1
                        or not re.fullmatch('[a-f0-9]{64}', args['sha256'] or '') or type(args['overwrite']) is not bool):
                    raise ValueError('Invalid upload length or checksum')
                if self.record(args['key']).exists():
                    row = self.read(args['key'])
                    if any(row[k] != args[k] for k in fields['begin']):
                        raise ValueError('Upload UUID belongs to different content')
                    return self.view(row)
                if previous and self.view(previous)['state'] not in ('COMPLETE', 'FAILED', 'CONFLICT'):
                    raise ValueError('Resume the original upload; a new UUID cannot replace it')
                before = target(self.root, path)
                if before is not None and not args['overwrite']:
                    raise ValueError('Destination exists; choose overwrite explicitly')
                row = dict(args, state='UPLOADING', baseTarget=before)
                self.part(row).touch(mode=0o600, exist_ok=False)
                save(self.record(row['key']), row)
                temporary = pointer.with_name('.'+uuid.uuid4().hex)
                temporary.write_text(row['key']); os.replace(temporary, pointer)
                return self.view(row)
            row = self.read(args['key'])
            if action == 'chunk':
                if row['state'] != 'UPLOADING':
                    raise ValueError('Upload is not accepting more chunks; query its status')
                offset = args['offset']; data = base64.b64decode(args['data'], validate=True)
                if type(offset) is not int or offset < 0 or len(data) > 1024**2 or offset+len(data) > row['totalSize']:
                    raise ValueError('Invalid upload chunk')
                fd = os.open(self.part(row), os.O_RDWR | os.O_NOFOLLOW)
                try:
                    size = os.fstat(fd).st_size
                    if offset < size:
                        if os.pread(fd, len(data), offset) != data:
                            raise ValueError('Upload offset/content mismatch; original bytes retained')
                    elif offset == size:
                        module('local-data').require_write_space(len(data), target_fd=fd)
                        os.lseek(fd, offset, 0)
                        view = memoryview(data)
                        while view: view = view[os.write(fd, view):]
                        os.fsync(fd)
                    else:
                        raise ValueError('Upload offset mismatch; query the original upload')
                finally:
                    os.close(fd)
                return self.view(row)
            if self.view(row)['state'] == 'COMPLETE':
                return self.view(row)
            if active(self.user, row['key']):
                return self.view(row)
            if self.part(row).stat().st_size != row['totalSize']:
                raise ValueError('Upload is incomplete')
            row['state'] = 'VERIFYING'; save(self.record(row['key']), row)
            subprocess.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+unit(self.user, row['key']),
                '--property=KillMode=control-group', sys.executable, str(Path(__file__).resolve()),
                str(self.config_path), self.user, row['key'], str(self.root)],
                capture_output=True, check=True, timeout=15)
            return self.view(row)

    def verify(self, key):
        row = self.read(key)
        try:
            digest = hashlib.sha256()
            with self.part(row).open('rb') as stream:
                while chunk := stream.read(4*1024**2): digest.update(chunk)
                verified = stamp(os.fstat(stream.fileno()))
            if verified[2] != row['totalSize'] or digest.hexdigest() != row['sha256']:
                raise ValueError('Upload checksum mismatch')
            with open(self.folder/'metadata.lock', 'a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if target(self.root, row['path']) != row['baseTarget']:
                    raise ValueError('Destination changed during upload; nothing was overwritten')
                row.update(state='COMMITTING', targetStamp=verified); save(self.record(key), row)
                with parent(self.root, row['path'], create=True) as fd:
                    os.replace(self.part(row), Path(row['path']).name, dst_dir_fd=fd); os.fsync(fd)
                row['state'] = 'COMPLETE'; save(self.record(key), row)
        except Exception:
            # The original handle and staged bytes remain for inspection.
            row['state'] = 'FAILED'; save(self.record(key), row)
            raise


def dispatch(config, operation, args, *, root=None, config_path=None):
    args = dict(args); user = args.pop('userId')
    return Uploads(config, user, root=root, config_path=config_path).process(operation.removeprefix('data.upload.'), args)


if __name__ == '__main__':
    config = json.loads(Path(sys.argv[1]).read_text())
    Uploads(config, sys.argv[2], root=sys.argv[4], config_path=sys.argv[1]).verify(sys.argv[3])

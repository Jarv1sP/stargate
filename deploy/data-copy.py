"""Explicit, resumable node-to-node directory copies using rsync over SSH.

Peer keys are deployment-owned, read-only rrsync keys restricted to the named
source root. Clients supply neither host paths nor SSH credentials. Transfers
never publish a dataset, reserve GPUs, delete source files or delete extras.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
import uuid


def local_data():
    spec = importlib.util.spec_from_file_location('copy_local_data', Path(__file__).with_name('local-data.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def relative(value):
    if (not isinstance(value, str) or not value or len(value) > 1024
            or any(ord(c) < 32 for c in value) or '\\' in value
            or any(p in ('', '.', '..') for p in value.split('/'))):
        raise ValueError('Use a relative directory path')
    return value


def record_path(config, user, key, *, create=False):
    if not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', user or '') or str(uuid.UUID(key)) != key:
        raise ValueError('Invalid data copy identity')
    folder = Path(config['root'])/'data-copies'/hashlib.sha256(user.encode()).hexdigest()
    if create:
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    return folder/(key+'.json')


def save(path, row):
    temporary = path.with_name('.'+uuid.uuid4().hex)
    with open(temporary, 'x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(row, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def unit(user, key):
    return 'gpuq-data-copy-'+hashlib.sha256((user+'\0'+key).encode()).hexdigest()[:32]+'.service'


def running(user, key):
    result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit(user, key),
        '--property=ActiveState,MainPID'], capture_output=True, text=True, timeout=10, check=True)
    state = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    if set(state) != {'ActiveState', 'MainPID'}:
        raise ValueError('Copy worker status is unconfirmed')
    return state['ActiveState'] not in ('inactive', 'failed') or state['MainPID'] != '0'


def public(row):
    return {key: value for key, value in row.items() if key not in ('userId', 'peer')}


def status(row):
    result = public(row)
    if row['state'] == 'RUNNING' and not running(row['userId'], row['key']):
        result['state'] = 'UNKNOWN'
    return result


def peer(config, source, scope, user):
    value = config['dataTransferPeers'][source][scope]
    if set(value) != {'host', 'user', 'port', 'identityFile', 'knownHostsFile'}:
        raise ValueError('Configure a restricted read-only rsync peer')
    if (not re.fullmatch(r'[A-Za-z0-9._-]+', value['host'])
            or not re.fullmatch(r'[a-z_][a-z0-9_-]*', value['user'])
            or type(value['port']) is not int or not 1 <= value['port'] <= 65535):
        raise ValueError('Invalid configured rsync endpoint')
    for name in ('identityFile', 'knownHostsFile'):
        if not isinstance(value[name], str) or not value[name].startswith('/') or '\0' in value[name]:
            raise ValueError('Rsync credentials must be deployment-owned files')
    return value


def dispatch(config, operation, args, *, config_path=None):
    action = operation.removeprefix('data.copy.')
    fields = {'start': {'from', 'scope', 'path', 'destination'}, 'status': set(), 'resume': set(), 'cancel': set()}
    if action not in fields or set(args) != {'userId', 'key'} | fields[action]:
        raise ValueError('Invalid data copy request')
    user, key = args['userId'], args['key']
    path = record_path(config, user, key, create=action == 'start')
    if action != 'start' and not path.exists():
        if action == 'status':
            return {'key': key, 'state': 'ABSENT'}
        raise ValueError('Copy ID has not been created for this account')
    with open(path.with_suffix('.lock'), 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if action == 'start':
            request = {k: args[k] for k in ('from', 'scope', 'path', 'destination')}
            relative(request['path']); relative(request['destination'])
            configured = peer(config, request['from'], request['scope'], user)
            if path.exists():
                row = json.loads(path.read_text())
                if any(row[k] != v for k, v in request.items()):
                    raise ValueError('Copy key already belongs to another request')
                return status(row)
            row = {**request, 'key': key, 'userId': user, 'peer': configured,
                   'state': 'PENDING', 'createdAt': time.time()}
            save(path, row)
        else:
            row = json.loads(path.read_text())
        if action == 'status':
            return status(row)
        if action == 'cancel':
            subprocess.run(['/usr/bin/systemctl', '--user', 'stop', unit(user, key)], check=True, timeout=15)
            if running(user, key):
                raise ValueError('Copy stop is unconfirmed')
            # A concurrently completed copy keeps its completed receipt.
            row = json.loads(path.read_text())
            if row['state'] != 'SUCCEEDED':
                row['state'] = 'PAUSED'; save(path, row)
            return public(row)
        if action == 'resume':
            if running(user, key):
                raise ValueError('Copy worker is still active')
            row = json.loads(path.read_text())
            if row['state'] == 'SUCCEEDED':
                return public(row)
            if row['peer'] != peer(config, row['from'], row['scope'], user):
                raise ValueError('Copy source endpoint changed')
        row.update(state='RUNNING', updatedAt=time.time())
        row.pop('exitCode', None)
        save(path, row)
        subprocess.run(['/usr/bin/systemd-run', '--user', '--collect', '--unit='+unit(user, key),
            '--property=KillMode=control-group', sys.executable, str(Path(__file__).resolve()),
            str(config_path or Path(__file__).with_name('node-config.json')), user, key],
            check=True, timeout=15, capture_output=True)
        return public(row)


def copy_command(row, target_fd, partial):
    value = row['peer']
    transport = shlex.join(['/usr/bin/ssh', '-T', '-oBatchMode=yes', '-oIdentitiesOnly=yes',
        '-oStrictHostKeyChecking=yes', '-oForwardAgent=no', '-oClearAllForwardings=yes',
        '-oUserKnownHostsFile='+value['knownHostsFile'], '-i', value['identityFile'], '-p', str(value['port'])])
    source = row['path']
    if row['scope'] == 'mine':
        source = hashlib.sha256(row['userId'].encode()).hexdigest()+'/'+source
    # rrsync must see the path arguments; secluded/protect-args is rejected by
    # its forced-command validator. rsync's normal shell escaping is retained.
    return ['/usr/bin/rsync', '-rlt', '--checksum', '--partial',
        '--partial-dir='+str(partial), '-e', transport, '--',
        value['user']+'@'+value['host']+':'+source+'/', '/proc/self/fd/'+str(target_fd)+'/']


def worker(config, user, key):
    path = record_path(config, user, key)
    row = json.loads(path.read_text())
    data = local_data()
    with open(path.parent/'writer.lock', 'a') as lock:
        # One transfer per target account at a time; never interleave writers.
        fcntl.flock(lock, fcntl.LOCK_EX)
        fd = data.open_directory(data.personal_directory(config, user))
        try:
            for part in relative(row['destination']).split('/'):
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd); fd = child
            partial = path.parent/(key+'.partial')
            partial.mkdir(mode=0o700, exist_ok=True)
            result = subprocess.run(copy_command(row, fd, partial), pass_fds=(fd,))
            row.update(state='SUCCEEDED' if result.returncode == 0 else 'FAILED', exitCode=result.returncode,
                       updatedAt=time.time())
        except Exception:
            row.update(state='FAILED', updatedAt=time.time())
            save(path, row)
            raise
        finally:
            os.close(fd)
        save(path, row)
        return row['state'] == 'SUCCEEDED'


if __name__ == '__main__':
    config = json.loads(Path(sys.argv[1]).read_text())
    raise SystemExit(0 if worker(config, *sys.argv[2:]) else 1)

#!/usr/bin/env python3
"""Install a node package locally. SSH and package transport belong to the caller.

The JSON config is administrator-owned input, never an RPC request. Each release
keeps its own real pyz/config paths: restarting the daemon leaves job units and
their lazily imported SDK files alone. No user data or database is rolled back.
"""
import argparse
import base64
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import shlex
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
import uuid


def sync_directory(path):
    fd = os.open(path, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data, mode=0o600, owner=None):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.install-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            if owner is not None:
                os.fchown(stream.fileno(), *owner)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        sync_directory(path.parent)
    finally:
        Path(temporary).unlink(missing_ok=True)


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def data_path(path, mounts):
    """Use the same real mount + root-device boundary as node/local-data.py."""
    target = Path(path).resolve()
    existing = target
    while not existing.exists():
        existing = existing.parent
    candidates = []
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        raw = line.split(' - ', 1)[0].split()[4]
        mount = Path(re.sub(r'\\([0-7]{3})', lambda m: chr(int(m[1], 8)), raw))
        if mount == existing or mount in existing.parents:
            candidates.append(mount)
    mount = max(candidates, key=lambda p: len(p.parts))
    if mount not in [Path(p).resolve(strict=True) for p in mounts] or existing.stat().st_dev == Path('/').stat().st_dev:
        raise ValueError('安装和数据目录必须位于配置的数据盘，不能使用系统盘。')
    if shutil.disk_usage(existing).free < 64 * 1024**3:
        raise ValueError('数据盘可用空间不足 64GiB，请先释放空间。')
    return target


def unpack(package, destination):
    """Accept a build-node-release directory or a single-node tar archive."""
    if package.is_dir():
        for source in package.rglob('*'):
            target = destination / source.relative_to(package)
            info = source.lstat()
            if stat.S_ISDIR(info.st_mode):
                target.mkdir(parents=True, exist_ok=True)
            elif stat.S_ISREG(info.st_mode):
                atomic(target, source.read_bytes(), stat.S_IMODE(info.st_mode))
            else:
                raise ValueError('节点包只接受普通文件和目录，不能包含链接。')
    else:
        with tarfile.open(package) as archive:
            members = archive.getmembers()
            manifest = next(PurePosixPath(m.name) for m in members if PurePosixPath(m.name).name == 'manifest.json')
            prefix = manifest.parent
            for member in members:
                path = PurePosixPath(member.name)
                if path.is_absolute() or '..' in path.parts or not (member.isdir() or member.isfile()):
                    raise ValueError('节点包路径不能越出发布目录或包含链接。')
                if path == prefix or path in prefix.parents:
                    continue
                relative = path.relative_to(prefix)
                target = destination / str(relative)
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    with archive.extractfile(member) as source:
                        atomic(target, source.read(), member.mode)


class Installer:
    system_units = Path('/etc/systemd/system')
    policy = Path('/etc/containers/policy.json')
    health_attempts = 30
    health_delay = 1

    def __init__(self, config):
        self.config = config
        self.account = pwd.getpwnam(config['account'])
        self.owner = (self.account.pw_uid, self.account.pw_gid)
        self.home = Path(self.account.pw_dir)
        self.root = Path(config['releaseRoot']).resolve()
        self.current = self.root / 'current'
        self.environment = {'HOME': str(self.home), 'PATH': '/usr/bin:/bin',
                            'XDG_RUNTIME_DIR': f'/run/user/{self.owner[0]}',
                            'DBUS_SESSION_BUS_ADDRESS': f'unix:path=/run/user/{self.owner[0]}/bus',
                            **config.get('environment', {})}

    def run(self, argv, *, user=False, check=True, timeout=90):
        if user:
            argv = ['/usr/sbin/runuser', '-u', self.account.pw_name, '--', '/usr/bin/env',
                    *[f'{k}={v}' for k, v in self.environment.items()], *map(str, argv)]
        try:
            result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            if not check:
                return subprocess.CompletedProcess(argv, 124, '', '等待超时')
            raise RuntimeError('节点安装命令等待超时，请在节点查看服务日志后重试。') from None
        if check and result.returncode:
            # argv may contain private proxy credentials. Do not send those
            # back to the release caller as part of CalledProcessError text.
            raise RuntimeError(f'节点安装命令未完成（返回码 {result.returncode}），请在节点查看服务日志后重试。')
        return result

    def systemctl(self, scope, *args, check=True):
        return self.run(['/usr/bin/systemctl', *(['--user'] if scope == 'user' else []), *args],
                        user=scope == 'user', check=check)

    def directory(self, path, owner=None, mode=0o700):
        path = Path(path)
        missing = []
        cursor = path
        while not cursor.exists():
            missing.append(cursor)
            cursor = cursor.parent
        for item in reversed(missing):
            item.mkdir(mode=mode)
            item.chmod(mode)
            os.chown(item, *(self.owner if owner is None else owner))

    def select(self, target):
        if target is None:
            self.current.unlink(missing_ok=True)
        else:
            temporary = self.root / ('.current-' + uuid.uuid4().hex)
            try:
                temporary.symlink_to(target)
                os.replace(temporary, self.current)
            finally:
                temporary.unlink(missing_ok=True)
        sync_directory(self.root)

    def stage(self, package):
        mounts = self.config['dataMountPoints']
        for profile in self.config['profiles'].values():
            for field in ('root', 'workspacesRoot', 'datasetsRoot'):
                self.directory(data_path(profile[field], mounts))
        self.directory(data_path(self.root, mounts))
        for field in ('root', 'log_dir', 'control_dir'):
            self.directory(data_path(self.config['gpuq'][field], mounts))
        self.directory(data_path(Path(self.config['gpuq']['db_path']).parent, mounts))
        release = self.root / ('release-' + uuid.uuid4().hex)
        staging = self.root / ('.stage-' + uuid.uuid4().hex)
        staging.mkdir(mode=0o700)
        try:
            unpack(Path(package), staging)
            manifest = json.loads((staging / 'manifest.json').read_text())
            scheduler = {**self.config['gpuq'], 'allowed_uid': self.owner[0],
                         'archive_path': str(release / 'gpuq.pyz')}
            atomic(staging / 'gpuq-config.json', encoded(scheduler))
            gpu = release / 'gpu'
            atomic(staging / 'gpu', ('#!/bin/sh\nexec ' + shlex.join([
                '/usr/bin/python3', '-I', '-B', scheduler['archive_path'], '--config',
                str(release / 'gpuq-config.json')]) + ' "$@"\n').encode(), 0o700)
            for name, config in self.config['profiles'].items():
                # Derived release bindings, not user data paths or resource values.
                value = {**config, 'gpu': str(gpu), 'gpuqArchive': scheduler['archive_path'],
                         'database': scheduler['db_path'], 'controlRoot': scheduler['control_dir'],
                         'dataMountPoints': mounts}
                atomic(staging / manifest['profiles'][name]['installedConfig'], encoded(value))
            if self.config.get('hamiLibrary'):
                source = data_path(self.config['hamiLibrary'], mounts)
                atomic(staging / 'hami/libvgpu.so', source.read_bytes(), 0o444)
            for path in [staging, *staging.rglob('*')]:
                os.chown(path, *self.owner)
                if path.is_dir():
                    path.chmod(0o700)
            os.replace(staging, release)
            sync_directory(self.root)
            return release, manifest
        finally:
            if staging.exists():
                shutil.rmtree(staging)

    @staticmethod
    def unit_word(value):
        return json.dumps(str(value)).replace('%', '%%').replace('$', '$$')

    def bindings(self, manifest):
        delegation = self.system_units / f'user@{self.owner[0]}.service.d/50-stargate-cpuset.conf'
        files = {str(delegation): (b'[Service]\nDelegate=cpu cpuset io memory pids\n', 0o644, (0, 0))}
        unit_dir = self.home / '.config/systemd/user'
        gpu_spec = {**self.config.get('gpuqService', {}), 'gpuq': True}
        specs = [{**gpu_spec, 'name': gpu_spec.get('name', 'gpuq.service'), 'scope': 'user'},
                 *self.config.get('services', [])]
        units = []
        for spec in specs:
            scope, name = spec.get('scope', 'user'), spec['name']
            owner = self.owner if scope == 'user' else (0, 0)
            directory = unit_dir if scope == 'user' else self.system_units
            seconds = spec.get('seconds')
            command = [str(self.current / 'gpu'), 'daemon'] if spec.get('gpuq') else [
                str(arg).replace('{release}', str(self.current))
                for arg in manifest['profiles'][spec['profile']]['serviceCommands'][0]]
            service = '[Service]\n'
            if scope == 'system':
                service += 'User=' + self.account.pw_name + '\n'
            if seconds:
                service += 'Type=oneshot\n'
            else:
                service += 'Restart=on-failure\nRestartSec=2\n'
            for key, value in self.environment.items():
                service += 'Environment=' + json.dumps(f'{key}={value}').replace('%', '%%') + '\n'
            service += 'ExecStart=\nExecStart=' + ' '.join(map(self.unit_word, command)) + '\nUMask=0077\n'
            if spec.get('gpuq'):
                # This setting takes one path, including spaces, not an argv word.
                service += ('WorkingDirectory=' + str(self.config['gpuq']['root']).replace('%', '%%') +
                            '\nRuntimeDirectory=gpuq\nRuntimeDirectoryMode=0700\n')
            body = '[Unit]\nDescription=STARGATE node runtime\n' + service
            body += '[Install]\nWantedBy=' + ('default.target' if scope == 'user' else 'multi-user.target') + '\n'
            files[str(directory / name)] = (body.encode(), 0o644, owner)
            # When a current installation uses an ExecStart drop-in, update that
            # installer-provided binding too; no historical command comparison.
            if spec.get('dropin'):
                files[spec['dropin']] = (service.encode(), 0o644, owner)
            target = name
            if seconds:
                target = name.removesuffix('.service') + '.timer'
                timer = f'[Timer]\nOnBootSec=15\nOnUnitActiveSec={seconds}\nUnit={name}\n[Install]\nWantedBy=timers.target\n'
                files[str(directory / target)] = (timer.encode(), 0o644, owner)
            units.append(dict(scope=scope, name=target, service=name if seconds else None))
        gpu_command = Path(self.config.get('gpuCommand', self.home / 'bin/gpu'))
        files[str(gpu_command)] = (('#!/bin/sh\nexec ' + shlex.quote(str(self.current / 'gpu')) + ' "$@"\n').encode(), 0o700, self.owner)
        if 'authorizedKeys' in self.config:
            path = self.home / '.ssh/authorized_keys'
            text = path.read_text() if path.exists() else ''
            keys = self.config['authorizedKeys']
            identities = [' '.join(entry['publicKey'].split()[:2]) for entry in keys]
            lines, inside = [], False
            for line in text.splitlines():
                if line == '# BEGIN STARGATE':
                    inside = True
                elif line == '# END STARGATE':
                    inside = False
                elif not inside and not any(key in line for key in identities):
                    lines.append(line)
            lines.append('# BEGIN STARGATE')
            for entry in keys:
                profile = entry['profile']
                env = ['/usr/bin/env', *[f'{k}={v}' for k, v in self.environment.items()]]
                if entry.get('collector'):
                    command = [*env, 'STARGATE_CORE_PROFILE=' + profile, '/usr/bin/python3', '-I', '-B',
                               str(self.current / 'node/node-probe.py')]
                else:
                    command = [*env, *[arg.replace('{release}', str(self.current))
                                       for arg in manifest['profiles'][profile]['entryCommand']]]
                forced = shlex.join(command).replace('\\', '\\\\').replace('"', '\\"')
                lines.append('restrict,command="' + forced + '" ' + entry['publicKey'].strip())
            files[str(path)] = (('\n'.join([*lines, '# END STARGATE']) + '\n').encode(), 0o600, self.owner)
        if not self.policy.exists():
            files[str(self.policy)] = (b'{"default":[{"type":"insecureAcceptAnything"}]}\n', 0o644, (0, 0))
        return files, units

    def capture(self, files, units):
        saved = []
        for name in files:
            path = Path(name)
            if path.exists():
                info = path.stat()
                saved.append(dict(path=name, data=base64.b64encode(path.read_bytes()).decode(),
                                  mode=stat.S_IMODE(info.st_mode), uid=info.st_uid, gid=info.st_gid))
            else:
                saved.append(dict(path=name, data=None))
        states = []
        for unit in units:
            scope, name = unit['scope'], unit['name']
            states.append(dict(**unit, active=self.systemctl(scope, 'is-active', '--quiet', name, check=False).returncode == 0,
                               enabled=self.systemctl(scope, 'is-enabled', '--quiet', name, check=False).returncode == 0))
        return dict(previous=os.readlink(self.current) if self.current.is_symlink() else None, files=saved, units=states)

    def reload(self, units):
        for scope in sorted({'system', *[u['scope'] for u in units]}):
            self.systemctl(scope, 'daemon-reload')

    def stop(self, units):
        for unit in reversed(units):
            for name in filter(None, (unit['name'], unit.get('service'))):
                stopped = self.systemctl(unit['scope'], 'stop', name, check=False)
                if stopped.returncode:
                    loaded = self.systemctl(unit['scope'], 'show', '--property=LoadState', '--value', name, check=False)
                    if loaded.stdout.strip() not in ('not-found', 'bad-setting', 'error'):
                        raise RuntimeError('节点服务未停止，未继续切换；请在节点查看服务日志。')

    def healthy(self, units):
        for attempt in range(self.health_attempts):
            active = all(self.systemctl(u['scope'], 'is-active', '--quiet', u['name'], check=False).returncode == 0 for u in units)
            gpu = self.run(['/usr/bin/nvidia-smi', '--query-gpu=uuid', '--format=csv,noheader'], user=True,
                           check=False, timeout=self.config['gpuq'].get('nvidia_timeout_seconds', 5))
            if active and gpu.returncode == 0 and gpu.stdout.strip():
                return
            if attempt + 1 < self.health_attempts:
                time.sleep(self.health_delay)
        raise RuntimeError('节点服务未启动或读不到 GPU，已停止切换；请查看服务日志后重试。')

    def restore(self, record):
        try:
            self.stop(record['units'])
        except Exception:
            # Repair files and the selector even if the broken unit cannot stop.
            pass
        for item in reversed(record['files']):
            if item['data'] is None:
                Path(item['path']).unlink(missing_ok=True)
            else:
                atomic(item['path'], base64.b64decode(item['data']), item['mode'], (item['uid'], item['gid']))
        self.select(record['previous'])
        self.reload(record['units'])
        active = []
        for unit in record['units']:
            self.systemctl(unit['scope'], 'enable' if unit['enabled'] else 'disable', unit['name'], check=unit['enabled'])
            if unit['active']:
                # Restart also replaces a new process left alive by a failed stop.
                self.systemctl(unit['scope'], 'restart', unit['name'])
                active.append(unit)
        if active:
            self.healthy(active)

    def install(self, package):
        release, manifest = self.stage(package)
        files, units = self.bindings(manifest)
        self.run(['/usr/bin/loginctl', 'enable-linger', self.account.pw_name])
        self.run(['/usr/bin/systemctl', 'start', f'user@{self.owner[0]}.service'])
        record = self.capture(files, units)
        atomic(release / 'rollback.json', encoded(record))
        try:
            self.stop(units)
            for name, (data, mode, owner) in files.items():
                self.directory(Path(name).parent, owner=owner, mode=0o755 if owner == (0, 0) else 0o700)
                atomic(name, data, mode, owner)
            self.select(str(release))
            self.reload(units)
            if not Path(self.config['gpuq']['db_path']).exists():
                self.run([str(release / 'gpu'), '_init'], user=True)
            for unit in units:
                self.systemctl(unit['scope'], 'enable', unit['name'])
                self.systemctl(unit['scope'], 'start', unit['name'])
            self.healthy(units)
        except BaseException:
            self.restore(record)
            raise
        return dict(state='INSTALLED', release=str(release))

    def rollback(self):
        record = json.loads((self.current.resolve(strict=True) / 'rollback.json').read_text())
        if record['previous'] is None:
            raise ValueError('没有上一版发布目录，当前版本未改变。')
        self.restore(record)
        return dict(state='ROLLED_BACK', release=str(self.current.resolve()))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('package', nargs='?', type=Path)
    parser.add_argument('--config', required=True, type=Path, help='Node-local administrator JSON; never commit it')
    parser.add_argument('--rollback', action='store_true')
    args = parser.parse_args()
    if not args.rollback and args.package is None:
        parser.error('安装时需要节点包路径')
    os.umask(0o077)
    installer = Installer(json.loads(args.config.read_text()))
    data_path(installer.root, installer.config['dataMountPoints'])
    installer.directory(installer.root)
    with (installer.root / '.install.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result = installer.rollback() if args.rollback else installer.install(args.package)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()

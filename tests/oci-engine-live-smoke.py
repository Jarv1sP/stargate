"""Opt-in CPU-only OCI smoke in a fresh private graph and transient test unit.

This is not platform admission: owner provisioning and GPU assignment are test
fixtures. Podman/crun, the task cgroup, mounts, environment and exits are real.
Never use an existing user graph. Preparation imports only a tiny local shell
image; no registry, production project, GPU or GPUQ queue is touched.
"""
import argparse
from contextlib import contextmanager, ExitStack
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
from types import SimpleNamespace
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True


def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


E = load('live_oci_engine', 'src/infrastructure/oci-training-engine.py')
R = load('live_oci_resources', 'deploy/job-resources.py')


class TestOwner:
    def __init__(self, folder):
        self.folder = folder
        self.owner = hashlib.sha256(b'isolated-oci-smoke').hexdigest()
        self.env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(folder / 'home'),
            'XDG_RUNTIME_DIR': str(folder / 'runtime'), 'XDG_CONFIG_HOME': str(folder / 'home'),
            'TMPDIR': str(folder / 'tmp'), 'CONTAINERS_CONF': str(folder / 'containers.conf')}

    def command(self, *args):
        return ['/usr/bin/podman', '--root', str(self.folder / 'graph'), '--runroot', str(self.folder / 'run'),
            '--tmpdir', str(self.folder / 'tmp'), '--storage-driver=overlay', '--cgroup-manager=cgroupfs',
            '--runtime=/usr/bin/crun', '--hooks-dir=' + str(self.folder / 'hooks'),
            '--cdi-spec-dir=' + str(self.folder / 'cdi'), '--events-backend=file', *args]

    def run(self, *args):
        return subprocess.check_output(self.command(*args), env=self.env, text=True).strip()

    def prepare_runtime_directory(self):
        return self.folder / 'tmp'

    @contextmanager
    def registry_auth(self):
        yield self.env, None

    @contextmanager
    def named_mounts(self, mounts, control):
        assert not control
        sources = {}
        for descriptor, target, readonly in mounts:
            source = os.readlink('/proc/self/fd/' + str(descriptor))
            if source.startswith('/memfd:'):
                assert readonly and target == '/run/gpuq/resources.json'
                path = self.folder / 'budget.json'
                path.write_bytes(os.pread(descriptor, 65536, 0)); source = str(path)
            sources[descriptor] = source
        yield sources


def prepare(root):
    folder = root / 'isolated-state'
    folder.mkdir(mode=0o700)
    for name in ('home', 'runtime', 'tmp', 'hooks', 'cdi', 'code', 'output', 'job-home', 'control', 'data'):
        (folder / name).mkdir(mode=0o700)
    for relative in ('home/.config/containers', 'home/containers'):
        policy = folder / relative
        policy.mkdir(parents=True, mode=0o700)
        # containers/image's tarball transport has no per-file policy identity.
        # Only this private fixture imports local tarballs; registries stay rejected.
        (policy / 'policy.json').write_text(json.dumps({'default': [{'type': 'reject'}],
            'transports': {'tarball': {'': [{'type': 'insecureAcceptAnything'}]}}}))
    (folder / 'containers.conf').write_text('[containers]\nenv_host=false\nhttp_proxy=false\nvolumes=[]\ndevices=[]\n[engine]\nremote=false\n')
    image_root = folder / 'rootfs'
    image_root.mkdir()
    paths = ['/bin/sh', *re.findall(r'(/[A-Za-z0-9_./+-]+)', subprocess.check_output(['/usr/bin/ldd', '/bin/sh'], text=True))]
    for source in dict.fromkeys(paths):
        target = image_root / source.lstrip('/')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    for name in ('tmp', 'etc', 'run', 'workspace', 'outputs', 'home/gpuq'):
        (image_root / name).mkdir(parents=True, exist_ok=True)
    archive = folder / 'shell.tar'
    def root_owner(info):
        info.uid = info.gid = 0; info.uname = info.gname = 'root'; return info
    with tarfile.open(archive, 'w') as stream:
        stream.add(image_root, arcname='.', filter=root_owner)
    owner = TestOwner(folder)
    info = json.loads(owner.run('info', '--format=json'))
    assert info['host']['security']['rootless'] is True
    image = owner.run('import', '--change', 'ENV PATH=/bin:/usr/bin', str(archive))
    if not image.startswith('sha256:'):
        image = 'sha256:' + image
    assert re.fullmatch('sha256:[a-f0-9]{64}', image)
    (folder / 'image').write_text(image)
    (folder / 'code/input.txt').write_text('original-code')
    (folder / 'data/input.txt').write_text('original-data')
    print(json.dumps({'prepared': True, 'image': image}))


def run(root):
    group = next(line[3:] for line in Path('/proc/self/cgroup').read_text().splitlines() if line.startswith('0::'))
    assert Path(group).name.startswith('stargate-v2-oci-smoke-') and Path(group).name.endswith('.service')
    folder = root / 'isolated-state'
    owner = TestOwner(folder)
    image = (folder / 'image').read_text()
    identity = SimpleNamespace(account_id='isolated-oci-smoke', job_id=str(uuid.uuid4()), dispatch_id=str(uuid.uuid4()),
        attempt_id='A' + uuid.uuid4().hex, invocation_id=os.environ['INVOCATION_ID'], assignments=(),
        process=SimpleNamespace(control_group=group))
    bus_env = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()), 'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()),
               'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(os.getuid()) + '/bus'}
    def systemd(argv, **kwargs):
        return subprocess.run(argv, env=bus_env, **kwargs)
    engine = E.OciTrainingEngine(owners=lambda account: owner, devices=lambda *_: [], systemd=systemd)
    with ExitStack() as handles:
        def directory(path):
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW); handles.callback(os.close, fd); return fd
        descriptors = {'code': directory(folder / 'code'), 'home': directory(folder / 'job-home'), 'output': directory(folder / 'output')}
        budget = R.read_budget({'id': identity.job_id}, group, [], terminal=True)
        metadata = os.memfd_create('gpuq-resources'); handles.callback(os.close, metadata)
        os.write(metadata, json.dumps(budget).encode()); os.lseek(metadata, 0, 0)
        limits = {'budget': budget, 'environment': R.resource_environment(budget),
                  'metadataFd': metadata, 'cgroupFd': directory(R.cgroup_path(group))}
        resources = {'execution': identity, 'runtime': {'kind': 'oci', 'identity': image},
            'project': {'meta': {'project': 'smoke', 'release': 'a' * 64}}, 'descriptors': descriptors,
            'dataMounts': [(directory(folder / 'data'), '/datasets/source')], 'command': {'env': {}}}
        command = {'argv': ['/bin/sh', '-c', '''set -eu
IFS= read -r text < /datasets/source/input.txt || [ -n "$text" ]
[ "$text" = original-data ]
if (printf bad > /datasets/source/input.txt) 2>/dev/null; then exit 9; fi
if (printf bad > /workspace/input.txt) 2>/dev/null; then exit 10; fi
printf '%s' "$lowercase" > /outputs/result.txt
printf '%s' "$GPUQ_GPU_COUNT" > /outputs/gpus.txt
printf saved > /home/gpuq/state.txt
exit 23
'''], 'workingDirectory': '/workspace', 'environment': {'lowercase': 'one\ntwo', 'PYTHONPATH': '/opt/gpuq/sdk.pyz'},
            'mounts': [(directory(folder / 'control'), '/run/gpuq/control', False)]}
        approvals = []
        code = engine.run(resources=resources, command=command, budget=limits, authorize_start=lambda: approvals.append(True))
        assert code == 23 and approvals == [True], {'exitCode': code, 'approvals': approvals}
        identity.attempt_id = 'A' + uuid.uuid4().hex
        rejected = {**command, 'argv': ['/bin/sh', '-c', 'printf bad > /outputs/revoked-ran']}
        def deny():
            raise PermissionError('test revocation before start')
        try:
            engine.run(resources=resources, command=rejected, budget=limits, authorize_start=deny)
        except PermissionError:
            pass
        else:
            raise AssertionError('revoked create was started')
        assert not (folder / 'output/revoked-ran').exists()
        identity.attempt_id = 'A' + uuid.uuid4().hex
        running = folder / 'output' / ('running-' + identity.attempt_id)
        interrupted = {**command, 'argv': ['/bin/sh', '-c', 'printf ready > /outputs/' + running.name + '; while :; do :; done']}
        original_popen, clients, failures = subprocess.Popen, [], []
        def spawn(argv, **kwargs):
            process = original_popen(argv, **kwargs)
            if argv[0] == '/usr/bin/podman' and 'start' in argv and '--attach' in argv:
                clients.append(process)
            return process
        def interrupt():
            deadline = time.monotonic() + 15
            while not running.exists() and time.monotonic() < deadline:
                time.sleep(.02)
            if not running.exists() or len(clients) != 1:
                failures.append('payload/client was not observed')
            for process in clients:
                if process.poll() is None:
                    process.kill()  # Exact test attach client; the engine must stop its container.
        killer = threading.Thread(target=interrupt)
        with patch.object(E.subprocess, 'Popen', side_effect=spawn):
            killer.start()
            try:
                engine.run(resources=resources, command=interrupted, budget=limits, authorize_start=lambda: None)
            except E.OciExecutionError:
                pass
            else:
                raise AssertionError('lost attach client was treated as success')
            finally:
                killer.join(16)
        assert not killer.is_alive() and not failures, failures
    assert (folder / 'output/result.txt').read_text() == 'one\ntwo'
    assert (folder / 'output/gpus.txt').read_text() == '0'
    assert (folder / 'job-home/state.txt').read_text() == 'saved'
    assert json.loads(owner.run('ps', '--all', '--format=json')) == []
    print(json.dumps({'passed': True, 'exitCode': code, 'gpuCount': 0, 'cpuLimit': budget['cpuLimit'],
        'memoryLimitBytes': budget['memoryLimitBytes'], 'containersRemaining': 0,
        'revocationBeforeStart': True, 'lostAttachClientStopped': True}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True, type=Path)
    parser.add_argument('--prepare', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve(strict=True)
    assert root.name.startswith('stargate-v2-oci-') and os.getuid() != 0
    (prepare if args.prepare else run)(root)

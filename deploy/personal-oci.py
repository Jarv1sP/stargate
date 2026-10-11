#!/usr/bin/python3
"""Managed rootless OCI projects. No socket or arbitrary Podman flags in RPC.

Containers are root only inside a user namespace. Every owner has a private,
quota-checked graphroot. A stopped development container is committed BEFORE
replacement, so package installs survive terminal reconnects without a daemon
escaping the terminal's systemd cgroup. Training always uses an immutable image
ID and the scheduler's exact CDI GPU UUIDs; development has no devices.
"""
import contextlib
import hashlib
import importlib.util
import json
import os
import platform
from pathlib import Path
import re
import select
import stat
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
IMAGE = re.compile(r'sha256:[a-f0-9]{64}\Z')
BASE = re.compile(r'[a-z0-9][a-z0-9.:-]*/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}\Z')
GPU = re.compile(r'GPU-[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}\Z')
OWNER = re.compile(r'builtin-admin|demo-user-[0-9]+\Z')
HOOKS = Path('/etc/gpuq-console/empty-hooks')
CDI = Path('/etc/gpuq-console/cdi/gpuq-nvidia.json')
ENGINE = Path('/etc/gpuq-console/personal-oci.conf')
SIGNATURE_POLICY = Path('/etc/gpuq-console/personal-oci-policy.json')
REGISTRY_DROPINS = Path('/etc/containers/registries.conf.d')
RUNTIME = Path('/run/user')
BASE_SEEDS = Path('/etc/gpuq-console/base-seeds')
STDERR_LIMIT = 64 * 1024
ENGINE_RAW = (b'[containers]\nenv_host = false\nhttp_proxy = false\nvolumes = []\ndevices = []\n'
              b'[engine]\nremote = false\ncdi_spec_dirs = ["/etc/gpuq-console/cdi"]\n')
ANONYMOUS_AUTH_RAW = b'{"auths":{}}\n'
ANONYMOUS_REGISTRIES_RAW = (b'credential-helpers = ["containers-auth.json"]\n'
                            b'unqualified-search-registries = []\nshort-name-mode = "enforcing"\n')


def module(name):
    paths = {'storage-quota':'storage-quota.py','project-store':'project-store.py',
             'training-control':'training-control.py','job-resources':'job-resources.py',
             'oci-cohort':'oci-cohort.py'}
    spec = importlib.util.spec_from_file_location('gpuq_oci_'+name.replace('-', '_'), HERE/paths[name])
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def need(condition, message):
    if not condition:
        raise ValueError(message)


def immutable_image_id(value):
    """Canonicalize Podman's exact sha256 ID, never tags or partial IDs."""
    if isinstance(value, str) and re.fullmatch('[a-f0-9]{64}', value):
        value = 'sha256:'+value
    need(isinstance(value, str) and IMAGE.fullmatch(value), 'Invalid immutable OCI image ID')
    return value


def signature_policy_raw(base_image):
    need(isinstance(base_image, str) and BASE.fullmatch(base_image), 'Invalid immutable base policy scope')
    value = {'default':[{'type':'reject'}], 'transports':{'docker':{
        base_image:[{'type':'insecureAcceptAnything'}]}}}
    return (json.dumps(value, sort_keys=True, separators=(',',':'))+'\n').encode()


def policy(config, user=None):
    value = config.get('personalOci', {'enabled': False})
    need(isinstance(value, dict) and type(value.get('enabled')) is bool, 'Invalid personal OCI policy')
    if value['enabled'] is False:
        need(set(value) == {'enabled'}, 'Disabled OCI policy must be explicit')
        raise ValueError('Personal OCI is not enabled on this node; use shared/isolated venv mode')
    required = {'enabled', 'baseImage', 'podmanSHA256', 'runtimeSHA256', 'cdiSHA256'}
    need(required <= set(value) <= required | {'owners','autoOwners','autoOwnersRevision'}
         and isinstance(value['baseImage'], str) and BASE.fullmatch(value['baseImage'])
         and all(isinstance(value[k], str) and re.fullmatch('[a-f0-9]{64}', value[k])
                 for k in ('podmanSHA256', 'runtimeSHA256', 'cdiSHA256')), 'Invalid trusted OCI capability policy')
    need('autoOwners' not in value or type(value['autoOwners']) is bool, 'Invalid automatic OCI cohort')
    need(not value.get('autoOwners') or 'owners' in value, 'Automatic OCI requires an explicit scoped cohort')
    need('autoOwnersRevision' not in value or ('owners' in value and 'autoOwners' in value and type(value['autoOwnersRevision']) is int and 0<=value['autoOwnersRevision']<=9007199254740991), 'Invalid automatic OCI cohort revision')
    if 'personalOciCohort' in config:
        need(config['personalOciCohort'] is not None, 'Invalid live OCI cohort binding')
        value = module('oci-cohort').current_policy(config, value)
    quota_enabled = module('storage-quota').enabled(config, user)
    if 'owners' in value:
        owners = value['owners']
        need(isinstance(owners, list) and (0 if value.get('autoOwners') is True else 1) <= len(owners) <= 10000
             and all(isinstance(owner, str) and OWNER.fullmatch(owner) for owner in owners)
             and len(set(owners)) == len(owners), 'Invalid personal OCI owner cohort')
        need(isinstance(user, str) and OWNER.fullmatch(user) and user in owners,
             'Authenticated owner is not in the personal OCI cohort')
    else:
        # Existing unscoped installations retain the original hard-quota gate.
        need(quota_enabled, 'OCI requires verified kernel hard quotas for this owner')
    return value


def protected_file(path, expected, *, executable=False):
    path = Path(path)
    st = path.lstat()
    need(stat.S_ISREG(st.st_mode) and st.st_uid == 0 and not st.st_mode & 0o022
         and st.st_nlink == 1 and (not executable or st.st_mode & 0o111), 'Untrusted OCI host dependency')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        need(os.fstat(fd) == st, 'OCI dependency replaced')
        digest = hashlib.sha256()
        while chunk := os.read(fd, 1024**2):
            digest.update(chunk)
        need(digest.hexdigest() == expected, 'OCI host dependency differs from accepted version')
    finally:
        os.close(fd)


def cdi_devices(raw, uuids):
    """Strict UUID selection only; never accept `all`, indices or caller CDI."""
    need(isinstance(uuids, list) and 0 < len(uuids) <= 64 and len(set(uuids)) == len(uuids)
         and all(isinstance(v, str) and GPU.fullmatch(v) for v in uuids), 'Invalid scheduler GPU UUIDs')
    value = json.loads(raw)
    need(value.get('kind') == 'nvidia.com/gpu' and isinstance(value.get('devices'), list), 'Invalid administrator CDI specification')
    names = [device.get('name') for device in value['devices']]
    need(len(names) == len(set(names)) and all(v in names for v in uuids), 'Assigned GPU missing from pinned CDI specification')
    return ['nvidia.com/gpu='+gpu for gpu in uuids]


def translate_control(arguments, sources=None):
    """Translate only the trusted training-control module's narrow bwrap DSL."""
    result, i = [], 0
    while i < len(arguments):
        op = arguments[i]
        if op == '--dir':
            i += 2
        elif op in ('--bind-fd', '--ro-bind-data'):
            fd, target = arguments[i+1:i+3]
            need(str(int(fd)) == fd and target in ('/run/gpuq/control', '/opt/gpuq/sdk.pyz', '/opt/gpuq/libvgpu.so'),
                 'Unexpected OCI scheduler mount')
            source = (sources or {}).get(int(fd), '/proc/'+str(os.getpid())+'/fd/'+fd)
            result += ['--volume', source+':'+target+(':'+'ro' if op == '--ro-bind-data' else ':rw')]
            i += 3
        elif op == '--setenv':
            key, value = arguments[i+1:i+3]
            need(isinstance(key, str) and isinstance(value, str) and len(key) <= 256 and len(value) <= 65536
                 and (re.fullmatch('[A-Z][A-Z0-9_]*', key) or key == 'RAY_object_spilling_directory')
                 and '\x00' not in value, 'Invalid scheduler environment')
            result += ['--env', key+'='+value]
            i += 3
        else:
            raise ValueError('Unsupported OCI training-control mount operation')
    return result


class PersonalOCI:
    initialize = True

    def __init__(self, config, user, *, initialize=True):
        need(type(initialize) is bool, 'Invalid OCI initialization mode')
        self.initialize = initialize
        self.config, self.user = config, user
        # Admission precedes any owner directory creation. A global OCI flag
        # must not let a legacy/non-cohort owner fall back to quota-free OCI.
        self.policy = policy(config, user)
        self.s = module('project-store')
        self.q = module('storage-quota')
        self.root = self.s.absolute(config['root'])
        self.s.check_platform_root(self.root)
        need(isinstance(user, str) and OWNER.fullmatch(user), 'Invalid OCI owner')
        self.owner = hashlib.sha256(user.encode()).hexdigest()
        parent = self.s.private_dir(self.root/'oci', create=initialize)
        self.folder = self.s.private_dir(parent/self.owner, create=initialize)
        if initialize:
            self.q.ensure(config, user, self.folder)
        for name in ('graph', 'run', 'tmp', 'home', 'projects'):
            self.s.private_dir(self.folder/name, create=initialize)
        for name in ('home/.config', 'home/.config/containers', 'home/.config/containers/registries.conf.d', 'home/containers'):
            self.s.private_dir(self.folder/name, create=initialize)
        if initialize:
            self.runtime_tmp = self.runtime_temporary()
        temporary = self.runtime_tmp if initialize else self.folder/'tmp'
        self.env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(self.folder/'home'),
                    'XDG_CONFIG_HOME': str(self.folder/'home'), 'XDG_DATA_HOME': str(self.folder/'home'),
                    'XDG_RUNTIME_DIR': '/run/user/'+str(os.getuid()), 'TMPDIR': str(temporary),
                    'REGISTRY_AUTH_FILE': str(self.folder/'anonymous-registry-auth.json'), 'LANG': 'C.UTF-8',
                    'CONTAINERS_REGISTRIES_CONF': str(self.folder/'anonymous-registries.conf'),
                    'CONTAINERS_CONF': str(ENGINE)}
        with self.registry_auth():
            pass

    def runtime_temporary(self, *, create=None):
        """Short private console-socket path; keep persistent engine DB paths."""
        create = self.initialize if create is None else create
        candidate = RUNTIME/str(os.getuid())/'gpuq-oci'/self.owner[:32]
        need(len(os.fsencode(candidate)) + len('/conmon-term.XXXXXX') < 108, 'OCI runtime console path too long')
        base = self.s.private_dir(RUNTIME/str(os.getuid()))
        parent = self.s.private_dir(base/'gpuq-oci', create=create)
        path = self.s.private_dir(parent/self.owner[:32], create=create)
        expected = (self.owner+'\n').encode()
        with self.s.directory(path) as directory:
            try: fd = os.open('.owner', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=directory)
            except FileNotFoundError:
                if not create:
                    raise
                created = os.open('.owner', os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=directory)
                try:
                    need(os.write(created, expected) == len(expected), 'OCI runtime owner creation incomplete')
                    os.fsync(created)
                finally: os.close(created)
                os.fsync(directory)
                fd = os.open('.owner', os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=directory)
            try:
                before = os.fstat(fd)
                need(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
                     and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
                     and before.st_size == len(expected) and os.read(fd, len(expected)+1) == expected
                     and self.s.stamp(os.fstat(fd)) == self.s.stamp(before), 'OCI runtime owner identity changed')
            finally: os.close(fd)
        return path

    def prepare_runtime_directory(self):
        """Explicitly restore only volatile owner IPC after login/reboot.

        Existing graph/project/image storage is never initialized by this call.
        """
        self.runtime_tmp = self.runtime_temporary(create=True)
        self.env['TMPDIR'] = str(self.runtime_tmp)
        return self.runtime_tmp

    @contextlib.contextmanager
    def registry_auth(self):
        """Verified private anonymous JSON and no external credential helpers."""
        auth = 'anonymous-registry-auth.json'; registries = 'anonymous-registries.conf'
        need(self.env.get('HOME') == str(self.folder/'home')
             and self.env.get('REGISTRY_AUTH_FILE') == str(self.folder/auth)
             and self.env.get('CONTAINERS_REGISTRIES_CONF') == str(self.folder/registries),
             'Anonymous OCI authentication path changed')
        if hasattr(self, 'runtime_tmp'):
            need(self.env.get('TMPDIR') == str(self.runtime_tmp) and self.runtime_temporary() == self.runtime_tmp,
                 'OCI private runtime path changed')
        with self.registry_file(auth, ANONYMOUS_AUTH_RAW) as authfd, \
             self.registry_file(registries, ANONYMOUS_REGISTRIES_RAW) as registriesfd, \
             self.registry_file('policy.json', signature_policy_raw(self.policy['baseImage']),
                                directory=self.folder/'home/containers') as policyfd, \
             self.registry_file('policy.json', signature_policy_raw(self.policy['baseImage']),
                                directory=self.folder/'home/.config/containers') as homepolicyfd:
            # Podman save uses containers/image's HOME lookup even when other
            # subcommands honor XDG_CONFIG_HOME. Both private lookup locations
            # must carry the identical narrow policy; never fall back to host
            # /etc/containers or broaden the default signature acceptance.
            # Podman 5.8 still loads both drop-in directories when an explicit
            # main config is supplied. Never let them override our helper policy.
            dropins = ((REGISTRY_DROPINS, 0),
                       (self.folder/'home/.config/containers/registries.conf.d', os.geteuid()))
            before = [self.registry_dropin_state(path, uid) for path, uid in dropins]
            # Rootless Podman re-execs inside its user namespace and cannot
            # open the host runner's /proc/<pid>/fd entries. Use the standard
            # service-private paths, held open and identity-checked before and
            # after the command. No host HOME/auth path is used as a fallback.
            yield dict(self.env), authfd
            need([self.registry_dropin_state(path, uid) for path, uid in dropins] == before,
                 'OCI registry drop-in directories changed during operation')

    def registry_dropin_state(self, path, uid):
        """Empty directory or safely absent; never delete operator drop-ins."""
        parent = path
        while True:
            try:
                with self.s.directory(parent) as fd:
                    info = os.fstat(fd)
                    need(info.st_uid in (0, uid) and not info.st_mode & 0o022,
                         'OCI registry drop-in directory is unsafe')
                    if parent == path:
                        need(info.st_uid == uid and not os.listdir(fd),
                             'OCI registry drop-in configuration requires administrator review')
                        return ('empty', self.s.stamp(info))
                    missing = path.relative_to(parent).parts[0]
                    try: os.stat(missing, dir_fd=fd, follow_symlinks=False)
                    except FileNotFoundError:
                        # Absence is about this lookup path, not every entry in
                        # its nearest existing ancestor (possibly all of /etc).
                        # Sibling writes change size/nlink/mtime/ctime without
                        # changing registry configuration. Keep the anchor's
                        # identity and trust boundary, and recheck the missing
                        # component after the engine operation. Existing empty
                        # drop-ins still retain their full mutation stamp above.
                        anchor = (info.st_dev, info.st_ino, info.st_mode,
                                  info.st_uid, info.st_gid)
                        return ('absent', str(parent), anchor, missing)
                    raise ValueError('OCI registry drop-in path changed during inspection')
            except FileNotFoundError:
                need(parent != Path('/'), 'OCI registry drop-in ancestor is missing')
                parent = parent.parent

    @contextlib.contextmanager
    def registry_file(self, name, expected, *, directory=None):
        # `commit` has no signature-policy CLI flag in Podman 5.x. Its default
        # lookup is this fixed private XDG_CONFIG_HOME/containers path. Never
        # inherit a host default, Docker credential or broad registry policy.
        need(directory is None or (name == 'policy.json' and directory in
                                  (self.folder/'home/containers', self.folder/'home/.config/containers')),
             'Invalid private OCI policy directory')
        folder = self.folder if directory is None else self.s.private_dir(directory, create=self.initialize)
        path = folder/name
        identity_key = str(path.relative_to(self.folder))
        with self.s.directory(folder) as parent:
            directory = os.fstat(parent)
            need(directory.st_uid == os.geteuid() and stat.S_IMODE(directory.st_mode) == 0o700,
                 'Anonymous OCI authentication parent is not private')
            created_identity = None
            try:
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            except FileNotFoundError:
                if not self.initialize:
                    raise
                need(identity_key not in getattr(self, '_registry_identities', {}), 'Anonymous OCI authentication file disappeared')
                created = os.open(path.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
                try:
                    need(os.write(created, expected) == len(expected),
                         'Anonymous OCI authentication creation was incomplete')
                    os.fsync(created)
                    created_identity = self.s.stamp(os.fstat(created))
                finally:
                    os.close(created)
                os.fsync(parent)
                fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd)
                need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                     and stat.S_IMODE(info.st_mode) == 0o600 and info.st_size == len(expected),
                     'Anonymous OCI authentication file is unsafe')
                identity = self.s.stamp(info)
                need(created_identity in (None, identity), 'Anonymous OCI authentication replaced after creation')
                need(os.pread(fd, len(expected)+1, 0) == expected,
                     'Anonymous OCI authentication content changed')
                identities = getattr(self, '_registry_identities', {})
                need(identities.get(identity_key, identity) == identity, 'Anonymous OCI authentication file replaced')
                self._registry_identities = {**identities, identity_key: identity}
                # Retain the verified descriptor throughout the operation and
                # reject replacement of the exact named file before returning.
                yield fd
                need(self.s.stamp(os.fstat(fd)) == identity
                     and self.s.stamp(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == identity,
                     'Anonymous OCI authentication changed during operation')
            finally:
                os.close(fd)

    def command(self, *args):
        return ['/usr/bin/podman', '--root', str(self.folder/'graph'), '--runroot', str(self.folder/'run'),
                '--tmpdir', str(self.folder/'tmp'), '--storage-driver=overlay', '--cgroup-manager=cgroupfs',
                '--runtime=/usr/bin/crun', '--hooks-dir='+str(HOOKS),
                '--cdi-spec-dir='+str(CDI.parent), '--events-backend=file', *args]

    def run(self, *args, timeout=30):
        if not self.initialize:
            need(args[:2] == ('image', 'inspect') or args in (
                ('version', '--format', '{{.Client.Version}}'), ('info', '--format=json'),
            ), 'Existing-only OCI permits inspection only')
        with self.registry_auth() as (env, authfd):
            # containers/image and Buildah stage complete image layers under
            # TMPDIR, not Podman's --tmpdir. Keep those potentially large
            # bytes in the owner's quota-managed data volume. Runtime create/
            # start still use the short private runtime directory for conmon's
            # UNIX socket; changing that boundary would revive long-path bugs.
            env['TMPDIR'] = str(self.s.private_dir(self.folder/'tmp'))
            try:
                result = subprocess.run(self.command(*args), env=env, capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired as error:
                self.record_stderr(error.stderr or b'', phase='OCI_PREPARATION')
                raise
            # Capture before context exit: integrity verification can raise
            # even after the engine itself has returned successfully.
            self.record_stderr(getattr(result, 'stderr', ''), phase='OCI_PREPARATION')
        need(result.returncode == 0 and len(result.stdout) < 2*1024**2, 'Managed OCI operation failed; no privileged fallback was attempted')
        return result.stdout.strip()

    def record_stderr(self, raw, *, phase='OCI_ENGINE', truncated=False):
        sink = getattr(self, 'stderr_sink', None)
        if sink is None or not raw: return
        if isinstance(raw, str): raw = raw.encode('utf-8', errors='replace')
        try: sink(raw[-STDERR_LIMIT:], phase=phase, truncated=truncated or len(raw) > STDERR_LIMIT)
        except Exception: pass  # Diagnostics must never replace an engine exit.

    def call(self, command, *, env, pass_fds):
        """Keep stdout/main stderr, plus one bounded private evidence tail.

        No wrapper shell, command logging, container logs, recursive scan or
        additional cancellation. Do not wait for unrelated inherited writers
        after the exact engine process exits.
        """
        if getattr(self, 'stderr_sink', None) is None:
            return subprocess.call(command, env=env, pass_fds=pass_fds)
        process = subprocess.Popen(command, env=env, pass_fds=pass_fds, stderr=subprocess.PIPE)
        tail = bytearray(); total = 0; last_saved = time.monotonic(); eof = False; drain_deadline = None
        try:
            while True:
                if process.poll() is not None:
                    if drain_deadline is None: drain_deadline = time.monotonic() + 1
                    if time.monotonic() >= drain_deadline: break
                ready = select.select([process.stderr], [], [], .5)[0]
                if ready:
                    raw = os.read(process.stderr.fileno(), 4096)
                    if not raw: eof = True; break
                    total += len(raw); tail.extend(raw)
                    if len(tail) > STDERR_LIMIT: del tail[:-STDERR_LIMIT]
                    try:
                        offset = 0
                        while offset < len(raw):
                            written = os.write(2, raw[offset:])
                            if written <= 0: break
                            offset += written
                    except OSError: pass
                    if time.monotonic() - last_saved >= 5:
                        self.record_stderr(bytes(tail), truncated=total > STDERR_LIMIT)
                        last_saved = time.monotonic()
                elif process.poll() is not None: break
            return process.wait()
        except BaseException:
            # Preserve subprocess.call's original exceptional cleanup: only
            # this exact engine child, not its unit or another owner's process.
            try: process.kill()
            except OSError: pass
            process.wait()
            raise
        finally:
            self.record_stderr(bytes(tail), truncated=total > STDERR_LIMIT or not eof)
            process.stderr.close()

    def verify_host(self):
        need(os.geteuid() != 0, 'Personal OCI must never run as host root')
        protected_file('/usr/bin/podman', self.policy['podmanSHA256'], executable=True)
        protected_file('/usr/bin/crun', self.policy['runtimeSHA256'], executable=True)
        with self.s.directory(HOOKS) as fd:
            info = os.fstat(fd)
            need(info.st_uid == 0 and not info.st_mode & 0o022 and not os.listdir(fd), 'OCI hooks must be a root-owned empty directory')
        protected_file(CDI, self.policy['cdiSHA256'])
        protected_file(ENGINE, hashlib.sha256(ENGINE_RAW).hexdigest())
        protected_file(SIGNATURE_POLICY, hashlib.sha256(signature_policy_raw(self.policy['baseImage'])).hexdigest())
        # Every command strongly overrides the default CDI search paths. The
        # host's automatic NVIDIA specs remain untouched and are never loaded.
        with self.s.directory(CDI.parent) as fd:
            info = os.fstat(fd)
            need(info.st_uid == 0 and not info.st_mode & 0o022
                 and set(os.listdir(fd)) == {CDI.name}, 'Unpinned CDI specification directory')
        # mounts.conf is independent of containers.conf and must not inject a
        # host secret/socket into every otherwise restricted rootless container.
        for path in (Path('/usr/share/containers/mounts.conf'), Path('/etc/containers/mounts.conf'),
                     self.folder/'home/containers/mounts.conf'):
            if path.exists() or path.is_symlink():
                with self.s.directory(path.parent) as parent:
                    fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
                    try:
                        info = os.fstat(fd)
                        need(stat.S_ISREG(info.st_mode) and info.st_size <= 65536
                             and not any(line.strip() and not line.lstrip().startswith(b'#')
                                         for line in os.read(fd, 65537).splitlines()),
                             'Automatic OCI host mounts are forbidden')
                    finally: os.close(fd)
        version = self.run('version', '--format', '{{.Client.Version}}')
        match = re.fullmatch(r'(\d+)\.(\d+)\.(\d+)(?:[+~-].*)?', version)
        need(match and tuple(map(int, match.groups())) >= (4, 1, 0), 'Podman >= 4.1 is required for exact CDI GPU isolation')
        value = json.loads(self.run('info', '--format=json'))
        host = value.get('host', {})
        runtime = host.get('ociRuntime', {})
        # An absolute --runtime is reported as the runtime name by Podman 5.x.
        # Require the same pinned executable, not an arbitrary crun alias.
        need(host.get('security', {}).get('rootless') is True and host.get('cgroupVersion') == 'v2'
             and runtime.get('name') in ('crun', '/usr/bin/crun') and runtime.get('path') == '/usr/bin/crun',
             'Rootless cgroup-v2/crun capability not verified')
        return {'rootless': True, 'gpuDevelopment': False, 'trainingGpu': 'scheduler-exact-cdi', 'podman': version}

    def state_path(self, slug):
        need(isinstance(slug, str) and self.s.SLUG.fullmatch(slug), 'Invalid OCI project')
        return self.folder/'projects'/(slug+'.json')

    @contextlib.contextmanager
    def seed_file(self, parent, name, maximum, digest=None):
        """Public administrator material, never an owner-selected host path."""
        fd = os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(fd); identity = self.s.stamp(info)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and info.st_nlink == 1
                 and stat.S_IMODE(info.st_mode) == 0o444 and 0 < info.st_size <= maximum,
                 'Unsafe offline base seed')
            if digest is not None:
                value = hashlib.sha256(); remaining = info.st_size+1
                while remaining:
                    chunk = os.read(fd, min(remaining, 1024**2))
                    if not chunk: break
                    value.update(chunk); remaining -= len(chunk)
                need(remaining == 1, 'Offline base archive changed while reading')
                need(value.hexdigest() == digest, 'Offline base archive checksum mismatch')
            yield fd
            need(self.s.stamp(os.fstat(fd)) == identity
                 and self.s.stamp(os.stat(name, dir_fd=parent, follow_symlinks=False)) == identity,
                 'Offline base seed changed during operation')
        finally:
            os.close(fd)

    def offline_base(self):
        """Optional fixed offline seed; configured failures never fall back to pull."""
        digest = self.policy['baseImage'].split('@sha256:', 1)[1]
        document = BASE_SEEDS/(digest+'.json')
        try: document.lstat()
        except FileNotFoundError: return None
        # No mkdir, arbitrary archive URL/path, host graph, or credential reuse.
        for path in (BASE_SEEDS, *BASE_SEEDS.parents):
            if path == Path('/'): continue
            with self.s.directory(path) as fd:
                info = os.fstat(fd)
                need(info.st_uid == 0 and not info.st_mode & 0o022, 'Unsafe offline base directory')
        with self.s.directory(BASE_SEEDS) as parent, self.seed_file(parent, document.name, 65536) as fd:
            value = json.loads(os.read(fd, 65537))
            need(isinstance(value, dict) and set(value) == {'schema', 'baseImage', 'archiveBytes',
                 'archiveSHA256', 'imageId', 'diffIds'} and type(value['schema']) is int and value['schema'] == 1
                 and value['baseImage'] == self.policy['baseImage']
                 and type(value['archiveBytes']) is int and 0 < value['archiveBytes'] <= 4*1024**3
                 and isinstance(value['archiveSHA256'], str) and re.fullmatch('[a-f0-9]{64}', value['archiveSHA256'])
                 and isinstance(value['imageId'], str) and IMAGE.fullmatch(value['imageId'])
                 and isinstance(value['diffIds'], list) and 1 <= len(value['diffIds']) <= 128
                 and all(isinstance(v, str) and IMAGE.fullmatch(v) for v in value['diffIds']),
                 'Invalid offline base identity')
            archive = BASE_SEEDS/(digest+'.oci.tar')
            with self.seed_file(parent, archive.name, value['archiveBytes'], value['archiveSHA256']) as archivefd:
                need(os.fstat(archivefd).st_size == value['archiveBytes'], 'Offline base archive size mismatch')
                with self.registry_auth() as (env, _):
                    exists = subprocess.run(self.command('image', 'exists', value['baseImage']),
                                            env=env, capture_output=True, timeout=30)
                need(exists.returncode in (0, 1) and len(exists.stdout) <= 65536 and len(exists.stderr) <= 65536,
                     'Offline base local lookup failed')
                if exists.returncode == 1:
                    policy = {'default':[{'type':'reject'}], 'transports':{
                        'oci-archive':{str(archive):[{'type':'insecureAcceptAnything'}]}}}
                    raw = (json.dumps(policy, sort_keys=True, separators=(',', ':'))+'\n').encode()
                    with self.registry_file('offline-base-policy.json', raw):
                        self.run('load', '--signature-policy', str(self.folder/'offline-base-policy.json'),
                                 '--quiet', '--input', str(archive), timeout=1800)
                images = json.loads(self.run('image', 'inspect', value['baseImage']))
                need(isinstance(images, list) and len(images) == 1 and isinstance(images[0], dict),
                     'Offline base local identity is missing')
                image = images[0]
                need(immutable_image_id(image.get('Id')) == value['imageId']
                     and value['baseImage'] in image.get('RepoDigests', [])
                     and image.get('Digest') == 'sha256:'+digest
                     and image.get('RootFS', {}).get('Layers') == value['diffIds'],
                     'Offline base local identity mismatch')
                return value['imageId']

    @contextlib.contextmanager
    def locked(self, slug):
        path = self.state_path(slug)
        fd = os.open(path.with_suffix('.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        try:
            info = os.fstat(fd)
            need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                 and not info.st_mode & 0o077, 'Invalid OCI project lock')
            import fcntl
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def load(self, slug):
        try:
            value = self.s.read_json(self.state_path(slug))
        except FileNotFoundError:
            return {'schema': 1, 'owner': self.owner, 'project': slug, 'image': self.policy['baseImage'], 'container': None}
        need(set(value) == {'schema', 'owner', 'project', 'image', 'container'} and value['schema'] == 1
             and value['owner'] == self.owner and value['project'] == slug
             and (IMAGE.fullmatch(value['image']) or value['image'] == self.policy['baseImage'])
             and (value['container'] is None or re.fullmatch('gpuq-dev-[a-f0-9]{32}', value['container'])),
             'OCI ownership state is invalid')
        return value

    def checkpoint(self, slug):
        """Caller holds project/OCI lock and has confirmed terminal unit stopped."""
        value = self.load(slug)
        if value['container'] is not None:
            container = json.loads(self.run('container', 'inspect', value['container']))
            need(len(container) == 1, 'Development container identity missing')
            entry = container[0]
            labels = entry.get('Config', {}).get('Labels', {})
            state = entry.get('State', {})
            need(labels.get('io.gpuq.owner') == self.owner and labels.get('io.gpuq.project') == slug,
                 'Development container ownership is unknown')
            if state.get('Running') is True:
                # A control-group stop can kill conmon before its exit event is
                # persisted. Reconcile only this dead, exactly owned runtime;
                # never stop/remove a live container or discard its overlay.
                identifier = entry.get('Id')
                need(isinstance(identifier, str) and re.fullmatch('[a-f0-9]{64}', identifier)
                     and state.get('Paused', False) is False
                     and all(type(state.get(key)) is int and state[key] >= 0
                             and (state[key] == 0 or not Path('/proc', str(state[key])).exists())
                             for key in ('Pid', 'ConmonPid')), 'Development container is still running')
                # Podman may report conmon's missing exit record as an error
                # even after native stop saved Exited. Accept no state from
                # that return code: only the fresh identity/stopped checks do.
                with self.registry_auth() as (env, authfd):
                    stopped = subprocess.run(self.command('stop', '--time', '1', identifier),
                                             env=env, capture_output=True, timeout=30)
                need(len(stopped.stdout) < 2*1024**2 and len(stopped.stderr) < 65536,
                     'Development container stop response exceeds bound')
                refreshed = json.loads(self.run('container', 'inspect', value['container']))
                need(len(refreshed) == 1 and refreshed[0].get('Id') == identifier,
                     'Development container changed during runtime refresh')
                entry = refreshed[0]
                labels = entry.get('Config', {}).get('Labels', {})
                state = entry.get('State', {})
            need(labels.get('io.gpuq.owner') == self.owner and labels.get('io.gpuq.project') == slug
                 and state.get('Running') is False and state.get('Paused', False) is False and state.get('Pid') == 0
                 and state.get('Status') in ('exited', 'stopped', 'created', 'configured'), 'Development container is running or ownership is unknown')
            image = immutable_image_id(self.run('commit', '--pause=false', value['container'], timeout=1800))
            old = value['container']
            value.update(image=image, container=None)
            # Durable head before removing the only writable layer. A crash may
            # leave an unused container, but never loses the acknowledged image.
            self.s.atomic_json(self.state_path(slug), value)
            self.run('rm', old)
        elif not IMAGE.fullmatch(value['image']):
            image = self.offline_base()
            if image is None:
                self.run('pull', '--signature-policy', str(SIGNATURE_POLICY), '--quiet', '--policy=missing',
                         '--retry=0', '--tls-verify=true', value['image'], timeout=1800)
                image = immutable_image_id(self.run('image', 'inspect', '--format={{.Id}}', value['image']))
            value['image'] = image
            self.s.atomic_json(self.state_path(slug), value)
        return value

    def publish(self, slug):
        self.verify_host()
        with self.locked(slug):
            value = self.checkpoint(slug)
            return {'schema': 1, 'owner': self.owner, 'project': slug, 'image': value['image']}

    def verify_image(self, slug, receipt):
        need(isinstance(receipt, dict) and set(receipt) == {'schema', 'owner', 'project', 'image'}
             and receipt['schema'] == 1 and receipt['owner'] == self.owner and receipt['project'] == slug
             and isinstance(receipt['image'], str) and IMAGE.fullmatch(receipt['image']), 'OCI release ownership mismatch')
        need(immutable_image_id(self.run('image', 'inspect', '--format={{.Id}}', receipt['image'])) == receipt['image'], 'Published OCI image is missing; no tag fallback allowed')
        return receipt['image']

    def inspect_existing_image(self, slug, receipt):
        """Inspect a prepared owner graph; never pull or start a container.

        The engine may use its own existing bookkeeping/locks. This does not
        promise zero engine-internal writes or prove that user code will run.
        """
        need(self.initialize is False, 'Existing image inspection requires no-initialization mode')
        self.verify_host()
        return self.verify_image(slug, receipt)

    def portable_image(self, slug, receipt):
        """Describe a pinned owner image; never checkpoint a live container."""
        self.verify_host()
        image_id = self.verify_image(slug, receipt)
        images = json.loads(self.run('image', 'inspect', image_id))
        need(isinstance(images, list) and len(images) == 1, 'Published image inspection failed')
        image = images[0]
        architecture = {'x86_64':'amd64', 'aarch64':'arm64'}.get(platform.machine(), platform.machine())
        layers = image.get('RootFS', {}).get('Layers')
        need(immutable_image_id(image.get('Id')) == image_id and image.get('Os') == 'linux'
             and image.get('Architecture') == architecture and isinstance(layers, list)
             and 1 <= len(layers) <= 256 and all(isinstance(v, str) and IMAGE.fullmatch(v) for v in layers)
             and type(image.get('Size')) is int and 0 < image['Size'] <= self.s.ProjectStore.MAX_BYTES,
             'Published OCI image is incompatible or its byte count is not exact')
        return {'schema':1, 'image':image_id, 'os':'linux', 'architecture':architecture,
                'diffIds':layers, 'unpackedBytes':image['Size']}

    def portable_image_entries(self, slug, receipt, *, max_entries=200000, timeout=2.0):
        """Bounded inode upper bound for a fixed image, never an image mount.

        Overlay layer entries are counted separately (including whiteouts and
        hard links), not merged/deduplicated. Symlinks in image content are
        counted, never followed. Only Podman's one fixed overlay/l alias is
        resolved, and only to a literal sibling layer's diff directory.
        """
        need(type(max_entries) is int and 1 <= max_entries <= 200000
             and type(timeout) in (int, float) and 0 < timeout <= 2,
             'Invalid image inode sampling bounds')
        self.verify_host()
        image_id = self.verify_image(slug, receipt)
        graph = self.folder/'graph'
        need(self.folder == self.root/'oci'/self.owner and ':' not in str(graph),
             'Image graph ownership changed')

        def inspect():
            value = json.loads(self.run('image', 'inspect', image_id, timeout=8))
            need(isinstance(value, list) and len(value) == 1
                 and immutable_image_id(value[0].get('Id')) == image_id,
                 'Immutable image changed during inode sampling')
            image = value[0]
            layers = image.get('RootFS', {}).get('Layers')
            driver = image.get('GraphDriver')
            need(isinstance(layers, list) and 1 <= len(layers) <= 256
                 and all(isinstance(layer, str) and IMAGE.fullmatch(layer) for layer in layers)
                 and isinstance(driver, dict) and driver.get('Name') == 'overlay'
                 and isinstance(driver.get('Data'), dict), 'Unknown immutable image layers')
            return layers, driver['Data']

        before = inspect()
        data = before[1]
        upper, lower = data.get('UpperDir'), data.get('LowerDir', '')
        need(isinstance(upper, str) and upper and isinstance(lower, str),
             'Unknown immutable image layer paths')
        raw_paths = [upper]+(lower.split(':') if lower else [])
        need(len(raw_paths) == len(before[0]), 'Immutable image layer count differs')
        paths, aliases = [], []
        for raw in raw_paths:
            path = self.s.absolute(raw)
            direct = re.fullmatch(r'([a-f0-9]{64})/diff', str(path.relative_to(graph/'overlay'))) if path.is_relative_to(graph/'overlay') else None
            if direct:
                paths.append(path)
                continue
            need(path.parent == graph/'overlay/l' and re.fullmatch(r'[A-Za-z0-9]{1,64}', path.name),
                 'Image layer escaped its fixed owner graph')
            with self.s.directory(path.parent) as fd:
                info = os.stat(path.name, dir_fd=fd, follow_symlinks=False)
                need(stat.S_ISLNK(info.st_mode), 'Unknown overlay layer alias')
                target = os.readlink(path.name, dir_fd=fd)
                match = re.fullmatch(r'\.\./([a-f0-9]{64})/diff', target)
                need(match is not None, 'Overlay alias escaped its fixed owner graph')
                aliases.append((path, self.s.stamp(info), target))
                paths.append(graph/'overlay'/match[1]/'diff')
        deadline = time.monotonic()+timeout
        entries, directories = 0, []
        with self.s.directory(graph) as graphfd:
            graph_info = os.fstat(graphfd)
            need(graph_info.st_uid == os.geteuid() and not graph_info.st_mode & 0o022,
                 'Image graph is not private')

            def bound():
                need(entries <= max_entries and time.monotonic() <= deadline,
                     'Image inode sampling incomplete or exceeds its bound')

            def walk(path, fd, depth):
                nonlocal entries
                bound()
                need(depth <= 128, 'Image inode sampling exceeds depth bound')
                info = os.fstat(fd)
                need(info.st_dev == graph_info.st_dev, 'Image layer crossed an unapproved mount')
                identity = self.s.stamp(info)
                directories.append((path, identity))
                entries += 1
                bound()
                with os.scandir(fd) as children:
                    for child in children:
                        bound()
                        current = os.stat(child.name, dir_fd=fd, follow_symlinks=False)
                        need(current.st_dev == graph_info.st_dev, 'Image content crossed an unapproved mount')
                        if stat.S_ISDIR(current.st_mode):
                            childfd = os.open(child.name, self.s.DIR_FLAGS, dir_fd=fd)
                            try:
                                need(self.s.stamp(os.fstat(childfd)) == self.s.stamp(current),
                                     'Image layer directory changed')
                                walk(path/child.name, childfd, depth+1)
                            finally:
                                os.close(childfd)
                        else:
                            entries += 1
                            bound()
                need(self.s.stamp(os.fstat(fd)) == identity, 'Image layer changed during inode sampling')

            for path in paths:
                with self.s.directory(path) as fd:
                    walk(path, fd, 0)
            # Re-open every observed directory after the complete multi-layer
            # walk. A change in an early layer cannot hide behind a later one.
            for path, identity in directories:
                bound()
                with self.s.directory(path) as fd:
                    need(self.s.stamp(os.fstat(fd)) == identity, 'Image layer changed during inode sampling')
            for path, identity, target in aliases:
                bound()
                with self.s.directory(path.parent) as fd:
                    need(self.s.stamp(os.stat(path.name, dir_fd=fd, follow_symlinks=False)) == identity
                         and os.readlink(path.name, dir_fd=fd) == target,
                         'Immutable image layer alias changed')
            with self.s.directory(graph) as current:
                info = os.fstat(current)
                need((info.st_dev, info.st_ino, info.st_uid, info.st_mode) ==
                     (graph_info.st_dev, graph_info.st_ino, graph_info.st_uid, graph_info.st_mode),
                     'Image graph identity changed')
        need(inspect() == before and self.verify_image(slug, receipt) == image_id,
             'Immutable image changed during inode sampling')
        # Conservatively cover engine layer/image index/link/work metadata.
        # No deduplication or bytes-to-inodes inference contributes free space.
        return entries+16*len(before[0])+1024

    @contextlib.contextmanager
    def portable_archive(self, archive, maximum, checksum=None):
        with self.s.directory(archive.parent) as parent:
            fd = os.open(archive.name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=parent)
            try:
                info = os.fstat(fd); identity = self.s.stamp(info)
                need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                     and not info.st_mode & 0o022 and 0 < info.st_size <= maximum, 'Unsafe portable OCI archive')
                if checksum is not None:
                    value = hashlib.sha256()
                    while block := os.read(fd, 1024**2): value.update(block)
                    need(value.hexdigest() == checksum, 'Portable image archive checksum mismatch')
                    os.lseek(fd, 0, os.SEEK_SET)
                yield fd
                need(self.s.stamp(os.fstat(fd)) == identity
                     and self.s.stamp(os.stat(archive.name, dir_fd=parent, follow_symlinks=False)) == identity,
                     'Portable image archive changed during operation')
            finally: os.close(fd)

    def export_image(self, slug, receipt, archive):
        """Internal worker destination, not an RPC path or a registry push."""
        image = self.portable_image(slug, receipt)
        archive = self.s.absolute(archive)
        need(archive.is_relative_to(self.root/'projects-v2'/self.owner), 'Image export must stay in the owner project store')
        self.s.private_dir(archive.parent)
        need(not archive.exists() and not archive.is_symlink(), 'Image export destination already exists')
        # Archive headers and image metadata need additional room. Admission is
        # conservative, and the shared volume's reserve is checked again after
        # the engine returns; this is not a per-user filesystem hard quota.
        self.s.require_workspace_space(self.root, self.s.workspace_reserve_bytes(self.config),
                                       image['unpackedBytes']*11//10+16*1024**2)
        # `save` verifies containers-storage too. Grant only this already
        # owner-verified immutable image in this exact private graph, not the
        # whole store and not any registry. Podman supports this hidden flag.
        scope = '[overlay@'+str(self.folder/'graph')+']@'+image['image'].removeprefix('sha256:')
        export_policy = {'default':[{'type':'reject'}], 'transports':{
            'containers-storage':{scope:[{'type':'insecureAcceptAnything'}]}}}
        name = 'portable-export-'+image['image'].removeprefix('sha256:')+'.json'
        with self.registry_file(name, self.s.canonical(export_policy)):
            self.run('save', '--signature-policy', str(self.folder/name),
                     '--format=oci-archive', '--output', str(archive), image['image'], timeout=1800)
        self.s.require_workspace_space(self.root, self.s.workspace_reserve_bytes(self.config))
        with self.portable_archive(archive, self.s.ProjectStore.MAX_BYTES) as fd:
            size = os.fstat(fd).st_size
            need(size > 0, 'Empty OCI archive')
            checksum = hashlib.sha256()
            while block := os.read(fd, 1024**2): checksum.update(block)
        return {**image, 'archiveBytes':size, 'archiveSha256':checksum.hexdigest()}

    def import_image(self, slug, receipt, archive, identity):
        """Load one authenticated, hashed LAN archive into this owner's graph.

        No tag resolution, network pull, project state update or container start.
        The receipt was authenticated by the immutable project release hash.
        """
        self.verify_host()
        need(isinstance(receipt, dict) and set(receipt) == {'schema','owner','project','image'}
             and receipt.get('schema') == 1 and receipt.get('owner') == self.owner
             and receipt.get('project') == slug and isinstance(receipt.get('image'), str)
             and IMAGE.fullmatch(receipt['image']), 'OCI release ownership mismatch')
        architecture = {'x86_64':'amd64', 'aarch64':'arm64'}.get(platform.machine(), platform.machine())
        need(isinstance(identity, dict) and set(identity) == {'schema','image','os','architecture','diffIds',
             'unpackedBytes','archiveBytes','archiveSha256'} and identity.get('schema') == 1
             and identity.get('image') == receipt['image'] and identity.get('os') == 'linux'
             and identity.get('architecture') == architecture and isinstance(identity.get('diffIds'), list)
             and 1 <= len(identity['diffIds']) <= 256
             and all(isinstance(v, str) and IMAGE.fullmatch(v) for v in identity['diffIds'])
             and all(type(identity.get(k)) is int and 0 < identity[k] <= self.s.ProjectStore.MAX_BYTES
                     for k in ('archiveBytes','unpackedBytes'))
             and isinstance(identity.get('archiveSha256'), str)
             and re.fullmatch('[a-f0-9]{64}', identity['archiveSha256']), 'Invalid portable image identity')
        archive = self.s.absolute(archive)
        need(archive.is_relative_to(self.root/'projects-v2'/self.owner), 'Image import must stay in the owner project store')
        self.s.private_dir(archive.parent)
        # The archive is already on disk; reserve space for unpacking as well.
        self.s.require_workspace_space(self.root, self.s.workspace_reserve_bytes(self.config),
                                       identity['unpackedBytes']*11//10+16*1024**2)
        with self.portable_archive(archive, identity['archiveBytes'], identity['archiveSha256']) as fd:
            need(os.fstat(fd).st_size == identity['archiveBytes'], 'Portable image archive size differs')
            name = 'portable-'+hashlib.sha256(str(archive).encode()).hexdigest()+'.json'
            policy = {'default':[{'type':'reject'}], 'transports':{
                'oci-archive':{str(archive):[{'type':'insecureAcceptAnything'}]}}}
            with self.registry_file(name, self.s.canonical(policy)):
                self.run('load', '--signature-policy', str(self.folder/name), '--quiet',
                         '--input', str(archive), timeout=1800)
        self.s.require_workspace_space(self.root, self.s.workspace_reserve_bytes(self.config))
        observed = self.portable_image(slug, receipt)
        # Podman's Size includes local storage accounting (even identical
        # image IDs/layers may differ by tens of bytes after save/load). It is
        # an admission estimate, never content identity. Keep every actual
        # identity field exact, plus the archive checksum verified above.
        content_keys = ('schema','image','os','architecture','diffIds')
        need(all(observed[key] == identity[key] for key in content_keys),
             'Imported OCI image identity differs; project release was not published')
        return observed

    def arguments(self, spec, project, terminal, uuids, mounts, control=()):
        need(project.get('environmentMode') == 'oci', 'Not an OCI project')
        need(isinstance(spec.get('argv'), list) and 1 <= len(spec['argv']) <= 256
             and all(isinstance(a, str) and '\x00' not in a and len(a) <= 65536 for a in spec['argv']), 'Invalid OCI argv')
        # All host sources are already-open descriptors owned by the trusted
        # runner, never a user-provided host path. No nested daemon/socket.
        args = ['--cgroups=split', '--cgroupns=private', '--user=0', '--pid=private', '--ipc=private',
                '--uts=private', '--hostname=gpuq-job', '--network=slirp4netns:allow_host_loopback=false',
                '--security-opt=no-new-privileges', '--image-volume=ignore', '--pull=never',
                # The existing parent unit enforces TasksMax=2048 and memory /
                # CPU limits across Podman + conmon + every payload descendant.
                # No competing nested pids controller in a populated unit.
                # gpuq-ray caps its object store at 8 GiB. Reserving only the
                # engine's small default shm forces disk-backed object storage.
                # tmpfs pages remain charged to the existing parent MemoryMax.
                '--log-driver=none', '--pids-limit=-1', '--shm-size=8g', '--workdir=/workspace',
                '--label', 'io.gpuq.owner='+self.owner, '--label', 'io.gpuq.project='+spec['project'],
                '--env=HOME=/home/gpuq', '--env=XDG_CACHE_HOME=/home/gpuq/.cache',
                '--env=GPUQ_OUTPUT_DIR=/outputs', '--env=GPUQ_PROJECT='+spec['project'],
                '--env=GPUQ_PROJECT_ENV_MODE=oci', '--env=GPUQ_OFFLINE_ASSETS=/workspace/offline',
                '--env=GPUQ_CONSOLE_JOB_ID='+spec.get('id', ''), '--env=NCCL_CUMEM_HOST_ENABLE=0',
                '--env=LANG=C.UTF-8', '--env=PYTHONUNBUFFERED=1',
                '--env=NVIDIA_VISIBLE_DEVICES=void', '--unsetenv=CUDA_VISIBLE_DEVICES',
                '--env=GPUQ_PROJECT_RELEASE='+spec.get('release', 'development')]
        for fd, target, readonly in mounts:
            need(type(fd) is int and fd >= 0 and isinstance(target, str) and target.startswith('/')
                 and '..' not in Path(target).parts and ':' not in target, 'Unsafe OCI mount')
            source = getattr(self, '_mount_sources', {}).get(fd, '/proc/'+str(os.getpid())+'/fd/'+str(fd))
            args += ['--volume', source+':'+target+(':ro' if readonly else ':rw')]
        if terminal:
            # Resource/PATH environment is useful in development too, but the
            # scheduler's writable attempt SDK is never mounted there.
            need(not uuids and all(control[i] == '--setenv' for i in range(0, len(control), 3)),
                 'Development OCI cannot have GPUs or scheduler controls')
            args += ['--interactive', '--tty', '--env=TERM=xterm-256color']
        else:
            protected_file(CDI, self.policy['cdiSHA256'])
            for device in cdi_devices(CDI.read_bytes(), uuids):
                args += ['--device', device]
        args += translate_control(list(control), getattr(self, '_mount_sources', {}))
        return args

    @contextlib.contextmanager
    def named_mounts(self, mounts, control):
        """Rootless re-exec needs named sources, derived only from trusted FDs.

        Hold the no-follow path chain and compare each edge before/after use.
        The client cannot supply host paths. Anonymous resource metadata alone
        is copied into a bounded new private file; no host credentials/cache.
        """
        entries = list(mounts)
        i = 0
        while i < len(control):
            if control[i] in ('--bind-fd', '--ro-bind-data'):
                entries.append((int(control[i+1]), control[i+2], control[i] == '--ro-bind-data'))
                i += 3
            elif control[i] == '--setenv': i += 3
            elif control[i] == '--dir': i += 2
            else: raise ValueError('Unsupported OCI training-control mount operation')
        sources, held, edges, snapshots = {}, [], [], []
        def identity(info):
            return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid)
        try:
            for fd, target, readonly in entries:
                need(type(fd) is int and fd >= 0, 'Invalid trusted OCI mount descriptor')
                info = os.fstat(fd); name = os.readlink('/proc/self/fd/'+str(fd))
                if name == '/memfd:gpuq-resources (deleted)':
                    need(readonly and target == '/run/gpuq/resources.json' and stat.S_ISREG(info.st_mode)
                         and 0 < info.st_size <= 65536, 'Unsupported anonymous OCI mount')
                    raw = os.pread(fd, 65537, 0)
                    need(len(raw) == info.st_size, 'OCI resource metadata changed')
                    module('job-resources').validate_budget(json.loads(raw))
                    path = self.folder/'tmp'/('resources-'+uuid.uuid4().hex+'.json')
                    with self.s.directory(path.parent) as parent:
                        parent_info = os.fstat(parent)
                        need(parent_info.st_uid == os.geteuid() and stat.S_IMODE(parent_info.st_mode) == 0o700,
                             'OCI resource snapshot parent is not private')
                        copied = os.open(path.name, os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o600, dir_fd=parent)
                        try:
                            offset = 0
                            while offset < len(raw):
                                written = os.write(copied, raw[offset:]); need(written > 0, 'OCI resource snapshot incomplete'); offset += written
                            os.fsync(copied); copied_info = os.fstat(copied)
                        finally: os.close(copied)
                        snapshots.append((path, identity(copied_info))); os.fsync(parent)
                    name = str(path); info = copied_info
                else:
                    need(stat.S_ISDIR(info.st_mode) or readonly and stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                         'Unsupported OCI mount descriptor type')
                path = Path(name)
                need(path.is_absolute() and str(path) == name and '..' not in path.parts and ':' not in name
                     and '\n' not in name and '\x00' not in name and not name.endswith(' (deleted)'),
                     'OCI descriptor has no safe named source')
                parent = os.open('/', os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW); held.append(parent)
                for index, part in enumerate(path.parts[1:]):
                    parent_info = os.fstat(parent)
                    child = os.stat(part, dir_fd=parent, follow_symlinks=False)
                    need(parent_info.st_uid in (0, os.geteuid())
                         and (not parent_info.st_mode & 0o022 or parent_info.st_uid == 0
                              and parent_info.st_mode & stat.S_ISVTX and child.st_uid in (0, os.geteuid())),
                         'OCI mount source parent can be replaced by another user')
                    need(not stat.S_ISLNK(child.st_mode), 'Symlink in OCI mount source')
                    edges.append((parent, part, identity(child)))
                    if index < len(path.parts)-2:
                        parent = os.open(part, os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=parent); held.append(parent)
                    else: need(identity(child) == identity(info), 'OCI named source differs from trusted descriptor')
                need(fd not in sources or sources[fd] == name, 'Ambiguous OCI mount descriptor')
                sources[fd] = name
            self._mount_sources = sources
            yield sources
            for parent, name, before in edges:
                need(identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == before,
                     'OCI mount source changed during operation')
        finally:
            self._mount_sources = {}
            try:
                for path, before in snapshots:
                    with self.s.directory(path.parent) as parent:
                        need(identity(os.stat(path.name, dir_fd=parent, follow_symlinks=False)) == before,
                             'OCI resource snapshot replaced before cleanup')
                        os.unlink(path.name, dir_fd=parent); os.fsync(parent)
            finally:
                for fd in reversed(held): os.close(fd)

    def execute(self, spec, project, terminal, uuids, mounts, *, control=(), pass_fds=()):
        # A queued job may start long after its initial preparation. Recheck
        # current membership before any new container execution, without
        # replacing immutable capabilities, storage roots or cleanup runtime.
        if 'personalOciCohort' in self.config:
            policy(self.config, self.user)
        with self.registry_auth() as (env, authfd), self.named_mounts(mounts, control):
            return self._execute(spec, project, terminal, uuids, mounts,
                                 control=control, pass_fds=pass_fds, registry_env=env)

    def _execute(self, spec, project, terminal, uuids, mounts, *, control=(), pass_fds=(), registry_env):
        self.verify_host()
        need(os.getuid() != 0, 'Rootless OCI cannot execute as host root')
        flags = self.arguments(spec, project, terminal, uuids, mounts, control)
        # Podman/conmon/crun remain in this scheduler/terminal delegated unit.
        group = next(v.split(':', 2)[2].strip() for v in Path('/proc/self/cgroup').read_text().splitlines() if v.startswith('0::'))
        need(Path(group).name.startswith('amax-term-' if terminal else 'gpuq-')
             and Path(group).name.endswith('.service'), 'OCI must be owned by an authorized systemd unit')
        env = {'PATH': '/usr/bin:/bin', 'HOME': str(Path.home()),
               'XDG_RUNTIME_DIR': '/run/user/'+str(os.getuid()),
               'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/'+str(os.getuid())+'/bus'}
        unit = Path(group).name
        # Delegation is installed when the unit is created, not a mutable
        # runtime property on all supported systemd versions. Never rewrite a
        # running unit's resource budget here: inspect the existing boundary.
        shown = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit,
            '--property=Delegate,KillMode,MemoryMax,TasksMax,ControlGroup'], env=env,
            check=True, text=True, capture_output=True, timeout=5)
        state = dict(line.split('=',1) for line in shown.stdout.splitlines() if '=' in line)
        need(state.get('Delegate') == 'yes' and state.get('KillMode') == 'control-group'
             and state.get('TasksMax') == '2048' and state.get('ControlGroup') == group
             and state.get('MemoryMax','').isdigit() and int(state['MemoryMax']) > 0,
             'OCI parent resource/cancellation boundary is not verified')
        # Read the kernel limits too; Delegate=yes or systemctl metadata alone
        # cannot establish the CPU, memory and PID budget of this payload.
        module('job-resources').read_budget(spec, group, uuids, terminal)
        if terminal:
            with self.locked(spec['project']):
                head = self.checkpoint(spec['project'])
                name = 'gpuq-dev-'+uuid.uuid4().hex
                # Store the intended exact name before create. Unknown outcome
                # retains this identity; never mint a replacement implicitly.
                head['container'] = name
                self.s.atomic_json(self.state_path(spec['project']), head)
                if 'personalOciCohort' in self.config:
                    policy(self.config, self.user)
                result = subprocess.run(self.command('create', '--name', name, *flags,
                    '--entrypoint', spec['argv'][0], head['image'], *spec['argv'][1:]),
                    env=registry_env, text=True, capture_output=True, pass_fds=pass_fds, timeout=60)
                need(result.returncode == 0, 'OCI development creation unconfirmed; inspect the retained identity')
            return subprocess.call(self.command('start', '--attach', '--interactive', name), env=registry_env, pass_fds=pass_fds)
        image = self.verify_image(spec['project'], project['meta']['oci'])
        name = 'gpuq-job-'+uuid.uuid4().hex
        if 'personalOciCohort' in self.config:
            policy(self.config, self.user)
        return self.call(self.command('run', '--rm', '--name', name, *flags,
                               '--entrypoint', spec['argv'][0], image, *spec['argv'][1:]),
                               env=registry_env, pass_fds=pass_fds)


def run_project(config, spec, project, terminal, uuids, workfd, project_fds,
                dataset_fds, datafd=None, runtimefd=None, resourcefd=None, cgroupfd=None, *, stderr_sink=None):
    """Both existing scheduler profiles enter here after allocation/limits."""
    owner = PersonalOCI(config, spec['userId'])
    owner.stderr_sink = stderr_sink
    mounts = [(workfd, '/workspace', not terminal), (project_fds['home'], '/home/gpuq', False),
              (project_fds['output'], '/outputs', False)]
    mounts += [(fd, target, True) for fd, target in dataset_fds]
    if datafd is not None:
        need(terminal, 'Mutable data workspace is only for development')
        mounts.append((datafd, '/data2', False))
    if runtimefd is not None:
        mounts.append((runtimefd, '/run/gpuq/runtime', False))
    if resourcefd is not None:
        mounts.append((resourcefd, '/run/gpuq/resources.json', True))
    # Keep the job's exact resource view read-only, not the host cgroup tree.
    if cgroupfd is not None:
        mounts.append((cgroupfd, '/sys/fs/cgroup', True))
    control, extra = ([], []) if terminal else module('training-control').prepare(
        config, spec, project['code'], project, os.environ)
    try:
        # Add helpers without hiding an image's own Conda/venv PATH. No host
        # environment forwarding: the immutable image supplies its base PATH.
        image = project['meta']['oci']['image'] if not terminal else owner.load(spec['project'])['image']
        if not IMAGE.fullmatch(image):
            # A new development base is pulled/checkpointed by execute(). A
            # conservative standard PATH suffices until the first checkpoint.
            image_path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        else:
            environment = json.loads(owner.run('image', 'inspect', '--format={{json .Config.Env}}', image)) or []
            paths = [v[5:] for v in environment if isinstance(v, str) and v.startswith('PATH=')]
            need(len(paths) <= 1, 'Ambiguous OCI image PATH')
            image_path = paths[0] if paths else '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
        control += ['--setenv', 'PATH', '/opt/gpuq/bin:'+image_path]
        if resourcefd is not None:
            budget = json.loads(os.pread(resourcefd, 65536, 0))
            for key, value in module('job-resources').resource_environment(budget).items():
                control += ['--setenv', key, value]
        if runtimefd is not None:
            for key, value in {'RAY_TMPDIR':'/run/gpuq/runtime','GPUQ_RAY_TEMP_DIR':'/run/gpuq/runtime/ray',
                               'RAY_object_spilling_directory':'/tmp/gpuq-ray-spill'}.items():
                control += ['--setenv', key, value]
        for name in ('gpuq-network', 'gpuq-ray', 'job-resources.py'):
            path = HERE/name
            if path.exists():
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
                extra.append(fd)
                mounts.append((fd, '/opt/gpuq/bin/'+name, True))
        # FDs belong to the trusted runner. Named sources are derived and
        # identity-checked by execute(); untrusted code never receives these FDs.
        return owner.execute(spec, project, terminal, uuids, mounts, control=control)
    finally:
        for fd in extra:
            os.close(fd)

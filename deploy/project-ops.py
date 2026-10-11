#!/usr/bin/env python3
"""Node-local project RPCs. No supplied commands execute on the host.

Slow publication runs in a bounded background unit, before GPU reservation.
Uploaded files are staged outside user mounts and atomically committed only
after their declared size and SHA256 match. Publication never reads an upload
in progress or a live development terminal.
"""
import base64
from contextlib import contextmanager
import ctypes
import fcntl
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

PROJECT = re.compile(r'^[a-z][a-z0-9_-]{0,47}$')
HASH = re.compile(r'^[a-f0-9]{64}$')
UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
PROJECT_LOCK_WAIT_SECONDS = 2.0


class ProjectOperations:
    def __init__(self, executor):
        self.n = executor
        spec = importlib.util.spec_from_file_location('gpuq_project_store', executor.HERE/'project-store.py')
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        self.store = module.ProjectStore(executor.ROOT, executor.CONFIG['conda'],
                                        reserve_bytes=module.workspace_reserve_bytes(executor.CONFIG), config=executor.CONFIG)
        self.folder = executor.ROOT/'project-ops'
        self.folder.mkdir(mode=0o700, exist_ok=True)

    def identity(self, args):
        user, project = args.get('userId'), args.get('project')
        self.n.workspace(user)  # validates trusted portal identity
        if not isinstance(project, str) or not PROJECT.fullmatch(project):
            raise ValueError('Invalid project name')
        return user, project

    def key(self, args):
        return hashlib.sha256(json.dumps(self.identity(args)).encode()).hexdigest()

    @contextmanager
    def guard(self, args, *, lifecycle=True):
        from contextlib import nullcontext
        with self.store.lifetime(*self.identity(args)) if lifecycle else nullcontext():
            fd = os.open(self.folder/(self.key(args)+'.lock'), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
            with os.fdopen(fd, 'a') as lock:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != os.geteuid() or info.st_mode & 0o077:
                    raise ValueError('Unsafe project operation lock')
                deadline = time.monotonic() + PROJECT_LOCK_WAIT_SECONDS
                while True:
                    try:
                        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                        break
                    except BlockingIOError:
                        remaining = deadline - time.monotonic()
                        if remaining <= 0:
                            raise ValueError('Project operation is busy; query or resume the original upload after it finishes') from None
                        time.sleep(min(0.05, remaining))
                yield

    def receipt_path(self, args):
        return self.folder/(self.key(args)+'.json')

    def active(self, args):
        return subprocess.run(['/usr/bin/systemctl', '--user', 'is-active', '--quiet',
                               'gpuq-project-'+self.key(args)[:32]], env=self.n.ENV,
                              timeout=4, stdout=subprocess.DEVNULL).returncode == 0

    def receipt(self, args):
        path = self.receipt_path(args)
        return json.loads(path.read_text()) if path.exists() else {}

    def historical_receipt_path(self, args, publication_id):
        if not isinstance(publication_id,str) or not UUID.fullmatch(publication_id):
            raise ValueError('Invalid publication identity')
        return self.folder/(self.key(args)+'.publication-'+publication_id+'.json')

    def historical_receipt(self, args, publication_id):
        module=sys.modules[type(self.store).__module__]
        try: receipt=module.read_json(self.historical_receipt_path(args,publication_id))
        except FileNotFoundError: return None
        user,project=self.identity(args)
        if (not isinstance(receipt,dict) or receipt.get('publicationId') != publication_id
                or receipt.get('userId') != user or receipt.get('project') != project):
            raise ValueError('Historical publication identity mismatch')
        return receipt

    def preserve_receipt(self, args, receipt):
        publication_id=receipt.get('publicationId')
        if publication_id is None: return  # Historical unkeyed intent.
        previous=self.historical_receipt(args,publication_id)
        if previous is not None:
            if previous != receipt: raise ValueError('Historical publication receipt changed')
            return
        raw=self.receipt_path(args).read_bytes()
        if json.loads(raw) != receipt: raise ValueError('Publication receipt changed before preservation')
        fd=os.open(self.historical_receipt_path(args,publication_id),os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'wb') as stream:
            stream.write(raw);stream.flush();os.fsync(stream.fileno())
        module=sys.modules[type(self.store).__module__]
        with module.directory(self.folder) as parent:
            os.fsync(parent)  # Make the retained UUID durable before replacing current intent.

    def belongs_to_project(self, args, receipt):
        generation = receipt.get('projectGeneration')
        project_uuid = receipt.get('projectUUID')
        if project_uuid is not None:
            if not isinstance(project_uuid, str) or not UUID.fullmatch(project_uuid):
                raise ValueError('Invalid publication project UUID')
            if generation is None:
                raise ValueError('Publication project generation is missing')
        if generation is not None:
            if not isinstance(generation, str) or not HASH.fullmatch(generation):
                raise ValueError('Invalid publication project generation')
            return (generation == self.store.generation(*self.identity(args)) and
                    (project_uuid is None or project_uuid == self.store.project_uuid(*self.identity(args))))
        # Legacy receipts have no incarnation ID. Only discard a display when
        # its recorded start provably predates the current project; unknown
        # legacy intent remains fenced rather than guessed to be obsolete.
        started = receipt.get('requestedAt', receipt.get('progress', {}).get('startedAt'))
        if type(started) not in (int, float):
            return True
        created = self.store.status(*self.identity(args))['createdAt']
        return not started < created

    def pending(self, args):
        receipt = self.receipt(args)
        if not receipt or not self.belongs_to_project(args, receipt):
            return {}
        if receipt.get('projectGeneration') is None:
            # Keep ambiguous legacy evidence on disk and fence writes, but do
            # not attribute its failure or committed release to this project.
            pending = {name:value for name,value in receipt.items()
                       if name not in ('error','errorDetails','progress','release','committedRelease')}
            return {**pending,'state':'UNKNOWN','projectIdentityUnconfirmed':True,
                    'error':'Project publication identity is unconfirmed; inspect the original receipt before retrying'}
        return receipt

    def terminal_stopped(self, jid):
        unit='amax-term-'+jid+'.service'
        result=subprocess.run(['/usr/bin/systemctl','--user','show',unit,
            '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup'],
            env=self.n.ENV,text=True,capture_output=True,timeout=5)
        props=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
        if set(props)!={'LoadState','ActiveState','SubState','MainPID','ControlGroup'}:return False
        if result.returncode and not (result.returncode==1 and props['LoadState']=='not-found'):return False
        quiet=props['ActiveState'] in ('inactive','failed') or (props['ActiveState']=='active' and props['SubState']=='exited')
        if props['MainPID']!='0' or not quiet:return False
        group=props['ControlGroup']
        if not group:return props['LoadState'] in ('loaded','not-found')
        if not group.startswith('/') or '..' in Path(group).parts or Path(group).name!=unit:return False
        path=Path('/sys/fs/cgroup')/group.lstrip('/')
        try:events=dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
        except FileNotFoundError:return not path.exists()
        return events.get('populated')=='0'

    def writable(self, args, *, lifecycle=True, publication_lock=True, synchronization=True):
        if lifecycle: self.store.admit(*self.identity(args))
        if (self.folder/(self.key(args)+'.local-import.json')).exists():
            self.local_imports().project_writable(args)
        sync=self.folder/(self.key(args)+'.sync.json')
        if synchronization and (sync.exists() or sync.is_symlink()):
            session,canceled=self.synchronization(args)
            if session.get('state')!='CODE_READY' and canceled is None:
                raise ValueError('Code synchronization is incomplete; repeat the original sync or cancel its exact UUID before editing, opening a terminal or publishing')
        pending = self.pending(args)
        if pending.get('projectIdentityUnconfirmed'):
            raise ValueError('Project publication identity is unconfirmed; inspect the original receipt before editing or publishing')
        if pending.get('state') == 'PUBLISHING' and self.active(args):
            raise ValueError('Project publication is running; wait before editing or uploading')
        if publication_lock: self.store.fail_if_publishing(*self.identity(args))

    def local_imports(self):
        spec=importlib.util.spec_from_file_location('gpuq_project_local_import',self.n.HERE/'project-local-import.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.LocalImports(self)

    def synchronization(self,args):
        spec=importlib.util.spec_from_file_location('gpuq_snapshot_observation',self.n.HERE/'snapshot-sync.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.observation(self,args)

    def development_terminals(self, args):
        """Discover original owned IDs, without probing or changing a session.

        Attachment metadata is not a process/stop proof. Call terminal.status
        explicitly for each ID before deciding whether any action is safe.
        Reads stay anchored to service-owned no-follow directory descriptors;
        a changing snapshot never becomes a complete (or empty) directory.
        """
        user, project = args.get('userId'), args.get('project')
        if (not isinstance(user, str) or not re.fullmatch(r'(builtin-admin|demo-user-[0-9]+)', user)
                or not isinstance(project, str) or not PROJECT.fullmatch(project)):
            raise ValueError('Invalid project terminal discovery identity')
        result = {'protocol':1, 'state':'UNCONFIRMED', 'complete':False, 'sessions':[]}
        store_module = sys.modules[type(self.store).__module__]
        prefix = hashlib.sha256((user+'private:project:'+project).encode()).hexdigest()[:20]
        stamps = {}

        def stamp(info):
            return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_nlink,
                    info.st_size, info.st_mtime_ns, info.st_ctime_ns)

        def private_directory(info, *, root=False):
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid()
                    or info.st_mode & (0o022 if root else 0o077)
                    or root and (info.st_dev,info.st_ino) != self.store.root_identity):
                raise ValueError('Project terminal directory is unconfirmed')

        def read(fd, name, maximum, *, secret=False, missing=False):
            try:
                handle = os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK, dir_fd=fd)
            except FileNotFoundError:
                if not missing: raise
                stamps[name] = None
                return None
            try:
                info = os.fstat(handle)
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                        or info.st_nlink != 1 or info.st_size > maximum
                        or info.st_mode & (0o077 if secret else 0o022)):
                    raise ValueError('Project terminal metadata is unconfirmed')
                before = stamp(info)
                data = os.read(handle, maximum+1)
                if (len(data) != info.st_size or stamp(os.fstat(handle)) != before
                        or stamp(os.stat(name, dir_fd=fd, follow_symlinks=False)) != before):
                    raise ValueError('Project terminal metadata changed')
                stamps[name] = before
                return data
            finally:
                os.close(handle)

        def names(fd):
            found, count = [], 0
            with os.scandir(fd) as entries:
                for entry in entries:
                    count += 1
                    if count > 20000: raise ValueError('Project terminal history exceeds bounded discovery')
                    if entry.name == prefix+'.current' or entry.name.startswith(prefix+'.') and entry.name.endswith('.current'):
                        found.append(entry.name)
                        if len(found) > 256: raise ValueError('Project terminal sessions exceed bounded discovery')
            return sorted(found)

        try:
            store_module.check_platform_root(self.n.ROOT)
            with store_module.directory(self.n.ROOT) as root_fd:
                root_before = stamp(os.fstat(root_fd)); private_directory(os.fstat(root_fd), root=True)
                try:
                    fd = os.open('terminals', os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW, dir_fd=root_fd)
                except FileNotFoundError:
                    if stamp(os.fstat(root_fd)) != root_before: return result
                    # Reopen the path: an old descriptor alone cannot prove its
                    # directory still belongs to the configured platform root.
                    with store_module.directory(self.n.ROOT) as current:
                        if stamp(os.fstat(current)) != root_before: return result
                    return {**result, 'state':'CONFIRMED', 'complete':True}
                try:
                    before = stamp(os.fstat(fd)); private_directory(os.fstat(fd))
                    paths = names(fd); complete = True; sessions = {}
                    for name in paths:
                        try:
                            legacy = name == prefix+'.current'
                            suffix = None if legacy else name[len(prefix)+1:-8]
                            if suffix is not None and not UUID.fullmatch(suffix): raise ValueError('Invalid terminal pointer')
                            jid = read(fd, name, 36).decode('ascii')
                            if not UUID.fullmatch(jid) or suffix is not None and suffix != jid: raise ValueError('Terminal pointer identity differs')
                            spec = json.loads(read(fd, jid+'.json', 16384))
                            if (not isinstance(spec, dict) or spec.get('userId') != user or spec.get('project') != project
                                    or type(spec.get('hostAdmin', False)) is not bool or spec.get('hostAdmin', False)
                                    or type(spec.get('dataWorkspace', False)) is not bool or spec.get('dataWorkspace', False)):
                                raise ValueError('Terminal does not belong to this project context')
                            raw = read(fd, jid+'.session.json', 16384, secret=True, missing=True)
                            receipt = json.loads(raw) if raw is not None else None
                            if receipt is not None:
                                lease = receipt.get('leaseExpiresAt') if isinstance(receipt, dict) else None
                                if (not isinstance(receipt, dict) or receipt.get('schema') != 2
                                        or receipt.get('state') not in ('OPEN','DETACHED','CLOSED')
                                        or not isinstance(lease, (int,float)) or isinstance(lease, bool)
                                        or not 0 <= lease <= 2**53-1 or not math.isfinite(lease)):
                                    raise ValueError('Terminal attachment metadata is unconfirmed')
                            row = {'id':jid, 'state':'UNCONFIRMED', 'requiresStatus':True,
                                   'attachmentState':receipt['state'] if receipt else 'UNKNOWN',
                                   'writerLeaseExpired':receipt['leaseExpiresAt'] <= time.time() if receipt else None,
                                   'legacy':legacy}
                            if jid in sessions: row['legacy'] = sessions[jid]['legacy'] or legacy
                            sessions[jid] = row
                        except (OSError, ValueError, UnicodeError, RecursionError):
                            complete = False
                    if names(fd) != paths or stamp(os.fstat(fd)) != before: return result
                    for name, identity in stamps.items():
                        try: current = stamp(os.stat(name, dir_fd=fd, follow_symlinks=False))
                        except FileNotFoundError: current = None
                        if current != identity: return result
                    if (stamp(os.stat('terminals', dir_fd=root_fd, follow_symlinks=False)) != before
                            or stamp(os.fstat(root_fd)) != root_before): return result
                    with store_module.directory(self.n.ROOT) as current:
                        if stamp(os.fstat(current)) != root_before: return result
                    with store_module.directory(self.n.ROOT/'terminals') as current:
                        if stamp(os.fstat(current)) != before: return result
                    store_module.check_platform_root(self.n.ROOT)
                    return {**result, 'complete':complete, 'state':'CONFIRMED' if complete else 'UNCONFIRMED',
                            'sessions':sorted(sessions.values(), key=lambda row:row['id'])}
                finally:
                    os.close(fd)
        except (OSError, ValueError):
            return result

    def status(self, args):
        result = self.store.status(*self.identity(args))
        result['lifecycle'] = self.lifecycle().view(*self.identity(args))
        result['publicationProtocol'] = 1
        local = None
        pointer=self.folder/(self.key(args)+'.local-import.json')
        if pointer.exists():
            helper=self.local_imports()
            local=helper.status(helper.s.read_json(pointer));result['localImport']=local
        sync=self.folder/(self.key(args)+'.sync.json')
        if sync.exists() or sync.is_symlink():
            session,canceled=self.synchronization(args)
            result['codeSync']={k:session[k] for k in ('state','source','manifestSha256')}
            result['codeSync']['warnings']=self.store.size_warnings(session['totalBytes'])
            if canceled is not None:result['codeSync'].update(state='CANCELED',key=session['key'],snapshotId=session['session'],preservesBytes=True)
            elif session['state']!='CODE_READY':result.update(state='SYNCING',error='Code sync incomplete; resume or cancel its original UUID')
        pending = self.pending(args)
        observed = pending
        if pending.get('state') == 'PUBLISHING':
            pending = pending if self.active(args) else {
                **pending,'state':'UNKNOWN','error':'Publication worker stopped without a final receipt; inspect READY versions before retrying'}
        # A complete callback is emitted only after the immutable release and
        # latest pointer are committed. It is a durable per-publication proof,
        # unlike merely finding some older READY version in this project.
        committed = pending.get('committedRelease')
        if (pending.get('state') in ('UNKNOWN','FAILED') and
                isinstance(committed, str) and HASH.fullmatch(committed) and
                committed == result.get('latestReadyRelease') and
                any(item['release'] == committed for item in result['releases'])):
            recovered = {k:v for k,v in pending.items() if k not in ('error','errorDetails')}
            recovered.update(state='READY',release=committed)
            try:
                with self.guard(args):
                    if self.pending(args) == observed:
                        self.n.atomic_json(self.receipt_path(args), recovered)
            except Exception: pass  # The on-disk commit proof remains authoritative.
            result.update(state='READY',progress=pending.get('progress',{}))
            pending = recovered
        if pending.get('state') in ('PUBLISHING', 'FAILED', 'UNKNOWN'):
            result.update({k: pending[k] for k in ('state','error','errorDetails','progress') if k in pending})
        self.publication_status(result, pending)
        # Historical publication recovery describes an immutable release,
        # not the current mutable draft. Never let it hide a newer import's
        # pending/unknown outcome or the exact-ID recovery entry point.
        if local is not None and local['state'] not in ('IMPORTED','FAILED','CANCELED'):
            result.update(state=local['state'],error='Local draft import is pending; use its original operation ID')
        result['developmentTerminals'] = self.development_terminals(args)
        if 'sharedDataDirectories' in self.n.CONFIG:
            definition=importlib.util.spec_from_file_location('gpuq_shared_data',self.n.HERE/'shared-data.py')
            helper=importlib.util.module_from_spec(definition);definition.loader.exec_module(helper)
            result['sharedData']=helper.describe(self.n.CONFIG)
        return result

    def lifecycle(self):
        spec=importlib.util.spec_from_file_location('gpuq_project_lifecycle',self.n.HERE/'project-lifecycle.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.ProjectLifecycle(self)

    def publication_status(self, result, pending):
        """Only this publication's durable commit proof, never an older READY."""
        identity = pending.get('publicationId')
        if identity is None: return result  # Historical unkeyed receipts.
        if not isinstance(identity, str) or not UUID.fullmatch(identity):
            raise ValueError('Invalid publication identity')
        state = pending.get('state')
        if state not in ('PUBLISHING', 'READY', 'FAILED', 'UNKNOWN'):
            raise ValueError('Invalid publication state')
        proof = {'id':identity, 'state':state}
        if state == 'READY':
            release = pending.get('committedRelease')
            if (not isinstance(release, str) or not HASH.fullmatch(release) or
                    pending.get('release') != release or
                    not any(item['release'] == release for item in result['releases'])):
                raise ValueError('Publication has no matching committed READY release')
            proof['release'] = release
        result['publication'] = proof
        return result

    def transfer_dir(self, args):
        path = self.folder/(self.key(args)+'.uploads')
        path.mkdir(mode=0o700, exist_ok=True)
        if 'storageQuota' in self.n.CONFIG:
            self.n.storage_quota(args['userId'], path, project=args['project'])
        return path

    def environment_modes(self, user):
        """Configured admission capability, not an engine/network probe.

        Merely listing projects must not create a private OCI graph, prime an
        image or run a container. The same strict policy used at admission
        determines whether this authenticated owner may choose OCI.
        """
        modes = ['shared', 'isolated']
        if self.n.CONFIG.get('personalOci', {}).get('enabled') is not True:
            return modes
        spec = importlib.util.spec_from_file_location('gpuq_project_oci_capability', self.n.HERE/'personal-oci.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        try:
            module.policy(self.n.CONFIG, user)
        except ValueError:
            return modes
        return [*modes, 'oci']

    def process(self, operation, args):
        if operation in ('projects.archive','projects.unarchive','projects.retire.plan','projects.retire','projects.retire.status'):
            return self.lifecycle().process(operation,args)
        if operation.startswith('projects.local-import.'):
            return self.local_imports().process(operation,args)
        allowed = {'userId'} if operation == 'projects.list' else {'userId','project'}
        if operation == 'projects.create': allowed.add('environmentMode')
        if operation == 'projects.publish': allowed.add('key')
        if operation == 'projects.verify': allowed.add('release')
        if not isinstance(args, dict) or set(args)-allowed:
            raise ValueError('Invalid project fields')
        if 'environmentMode' in args and args['environmentMode'] not in ('shared','isolated','oci'):
            raise ValueError('Environment mode must be shared, isolated or oci')
        if 'key' in args and (not isinstance(args['key'],str) or not UUID.fullmatch(args['key'])):
            raise ValueError('Invalid publication key')
        if operation == 'projects.list':
            self.n.workspace(args['userId'])
            result = {'projects':self.store.list(args['userId']),
                      'environmentModes':self.environment_modes(args['userId'])}
            # Store does not know detached-worker state.
            for item in result['projects']:
                item.update(self.status({'userId':args['userId'],'project':item['project']}))
            return result
        identity = self.identity(args)
        if operation == 'projects.status': return self.status(args)
        if operation == 'projects.verify':
            self.store.admit(*identity)
            release = self.store.release(*identity, args['release'])
            return {'project':args['project'],'release':args['release'],'state':'READY'}
        with self.guard(args):
            if operation == 'projects.create': return self.store.create(*identity, environment_mode=args.get('environmentMode'))
            if operation != 'projects.publish': raise ValueError('Unknown project operation')
            pending = self.pending(args)
            original = self.receipt(args)
            if ('key' in args and original.get('publicationId') == args['key']
                    and original and not pending):
                raise ValueError('Original publication belongs to an earlier project; it was not replayed')
            if 'key' in args and pending.get('publicationId') == args['key']:
                return self.status(args)  # Lost reply: never start a second worker.
            if 'key' in args and self.historical_receipt(args,args['key']) is not None:
                raise ValueError('Original publication is no longer current; inspect its original receipt or release; it was not replayed')
            self.writable(args)
            # A clean exit may leave a pointer. Confirm the entire unit is
            # stopped before copying; an unavailable socket is not enough.
            for pointer in self.n.terminal_pointers(args):
                jid = pointer.read_text()
                if not UUID.fullmatch(jid): raise ValueError('Invalid project terminal pointer')
                if self.n.terminal_alive(self.n.ROOT/'terminals', jid):
                    discovered = self.development_terminals(args)
                    owned = any(row['id'] == jid for row in discovered['sessions'])
                    suffix = ('; inspect original session '+jid+' with terminal status in this project context') if owned else '; query project status to discover original owned sessions'
                    raise ValueError('Close the project development terminal before publishing'+suffix)
                self.n.stop_terminal(jid)
                if not self.terminal_stopped(jid):
                    raise ValueError('Cannot confirm development terminal termination; publication blocked')
                pointer.unlink(missing_ok=True)
            uploads = self.transfer_dir(args)
            if any(uploads.glob('*.json')):
                raise ValueError('Unfinished project upload; retry that file or discard pending uploads')
            self.store.status(*identity)
            task = {'userId':identity[0],'project':identity[1],'state':'PUBLISHING',
                    'publicationId':args.get('key',str(uuid.uuid4())),
                    'projectUUID':self.store.project_uuid(*identity,create=True),
                    'projectGeneration':self.store.generation(*identity),
                    'requestedAt':int(time.time())}
            if original: self.preserve_receipt(args,original)
            self.n.atomic_json(self.receipt_path(args), task)
            try:
                self.n.run(['/usr/bin/systemd-run','--user','--collect',
                            '--unit=gpuq-project-'+self.key(args)[:32],
                            '--property=KillMode=control-group','--property=UMask=0077',
                            '--property=CPUQuota=100%','--property=MemoryMax=1G',
                            '--property=IOWeight=10','--property=RuntimeMaxSec=7200',
                            '/usr/bin/python3',str(self.n.HERE/'node-executor.py'),
                            '--project-worker',self.key(args),task['publicationId'],
                            task['projectGeneration']], timeout=8)
            except Exception:
                self.n.atomic_json(self.receipt_path(args), {**task,'state':'FAILED','error':'Unable to start publication worker'})
                raise
            return {**self.store.status(*identity),'state':'PUBLISHING','operationId':self.key(args),
                    'publicationProtocol':1,'publication':{'id':task['publicationId'],'state':'PUBLISHING'}}

    def worker(self, key, publication_id=None, project_generation=None):
        if not HASH.fullmatch(key): raise ValueError('Invalid project worker key')
        args = json.loads((self.folder/(key+'.json')).read_text())
        if self.key(args) != key: raise ValueError('Project worker identity mismatch')
        if (not isinstance(publication_id,str) or not UUID.fullmatch(publication_id)
                or not isinstance(project_generation,str) or not HASH.fullmatch(project_generation)
                or args.get('publicationId') != publication_id
                or args.get('projectGeneration') != project_generation):
            raise ValueError('Publication worker identity is unconfirmed or no longer matches its original intent; it did not run')
        if args.get('state') != 'PUBLISHING':
            raise ValueError('Publication worker intent is no longer pending; it did not run')
        # The receipt read above is only an initial identity check. A new
        # publication can replace it while this worker waits for its lock.
        # Hold the operation guard through publication so that an unconfirmed
        # native unit cannot admit another intent between validation and copy.
        with self.guard(args):
            current = self.receipt(args)
            if (self.key(current) != key or current.get('publicationId') != publication_id
                    or current.get('projectGeneration') != project_generation
                    or current.get('state') != 'PUBLISHING'):
                raise ValueError('Publication worker no longer matches its original intent; it did not run')
            if not self.belongs_to_project(current, current):
                raise ValueError('Publication belongs to an earlier project; worker did not run')
            return self.publication_worker(current)

    def write_publication_receipt(self, args, value):
        """CAS under the worker's operation guard, including late callbacks."""
        current = self.receipt(args)
        fields = ('userId','project','publicationId','projectUUID','projectGeneration')
        if (any(current.get(name) != args.get(name) for name in fields)
                or current.get('state') != 'PUBLISHING'
                or not self.belongs_to_project(args,current)):
            raise ValueError('Publication receipt no longer belongs to this worker; it was not overwritten')
        self.n.atomic_json(self.receipt_path(args),value)

    def publication_worker(self, args):
        args = {name:args[name] for name in ('userId','project','publicationId','projectUUID','projectGeneration','requestedAt') if name in args}
        args.setdefault('projectGeneration', self.store.generation(*self.identity(args)))
        last_progress, committed = {}, {}
        def progress(value):
            last_progress.update(value)
            if value.get('phase') == 'complete':
                status = self.store.status(*self.identity(args))
                release = status.get('latestReadyRelease')
                if (isinstance(release,str) and HASH.fullmatch(release) and
                        any(item['release'] == release for item in status['releases'])):
                    committed.update(project=args['project'],release=release,state='READY')
            self.write_publication_receipt(args, {**args,'state':'PUBLISHING','progress':value,
                **({'committedRelease':committed['release']} if committed else {})})
        try:
            out = self.store.publish(*self.identity(args), progress=progress)
        except Exception as error:
            if not committed:
                self.write_publication_receipt(args, {**args,'state':'FAILED',
                    'error':str(error)[:500] if isinstance(error,ValueError) else 'Publication failed; inspect node logs',
                    'errorDetails':getattr(error,'details',{}),'progress':last_progress})
                return 1
            # Post-commit cleanup cannot revoke a published immutable snapshot.
            print('GPUQ project publication committed; post-commit cleanup needs inspection',file=sys.stderr)
            out = committed
        try:
            self.write_publication_receipt(args, {**args,**out,'state':'READY',
                'committedRelease':out['release'],'progress':last_progress})
        except Exception:
            print('GPUQ project publication committed; final receipt unavailable, query project status',file=sys.stderr)
        return 0

    def files(self, operation, args):
        user, project = self.identity(args)
        area = args.get('area','code')
        if area == 'output':
            if operation == 'files.put': raise ValueError('Job outputs cannot be overwritten via upload')
            jid = args.get('runId')
            if not isinstance(jid,str) or not UUID.fullmatch(jid): raise ValueError('Invalid run ID')
            spec = json.loads((self.n.ROOT/'jobs'/(jid+'.json')).read_text())
            if spec.get('userId') != user or spec.get('project') != project:
                raise ValueError('Run is not owned by this project')
            root = self.store.existing_run_paths(user, project, spec['release'], jid)['output']
            return self.n.file_op(operation,args,root=root)
        if area != 'code' or args.get('runId') is not None: raise ValueError('Invalid project file area')
        root = self.store.dev_paths(user,project)['code']
        if operation in ('files.upload.status','files.upload.list','files.upload.cancel'):
            with self.guard(args), self.store.locked(user, project):
                if operation=='files.upload.list':return self.upload_list(args,root)
                if operation=='files.upload.cancel':return self.upload_cancel(args,root)
                return {**self.upload_status(args, root),
                        'warnings':self.store.size_warnings(args['totalSize'],file=True)}
        if operation != 'files.put':
            with self.store.lifetime(user,project):
                return self.n.file_op(operation,args,root=root)
        with self.guard(args):
            self.writable(args)
            with self.store.locked(user, project):
                return {**self.upload(args, root),
                        'warnings':self.store.size_warnings(args['totalSize'],file=True)}

    def upload_identity(self, args, *, required=True):
        path, upload = args.get('path'), args.get('uploadId')
        if not isinstance(path,str) or len(path)>1024 or '\\' in path or '\0' in path:
            raise ValueError('Invalid project upload path')
        parts = path.split('/')
        if any(p in ('','.','..') or len(p)>255 for p in parts): raise ValueError('Invalid project upload path')
        if (required or upload is not None) and (not isinstance(upload,str) or not UUID.fullmatch(upload)):
            raise ValueError('Invalid upload ID')
        total, digest = args.get('totalSize'), args.get('sha256')
        if type(total)!=int or not 0<=total<=self.store.MAX_BYTES:
            raise ValueError('Code upload byte count is not an exact protocol integer')
        if not isinstance(digest,str) or not HASH.fullmatch(digest): raise ValueError('Invalid upload checksum')
        return {'path':path,'uploadId':upload,'totalSize':total,'sha256':digest}

    def upload_list(self,args,root):
        """Discover exact pending identities without the original local source."""
        folder=self.folder/(self.key(args)+'.uploads')
        if not folder.exists():return {'protocol':1,'project':args['project'],'uploads':[]}
        module=sys.modules[type(self.store).__module__]
        rows=[]
        for path in sorted(folder.glob('*.json')):
            if len(rows)>=64:raise ValueError('Too many pending uploads; inspect node state')
            if not HASH.fullmatch(path.stem):raise ValueError('Invalid pending upload metadata name')
            value=module.read_json(path);record=self.upload_identity(value.get('identity',value))
            if hashlib.sha256(record['path'].encode()).hexdigest()!=path.stem:raise ValueError('Pending upload path identity differs')
            part=path.with_suffix('.part');size=0
            try:
                info=part.lstat()
                if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid() or info.st_mode&0o022 or info.st_size>record['totalSize']:
                    raise ValueError('Unsafe upload staging')
                size=info.st_size
            except FileNotFoundError:pass
            state=value.get('state','UNKNOWN')
            modern='identity' in value and state in ('UPLOADING','CANCELING') and 'baseTarget' in value
            legacy=self.legacy_upload_partial(folder,path,value,record) is not None
            canceling=(folder/(record['uploadId']+'.legacy-cancel')).exists()
            rows.append({**record,'state':'CANCELING' if canceling else state,'receivedBytes':size,
                         'cancelable':modern or legacy or canceling,'legacy':'identity' not in value})
        return {'protocol':1,'project':args['project'],'uploads':rows}

    def legacy_upload_partial(self,folder,meta,value,record):
        """Only provably partial old staging; never infer a commit from absence."""
        if set(value)!=set(record) or value!=record:return None
        module=sys.modules[type(self.store).__module__]
        try:
            with module.directory(folder):pass
            part=meta.with_suffix('.part');info=part.lstat()
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.geteuid()
                    or info.st_mode&0o077 or not 0<=info.st_size<record['totalSize']):return None
            done=module.read_json(meta.with_suffix('.done')) if meta.with_suffix('.done').exists() else None
            if done is not None and (not isinstance(done,dict) or not isinstance(done.get('identity'),dict)
                                     or done['identity'].get('uploadId')==record['uploadId']):return None
            # Atomic no-replace is required before recording a cancellation.
            if getattr(ctypes.CDLL(None,use_errno=True),'renameat2',None) is None:return None
            return {'identity':record,'metaSha256':hashlib.sha256(module.canonical(value)).hexdigest(),
                    'partIdentity':[info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns]}
        except FileNotFoundError:return None

    @staticmethod
    def upload_quarantine_move(source_fd,source,target_fd,target):
        function=getattr(ctypes.CDLL(None,use_errno=True),'renameat2',None)
        if function is None:raise ValueError('Atomic no-replace upload quarantine is unavailable')
        function.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint]
        function.restype=ctypes.c_int
        if function(source_fd,os.fsencode(source),target_fd,os.fsencode(target),1):
            code=ctypes.get_errno();raise OSError(code,os.strerror(code),target)

    def legacy_upload_cancel(self,folder,upload,receipt=None):
        """Durable tombstone first; retain original metadata and partial bytes.

        Called only under the same project guard + store lock as files.put.
        A lost response continues this original quarantine, never a new upload.
        """
        module=sys.modules[type(self.store).__module__]
        module.private_dir(folder)
        intent_path=folder/(upload+'.legacy-cancel')
        try:intent=module.read_json(intent_path)
        except FileNotFoundError:intent=None
        if intent is None:
            if receipt is not None:return None
            candidates=[]
            for meta in folder.glob('*.json'):
                value=module.read_json(meta);record=self.upload_identity(value.get('identity',value))
                if record['uploadId']==upload:
                    if not HASH.fullmatch(meta.stem) or hashlib.sha256(record['path'].encode()).hexdigest()!=meta.stem:
                        raise ValueError('Pending upload path identity differs')
                    proof=self.legacy_upload_partial(folder,meta,value,record)
                    if proof is None:return None
                    candidates.append(proof)
            if len(candidates)!=1:return None
            intent={'protocol':1,'uploadId':upload,**candidates[0]}
            self.n.atomic_json(intent_path,intent)
        if (not isinstance(intent,dict) or set(intent)!={'protocol','uploadId','identity','metaSha256','partIdentity'}
                or intent.get('protocol')!=1 or intent.get('uploadId')!=upload
                or not isinstance(intent.get('metaSha256'),str) or not HASH.fullmatch(intent['metaSha256'])
                or not isinstance(intent.get('partIdentity'),list) or len(intent['partIdentity'])!=4
                or any(type(v)!=int or v<0 for v in intent['partIdentity'])):
            raise ValueError('Invalid legacy upload cancellation intention')
        record=self.upload_identity(intent['identity'])
        if (record['uploadId']!=upload or set(intent['identity'])!=set(record)
                or intent['partIdentity'][2]>=record['totalSize']
                or hashlib.sha256(module.canonical(record)).hexdigest()!=intent['metaSha256']):
            raise ValueError('Legacy upload cancellation identity changed')
        key=hashlib.sha256(record['path'].encode()).hexdigest()
        quarantine=module.private_dir(folder/'.canceled-staging',create=True)
        quarantine=module.private_dir(quarantine/upload,create=True)
        # Validate both original files or their already-moved counterparts before
        # making the permanent cancellation receipt. No existing destination wins.
        def verify(source,target,metadata=False):
            sources=[path for path in (folder/source,quarantine/target) if path.exists() or path.is_symlink()]
            if len(sources)!=1:raise ValueError('Legacy upload quarantine outcome is unconfirmed')
            path=sources[0]
            if metadata:
                if module.read_json(path)!=record:raise ValueError('Legacy upload metadata changed')
            else:
                info=path.lstat()
                if (not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or info.st_mode&0o077
                        or [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns]!=intent['partIdentity']):
                    raise ValueError('Legacy upload partial bytes changed')
            return path==folder/source
        move_meta=verify(key+'.json','metadata.json',True);move_part=verify(key+'.part','partial.part')
        # Persist the quarantine's own parent link before either source rename.
        # Fsync of the new directory alone would not preserve that link at crash.
        with module.directory(quarantine.parent) as parent_fd:os.fsync(parent_fd)
        canceled={'protocol':1,'state':'CANCELED','uploadId':upload}
        self.n.atomic_json(folder/(upload+'.canceled'),canceled)
        with module.directory(folder) as source_fd,module.directory(quarantine) as target_fd:
            # Metadata moves last: an interrupted quarantine must still block
            # publication and project retirement until all partial bytes moved.
            for source,target,moving,metadata in ((key+'.part','partial.part',move_part,False),(key+'.json','metadata.json',move_meta,True)):
                if moving:
                    verify(source,target,metadata)
                    self.upload_quarantine_move(source_fd,source,target_fd,target)
                    os.fsync(target_fd);os.fsync(source_fd)
            verify(key+'.json','metadata.json',True);verify(key+'.part','partial.part')
        return canceled

    def upload_cancel(self,args,root):
        upload=args.get('uploadId')
        if not isinstance(upload,str) or not UUID.fullmatch(upload):raise ValueError('Use an exact pending upload UUID')
        folder=self.folder/(self.key(args)+'.uploads')
        module=sys.modules[type(self.store).__module__]
        canceled=folder/(upload+'.canceled')
        try:receipt=module.read_json(canceled)
        except FileNotFoundError:receipt=None
        if receipt is not None:
            if receipt!={'protocol':1,'state':'CANCELED','uploadId':upload}:raise ValueError('Invalid upload cancellation receipt')
        legacy=self.legacy_upload_cancel(folder,upload,receipt) if folder.exists() else None
        if legacy is not None:return legacy
        rows=[row for row in self.upload_list(args,root)['uploads'] if row['uploadId']==upload]
        if not rows:return receipt or {'protocol':1,'state':'ABSENT','uploadId':upload}
        if receipt is not None and any(row['state']!='CANCELING' for row in rows):raise ValueError('Cancellation receipt conflicts with pending upload state')
        if len(rows)!=1 or not rows[0]['cancelable']:raise ValueError('Upload commit or legacy outcome is unconfirmed; preserve its metadata and use exact status/recovery')
        record={k:rows[0][k] for k in ('path','uploadId','totalSize','sha256')}
        key=hashlib.sha256(record['path'].encode()).hexdigest();meta=folder/(key+'.json');part=folder/(key+'.part')
        value=module.read_json(meta)
        if value.get('identity')!=record or self.upload_target(root,record['path'])!=value.get('baseTarget'):
            raise ValueError('Upload target changed; cancellation cannot discard unconfirmed evidence')
        self.n.atomic_json(meta,{**value,'state':'CANCELING'})
        # Only this unpublished, private staging file is removed. Draft code,
        # READY releases and historical completion receipts remain untouched.
        part.unlink(missing_ok=True)
        receipt={'protocol':1,'state':'CANCELED','uploadId':upload}
        self.n.atomic_json(canceled,receipt)
        meta.unlink()
        fd=os.open(folder,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:os.fsync(fd)
        finally:os.close(fd)
        return receipt

    @staticmethod
    def upload_stamp(info):
        return [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns]

    def upload_target(self, root, path, *, digest=False):
        """No-follow traversal. A receipt never grants access to another path."""
        parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        fd=None
        try:
            parts=path.split('/')
            for component in parts[:-1]:
                child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                os.close(parent);parent=child
            # Keep the existing explicit-upload ability to replace a symlink,
            # but never hash or follow it while recovering a completed upload.
            info=os.stat(parts[-1],dir_fd=parent,follow_symlinks=False)
            if not digest:return self.upload_stamp(info)
            fd=os.open(parts[-1],os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1:raise ValueError('Unsafe completed upload target')
            value=hashlib.sha256()
            while True:
                data=os.read(fd,1024**2)
                if not data:break
                value.update(data)
            after=os.fstat(fd)
            if self.upload_stamp(before)!=self.upload_stamp(after):raise ValueError('Completed upload target changed during verification')
            if self.upload_stamp(os.stat(parts[-1],dir_fd=parent,follow_symlinks=False))!=self.upload_stamp(after):
                raise ValueError('Completed upload target was replaced during verification')
            return {'stamp':self.upload_stamp(after),'size':after.st_size,'sha256':value.hexdigest()}
        except FileNotFoundError:return None
        finally:
            if fd is not None:os.close(fd)
            os.close(parent)

    def upload_status(self, args, root, *, _stamp=False):
        wanted=self.upload_identity(args,required=False)
        folder=self.folder/(self.key(args)+'.uploads')
        if wanted['uploadId'] is not None and (folder/(wanted['uploadId']+'.legacy-cancel')).exists():
            module=sys.modules[type(self.store).__module__]
            intent=module.read_json(folder/(wanted['uploadId']+'.legacy-cancel'))
            if intent.get('identity')!=wanted:
                return {'protocol':2,'state':'CONFLICT','complete':False,'path':wanted['path'],'receivedBytes':0}
            pending=folder/(hashlib.sha256(wanted['path'].encode()).hexdigest()+'.json')
            state='CANCELING'
            if not pending.exists():
                receipt=module.read_json(folder/(wanted['uploadId']+'.canceled'))
                quarantine=module.private_dir(folder/'.canceled-staging'/wanted['uploadId'])
                metadata=module.read_json(quarantine/'metadata.json');info=(quarantine/'partial.part').lstat()
                if (receipt!={'protocol':1,'state':'CANCELED','uploadId':wanted['uploadId']} or metadata!=wanted
                        or not stat.S_ISREG(info.st_mode) or info.st_uid!=os.geteuid() or info.st_nlink!=1 or info.st_mode&0o077
                        or [info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns]!=intent.get('partIdentity')):
                    raise ValueError('Legacy upload cancellation outcome is unconfirmed')
                state='CANCELED'
            return {'protocol':2,'state':state,'complete':False,
                    **wanted,'receivedBytes':0,'resumable':False,'legacy':True}
        key=hashlib.sha256(wanted['path'].encode()).hexdigest()
        meta,part,done=(folder/(key+suffix) for suffix in ('.json','.part','.done'))
        active=json.loads(meta.read_text()) if meta.exists() else None
        complete=json.loads(done.read_text()) if done.exists() else None
        def matches(record):
            return (isinstance(record,dict) and all(record.get(k)==wanted[k] for k in ('path','totalSize','sha256'))
                    and (wanted['uploadId'] is None or record.get('uploadId')==wanted['uploadId']))
        if active is not None:
            record=active.get('identity',active)
            if not matches(record):
                # An explicit new push can replace unfinished different input,
                # as before. A recovery query with an existing ID may not.
                return {'protocol':2,'state':'ABSENT' if wanted['uploadId'] is None and 'identity' in active else 'CONFLICT',
                        'complete':False,'path':wanted['path'],'receivedBytes':0}
            if active.get('state')=='CANCELING':
                return {'protocol':2,'state':'CANCELING','complete':False,**record,'receivedBytes':0,'resumable':False}
            if active.get('state')=='COMMITTING' and not part.exists():
                # The data rename can finish before the durable receipt (or
                # active-intent removal). Status remains read-only; the client
                # must finalize this exact identity before publication.
                if complete is None or complete.get('identity')!=record:complete={'identity':record}
            else:
                if 'baseTarget' in active and self.upload_target(root,record['path'])!=active['baseTarget']:
                    return {'protocol':2,'state':'CONFLICT','complete':False,'path':record['path'],'error':'Target changed during upload'}
                size=0
                if part.exists():
                    info=part.lstat()
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>record['totalSize']:
                        raise ValueError('Unsafe upload staging')
                    size=info.st_size
                if active.get('state')=='COMMITTING' and size!=record['totalSize']:
                    raise ValueError('Incomplete committing upload; preserve staging for inspection')
                return {'protocol':2,'state':'UPLOADING','complete':False,**record,'receivedBytes':size,
                        'resumable':active.get('state') in ('UPLOADING','COMMITTING'),'legacy': 'identity' not in active}
        if complete is not None and matches(complete.get('identity')):
            record=complete['identity'];target=self.upload_target(root,record['path'],digest=True)
            if (not target or target['size']!=record['totalSize'] or target['sha256']!=record['sha256']
                    or complete.get('targetStamp',target['stamp'])!=target['stamp']):
                return {'protocol':2,'state':'CONFLICT','complete':False,'path':record['path'],'error':'Completed target changed; it was not overwritten'}
            return {'protocol':2,'state':'COMPLETE','complete':True,**record,'size':target['size'],'receivedBytes':target['size'],
                    'completionPending':active is not None,
                    **({'_targetStamp':target['stamp']} if _stamp else {})}
        return {'protocol':2,'state':'ABSENT','complete':False,'path':wanted['path'],'receivedBytes':0}

    def upload(self, args, root):
        record=self.upload_identity(args)
        path, upload, total, digest=(record[k] for k in ('path','uploadId','totalSize','sha256'))
        offset=args.get('offset');parts=path.split('/')
        if type(offset)!=int or not 0<=offset<=total:
            raise ValueError('Code upload offset is outside this exact file')
        if not isinstance(digest,str) or not HASH.fullmatch(digest) or type(args.get('final')) is not bool:
            raise ValueError('Upload requires checksum and final marker')
        data = base64.b64decode(args.get('data',''),validate=True)
        if len(data)>1024**2 or offset+len(data)>total: raise ValueError('Invalid upload chunk')
        folder = self.transfer_dir(args)
        if (folder/(upload+'.canceled')).exists():raise ValueError('This exact upload was canceled; choose a new explicit upload identity')
        if (folder/(upload+'.legacy-cancel')).exists():raise ValueError('Upload cancellation is pending; finish canceling its original UUID first')
        # At most one in-flight version of a path; retrying with a new UUID
        # replaces only its unfinished staging, never the published code file.
        key = hashlib.sha256(path.encode()).hexdigest()
        meta, part = folder/(key+'.json'), folder/(key+'.part')
        done=folder/(key+'.done')
        prior = json.loads(meta.read_text()) if meta.exists() else None
        prior_identity=prior.get('identity',prior) if prior is not None else None
        if prior is not None and prior.get('state')=='CANCELING':raise ValueError('Upload cancellation is pending; finish canceling its original UUID first')
        completed=json.loads(done.read_text()) if done.exists() else None
        if (completed is not None and completed.get('identity')==record) or (prior_identity==record and prior.get('state')=='COMMITTING' and not part.exists()):
            current=self.upload_status(args,root,_stamp=True)
            if current['state']!='COMPLETE':raise ValueError('Completed upload target changed; refusing to overwrite it during recovery')
            target_stamp=current.pop('_targetStamp')
            if meta.exists():
                self.n.atomic_json(done,{'identity':record,'targetStamp':target_stamp})
                meta.unlink()
            current['completionPending']=False
            return current
        if prior_identity != record:
            if offset: raise ValueError('Upload identity changed; restart this file')
            if len(list(folder.glob('*.json')))>=64 and prior is None: raise ValueError('Too many unfinished uploads')
            self.store._space(len(data))
            prior={'identity':record,'state':'UPLOADING','baseTarget':self.upload_target(root,path)}
            part.unlink(missing_ok=True)
            # Never label old partial bytes as a new upload if the process dies
            # between metadata commit and removing the replaced staging file.
            self.n.atomic_json(meta, prior)
        fd = os.open(part,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1: raise ValueError('Unsafe upload staging')
            # A retried already-accepted chunk is harmless and not appended twice.
            if info.st_size >= offset+len(data) and os.pread(fd,len(data),offset)==data:
                pass
            elif info.st_size == offset:
                self.store._space(len(data))
                os.lseek(fd,offset,0)
                view=memoryview(data)
                while view: view=view[os.write(fd,view):]
                os.fsync(fd)
            else: raise ValueError('Upload offset mismatch; restart this file')
            size=os.fstat(fd).st_size
            if not args['final']: return {'path':path,'size':size,'complete':False}
            if size!=total or offset+len(data)!=total: raise ValueError('Final upload size mismatch')
            os.lseek(fd,0,0);hasher=hashlib.sha256()
            while True:
                chunk=os.read(fd,1024**2)
                if not chunk:break
                hasher.update(chunk)
            if hasher.hexdigest()!=digest: raise ValueError('Upload SHA256 mismatch; retry the file')
            if 'baseTarget' in prior and self.upload_target(root,path)!=prior['baseTarget']:
                raise ValueError('Project target changed during upload; no replacement was made. Pause same-path terminal edits before uploading')
            self.n.atomic_json(meta,{**prior,'identity':record,'state':'COMMITTING'})
            parent=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
            try:
                for component in parts[:-1]:
                    try:os.mkdir(component,mode=0o700,dir_fd=parent)
                    except FileExistsError:pass
                    child=os.open(component,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=parent)
                    os.close(parent);parent=child
                os.replace(part,parts[-1],dst_dir_fd=parent);os.fsync(parent)
            finally:os.close(parent)
            target_stamp=self.upload_target(root,path)
            current_stamp=self.upload_stamp(os.fstat(fd))
            if target_stamp!=current_stamp or current_stamp[2]!=total:raise ValueError('Committed upload requires verification before recovery')
            self.n.atomic_json(done,{'identity':record,'targetStamp':target_stamp})
            meta.unlink()
            return {'path':path,'size':total,'complete':True,'sha256':digest}
        finally:os.close(fd)

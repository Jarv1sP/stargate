#!/usr/bin/python3
"""Private mutable data folders, separate from immutable training datasets.

Only this module derives host paths. The namespace terminal receives the data
directory by FD, never the cache or metadata directories containing it.
"""
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
import time

UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')
NAME = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,39}\Z')


class DataWorkspaces:
    def __init__(self, executor):
        self.n = executor

    def cleanups(self):
        spec = importlib.util.spec_from_file_location('gpuq_workspace_cleanup', self.n.HERE/'workspace-cleanup.py')
        module = importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        return module.WorkspaceCleanup(self)

    def storage(self, user):
        self.n.workspace(user)
        module, cache = self.n.dataset_cache()  # revalidate the actual data mount
        root = cache.root/'.workspaces'
        owner = root/hashlib.sha256(user.encode()).hexdigest()
        for path in (root, owner, owner/'data', owner/'operations'):
            module._mkdir(path)
            if path == owner and 'storageQuota' in self.n.CONFIG:
                self.n.storage_quota(user, owner)
        return module, cache, owner

    @staticmethod
    def relative(path, root=False):
        if root and path == '.':
            return []
        if (not isinstance(path, str) or not path or len(path) > 1024 or path.startswith('/')
                or '\\' in path or any(ord(c) < 32 or ord(c) == 127 for c in path)):
            raise ValueError('Use a relative path inside your personal /data2 folder')
        parts = path.split('/')
        if any(part in ('', '.', '..') or len(part.encode()) > 255 for part in parts):
            raise ValueError('Use a relative path inside your personal /data2 folder')
        return parts

    @contextmanager
    def guard(self, args, blocking=False):
        module, _, owner = self.storage(args['userId'])
        with module._directory(owner) as parent:
            fd = os.open('operation.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            module._regular(fd)
            fcntl.flock(fd, fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
            yield
        finally:
            os.close(fd)

    def lifetime(self, user, exclusive=False):
        module, _, owner = self.storage(user)
        with module._directory(owner) as parent:
            fd = os.open('lifetime.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            module._regular(fd)
            fcntl.flock(fd, (fcntl.LOCK_EX if exclusive else fcntl.LOCK_SH) | fcntl.LOCK_NB)
            return fd
        except BaseException:
            os.close(fd)
            raise ValueError('Personal data workspace is busy; close its terminals or wait for publication') from None

    @staticmethod
    def unit(user, key):
        # Request UUIDs are user-chosen, not a cross-account namespace.
        return 'gpuq-workspace-'+hashlib.sha256((user+'\0'+key).encode()).hexdigest()[:32]

    def unit_stopped(self, unit):
        result = subprocess.run(['/usr/bin/systemctl', '--user', 'show', unit,
            '--property=LoadState,ActiveState,SubState,MainPID,ControlGroup'],
            env=self.n.ENV, text=True, capture_output=True, timeout=5)
        props = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
        if set(props) != {'LoadState','ActiveState','SubState','MainPID','ControlGroup'}:
            return False
        if result.returncode and not (result.returncode == 1 and props['LoadState'] == 'not-found'):
            return False
        quiet = props['ActiveState'] in ('inactive', 'failed') or (props['ActiveState'] == 'active' and props['SubState'] == 'exited')
        if props['MainPID'] != '0' or not quiet:
            return False
        group = props['ControlGroup']
        if not group:
            return props['LoadState'] in ('loaded', 'not-found')
        if not group.startswith('/') or '..' in Path(group).parts or Path(group).name != unit:
            return False
        path = Path('/sys/fs/cgroup')/group.lstrip('/')
        try:
            events = dict(line.split() for line in (path/'cgroup.events').read_text().splitlines())
        except FileNotFoundError:
            return not path.exists()
        return events.get('populated') == '0'

    def pending(self, user):
        module, _, owner = self.storage(user)
        try:
            current = module._read_json(owner/'current.json')
        except FileNotFoundError:
            return None
        key = current.get('operationId')
        if not isinstance(key, str) or not UUID.fullmatch(key):
            raise ValueError('Invalid personal data publication pointer')
        return self.receipt(user, key)

    def receipt(self, user, key):
        if not isinstance(key, str) or not UUID.fullmatch(key):
            raise ValueError('Invalid data publication ID')
        module, _, owner = self.storage(user)
        task = module._read_json(owner/'operations'/(key+'.json'))
        if task.get('userId') != user or task.get('operationId') != key:
            raise ValueError('Data publication is not owned by this user')
        return task

    def writable(self, args):
        _,_,owner=self.storage(args['userId'])
        if (owner/'project-import.json').exists():
            self.n.projects().local_imports().data_writable(args['userId'])
        pending = self.pending(args['userId'])
        # A missing/failed unit never converts a pending record into permission
        # to edit. Its launch could have timed out before systemd accepted it.
        if pending and pending.get('state') not in ('READY', 'FAILED'):
            raise ValueError('Data publication is pending; wait for completion before editing or opening a data terminal')

    def no_terminals(self, user):
        folder = self.n.ROOT/'terminals'
        if not folder.exists():
            return
        for path in folder.glob('*.json'):
            if not UUID.fullmatch(path.stem):
                continue
            spec = self.n.terminal_metadata(path)
            if spec.get('userId') == user and spec.get('dataWorkspace') is True:
                if not self.unit_stopped('amax-term-'+path.stem+'.service'):
                    raise ValueError('Close all personal data terminals before publishing; a terminal is running or its termination is unconfirmed')

    def terminal_mount(self, spec, jid):
        if (spec.get('dataWorkspace') is not True or spec.get('project')
                or spec.get('hostAdmin') is True or spec.get('cards') != 0
                or not isinstance(jid, str) or not UUID.fullmatch(jid)):
            raise ValueError('Invalid personal data terminal specification')
        module, _, owner = self.storage(spec['userId'])
        lock = self.lifetime(spec['userId'])
        try:
            self.writable(spec)
            with module._directory(owner/'data') as data:
                fd = os.dup(data)
            return fd, lock
        except BaseException:
            os.close(lock)
            raise

    def public(self, task):
        return {key: task[key] for key in ('operationId', 'state', 'path', 'name', 'dataset', 'version', 'files', 'bytes', 'error', 'phase', 'failureKind', 'lockWait') if key in task}

    def status(self, user, key=None):
        task = self.receipt(user, key) if key else self.pending(user)
        if not task:
            return {'state': 'EDITABLE', 'mountPath': '/data2'}
        result = self.public(task)
        if task['state'] == 'READY':
            module, cache, _ = self.storage(user)
            try:
                with module.wait_for_locks(timeout=5, total=8):
                    current = cache.status(module.Principal(user, False), task['dataset'], task['version'])
                if current['state'] != 'READY':
                    result.update(state='NOT_READY', publicationState='READY',
                        error='This publication completed previously, but its local dataset copy is no longer ready. Publish the prepared personal directory again with a new request key.')
            except FileNotFoundError:
                result.update(state='UNREGISTERED', publicationState='READY',
                    error='This publication completed previously, but the dataset registration was removed. Publish the prepared personal directory again with a new request key.')
            except PermissionError:
                result.update(state='UNAVAILABLE', publicationState='READY',
                    error='This publication completed previously, but the dataset is no longer assigned to this account. Contact an administrator.')
        if task['state'] == 'PUBLISHING':
            try:
                stopped = self.unit_stopped(self.unit(user, task['operationId'])+'.service')
            except (OSError, subprocess.SubprocessError):
                stopped = True
            if stopped:
                result.update(state='UNKNOWN', error='Publication outcome is unconfirmed; do not edit this workspace. Ask an administrator to inspect the publication worker before retrying.')
        if not key:
            result['mountPath'] = '/data2'
            result['editable'] = task['state'] in ('READY', 'FAILED')
        return result

    def publish(self, args):
        if self.n.CONFIG.get('storageTier',{}).get('enabled') is True:
            raise PermissionError('Dataset originals must be published in the HDD warehouse, not a training cache')
        user, key, name, path = args['userId'], args.get('key'), args.get('name'), args.get('path')
        if not isinstance(key, str) or not UUID.fullmatch(key):
            raise ValueError('A valid publication key is required')
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError('Dataset name must be 1–40 letters, digits, underscores or hyphens')
        self.relative(path)
        module, cache, owner = self.storage(user)
        location = owner/'operations'/(key+'.json')
        try:
            previous = self.receipt(user, key)
        except FileNotFoundError:
            previous = None
        if previous:
            if previous['path'] != path or previous['name'] != name:
                raise ValueError('Publication key belongs to a different request')
            return self.status(user, key)
        self.writable(args)
        self.no_terminals(user)
        lock = self.lifetime(user, exclusive=True)
        try:
            with module._directory(owner/'data'/path):
                pass
            with cache._locked():
                cache._free(cache._reserved()+65536)
            task = {'userId': user, 'operationId': key, 'path': path, 'name': name,
                    'state': 'PUBLISHING', 'createdAt': time.time()}
            module._write_json(location, task)
            module._write_json(owner/'current.json', {'operationId': key})
            # Marker precedes launch. An ambiguous launcher failure must leave
            # writes fenced, never erase the operation or silently re-launch it.
            self.n.run(['/usr/bin/systemd-run', '--user', '--collect',
                '--unit='+self.unit(user, key), '--property=KillMode=control-group',
                '--property=UMask=0077', '--property=CPUQuota=100%', '--property=MemoryMax=2G',
                '--property=IOWeight=10', '--property=RuntimeMaxSec=86400', '--property=TimeoutStopSec=20',
                '/usr/bin/python3', str(self.n.HERE/'node-executor.py'), '--data-workspace-worker', user, key], timeout=8)
            return self.public(task)
        finally:
            os.close(lock)

    def worker(self, user, key):
        module, _ = self.n.dataset_cache()
        with module.wait_for_locks():
            return self._worker(user, key)

    def _worker(self, user, key):
        args = {'userId': user}
        # Opening holds guard through systemd startup. Wait here; the lifetime
        # exclusive lock is acquired before guard is released for status reads.
        with self.guard(args, blocking=True):
            task = self.receipt(user, key)
            pending = self.pending(user)
            if not pending or pending['operationId'] != key or task['state'] != 'PUBLISHING':
                raise ValueError('Publication worker no longer owns this workspace')
            self.no_terminals(user)
            lock = self.lifetime(user, exclusive=True)
        module, cache, owner = self.storage(user)
        def checkpoint(phase, **facts):
            nonlocal task
            task = {**task, **facts, 'phase': phase}
            module._write_json(owner/'operations'/(key+'.json'), task)

        try:
            if self.n.CONFIG.get('storageTier',{}).get('enabled') is True:
                raise PermissionError('Dataset originals must be published in the HDD warehouse, not a training cache')
            source = owner/'data'/task['path']
            self.relative(task['path'])
            checkpoint('SCANNING')
            manifest = module._scan(source)  # FD traversal rejects links/special files
            total = sum(entry['size'] for entry in manifest['files'])
            limit = self.n.CONFIG.get('datasets', {}).get('uploads', {}).get('maxUploadBytes', 1024**4)
            if total > limit:
                raise ValueError('Dataset exceeds the configured publication size limit')
            # Do not mutate a direct-upload registration (u- namespace): its
            # transfer binds the registry identity including sourceId=None.
            dataset = 'w-'+hashlib.sha256(user.encode()).hexdigest()[:16]+'-'+task['name']
            actor = module.Principal(user, False)
            internal = module.Principal(user, True)
            # Internal-only source: no arbitrary client path, no configuration
            # mutation and no globally reusable approved source. Evicted copies
            # are republished explicitly from the personal workspace.
            source_id = 'workspace-'+hashlib.sha256((user+'\0'+dataset).encode()).hexdigest()[:40]
            cache.sources[source_id] = source
            checkpoint('REGISTERING', files=len(manifest['files']), bytes=total)
            # Bind source and creation provenance in the same metadata commit.
            # An existing historical registration is never upgraded to personal
            # merely because its name/owner matches this workspace.
            with cache._new_registration(internal,dataset,manifest,[user],source_id,origin='workspace',receipt=key,explicit=True),cache._locked():
                registered = cache._register(internal, dataset, manifest, [user], source_id,
                                             _origin='workspace', _receipt=key)
            checkpoint('REGISTERED', **registered)
            archive = None
            if self.n.CONFIG.get('storageArchive', {}).get('enabled') is True:
                checkpoint('ARCHIVE_INTENT')
                archive = self.n.storage_archive()
                intent = archive.outbox_begin({'opId': key, 'userId': user,
                    'reference': {'dataset': dataset, 'version': registered['version']}, 'origin': 'workspace'})
            checkpoint('MATERIALIZING')
            result = cache.materialize(actor, dataset, registered['version'])
            receipt = {**task, **registered, 'state': result['state'], 'phase': 'COMPLETED', 'completedAt': time.time()}
            if archive is not None and result['state'] == 'READY':
                # The durable intent also recovers a crash between publication
                # and this acknowledgement. The writable draft is not a cache.
                try:
                    archive.outbox_ready({'opId': intent['id'], 'userId': user})
                except Exception:
                    # Publication already committed. Never misreport it as
                    # failed or delete it because the outbox ack was lost.
                    # The previously durable intent is reconciled separately.
                    pass
        except Exception as error:
            receipt = {**task, 'state': 'FAILED', 'error': self.n.dataset_error(error), 'completedAt': time.time()}
            if isinstance(error, module.CacheBusy):
                receipt['failureKind'] = 'CACHE_BUSY'
                if getattr(error, 'lock_wait', None) is not None:
                    receipt['lockWait'] = error.lock_wait
        finally:
            # Result is durable before writers are allowed back in. If saving
            # it fails, PUBLISHING remains a fail-closed recovery fence.
            try:
                with self.guard(args, blocking=True):
                    module._write_json(owner/'operations'/(key+'.json'), receipt)
            finally:
                os.close(lock)
        return 0 if receipt['state'] == 'READY' else 1

    def recover(self, user, key):
        """Local maintenance only; deliberately absent from the remote API.

        A durable FAILED fence also prevents a late, previously queued worker
        from starting. Never terminate processes or delete data/registrations.
        """
        args = {'userId': user}
        with self.guard(args):
            task = self.receipt(user, key)
            pending = self.pending(user)
            if not pending or pending['operationId'] != key:
                raise ValueError('Only the current personal data publication can be recovered')
            if task['state'] in ('READY', 'FAILED'):
                return self.public(task)
            if task['state'] != 'PUBLISHING' or not self.unit_stopped(self.unit(user, key)+'.service'):
                raise ValueError('Publication worker termination is not confirmed; no recovery change made')
            self.no_terminals(user)
            lock = self.lifetime(user, exclusive=True)
            try:
                module, _, owner = self.storage(user)
                receipt = {**task, 'state': 'FAILED', 'completedAt': time.time(),
                    'error': 'Interrupted publication was unlocked by administrator after confirming all writers stopped. Source files and existing dataset versions were retained; publish again with a new request key.'}
                module._write_json(owner/'operations'/(key+'.json'), receipt)
                return self.public(receipt)
            finally:
                os.close(lock)

    def process(self, operation, args):
        fields = {'list': {'path'}, 'put': {'path','offset','data','truncate'},
                  'get': {'path','offset'}, 'status': {'operationId'}, 'publish': {'path','name','key'},
                  'remove-plan': {'path','recursive'}, 'remove': {'path','recursive','key'}, 'remove-status': {'key'}}
        action = operation.removeprefix('datasets.workspace.')
        if (not isinstance(args, dict) or action not in fields
                or set(args)-fields[action]-{'userId','hostAdmin'}
                or type(args.get('hostAdmin', False)) is not bool or args.get('hostAdmin', False)):
            raise ValueError('Invalid personal data workspace request')
        module, cache, owner = self.storage(args.get('userId'))
        if action == 'remove-plan':return self.cleanups().plan(args['userId'], args.get('path'), args.get('recursive', False))
        if action == 'remove-status':return self.cleanups().status(args['userId'], args.get('key'))
        if action == 'remove':return self.cleanups().remove(args)
        if action == 'status':
            return self.status(args['userId'], args.get('operationId'))
        with self.guard(args):
            if action == 'publish':
                return self.publish(args)
            self.relative(args.get('path', '.'), root=action == 'list')
            if action == 'put':
                self.writable(args)
                if type(args.get('truncate', False)) is not bool:
                    raise ValueError('Invalid truncate flag')
                with cache._locked():
                    cache._free(cache._reserved()+1024*1024+65536)
            result = self.n.file_op('files.'+action, args, root=owner/'data')
            return {**result, 'path': args.get('path', '.'), 'cleanupProtocol': 1} if action == 'list' else result

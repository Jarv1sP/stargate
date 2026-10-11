"""Owner project archive and unused-project retirement, never host deletion.

Display/group metadata lives in the portal. Immutable project/release/run
identities stay unchanged. A retired slug is permanently fenced; bytes move
to a private same-filesystem trash directory and are not purged by this API.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import time

PROTOCOL = 'project-lifecycle-v1'


class ProjectLifecycle:
    def __init__(self, operations):
        self.ops, self.n, self.store = operations, operations.n, operations.store
        self.s = sys.modules[type(self.store).__module__]

    def identity(self, args, action):
        allowed = {'userId', 'project'} | ({'revision'} if action in ('archive', 'unarchive') else
                  {'key', 'manifestSha256', 'revision'} if action == 'retire' else
                  {'key'} if action == 'retire-status' else set())
        if not isinstance(args, dict) or set(args) != allowed:
            raise ValueError('Invalid project lifecycle fields')
        self.ops.identity(args)
        if 'revision' in args and (type(args['revision']) is not int or not 0 <= args['revision'] < 9007199254740991):
            raise ValueError('Use the exact current lifecycle revision')
        if 'key' in args and (not isinstance(args['key'], str) or not self.s.JOB_ID.fullmatch(args['key'])):
            raise ValueError('Use the original complete retirement UUID')
        if 'manifestSha256' in args and (not isinstance(args['manifestSha256'], str) or not self.s.VERSION.fullmatch(args['manifestSha256'])):
            raise ValueError('Use the exact retirement plan digest')

    def view(self, user, project):
        value = self.store.lifecycle(user, project)
        return {'protocol': PROTOCOL, 'project': project, 'state': value['state'], 'revision': value['revision'],
                **{k: value[k] for k in ('updatedAt', 'retiredAt', 'retirementId', 'manifestSha256') if k in value}}

    def writer_blockers(self, args, *, synchronization=True):
        blockers = []
        # Caller holds the exact project publication lock. Do not reacquire
        # it on another descriptor and misclassify our own lock as a writer.
        try: self.ops.writable(args, lifecycle=False, publication_lock=False,synchronization=synchronization)
        except (OSError, ValueError): blockers.append({'kind': 'writer', 'reason': 'Draft writer or outcome is unconfirmed'})
        pending = self.ops.pending(args)
        if pending.get('state') in ('PUBLISHING', 'UNKNOWN') or self.ops.active(args):
            blockers.append({'kind': 'publication', 'reason': 'Publication is active or unconfirmed'})
        uploads = self.ops.folder / (self.ops.key(args) + '.uploads')
        if uploads.exists():
            self.s.private_dir(uploads)
            if any(uploads.glob('*.json')): blockers.append({'kind': 'upload', 'reason': 'Unfinished upload; inspect and cancel its original UUID'})
        folder = self.n.ROOT / 'terminals'
        if folder.exists():
            self.s.private_dir(folder)
            paths = list(folder.glob('*.json'))
            if len(paths) > 20000: raise ValueError('Terminal history is too large to confirm safely')
            for path in paths:
                if not self.s.JOB_ID.fullmatch(path.stem): continue
                spec = self.s.read_json(path)
                if spec.get('userId') == args['userId'] and spec.get('project') == args['project']:
                    if not self.ops.terminal_stopped(path.stem):
                        blockers.append({'kind': 'terminal', 'id': path.stem, 'reason': 'Terminal process group is not confirmed stopped'})
        copies = self.n.ROOT / 'project-copies'
        if copies.exists():
            self.s.private_dir(copies)
            paths = list(copies.glob('*.json'))
            if len(paths) > 100000: raise ValueError('Project copy history is too large to confirm safely')
            for path in paths:
                if not self.s.JOB_ID.fullmatch(path.stem): continue
                spec = self.s.read_json(path)
                if spec.get('userId') != args['userId'] or spec.get('project') != args['project']: continue
                helper = self.n.project_copies()
                try: result = helper.load(path.stem, '.result.json')
                except FileNotFoundError: result = {}
                quiet = helper.activity(helper.unit(path.stem, spec.get('attempt'))) is False
                final = result.get('attempt') == spec.get('attempt') and result.get('state') in ('READY', 'SUCCEEDED', 'CANCELED', 'FAILED')
                export_reader = spec.get('role') == 'export' and not (helper.path(path.stem, '.revoked').exists() or helper.path(path.stem, '.cancel').exists())
                if not quiet or not final or export_reader:
                    blockers.append({'kind': 'copy', 'id': path.stem, 'reason': 'Copy worker or source reader is active/unconfirmed'})
        return blockers

    def history_blockers(self, args, path):
        blockers = []
        owner = self.store._identity(args['userId'], args['project'])
        for folder, kind in ((self.store.path / '.run-claims', 'run-claim'), (self.n.ROOT / 'jobs', 'job-history')):
            if not folder.exists(): continue
            self.s.private_dir(folder)
            paths = list(folder.glob('*.json'))
            if len(paths) > 100000: raise ValueError('Job history is too large to confirm safely')
            for item in paths:
                if not self.s.JOB_ID.fullmatch(item.stem): continue
                value = self.s.read_json(item)
                if value.get('project') == args['project'] and (value.get('owner') == owner if kind == 'run-claim' else value.get('userId') == args['userId']):
                    blockers.append({'kind': kind, 'id': item.stem, 'reason': 'Historical execution identity must remain accessible; archive this project instead'})
        runs = self.s.private_dir(path / 'runs')
        if any(runs.iterdir()): blockers.append({'kind': 'run-output', 'reason': 'Run directories or outputs exist; archive this project instead'})
        return blockers

    def manifest(self, root):
        """Full no-follow stat CAS, including ctime, every link and directory.

        No uploaded code executes and no venv link is followed. The immutable
        release closure is validated by status before this scan. Byte hashes
        are unnecessary here: any writer changes inode/ctime even if it resets
        mtime. Host root is outside this trust boundary, as for publication.
        """
        records, total = [], 0
        def stamp(info): return (info.st_dev,info.st_ino,info.st_mode,info.st_nlink,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
        def walk(path, relative):
            nonlocal total
            info = path.lstat()
            if info.st_uid != os.geteuid() or info.st_nlink < 1 or info.st_dev != root.lstat().st_dev:
                raise ValueError('Project contains foreign ownership or another filesystem')
            if len(records) >= 250000: raise ValueError('Retirement plan exceeds bounded scan size')
            row = [relative, info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns]
            if stat.S_ISDIR(info.st_mode):
                records.append(row)
                with self.s.directory(path) as fd:
                    if stamp(os.fstat(fd)) != stamp(info): raise ValueError('Project directory changed during scan')
                    for name in sorted(os.listdir(fd)): walk(path / name, name if not relative else relative + '/' + name)
                    if stamp(os.fstat(fd)) != stamp(info): raise ValueError('Project directory changed during scan')
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink != 1: raise ValueError('Project has hard links; preserve it for operator review')
                records.append(row); total += info.st_size
            elif stat.S_ISLNK(info.st_mode):
                records.append(row + [os.readlink(path)])
            else: raise ValueError('Project has special files; preserve it for operator review')
            if stamp(path.lstat()) != stamp(info): raise ValueError('Project entry changed during scan')
        walk(root, '')
        return {'manifestSha256': hashlib.sha256(self.s.canonical(records)).hexdigest(), 'entries': len(records), 'bytes': total,
                'rootIdentity': [records[0][1], records[0][2]]}

    def plan_locked(self, args):
        path, meta = self.store._project(args['userId'], args['project'])
        status = self.store.status(args['userId'], args['project'])
        blockers = self.writer_blockers(args) + self.history_blockers(args, path)
        # A blocked project cannot be retired. Scanning its entire tree can
        # mask the actual blocker with the manifest size limit (and needlessly
        # walk active outputs). Only eligible plans need a content CAS proof.
        manifest = {} if blockers else self.manifest(path)
        return {'protocol': PROTOCOL, 'project': args['project'], 'state': 'BLOCKED' if blockers else 'ELIGIBLE',
                'lifecycle': self.view(args['userId'], args['project']), 'blockers': blockers[:100], 'blockerCount': len(blockers),
                'releases': [r['release'] for r in status['releases']], 'environmentMode': meta.get('environmentMode', 'shared'),
                'preservesBytes': True, 'ociStorageRetained': meta.get('environmentMode') == 'oci', **manifest}

    def plan(self, args):
        self.identity(args, 'plan')
        with self.ops.guard(args,lifecycle=False), self.store.lifetime(args['userId'], args['project'], exclusive=True), self.store.locked(args['userId'], args['project']):
            return self.plan_locked(args)

    def archive(self, args, archived):
        self.identity(args, 'archive' if archived else 'unarchive')
        user, project = self.ops.identity(args)
        with self.ops.guard(args,lifecycle=False), self.store.lifetime(user, project, exclusive=True), self.store.locked(user, project):
            value = self.store.lifecycle(user, project)
            if value['revision'] != args['revision']: raise ValueError('Project lifecycle changed; refresh its revision')
            blockers = self.writer_blockers(args)
            if blockers: raise ValueError('Close or reconcile draft writers before archiving/unarchiving')
            value.update(state='ARCHIVED' if archived else 'ACTIVE', revision=value['revision'] + 1, updatedAt=time.time())
            self.s.atomic_json(self.store.lifecycle_folder(user, project) / (project + '.json'), value)
            return self.view(user, project)

    def status(self, args):
        self.identity(args, 'retire-status')
        value = self.store.lifecycle(args['userId'], args['project'])
        if value.get('retirementId') != args['key']: raise ValueError('Retirement UUID does not belong to this project')
        return {**self.view(args['userId'], args['project']), 'preservesBytes': True,
                'error': 'Retirement commit is unconfirmed; inspect the original UUID, do not retry with a new key' if value['state'] == 'RETIRING' else None}

    def retire(self, args):
        self.identity(args, 'retire')
        user, project = self.ops.identity(args)
        with self.ops.guard(args,lifecycle=False), self.store.lifetime(user, project, exclusive=True):
            value = self.store.lifecycle(user, project)
            folder = self.store.lifecycle_folder(user, project)
            receipt = folder / (project + '.json')
            trash = self.s.private_dir(folder / '.trash', create=True)
            target = trash / args['key']
            original = self.store.path / self.store._identity(user, project) / project
            if value['state'] in ('RETIRING', 'RETIRED'):
                if value.get('retirementId') != args['key'] or value.get('manifestSha256') != args['manifestSha256'] or value.get('sourceRevision') != args['revision']:
                    raise ValueError('Project is fenced by another exact retirement request')
                if not original.exists() and target.exists():
                    info = target.lstat()
                    if [info.st_dev, info.st_ino] != value.get('rootIdentity') or not stat.S_ISDIR(info.st_mode):
                        raise ValueError('Retired project identity is unconfirmed; preserve the fence')
                    value.update(state='RETIRED', retiredAt=value.get('retiredAt', time.time()))
                    self.s.atomic_json(receipt, value)
                return self.status({'userId': user, 'project': project, 'key': args['key']})
            if value['revision'] != args['revision']: raise ValueError('Project lifecycle revision changed; make a new plan')
            with self.store.locked(user, project):
                plan = self.plan_locked({'userId': user, 'project': project})
                if plan['state'] != 'ELIGIBLE': raise ValueError('Project has execution history or active/unconfirmed consumers; preserve it and inspect the plan')
                if plan['manifestSha256'] != args['manifestSha256']: raise ValueError('Project content changed since the retirement plan; no files moved')
                if target.exists() or target.is_symlink(): raise ValueError('Retirement destination already exists; no replacement allowed')
                spec = importlib.util.spec_from_file_location('gpuq_lifecycle_rename', self.n.HERE / 'project-local-import.py')
                helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
                if not helper.atomic_import_available(): raise ValueError('Atomic no-replace retirement is unavailable on this node')
                value.update(state='RETIRING', revision=value['revision'] + 1, sourceRevision=args['revision'], retirementId=args['key'],
                             manifestSha256=plan['manifestSha256'], rootIdentity=plan['rootIdentity'], entries=plan['entries'], bytes=plan['bytes'], updatedAt=time.time())
                self.s.atomic_json(receipt, value)  # Permanent fence precedes the move.
                with self.s.directory(original.parent) as source_fd, self.s.directory(trash) as target_fd:
                    helper.rename_new(source_fd, project, target_fd, args['key'])
                    os.fsync(source_fd); os.fsync(target_fd)
                value.update(state='RETIRED', retiredAt=time.time())
                self.s.atomic_json(receipt, value)
                return self.status({'userId': user, 'project': project, 'key': args['key']})

    def process(self, operation, args):
        action = operation.removeprefix('projects.')
        if action == 'retire.plan': return self.plan(args)
        if action == 'retire.status': return self.status(args)
        if action == 'retire': return self.retire(args)
        if action in ('archive', 'unarchive'): return self.archive(args, action == 'archive')
        raise ValueError('Unknown project lifecycle operation')

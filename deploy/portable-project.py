"""Immutable owner project bundles. Never copy a live container or dev HOME.

Only a published OCI image and the exact release's code tree are portable.
Bundles remain in the owner's private SSD project store, not the dataset
catalog. All path arguments here are internal worker paths, never HTTP input.
"""
import base64
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import stat
import threading
import functools
import uuid

CHUNK = 1024**2
MAX_MANIFEST = 64*CHUNK
MAX_IMAGE = 2**53-1  # exact JSON byte counts, not a fixed image quota


def load_store():
    spec = importlib.util.spec_from_file_location('gpuq_portable_store', Path(__file__).with_name('project-store.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def need(condition, message):
    if not condition: raise ValueError(message)


def safe_path(value):
    need(isinstance(value, str) and 0 < len(value.encode()) <= 4096
         and not any(ord(c) < 32 or ord(c) == 127 for c in value) and '\\' not in value
         and all(part not in ('', '.', '..') for part in value.split('/')), 'Invalid portable file path')
    return value


def project_reader(function):
    @functools.wraps(function)
    def wrapped(self,user,project,*args,**kwargs):
        with self.store.lifetime(user,project):
            need(self.store.lifecycle(user,project)['state'] not in ('RETIRING','RETIRED'),
                 'Project is retired or its retirement is unconfirmed')
            return function(self,user,project,*args,**kwargs)
    return wrapped


class PortableProjects:
    def __init__(self, store):
        self.store, self.s = store, load_store()
        self._manifests = {}
        self._manifest_lock = threading.RLock()

    def folder(self, user, kind, project=None):
        need(kind in ('exports','imports'), 'Invalid portable storage kind')
        self.store._check_root()
        owner = self.store._identity(user, project)
        parent = self.s.private_dir(self.store.path/owner, create=True)
        self.store._quota(user, parent)
        folder = self.s.private_dir(parent/('.portable-'+kind), create=True)
        return self.s.private_dir(folder/project, create=True) if project else folder

    @project_reader
    def export(self, user, project, release, operation=None):
        need(self.store.local_storage(user, project) is None,
             'Local public-root project export needs an explicitly configured target layout')
        source = self.store.release(user, project, release)
        meta = source['meta']
        need(meta.get('environmentMode') == 'oci', 'Cross-node environments require a published OCI project')
        parent = self.folder(user, 'exports', project)
        with self.store._file_lock(parent/'.lock'):
            target = parent/release
            if target.exists(): return self.info(user, project, release)
            need(operation is None or self.s.JOB_ID.fullmatch(operation), 'Invalid export operation')
            stage = self.s.private_dir(parent/('.stage-'+(operation or uuid.uuid4().hex)), create=True)
            try:
                self.store._space(meta['bytes'])
                root = self.s.private_dir(stage/'release', create=True)
                for name in ('code','env'): self.s.private_dir(root/name, create=True)
                budget = {'entries':0,'bytes':0}
                content, _ = self.store._walk(source['code'], 'code', root/'code', budget)
                need(content == meta['content']['code'] and budget['bytes'] == meta['bytes']
                     and budget['entries'] == meta['entries'], 'Published project code changed')
                self.s.atomic_json(root/'meta.json', meta)
                self.s.atomic_json(root/'READY.json', self.store._ready_marker(meta))
                image = self.store._oci(user).export_image(project, meta['oci'], stage/'image.oci.tar')
                self.s.atomic_json(stage/'image.json', image)
                files = []
                directories = ['release','release/code','release/env']
                for item in content:
                    path = 'release/code/'+safe_path(item['path'])
                    if item['type'] == 'directory': directories.append(path)
                    else: files.append({'path':path,'size':item['bytes'],'sha256':item['sha256']})
                for path in ('release/meta.json','release/READY.json','image.json','image.oci.tar'):
                    with self.file(stage, path) as fd:
                        checksum = hashlib.sha256()
                        while block := os.read(fd, CHUNK): checksum.update(block)
                        files.append({'path':path,'size':os.fstat(fd).st_size,'sha256':checksum.hexdigest()})
                manifest = {'schema':1,'owner':meta['owner'],'project':project,'release':release,
                            'files':files,'directories':directories}
                self.validate_manifest(manifest, user, project, release)
                raw = self.s.canonical(manifest)
                need(len(raw) <= MAX_MANIFEST, 'Portable project manifest is too large')
                self.s.atomic_json(stage/'manifest.json', manifest)
                self.freeze(root)
                # This private path is an immutable export cache, not latest/dev.
                os.rename(stage, target)
                with self.s.directory(parent) as fd: os.fsync(fd)
                return self.info(user, project, release)
            finally:
                if stage.exists(): self.store._remove_stage(stage)

    def validate_manifest(self, value, user, project, release):
        need(isinstance(value, dict) and set(value) == {'schema','owner','project','release','files','directories'}
             and value.get('schema') == 1 and value.get('owner') == self.store._identity(user, project)
             and value.get('project') == project and value.get('release') == release
             and isinstance(release, str) and self.s.VERSION.fullmatch(release), 'Portable manifest identity differs')
        files, directories = value['files'], value['directories']
        need(isinstance(files, list) and isinstance(directories, list)
             and len(files)+len(directories) <= self.store.max_entries+7, 'Invalid portable manifest entries')
        seen, total = set(), 0
        required = {'image.oci.tar','image.json','release/meta.json','release/READY.json'}
        for path in directories:
            safe_path(path)
            need(path not in seen and (path in ('release','release/code','release/env')
                 or path.startswith('release/code/')), 'Invalid portable directory')
            seen.add(path)
        directory_set = set(directories)|{'.'}
        need({'release','release/code','release/env'} <= seen, 'Incomplete portable directory manifest')
        for item in files:
            need(isinstance(item, dict) and set(item) == {'path','size','sha256'}, 'Invalid portable file entry')
            path = safe_path(item['path'])
            need(path not in seen and (path in required or path.startswith('release/code/'))
                 and type(item['size']) is int and 0 <= item['size'] <= self.store.MAX_BYTES
                 and isinstance(item['sha256'], str) and self.s.VERSION.fullmatch(item['sha256']), 'Invalid portable file identity')
            need(str(PurePosixPath(path).parent) in directory_set, 'Portable file parent is not declared')
            seen.add(path); total += item['size']
        need(required <= seen and total <= self.store.MAX_BYTES,
             'Portable bundle is incomplete or its byte count is not exact')
        for path in directories:
            need(str(PurePosixPath(path).parent) in directory_set, 'Portable directory parent is not declared')
        return total

    @staticmethod
    def freeze(root):
        for current, dirs, files in os.walk(root, topdown=False, followlinks=False):
            for name in files:
                path = Path(current)/name
                need(not path.is_symlink(), 'Portable snapshots cannot contain symlinks')
                path.chmod(0o444 | (path.stat().st_mode & 0o111))
            if Path(current) != root: Path(current).chmod(0o555)

    @project_reader
    def manifest(self, user, project, release):
        folder, cached = self._manifest(user, project, release)
        return folder, cached[1]

    def _manifest(self, user, project, release):
        with self._manifest_lock:
            return self._manifest_locked(user, project, release)

    def _manifest_locked(self, user, project, release):
        need(isinstance(release, str) and self.s.VERSION.fullmatch(release), 'Invalid project release')
        folder = self.folder(user, 'exports', project)/release
        stat_now = self.s.stamp((folder/'manifest.json').lstat())
        cache_key = (user, project, release)
        cached = self._manifests.get(cache_key)
        if cached and cached[0] == stat_now: return folder, cached
        manifest = self.s.read_json(folder/'manifest.json', MAX_MANIFEST)
        self.validate_manifest(manifest, user, project, release)
        # Releases and export directories are immutable/private. Revalidate the
        # file identity each read, but never parse a 40 MiB manifest per 1 MiB.
        need(self.s.stamp((folder/'manifest.json').lstat()) == stat_now, 'Portable manifest changed')
        if len(self._manifests) >= 2: self._manifests.pop(next(iter(self._manifests)))
        self._manifests[cache_key] = (stat_now, manifest, self.s.canonical(manifest), {f['path']:f for f in manifest['files']})
        return folder, self._manifests[cache_key]

    @project_reader
    def info(self, user, project, release):
        _, cached = self._manifest(user, project, release)
        manifest, raw = cached[1:3]
        return {'protocol':'portable-project-v1','state':'READY','project':project,'release':release,
                'manifestBytes':len(raw),'manifestSha256':hashlib.sha256(raw).hexdigest(),
                'totalBytes':sum(f['size'] for f in manifest['files']),
                'entries':len(manifest['files'])+len(manifest['directories'])}

    def file(self, folder, path):
        """Pinned private regular-file read; no symlink, hardlink or path escape."""
        import contextlib
        @contextlib.contextmanager
        def opened():
            target = folder/safe_path(path)
            with self.s.directory(target.parent) as parent:
                fd = os.open(target.name, self.s.FILE_FLAGS, dir_fd=parent)
                try:
                    info = os.fstat(fd); stamp = self.s.stamp(info)
                    need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid() and info.st_nlink == 1
                         and not info.st_mode & 0o022, 'Unsafe portable snapshot file')
                    yield fd
                    need(self.s.stamp(os.fstat(fd)) == stamp
                         and self.s.stamp(os.stat(target.name, dir_fd=parent, follow_symlinks=False)) == stamp,
                         'Portable snapshot file changed')
                finally: os.close(fd)
        return opened()

    @project_reader
    def read(self, user, project, release, action, *, path=None, offset=0):
        folder, cached = self._manifest(user, project, release)
        need(type(offset) is int and offset >= 0, 'Invalid portable read offset')
        if action == 'info': return self.info(user, project, release)
        if action == 'manifest':
            need(path is None, 'Manifest does not take a file path')
            raw = cached[2]; need(offset <= len(raw), 'Manifest offset exceeds size')
            part = raw[offset:offset+CHUNK]
            return {'data':base64.b64encode(part).decode(),'offset':offset+len(part),'size':len(raw)}
        need(action == 'get', 'Unknown portable snapshot action')
        entry = cached[3].get(path)
        need(entry is not None and offset <= entry['size'], 'File is not in this portable snapshot')
        with self.file(folder, path) as fd:
            need(os.fstat(fd).st_size == entry['size'], 'Portable source file size changed')
            part = os.pread(fd, min(CHUNK,entry['size']-offset), offset)
            return {'data':base64.b64encode(part).decode(),'offset':offset+len(part),'size':entry['size']}

    @project_reader
    def import_bundle(self, user, project, release, folder, manifest):
        self.store.admit(user,project)
        """Publish only a new immutable release. Existing dev/latest stay intact."""
        total = self.validate_manifest(manifest, user, project, release)
        parent = self.folder(user, 'imports')
        folder = self.s.absolute(folder)
        need(folder.parent == parent and self.s.JOB_ID.fullmatch(folder.name), 'Invalid private import staging directory')
        self.s.private_dir(folder)
        expected_files = {f['path'] for f in manifest['files']}
        observed_files, observed_dirs = set(), set()
        for current, dirs, files in os.walk(folder, followlinks=False):
            for name in dirs:
                path = Path(current)/name
                need(not path.is_symlink(), 'Portable bundle has a linked directory')
                observed_dirs.add(path.relative_to(folder).as_posix())
            for name in files: observed_files.add((Path(current)/name).relative_to(folder).as_posix())
        need(observed_files == expected_files and observed_dirs == set(manifest['directories']), 'Portable bundle has missing or unexpected content')
        for entry in manifest['files']:
            with self.file(folder, entry['path']) as fd:
                need(os.fstat(fd).st_size == entry['size'], 'Portable file size differs')
                checksum = hashlib.sha256()
                while block := os.read(fd, CHUNK): checksum.update(block)
                need(checksum.hexdigest() == entry['sha256'], 'Portable file checksum differs')
        root = folder/'release'
        meta = self.store._release_meta(root, release)
        need(meta.get('owner') == self.store._identity(user, project) and meta.get('project') == project
             and meta.get('environmentMode') == 'oci', 'Portable project metadata differs')
        # Transport files have safe 0600 defaults. Executability is restored
        # only from metadata authenticated by the exact release digest.
        for item in meta.get('content', {}).get('code', []):
            if item.get('type') == 'file':
                target = root/'code'/safe_path(item['path'])
                with self.file(root/'code', item['path']) as fd:
                    retained = os.dup(fd)
                try: os.fchmod(retained, 0o555 if item.get('executable') is True else 0o444)
                finally: os.close(retained)
        budget = {'entries':0,'bytes':0}
        code, _ = self.store._walk(root/'code', 'code', budget=budget)
        need(meta.get('content') == {'code':code} and meta['bytes'] == budget['bytes']
             and meta['entries'] == budget['entries'] and not os.listdir(root/'env'), 'Portable code differs from its published version')
        image = self.s.read_json(folder/'image.json', 65536)
        # Creating the target is safe and mode-checked; no existing development
        # state is changed. Import may coexist with an existing active container.
        self.store.create(user, project, environment_mode='oci')
        self.store._oci(user).import_image(project, meta['oci'], folder/'image.oci.tar', image)
        with self.store.locked(user, project):
            target, _ = self.store._project(user, project)
            releases = self.s.private_dir(target/'releases')
            destination = releases/release
            if destination.exists():
                existing = self.store.release(user, project, release)
                need(all(existing['meta'].get(k) == meta.get(k) for k in
                         ('schema','base','content','environmentMode','oci','owner','project')),
                     'Existing immutable release differs')
            else:
                need(sum(bool(self.s.VERSION.fullmatch(name)) for name in os.listdir(releases)) < self.store.max_releases,
                     'Maximum project versions reached')
                self.freeze(root)
                os.rename(root, destination)
                with self.s.directory(releases) as fd: os.fsync(fd)
            self.store.release(user, project, release)
        return {'project':project,'release':release,'state':'READY','environmentMode':'oci',
                'developmentChanged':False,'route':'lan','bytes':total}

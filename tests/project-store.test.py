"""Project snapshots use synthetic temporary files only; never execute user code."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


spec = importlib.util.spec_from_file_location('project_store', Path(__file__).resolve().parents[1] / 'deploy/project-store.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ProjectStoreTests(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name).resolve()
        self.root, self.base = self.path / 'service', self.path / 'approved-conda'
        self.root.mkdir(mode=0o700)
        self.base.mkdir()
        (self.base / 'bin').mkdir()
        (self.base / 'bin/python3.12').write_bytes(b'fake interpreter, never executed')
        (self.base / 'bin/python').symlink_to('python3.12')
        (self.base / 'conda-meta').mkdir()
        (self.base / 'conda-meta/python-3.12.1-0.json').write_text(json.dumps({'name': 'python', 'version': '3.12.1'}))
        (self.base / 'lib/python3.12/site-packages').mkdir(parents=True)
        self.store = module.ProjectStore(self.root, self.base, reserve_bytes=0)
        self.user, self.slug = 'demo-user-12', 'training'
        self.store.create(self.user, self.slug)
        self.dev = self.store.dev_paths(self.user, self.slug)
        (self.dev['code'] / 'train.py').write_text('print("test")\n')
        self.initialize_env(self.dev)
        self.addCleanup(self.cleanup)

    def cleanup(self):
        for current, dirs, _ in os.walk(self.path, followlinks=False):
            Path(current).chmod(0o700)
            for name in dirs:
                child = Path(current) / name
                if not child.is_symlink():
                    child.chmod(0o700)
        self.temp.cleanup()

    def initialize_env(self, dev):
        (dev['env'] / 'pyvenv.cfg').write_text('home = /opt/conda/bin\nversion = 3.12.1\n')
        (dev['env'] / 'bin').mkdir()
        (dev['env'] / 'bin/python').symlink_to('/opt/conda/bin/python')
        (dev['env'] / 'lib/python3.12/site-packages').mkdir(parents=True)
        (dev['env'] / 'lib64').symlink_to('lib')

    def publish(self):
        return self.store.publish(self.user, self.slug)

    def existing_reader_type(self):
        path = Path(__file__).resolve().parents[1] / 'src' / 'infrastructure' / 'legacy-project-reader.py'
        spec = importlib.util.spec_from_file_location('v2_project_reader', path)
        reader = importlib.util.module_from_spec(spec); spec.loader.exec_module(reader)
        return reader.LegacyProjectReader

    def test_existing_metadata_reader_does_not_prepare_or_write(self):
        published = self.publish()
        reader_type = self.existing_reader_type()
        before = {str(path.relative_to(self.root)): (path.lstat().st_ino, path.lstat().st_mtime_ns)
                  for path in self.root.rglob('*')}
        original_open = os.open
        def read_only_open(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC), str(path))
            return original_open(path, flags, *args, **kwargs)
        with patch.object(module.os, 'open', side_effect=read_only_open), \
                patch.object(module.ProjectStore, '_quota', side_effect=AssertionError('no quota preparation')), \
                patch.object(module.ProjectStore, '_space', side_effect=AssertionError('no space admission')), \
                patch.object(module.ProjectStore, '_oci', side_effect=AssertionError('no OCI initialization')), \
                patch.object(module.ProjectStore, 'base_fingerprint', side_effect=AssertionError('no runtime/base verification')):
            reader = reader_type(module, root=self.root, base_path=self.base)
            result = reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(result['projectUUID'], self.store.project_uuid(self.user, self.slug))
        self.assertEqual(result['generation'], self.store.generation(self.user, self.slug))
        self.assertEqual(result['release'], published['release'])
        self.assertEqual(result['lifecycle'], 'ACTIVE')
        self.assertFalse(result['runtimeVerified'])
        self.assertNotIn(str(self.root), json.dumps(result))
        after = {str(path.relative_to(self.root)): (path.lstat().st_ino, path.lstat().st_mtime_ns)
                 for path in self.root.rglob('*')}
        self.assertEqual(before, after)

    def test_existing_reader_does_not_create_missing_project_layout(self):
        root = self.path / 'empty-service'; root.mkdir(mode=0o700)
        with self.assertRaises(FileNotFoundError):
            self.existing_reader_type()(module, root=root, base_path=self.base)
        self.assertFalse((root / 'projects-v2').exists())

    def test_metadata_observation_does_not_require_a_present_runtime_base(self):
        published = self.publish()
        self.base.rename(self.base.with_name('offline-base'))
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        self.assertFalse(reader.inspect(user_id=self.user, project=self.slug, release=published['release'])['runtimeVerified'])
        self.assertFalse(self.base.exists())

    def test_runtime_identity_observation_checks_base_changes_without_executing_code(self):
        published = self.publish()
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        result = reader.verify_runtime(user_id=self.user, project=self.slug, release=published['release'])
        self.assertTrue(result['runtimeIdentityVerified'])
        self.assertEqual(result['runtime'], {'kind': 'base', 'identity': self.store.base_fingerprint()['sha256']})
        self.assertNotIn('runtimeVerified', result)
        (self.base/'bin/python3.12').write_bytes(b'changed approved base')
        with self.assertRaises(module.ProjectError) as error:
            reader.verify_runtime(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(error.exception.code, 'base_changed')

    def test_runtime_identity_observation_requires_active_project(self):
        published = self.publish()
        path, project = self.store._project(self.user, self.slug)
        module.atomic_json(self.store.lifecycle_folder(self.user, self.slug)/(self.slug+'.json'),
                          dict(schema=1, owner=project['owner'], project=self.slug, state='ARCHIVED', revision=1))
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        with self.assertRaises(module.ProjectError) as error:
            reader.verify_runtime(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(error.exception.code, 'project_archived')

    def test_runtime_oci_branch_requests_existing_only_image_verification(self):
        published = self.publish()
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        path, project = self.store._project(self.user, self.slug)
        meta = self.store._release_meta(path/'releases'/published['release'], published['release'])
        receipt = dict(schema=1, owner=project['owner'], project=self.slug, image='sha256:'+'a'*64)
        # Unit-test the routing only: metadata proof and engine are separate fixtures.
        image = SimpleNamespace(inspect_existing_image=lambda slug, value: value['image'])
        with patch.object(reader._store, '_release_meta', return_value={**meta, 'environmentMode': 'oci', 'oci': receipt}), \
                patch.object(reader._store, '_oci', return_value=image) as existing, \
                patch.object(reader._store, 'base_fingerprint', side_effect=AssertionError('no shared-base fallback')):
            result = reader.verify_runtime(user_id=self.user, project=self.slug, release=published['release'])
        existing.assert_called_once_with(self.user, initialize=False)
        self.assertEqual(result['runtime'], {'kind': 'oci', 'identity': receipt['image']})

    def test_existing_reader_does_not_create_missing_lifecycle_lock(self):
        published = self.publish()
        lock = self.store.lifecycle_folder(self.user, self.slug) / (self.slug + '.lock')
        lock.unlink()
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        with self.assertRaises(FileNotFoundError):
            reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        self.assertFalse(lock.exists())

    def test_existing_reader_rejects_missing_identity_and_corrupt_release(self):
        published = self.publish()
        path, meta = self.store._project(self.user, self.slug)
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        original = dict(meta); meta.pop('projectUUID')
        module.atomic_json(path / 'project.json', meta)
        with self.assertRaises(module.ProjectError) as error:
            reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(error.exception.code, 'identity_missing')
        module.atomic_json(path / 'project.json', original)
        ready = path / 'releases' / published['release'] / 'READY.json'
        ready.chmod(0o600); ready.write_text('{}')
        with self.assertRaises(module.ProjectError):
            reader.inspect(user_id=self.user, project=self.slug, release=published['release'])

    def test_existing_reader_preserves_owner_and_lifecycle_boundaries(self):
        published = self.publish()
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        with self.assertRaises(FileNotFoundError):
            reader.inspect(user_id='another-user', project=self.slug, release=published['release'])
        path, project = self.store._project(self.user, self.slug)
        receipt = self.store.lifecycle_folder(self.user, self.slug) / (self.slug + '.json')
        value = dict(schema=1, owner=project['owner'], project=self.slug, state='ARCHIVED', revision=1)
        module.atomic_json(receipt, value)
        self.assertEqual(reader.inspect(user_id=self.user, project=self.slug, release=published['release'])['lifecycle'], 'ARCHIVED')
        module.atomic_json(receipt, {**value, 'state': 'RETIRING', 'revision': 2})
        with self.assertRaises(module.ProjectError) as error:
            reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(error.exception.code, 'project_retired')

    def test_same_name_replacement_has_a_different_observed_instance_generation(self):
        published = self.publish()
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        first = reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        path, _ = self.store._project(self.user, self.slug)
        previous = path.with_name('.previous-project')
        path.rename(previous)
        shutil.copytree(previous, path, symlinks=True)
        second = reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(first['projectUUID'], second['projectUUID'])
        self.assertNotEqual(first['generation'], second['generation'])

    def test_metadata_observation_ignores_draft_write_lock_but_respects_retirement_lock(self):
        published = self.publish()
        reader = self.existing_reader_type()(module, root=self.root, base_path=self.base)
        with self.store.locked(self.user, self.slug):
            self.assertEqual(reader.inspect(user_id=self.user, project=self.slug, release=published['release'])['release'], published['release'])
        with self.store.lifetime(self.user, self.slug, exclusive=True), \
                patch.object(module, 'PROJECT_LOCK_WAIT_SECONDS', 0.01):
            with self.assertRaises(module.ProjectError) as error:
                reader.inspect(user_id=self.user, project=self.slug, release=published['release'])
        self.assertEqual(error.exception.code, 'project_busy')

    def assert_error(self, code, function, *args, **kwargs):
        with self.assertRaises(module.ProjectError) as raised:
            function(*args, **kwargs)
        self.assertEqual(raised.exception.code, code)

    def test_create_idempotent_status_list_and_private_layout(self):
        first = self.store.status(self.user, self.slug)
        self.assertEqual(first['state'], 'DRAFT')
        self.assertIsNone(first['latestReadyRelease'])
        self.assertEqual(self.store.create(self.user, self.slug), first)
        self.assertEqual(self.store.list(self.user), [first])
        self.assertEqual(self.store.list('another-user'), [])
        self.assertTrue(all(str(path).startswith(str(self.root / 'projects-v2')) for path in self.dev.values()))
        self.assertFalse((self.root / 'users').exists())
        self.assertEqual(set(self.dev), {'code', 'env', 'home', 'scratch'})

    def test_publication_reports_stages_totals_and_keeps_snapshot_digest(self):
        first = self.publish()
        reports=[]
        second=self.store.publish(self.user,self.slug,progress=reports.append)
        self.assertEqual(first['release'],second['release'])
        self.assertEqual([r['phase'] for r in reports],['scanning','copying','verifying','publishing','complete'])
        for record in reports[1:]:
            self.assertEqual(record['totalEntries'],second['entries'])
            self.assertEqual(record['totalBytes'],second['bytes'])
        self.assertEqual(reports[-1]['completedEntries'],second['entries'])
        self.assertEqual(reports[-1]['completedBytes'],second['bytes'])
        self.assertNotIn(str(self.root),json.dumps(reports))

    def test_completed_progress_failure_does_not_undo_committed_release(self):
        self.store.create(self.user,self.slug)
        def progress(value):
            if value['phase']=='complete': raise OSError('receipt temporarily unavailable')
        result=self.store.publish(self.user,self.slug,progress=progress)
        self.assertEqual(result['state'],'READY')
        self.assertEqual(self.store.status(self.user,self.slug)['latestReadyRelease'],result['release'])

    def test_publication_failure_identifies_relative_path_mode_links_and_remedy(self):
        os.link(self.dev['code']/'train.py',self.dev['code']/'hardlink.py')
        with self.assertRaises(module.ProjectError) as error:
            self.publish()
        details=error.exception.details
        self.assertEqual(details['path'],'code/hardlink.py')
        self.assertEqual(details['links'],2)
        self.assertEqual(details['kind'],'file')
        self.assertIn('mode',details)
        self.assertIn('independent regular copy',details['remediation'])
        self.assertNotIn(str(self.root),str(error.exception))

    def test_bad_environment_link_error_has_original_link_path(self):
        (self.dev['env']/'bad').symlink_to('../../escape')
        with self.assertRaises(module.ProjectError) as error:
            self.publish()
        self.assertEqual(error.exception.details['path'],'env/bad')
        self.assertEqual(error.exception.details['kind'],'symlink')
        self.assertEqual(error.exception.details['linkTarget'],'../../escape')

    def test_validation_blocks_traversal_and_arbitrary_identity(self):
        for slug in ('../bad', '/tmp/bad', 'bad/name', 'Bad', '.', '', 'a' * 49, '1project'):
            self.assert_error('invalid_input', self.store.create, self.user, slug)
        for user in ('', 'a\n', None, 'a' * 129):
            self.assert_error('invalid_input', self.store.list, user)

    def test_per_user_project_and_release_access(self):
        info = self.publish()
        self.assert_error('not_found', self.store.status, 'other', self.slug)
        self.assert_error('not_found', self.store.release, 'other', self.slug, info['release'])
        self.store.create('other', self.slug)
        other = self.store.dev_paths('other', self.slug)
        self.assertNotEqual(self.dev['code'], other['code'])
        self.assert_error('not_found', self.store.release, 'other', self.slug, info['release'])

    def test_publish_freezes_copies_not_hardlinks_and_preserves_execution(self):
        script = self.dev['code'] / 'run.sh'
        script.write_text('#!/bin/sh\necho test\n')
        script.chmod(0o755)
        info = self.publish()
        release = self.store.release(self.user, self.slug, info['release'])
        frozen = release['code'] / 'train.py'
        self.assertNotEqual(frozen.stat().st_ino, (self.dev['code'] / 'train.py').stat().st_ino)
        self.assertEqual(stat.S_IMODE(frozen.stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE((release['code'] / 'run.sh').stat().st_mode), 0o555)
        self.assertEqual(stat.S_IMODE(release['env'].stat().st_mode), 0o555)
        (self.dev['code'] / 'train.py').write_text('changed dev')
        self.assertEqual(frozen.read_text(), 'print("test")\n')
        self.assertEqual(self.store.status(self.user, self.slug)['latestReadyRelease'], info['release'])
        self.assertIn('not all base files', info['baseFingerprint']['coverage'])

    def test_identical_content_reuses_release_even_when_at_release_limit(self):
        self.store.max_releases = 1
        first = self.publish()
        second = self.publish()
        self.assertEqual(first, second)
        (self.dev['code'] / 'train.py').write_text('different')
        self.assert_error('limit_exceeded', self.publish)
        self.assertEqual(len(self.store.status(self.user, self.slug)['releases']), 1)

    def test_no_environment_means_not_ready_and_no_release(self):
        (self.dev['env'] / 'pyvenv.cfg').unlink()
        self.assert_error('environment_not_ready', self.publish)
        self.assertEqual(self.store.status(self.user, self.slug)['state'], 'DRAFT')

    def test_safe_absolute_and_relative_environment_links(self):
        (self.dev['env'] / 'bin/python3').symlink_to('python')
        (self.dev['env'] / 'bin/alternate').symlink_to(str(self.base / 'bin/python'))
        (self.dev['env'] / 'bin/stable').symlink_to('/opt/project-env/bin/python')
        self.assertEqual(self.publish()['state'], 'READY')

    def test_environment_external_dangling_cycles_and_traversal_rejected(self):
        link = self.dev['env'] / 'bad'
        for value in ('/etc/passwd', '../../other', '/opt/conda/../etc/passwd', '/opt/project-env/../outside', 'missing', 'bad'):
            with self.subTest(value=value):
                link.symlink_to(value)
                self.assert_error('unsafe_path', self.publish)
                link.unlink()

    def test_base_python_link_cannot_escape_preapproved_installation(self):
        (self.base / 'bin/python').unlink()
        (self.base / 'bin/python').symlink_to('/etc/passwd')
        self.assert_error('unsafe_path', self.publish)

    def test_base_python_directory_alias_is_resolved_and_deduplicated(self):
        packages = self.base / 'lib/python3.12/site-packages'
        dist = packages / 'demo-1.dist-info'
        dist.mkdir()
        (dist / 'METADATA').write_text('Name: demo\nVersion: 1\n')
        (dist / 'RECORD').write_text('demo.py,sha256=test,4\n')
        before = self.store.base_fingerprint()
        # Real Conda compatibility shape: shortened Python version is a link.
        (self.base / 'lib/python3.1').symlink_to('python3.12')
        hashed = []
        original = self.store._hash_base_file
        def capture(path, *args, **kwargs):
            hashed.append(path)
            return original(path, *args, **kwargs)
        with patch.object(self.store, '_hash_base_file', side_effect=capture):
            after = self.store.base_fingerprint()
        self.assertEqual(before, after)
        self.assertEqual(hashed.count(dist / 'METADATA'), 1)
        self.assertEqual(hashed.count(dist / 'RECORD'), 1)
        self.assertEqual(self.publish()['state'], 'READY')

    def test_base_lib_and_distribution_internal_aliases_are_supported(self):
        library = self.base / 'lib'
        library.rename(self.base / 'real-lib')
        library.symlink_to('real-lib')
        packages = self.base / 'real-lib/python3.12/site-packages'
        dist = packages / 'actual-1.dist-info'
        dist.mkdir()
        (dist / 'METADATA').write_text('Name: actual\nVersion: 1\n')
        (packages / 'alias-1.dist-info').symlink_to('actual-1.dist-info')
        (self.base / 'real-lib/python3.1').symlink_to('/opt/conda/real-lib/python3.12')
        self.assertEqual(self.publish()['state'], 'READY')

    def test_base_directory_aliases_cannot_escape_or_cycle(self):
        alias = self.base / 'lib/python3.1'
        for destination in ('/etc', '../../outside', '/opt/conda/lib/../../outside', 'python3.1'):
            with self.subTest(destination=destination):
                alias.symlink_to(destination)
                self.assert_error('unsafe_path', self.store.base_fingerprint)
                alias.unlink()

    def test_base_lib_alias_to_external_tree_is_rejected(self):
        (self.base / 'lib').rename(self.base / 'real-lib')
        (self.base / 'lib').symlink_to(self.path)
        self.assert_error('unsafe_path', self.store.base_fingerprint)

    def test_code_symlinks_hardlinks_fifo_are_rejected_without_following(self):
        bad = self.dev['code'] / 'bad'
        bad.symlink_to('/etc/passwd')
        self.assert_error('unsafe_path', self.publish)
        bad.unlink()
        os.link(self.dev['code'] / 'train.py', bad)
        self.assert_error('unsafe_path', self.publish)
        bad.unlink()
        os.mkfifo(bad)
        self.assert_error('unsafe_path', self.publish)
        bad.unlink()

    def test_world_writable_or_setid_tree_rejected(self):
        file = self.dev['code'] / 'train.py'
        for mode in (0o666, 0o4755):
            with self.subTest(mode=oct(mode)):
                file.chmod(mode)
                if mode & 0o6000 and not file.stat().st_mode & 0o6000:
                    # Some temporary filesystems strip set-ID on chmod.
                    info = file.stat()
                    fake = SimpleNamespace(st_dev=info.st_dev, st_uid=info.st_uid, st_gid=info.st_gid,
                                           st_mode=info.st_mode | mode, st_nlink=1)
                    self.assert_error('unsafe_path', self.store._check_tree_stat, fake, info.st_dev)
                else:
                    self.assert_error('unsafe_path', self.publish)
        file.chmod(0o644)

    def test_private_service_group_writable_venv_templates_publish_read_only(self):
        scripts = self.dev['env'] / 'bin'
        os.chown(scripts, -1, os.getegid())
        scripts.chmod(0o770)
        for name in ('activate', 'activate.csh', 'activate.fish', 'Activate.ps1'):
            script = scripts / name
            script.write_text('# synthetic Conda venv activation template\n')
            os.chown(script, -1, os.getegid())
            script.chmod(0o664)
            self.assertEqual(script.stat().st_gid, os.getegid())
        result = self.publish()
        release = self.store.release(self.user, self.slug, result['release'])
        self.assertEqual(stat.S_IMODE(scripts.stat().st_mode), 0o770)
        self.assertEqual(stat.S_IMODE((scripts / 'activate').stat().st_mode), 0o664)
        self.assertEqual(stat.S_IMODE((release['env'] / 'bin').stat().st_mode), 0o555)
        for name in ('activate', 'activate.csh', 'activate.fish', 'Activate.ps1'):
            self.assertEqual(stat.S_IMODE((release['env'] / 'bin' / name).stat().st_mode), 0o444)

    def test_group_write_requires_service_group_for_files_and_directories(self):
        info = (self.dev['code'] / 'train.py').stat()
        for is_directory in (False, True):
            fake = SimpleNamespace(st_dev=info.st_dev, st_uid=os.geteuid(),
                                   st_gid=os.getegid() + 1, st_nlink=1,
                                   st_mode=(stat.S_IFDIR | 0o770) if is_directory else (stat.S_IFREG | 0o664))
            with self.assertRaises(module.ProjectError) as raised:
                self.store._check_tree_stat(fake, info.st_dev, directory=is_directory)
            self.assertEqual(raised.exception.code, 'unsafe_path')
            fake.st_gid = os.getegid()
            self.store._check_tree_stat(fake, info.st_dev, directory=is_directory)

    def test_group_write_exception_does_not_relax_controls_metadata_or_locks(self):
        project = self.dev['code'].parents[1]
        for path in (self.dev['code'], self.dev['env'], project):
            path.chmod(0o770)
            self.assert_error('unsafe_path', self.store.dev_paths, self.user, self.slug)
            path.chmod(0o700)
        meta = project / 'project.json'
        meta.chmod(0o664)
        self.assert_error('unsafe_path', self.store.status, self.user, self.slug)
        meta.chmod(0o600)
        with self.store.locked(self.user, self.slug):
            pass
        (project / '.lock').chmod(0o660)
        self.assert_error('unsafe_path', self.store.fail_if_publishing, self.user, self.slug)
        (project / '.lock').chmod(0o600)
        published = self.publish()
        ready = self.store.release(self.user, self.slug, published['release'])['code'].parent / 'READY.json'
        ready.chmod(0o664)
        self.assert_error('unsafe_path', self.store.status, self.user, self.slug)

    def test_control_directory_symlink_and_wrong_permission_rejected(self):
        code = self.dev['code']
        code.rename(code.with_name('real-code'))
        code.symlink_to(code.with_name('real-code'))
        with self.assertRaises(OSError):
            self.store.dev_paths(self.user, self.slug)
        code.unlink()
        code.with_name('real-code').rename(code)
        code.chmod(0o755)
        self.assert_error('unsafe_path', self.store.dev_paths, self.user, self.slug)
        code.chmod(0o700)

    def test_second_full_scan_detects_source_edits_and_never_publishes(self):
        walk = self.store._walk
        calls = 0
        def changed(*args, **kwargs):
            nonlocal calls
            result = walk(*args, **kwargs)
            calls += 1
            if calls == 2:
                file = self.dev['code'] / 'train.py'
                before = file.stat()
                file.write_text('print("evil")\n')
                os.utime(file, ns=(before.st_atime_ns, before.st_mtime_ns))
            return result
        with patch.object(self.store, '_walk', side_effect=changed):
            self.assert_error('changed', self.publish)
        state = self.store.status(self.user, self.slug)
        self.assertEqual(state['releases'], [])
        project = self.dev['code'].parents[1]
        self.assertEqual(list((project / '.staging').iterdir()), [])
        self.assertFalse((project / '.publishing.json').exists())

    def test_base_change_during_publish_rejected(self):
        original = self.store.base_fingerprint
        calls = 0
        def changing():
            nonlocal calls
            calls += 1
            data = original()
            if calls > 1:
                data['sha256'] = '0' * 64
            return data
        with patch.object(self.store, 'base_fingerprint', side_effect=changing):
            self.assert_error('base_changed', self.publish)

    def test_old_release_rejected_after_interpreter_or_metadata_changes(self):
        first = self.publish()
        interpreter = self.base / 'bin/python3.12'
        old = interpreter.read_bytes()
        interpreter.write_bytes(old + b' changed')
        self.assert_error('base_changed', self.store.release, self.user, self.slug, first['release'])
        interpreter.write_bytes(old)
        self.store.release(self.user, self.slug, first['release'])
        metadata = self.base / 'lib/python3.12/site-packages/pkg-1.dist-info'
        metadata.mkdir()
        (metadata / 'METADATA').write_text('Name: pkg\nVersion: 1\n')
        self.assert_error('base_changed', self.store.release, self.user, self.slug, first['release'])

    def test_entry_limits_and_free_space_stay_strict_above_byte_warning(self):
        self.store.max_entries = 1
        self.assert_error('limit_exceeded', self.publish)
        self.store.max_entries = 200000
        self.store.warning_bytes = 1
        published = self.publish()
        self.assertEqual(published['state'], 'READY')
        self.assertGreater(published['bytes'], 1)
        self.assertEqual(published['warnings'], [{'code':'LARGE_PROJECT',
            'bytes':published['bytes'], 'warningBytes':1, 'blocking':False}])
        self.assertEqual(self.store.release(self.user,self.slug,published['release'])['meta']['bytes'],published['bytes'])
        self.assertEqual(self.store.status(self.user,self.slug)['warnings'],published['warnings'])
        self.assertEqual(self.store.status(self.user,self.slug)['releases'][0]['warnings'],published['warnings'])
        self.store.warning_bytes = 50 * 1024**3
        self.store.reserve_bytes = 100
        with patch.object(module.os, 'fstatvfs', return_value=SimpleNamespace(f_bavail=99, f_frsize=1)):
            self.assert_error('insufficient_space', self.publish)

    def test_warning_boundary_and_protocol_integer_are_distinct(self):
        self.assertEqual(self.store.size_warnings(self.store.warning_bytes), [])
        self.assertFalse(self.store.size_warnings(self.store.warning_bytes+1)[0]['blocking'])
        self.assertEqual(self.store.size_warnings(4*1024**3,file=True), [])
        self.assertEqual(self.store.size_warnings(4*1024**3+1,file=True)[0]['code'], 'LARGE_FILE')
        for bad in (True,-1,2**53,1.5):
            self.assert_error('invalid_input', self.store.size_warnings, bad)

    def test_per_user_project_count(self):
        self.store.max_projects = 1
        self.assert_error('limit_exceeded', self.store.create, self.user, 'another')
        self.assertEqual(self.store.create('other', 'another')['state'], 'DRAFT')

    def test_lock_blocks_publish_and_upload_commit_checks(self):
        with self.store.locked(self.user, self.slug):
            self.assert_error('project_busy', self.publish)
            self.assert_error('project_busy', self.store.fail_if_publishing, self.user, self.slug)
        self.store.fail_if_publishing(self.user, self.slug)

    def test_status_publishing_only_with_live_lock_and_marker(self):
        path = self.dev['code'].parents[1]
        with self.store.locked(self.user, self.slug):
            module.atomic_json(path / '.publishing.json', {'startedAt': 1})
            self.assertEqual(self.store.status(self.user, self.slug)['state'], 'PUBLISHING')
        self.assertEqual(self.store.status(self.user, self.slug)['state'], 'DRAFT')

    def test_exact_run_preparation_reuses_durable_claims_without_legacy_runtime_initialization(self):
        release = self.publish()['release']; job = str(uuid.uuid4())
        observed = self.store.inspect_release_metadata(self.user, self.slug, release)
        reference = {'project_uuid': observed['projectUUID'], 'generation': observed['generation']}
        with patch.object(self.store, 'release', side_effect=AssertionError('must not initialize OCI during preparation')):
            prepared = self.store.prepare_run(self.user, self.slug, release, job, **reference)
            self.assertEqual(self.store.prepare_run(self.user, self.slug, release, job, **reference), prepared)
        self.assertTrue(prepared['runPrepared']); self.assertTrue(prepared['runtimeIdentityVerified'])
        self.assertEqual(prepared['jobId'], job)
        self.assertNotIn(str(self.root), json.dumps(prepared))
        paths = self.store.existing_run_paths(self.user, self.slug, release, job)
        self.assertEqual(set(paths), {'home', 'output'})
        self.assertTrue(all(path.is_dir() for path in paths.values()))
        claim = json.loads((self.store.path / '.run-claims' / (job + '.json')).read_text())
        self.assertEqual(claim['release'], release)

    def test_wrong_project_instance_never_creates_a_run_or_verifies_an_unrelated_runtime(self):
        release = self.publish()['release']; job = str(uuid.uuid4())
        observed = self.store.inspect_release_metadata(self.user, self.slug, release)
        with patch.object(self.store, 'inspect_release_runtime', side_effect=AssertionError('wrong instance runtime')):
            self.assert_error('project_changed', self.store.prepare_run, self.user, self.slug, release, job,
                              project_uuid=observed['projectUUID'], generation='0' * 64)
        self.assertFalse((self.store.path / '.run-claims' / (job + '.json')).exists())

    def test_changed_runtime_prevents_run_preparation_without_creating_claims(self):
        release = self.publish()['release']; job = str(uuid.uuid4())
        observed = self.store.inspect_release_metadata(self.user, self.slug, release)
        (self.base / 'bin/python3.12').write_bytes(b'changed approved base')
        self.assert_error('base_changed', self.store.prepare_run, self.user, self.slug, release, job,
                          project_uuid=observed['projectUUID'], generation=observed['generation'])
        self.assertFalse((self.store.path / '.run-claims' / (job + '.json')).exists())

    def test_run_paths_are_isolated_idempotent_and_globally_bound(self):
        release = self.publish()['release']
        job = str(uuid.uuid4())
        paths = self.store.run_paths(self.user, self.slug, release, job)
        self.assertEqual(set(paths), {'home', 'output'})
        self.assertEqual(paths, self.store.run_paths(self.user, self.slug, release, job))
        second = self.store.run_paths(self.user, self.slug, release, str(uuid.uuid4()))
        self.assertNotEqual(paths['home'], second['home'])
        self.assertNotEqual(paths['output'], self.dev['code'])
        self.store.create('other', self.slug)
        other = self.store.dev_paths('other', self.slug)
        self.initialize_env(other)
        other_release = self.store.publish('other', self.slug)['release']
        self.assert_error('job_conflict', self.store.run_paths, 'other', self.slug, other_release, job)
        (self.dev['code'] / 'train.py').write_text('new release')
        newer = self.publish()['release']
        self.assert_error('job_conflict', self.store.run_paths, self.user, self.slug, newer, job)

    def test_invalid_run_and_release_references_rejected(self):
        release = self.publish()['release']
        self.assert_error('invalid_input', self.store.run_paths, self.user, self.slug, release, '../job')
        self.assert_error('invalid_input', self.store.release, self.user, self.slug, '../release')
        self.assert_error('not_found', self.store.release, self.user, self.slug, '0' * 64)

    def test_existing_outputs_remain_accessible_after_base_upgrade(self):
        release, job = self.publish()['release'], str(uuid.uuid4())
        paths = self.store.run_paths(self.user, self.slug, release, job)
        (paths['output'] / 'checkpoint.bin').write_bytes(b'previous experiment')
        (self.base / 'bin/python3.12').write_bytes(b'upgraded base')
        self.assert_error('base_changed', self.store.release, self.user, self.slug, release)
        self.assertEqual(self.store.existing_run_paths(self.user, self.slug, release, job), paths)
        self.assertEqual((paths['output'] / 'checkpoint.bin').read_bytes(), b'previous experiment')
        self.assert_error('job_conflict', self.store.existing_run_paths, self.user, self.slug, '0' * 64, job)
        unknown = str(uuid.uuid4())
        self.assert_error('not_found', self.store.existing_run_paths, self.user, self.slug, release, unknown)
        self.assertFalse((self.store.path / '.run-claims' / (unknown + '.json')).exists())

    def test_existing_outputs_require_same_owner_project_and_safe_directory(self):
        release, job = self.publish()['release'], str(uuid.uuid4())
        paths = self.store.run_paths(self.user, self.slug, release, job)
        self.store.create('another', self.slug)
        self.assert_error('job_conflict', self.store.existing_run_paths, 'another', self.slug, release, job)
        paths['output'].rename(paths['output'].with_name('actual-output'))
        paths['output'].symlink_to(paths['output'].with_name('actual-output'))
        with self.assertRaises(OSError):
            self.store.existing_run_paths(self.user, self.slug, release, job)

    def test_release_metadata_larger_than_default_json_limit_is_readable(self):
        info = self.publish()
        release = self.store.release(self.user, self.slug, info['release'])
        meta = dict(release['meta'])
        meta['largeRegressionField'] = 'x' * (4 * 1024 * 1024 + 10)
        parent = release['code'].parent
        module.atomic_json(parent / 'meta.json', meta)
        module.atomic_json(parent / 'READY.json', self.store._ready_marker(meta))
        self.assertEqual(self.store.release(self.user, self.slug, info['release'])['meta']['largeRegressionField'], meta['largeRegressionField'])

    def test_status_does_not_load_or_rehash_full_release_manifests(self):
        self.publish()
        with patch.object(self.store, '_release_meta', side_effect=AssertionError('slow manifest read')), patch.object(self.store, 'base_fingerprint', side_effect=AssertionError('slow base hash')):
            result = self.store.status(self.user, self.slug)
        self.assertEqual(result['state'], 'READY')

    def test_release_requires_atomic_ready_and_consistent_metadata(self):
        info = self.publish()
        release = self.store.release(self.user, self.slug, info['release'])
        ready = release['code'].parent / 'READY.json'
        ready.unlink()
        self.assert_error('not_found', self.store.release, self.user, self.slug, info['release'])
        ready.write_text('{}')
        self.assert_error('unsafe_path', self.store.release, self.user, self.slug, info['release'])

    def test_legacy_data_and_user_directories_untouched(self):
        legacy = self.root / 'users/old-user'
        legacy.mkdir(parents=True)
        (legacy / 'active.py').write_text('keep running')
        before = (legacy.stat().st_ino, (legacy / 'active.py').read_bytes())
        self.publish()
        self.assertEqual(before, (legacy.stat().st_ino, (legacy / 'active.py').read_bytes()))


if __name__ == '__main__':
    unittest.main()

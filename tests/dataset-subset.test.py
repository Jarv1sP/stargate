"""Subset protocol/copy-view tests; isolated fixtures, no RPC or real datasets."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('subset_tests', ROOT / 'deploy' / 'dataset-subset.py')
S = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(S)
FIXTURE = json.loads((ROOT / 'tests' / 'fixtures' / 'dataset-subsets.json').read_text())
OWNER = 'fixture-owner'
OPERATION = '00000000-0000-4000-8000-000000000001'


class SelectionTests(unittest.TestCase):
    def test_golden_vectors_share_exact_js_identity(self):
        for vector in FIXTURE['vectors']:
            with self.subTest(selection=vector['selection']):
                self.assertEqual(S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], vector['selection']), vector['expected'])

    def test_rule_order_dedup_unicode_and_version_are_preserved(self):
        before = json.dumps(FIXTURE['manifest'])
        a = S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], {'include': ['train/**', 'metadata.json', 'train/**']})
        b = S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], {'include': ['metadata.json', 'train/**']})
        self.assertEqual(a['selectionId'], b['selectionId'])
        self.assertEqual(json.dumps(FIXTURE['manifest']), before)
        all_files = S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], {'include': ['**']})
        self.assertNotEqual(all_files['selectionId'], FIXTURE['version'])
        self.assertEqual(all_files['fileCount'], len(FIXTURE['manifest']['files']))

    def test_files_from_bom_crlf_spaces_and_empty(self):
        self.assertEqual(S.parse_files_from('\ufeffnotes #1.txt\r\n train \r\n\r\n'.encode()), ['notes #1.txt', ' train '])
        for raw, error in [(b'\xff', 'UTF-8'), (b'', 'empty'), (b'\n', 'empty'), (b'bad\rname', 'relative')]:
            with self.subTest(raw=raw), self.assertRaisesRegex(ValueError, error):
                S.parse_files_from(raw)

    def test_rule_and_files_limits_before_deduplication(self):
        self.assertEqual(S.normalize_selection({'include': ['a'] * 32, 'exclude': ['b'] * 32})['include'], ['a'])
        with self.assertRaisesRegex(ValueError, 'glob rules'):
            S.normalize_selection({'include': ['a'] * 33, 'exclude': ['b'] * 32})
        self.assertEqual(len(S.parse_files_from(b'a\n' * 100000)), 100000)
        with self.assertRaisesRegex(ValueError, '100000'):
            S.parse_files_from(b'a\n' * 100001)
        boundary = (b'a' * 2047 + b'\n') * 4096
        self.assertEqual(len(boundary), 8 * 1024 * 1024)
        self.assertEqual(len(S.parse_files_from(boundary)), 4096)
        with self.assertRaisesRegex(ValueError, '8 MiB'):
            S.parse_files_from(boundary + b'x')
        with self.assertRaisesRegex(ValueError, '1024'):
            S.normalize_selection({'include': ['a' * 1025]})

    def test_missing_empty_invalid_glob_and_traversal_reject(self):
        for value in [{}, {'files': []}, {'files': None}, {'extra': True}, []]:
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'selection|entries'):
                S.normalize_selection(value)
        for name in ['/etc/passwd', 'a/../b', 'a//b', 'C:/data', 'a\\b', '.git/config', 'a\x00b', '\ud800']:
            with self.subTest(path=repr(name)), self.assertRaisesRegex(ValueError, 'relative|unsafe|credential'):
                S.normalize_selection({'files': [name]})
        for pattern in ['a[', 'a[]', 'a[z-a]', 'a]']:
            with self.subTest(pattern=pattern), self.assertRaisesRegex(ValueError, 'glob'):
                S.normalize_selection({'include': [pattern]})
        with self.assertRaisesRegex(ValueError, 'not in'):
            S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], {'files': ['*.bin']})
        with self.assertRaisesRegex(ValueError, 'empty'):
            S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], {'include': ['missing/**']})

    def test_forged_parent_and_cancel_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'SHA mismatch'):
            S.resolve_selection(FIXTURE['manifest'], '0' * 64, {'include': ['**']})
        with self.assertRaisesRegex(ValueError, 'manifest'):
            S.resolve_selection({**FIXTURE['manifest'], 'schema': True}, FIXTURE['version'], {'include': ['**']})
        def cancel():
            raise PermissionError('revoked')
        with self.assertRaisesRegex(PermissionError, 'revoked'):
            S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], {'include': ['**']}, checkpoint=cancel)


class ViewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source, self.output = self.base / 'source', self.base / 'views'
        self.source.mkdir()
        for name, content in FIXTURE['contents'].items():
            target = self.source / name
            target.parent.mkdir(exist_ok=True, parents=True)
            target.write_text(content)
        self.rules = {'include': ['train/**'], 'exclude': ['**/*.tmp']}
        self.descriptor = {'dataset': 'fixture', **S.resolve_selection(FIXTURE['manifest'], FIXTURE['version'], self.rules)}
        self.checks = []

    def tearDown(self):
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                p = Path(root) / name
                if not p.is_symlink():
                    os.chmod(p, 0o600)
        self.temp.cleanup()

    @contextmanager
    def guard(self):
        def check(remaining, inodes):
            self.assertGreaterEqual(remaining, 0)
            self.assertGreaterEqual(inodes, 0)
            self.checks.append((remaining, inodes))
        yield check

    def copy(self, **changes):
        args = dict(owner=OWNER, operation_id=OPERATION, dataset='fixture', machine='example-node', guard=self.guard)
        args.update(changes)
        return S.materialize_view(self.source, self.output, FIXTURE['manifest'], FIXTURE['version'], self.rules, **args)

    def ready(self):
        return self.output / self.descriptor['selectionId']

    def stage(self):
        return self.output / ('.staging-' + OPERATION)

    def test_only_selected_files_copy_sha_and_single_link_readonly(self):
        before = {p: p.stat().st_ctime_ns for p in self.source.rglob('*')}
        result = self.copy()
        self.assertEqual(result['kind'], 'SUBSET')
        self.assertFalse(result['fullVersionReady'])
        self.assertEqual(result['logicalBytes'], self.descriptor['bytes'])
        self.assertIsNone(result['physicalBytes'])
        self.assertEqual(result['version'], FIXTURE['version'])
        files = sorted(p.relative_to(self.ready() / 'data').as_posix() for p in (self.ready() / 'data').rglob('*') if p.is_file())
        self.assertEqual(files, ['train/a.bin', 'train/nested/b.bin'])
        for name in files:
            p = self.ready() / 'data' / name
            original = self.source / name
            self.assertEqual(p.read_bytes(), original.read_bytes())
            self.assertNotEqual(p.stat().st_ino, original.stat().st_ino)
            self.assertEqual(p.stat().st_nlink, 1)
            self.assertEqual(p.stat().st_mode & 0o222, 0)
        self.assertEqual(before, {p: p.stat().st_ctime_ns for p in self.source.rglob('*')})
        self.assertEqual(S.inspect_view(self.ready(), self.descriptor), result)
        self.assertEqual(self.copy(), result)

    def test_guard_denies_before_any_destination_write(self):
        @contextmanager
        def denied():
            raise PermissionError('owner permission revoked')
            yield
        with self.assertRaisesRegex(PermissionError, 'revoked'):
            self.copy(guard=denied)
        self.assertFalse(self.output.exists())

    def test_revocation_during_copy_never_publishes(self):
        @contextmanager
        def revoke():
            def check(*_):
                if self.stage().exists() and any((self.stage() / '.acks').glob('*.json')):
                    raise PermissionError('owner permission revoked')
            yield check
        with self.assertRaisesRegex(PermissionError, 'revoked'):
            self.copy(guard=revoke)
        self.assertFalse(self.ready().exists())
        self.assertEqual(self.copy()['state'], 'READY')

    def test_wrong_sha_does_not_publish_or_modify_original(self):
        (self.source / 'train/a.bin').write_bytes(b'X')
        with self.assertRaisesRegex(ValueError, 'SHA differs'):
            self.copy()
        self.assertFalse(self.ready().exists())
        self.assertEqual((self.source / 'train/a.bin').read_bytes(), b'X')

    def test_no_unselected_file_is_opened_or_hashed(self):
        original = os.open
        def guarded(name, *args, **kwargs):
            if name == 'a.tmp':
                raise AssertionError('unselected file was opened')
            return original(name, *args, **kwargs)
        with patch.object(S.os, 'open', side_effect=guarded):
            self.copy()

    def test_source_symlink_and_hardlink_still_reject(self):
        source = self.source / 'train/a.bin'
        outside = self.base / 'outside'
        outside.write_bytes(b'A')
        source.unlink()
        source.symlink_to(outside)
        with self.assertRaisesRegex(OSError, 'symbolic|links'):
            self.copy()
        source.unlink()
        os.link(outside, source)
        with self.assertRaisesRegex(ValueError, 'single link'):
            self.copy()
        self.assertEqual(outside.read_bytes(), b'A')

    def test_lost_ack_uses_original_uuid_and_discards_only_uncommitted_tail(self):
        write = S.D._write_json
        def lose_ack(path, value, *args, **kwargs):
            if path.parent.name == '.acks' and value['offset']:
                raise OSError('lost ACK')
            return write(path, value, *args, **kwargs)
        with patch.object(S.D, '_write_json', side_effect=lose_ack), self.assertRaisesRegex(OSError, 'lost ACK'):
            self.copy()
        self.assertFalse(self.ready().exists())
        partial = self.stage() / 'data/train/a.bin'
        self.assertEqual(partial.read_bytes(), b'A')
        partial.write_bytes(b'not-confirmed')
        result = self.copy()
        self.assertEqual(result['state'], 'READY')
        self.assertEqual((self.ready() / 'data/train/a.bin').read_bytes(), b'A')
        self.assertEqual(S.D._read_json(self.ready() / 'operation.json')['operationId'], OPERATION)

    def test_wrong_owner_or_reference_cannot_adopt_partial_ack(self):
        @contextmanager
        def interrupted():
            def check(*_):
                if self.stage().exists() and (self.stage() / 'operation.json').exists():
                    raise OSError('paused')
            yield check
        with self.assertRaisesRegex(OSError, 'paused'):
            self.copy(guard=interrupted)
        with self.assertRaisesRegex(ValueError, 'owner, UUID or fixed reference differs'):
            self.copy(owner='other-owner')
        with self.assertRaisesRegex(ValueError, 'staging identity differs'):
            self.copy(dataset='other-dataset')
        with self.assertRaisesRegex(ValueError, 'owner, UUID or fixed reference differs'):
            self.copy(machine='another-node')
        self.assertEqual(self.copy()['state'], 'READY')

    def test_crash_after_ready_before_rename_can_finish_without_widening(self):
        with patch.object(S.D, '_rename_new', side_effect=OSError('interrupted publication')):
            with self.assertRaisesRegex(OSError, 'interrupted publication'):
                self.copy()
        self.assertFalse(self.ready().exists())
        self.assertEqual((self.stage() / 'data').stat().st_mode & 0o222, 0)
        self.assertEqual(self.copy()['state'], 'READY')

    def test_original_uuid_cannot_change_selection_and_original_tree_is_preserved(self):
        @contextmanager
        def pause():
            def check(*_):
                if self.stage().exists() and (self.stage() / 'operation.json').exists():
                    raise OSError('paused')
            yield check
        with self.assertRaisesRegex(OSError, 'paused'):
            self.copy(guard=pause)
        self.rules = {'include': ['metadata.json']}
        with self.assertRaisesRegex(ValueError, 'staging identity differs'):
            self.copy()
        self.assertEqual((self.source / 'metadata.json').read_bytes(), b'{}')

    def test_full_ready_parent_and_its_lease_guard_remain_independent(self):
        cache = S.D.DatasetCache(self.base / 'full-cache', sources={'fixture-source': self.source}, reserve_bytes=0)
        admin, owner = S.D.Principal(OWNER, True), S.D.Principal(OWNER)
        version = cache.register_source(admin, 'fixture', 'fixture-source', [OWNER])['version']
        self.assertEqual(version, FIXTURE['version'])
        cache.materialize(owner, 'fixture', version)
        self.source = cache._paths('fixture', version)['ready'] / 'data'
        original_identity = cache._ready_identity(cache._paths('fixture', version))
        @contextmanager
        def leased():
            record, registered = cache._record_snapshot(owner, 'fixture', version)
            lease = cache.acquire_lease(owner, 'fixture', version, 'subset-copy:' + OPERATION)
            try:
                def check(*_):
                    with cache._locked():
                        cache._check_snapshot(owner, 'fixture', version, registered)
                        cache._check_ready_snapshot(cache._paths('fixture', version), original_identity)
                        self.assertEqual(len(cache._leases('fixture', version)), 1)
                yield check
            finally:
                cache.release_lease(admin, 'fixture', version, lease['leaseId'])
        self.assertFalse(self.copy(guard=leased)['fullVersionReady'])
        self.assertEqual(cache.status(owner, 'fixture', version)['state'], 'READY')
        self.assertEqual(cache._ready_identity(cache._paths('fixture', version)), original_identity)
        self.assertEqual(S.D._scan(self.source), FIXTURE['manifest'])
        self.assertEqual(cache._leases('fixture', version), [])

    def test_foreign_ack_and_unselected_staging_payload_are_rejected(self):
        @contextmanager
        def after_ack():
            def check(*_):
                if self.stage().exists() and any((self.stage() / '.acks').glob('*.json')):
                    raise OSError('paused')
            yield check
        with self.assertRaisesRegex(OSError, 'paused'):
            self.copy(guard=after_ack)
        ack_path = next((self.stage() / '.acks').glob('*.json'))
        original = S.D._read_json(ack_path)
        S.D._write_json(ack_path, {**original, 'bindingSha256': '0' * 64})
        with self.assertRaisesRegex(ValueError, 'ACK identity differs'):
            self.copy()
        S.D._write_json(ack_path, original)
        (self.stage() / 'data' / 'unselected.txt').write_bytes(b'not in selection')
        with self.assertRaisesRegex(ValueError, 'payload differs'):
            self.copy()
        self.assertFalse(self.ready().exists())


if __name__ == '__main__':
    unittest.main()

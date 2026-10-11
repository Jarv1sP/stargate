"""Read existing attempt logs with real descriptors; no GPU execution or log writes by the reader."""
import base64
from copy import deepcopy
import importlib.util
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('job_log_reader',
    Path(__file__).resolve().parents[1] / 'src/infrastructure/gpuq-job-logs.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)


class JobLogsTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.job_id, self.attempt_id = 'J0123456789ab', 'A' + 'a' * 32
        self.path = self.root / f'{self.job_id}-{self.attempt_id}.log'
        self.payload = '训练🙂\nprogress\x00\n'.encode()
        self.path.write_bytes(self.payload)
        self.path.chmod(0o600)
        self.binding = {'dispatchId': 'aaaaaaaa-1111-4111-8111-111111111111', 'nativeDigest': 'b' * 64,
            'nativeOwner': 'owner', 'nativeName': 'name', 'nativeMaxGpus': 4}
        self.reference = {'job': {'job_id': self.job_id, 'submit_key': self.binding['dispatchId'], 'submit_digest': self.binding['nativeDigest'],
            'owner': 'owner', 'name': 'name', 'gpu_count': 4},
            'attempt': {'id': self.attempt_id, 'ordinal': 1, 'state': 'RUNNING', 'log_path': str(self.path)}}
        self.native = SimpleNamespace(call=Mock(side_effect=lambda *_: deepcopy(self.reference)))
        self.reader = M.NativeJobLogs(native=self.native, root=self.root)

    def read(self, **changes):
        return self.reader.read(self.binding, {'attemptId': None, 'fileId': None, 'offset': None, 'maxBytes': 65536, **changes})

    def test_tail_and_byte_cursor_preserve_unicode_and_binary_bytes_without_touching_the_file(self):
        before = self.path.stat()
        tail = self.read(maxBytes=5)
        self.assertEqual(base64.b64decode(tail['dataBase64']), self.payload[-5:])
        self.assertEqual(tail['offset'], len(self.payload) - 5)
        first = self.read(offset=0, maxBytes=1)
        chunks = [base64.b64decode(first['dataBase64'])]
        cursor = first
        while cursor['nextOffset'] < cursor['observedSize']:
            cursor = self.read(attemptId=cursor['attemptId'], fileId=cursor['fileId'], offset=cursor['nextOffset'], maxBytes=1)
            chunks.append(base64.b64decode(cursor['dataBase64']))
        self.assertEqual(b''.join(chunks), self.payload)
        self.assertEqual(cursor['fileId'], first['fileId'])
        self.assertEqual((self.path.stat().st_ino, self.path.stat().st_mtime_ns), (before.st_ino, before.st_mtime_ns))
        self.assertNotIn('log_path', first)
        self.native.call.assert_any_call('attempt_log_reference', {'submit_key': self.binding['dispatchId'], 'attempt_id': self.attempt_id})

    def test_append_continues_the_same_file_and_empty_current_end_is_not_training_completion(self):
        first = self.read()
        with self.path.open('ab') as stream:
            stream.write(b'next\n')
        more = self.read(attemptId=self.attempt_id, fileId=first['fileId'], offset=first['nextOffset'])
        self.assertEqual(more['fileId'], first['fileId'])
        self.assertEqual(base64.b64decode(more['dataBase64']), b'next\n')
        empty = self.read(attemptId=self.attempt_id, fileId=more['fileId'], offset=more['nextOffset'])
        self.assertEqual(empty['dataBase64'], '')
        self.assertEqual(empty['attemptState'], 'RUNNING')

    def test_replacement_shrink_and_truncation_during_read_reject_the_old_cursor(self):
        first = self.read()
        moved = self.path.with_suffix('.old')
        self.path.rename(moved)
        self.path.write_bytes(self.payload)
        with self.assertRaises(M.LogReadError) as failure:
            self.read(attemptId=self.attempt_id, fileId=first['fileId'], offset=first['nextOffset'])
        self.assertEqual(failure.exception.code, 'TASK_LOG_CHANGED')
        current = self.read()
        self.path.write_bytes(b'')
        with self.assertRaises(M.LogReadError) as failure:
            self.read(attemptId=self.attempt_id, fileId=current['fileId'], offset=current['nextOffset'])
        self.assertEqual(failure.exception.code, 'TASK_LOG_CHANGED')
        self.path.write_bytes(self.payload)
        original = os.pread
        def truncate(fd, size, offset):
            self.path.write_bytes(b'')
            return original(fd, size, offset)
        with patch.object(M.os, 'pread', side_effect=truncate), self.assertRaises(M.LogReadError) as failure:
            self.read(offset=0)
        self.assertEqual(failure.exception.code, 'TASK_LOG_CHANGED')

    def test_foreign_binding_or_attempt_never_opens_a_log(self):
        for key in ('submit_key', 'submit_digest', 'owner', 'name', 'gpu_count'):
            value = deepcopy(self.reference)
            value['job'][key] = 1 if key == 'gpu_count' else 'different'
            self.native.call.side_effect = lambda *_, value=value: value
            with patch.object(M.os, 'open', side_effect=AssertionError('identity must match before file I/O')):
                with self.assertRaises(M.LogReadError):
                    self.read()
        self.native.call.side_effect = lambda *_: self.reference
        with patch.object(M.os, 'open', side_effect=AssertionError('wrong attempt must not open')):
            with self.assertRaises(M.LogReadError):
                self.read(attemptId='A' + 'b' * 32)

    def test_stored_paths_cannot_redirect_to_another_file_and_symlinks_or_special_files_are_not_followed(self):
        self.reference['attempt']['log_path'] = str(self.root / 'other.log')
        with patch.object(M.os, 'open', side_effect=AssertionError('path mismatch must not open')), self.assertRaises(M.LogReadError):
            self.read()
        self.reference['attempt']['log_path'] = str(self.path)
        self.path.unlink()
        outside = self.root / 'other.log'; outside.write_bytes(b'not this task')
        self.path.symlink_to(outside)
        with self.assertRaises(OSError):
            self.read()
        self.path.unlink(); os.mkfifo(self.path)
        with self.assertRaises(M.LogReadError):
            self.read()

    def test_missing_references_and_files_are_not_created_and_malformed_cursors_never_contact_native(self):
        self.native.call.side_effect = lambda *_: None
        self.assertIsNone(self.read())
        self.native.call.side_effect = lambda *_: {**self.reference, 'attempt': None}
        self.assertIsNone(self.read())
        self.native.call.side_effect = lambda *_: self.reference
        self.path.unlink()
        with self.assertRaises(FileNotFoundError):
            self.read()
        self.assertFalse(self.path.exists())
        self.native.call.reset_mock()
        for changes in [{'maxBytes': 0}, {'maxBytes': 65537}, {'offset': True}, {'offset': 1},
                        {'attemptId': '../other'}, {'fileId': 'c' * 64}, {'hostPath': '/private'}]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                self.read(**changes)
        self.native.call.assert_not_called()

    def test_all_descriptors_close_after_success_and_after_file_read_failure(self):
        opened = []
        original = os.open
        def track(*args, **kwargs):
            fd = original(*args, **kwargs); opened.append(fd); return fd
        with patch.object(M.os, 'open', side_effect=track):
            self.read()
        for fd in opened:
            with self.assertRaises(OSError): os.fstat(fd)
        opened.clear()
        with (patch.object(M.os, 'open', side_effect=track), patch.object(M.os, 'pread', side_effect=OSError('fixture I/O error')),
              self.assertRaises(OSError)):
            self.read()
        for fd in opened:
            with self.assertRaises(OSError): os.fstat(fd)

    def test_large_logs_only_read_one_bounded_range_and_configured_root_symlinks_are_rejected(self):
        self.path.write_bytes(b'x' * (65536 * 5))
        original, calls = os.pread, []
        def bounded(fd, count, offset):
            calls.append((count, offset)); return original(fd, count, offset)
        with patch.object(M.os, 'pread', side_effect=bounded):
            result = self.read()
        self.assertEqual(calls, [(65536, 65536 * 4)])
        self.assertEqual(len(base64.b64decode(result['dataBase64'])), 65536)
        link = self.root / 'linked-root'; link.symlink_to(self.root, target_is_directory=True)
        self.reference['attempt']['log_path'] = str(link / self.path.name)
        linked = M.NativeJobLogs(native=self.native, root=link)
        with self.assertRaises(OSError):
            linked.read(self.binding, {'attemptId': None, 'fileId': None, 'offset': None, 'maxBytes': 1})


if __name__ == '__main__':
    unittest.main()

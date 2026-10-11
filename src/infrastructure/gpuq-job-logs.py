"""Bounded existing log bytes for one native round. Never creates or rotates logs."""
import base64
from contextlib import ExitStack
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.protocol import Client

ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,255}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')


class LogReadError(RuntimeError):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


class NativeJobLogs:
    def __init__(self, *, native, root):
        self.native, self.root = native, Path(root)
        if not self.root.is_absolute() or '..' in self.root.parts:
            raise ValueError('Invalid configured log root')

    def read(self, binding, request):
        if not isinstance(request, dict) or set(request) != {'attemptId', 'fileId', 'offset', 'maxBytes'}:
            raise ValueError('Invalid log query')
        attempt_id, file_id, offset, limit = (request[key] for key in ('attemptId', 'fileId', 'offset', 'maxBytes'))
        if (attempt_id is not None and (not isinstance(attempt_id, str) or not ID.fullmatch(attempt_id))
            or file_id is not None and (not isinstance(file_id, str) or not HASH.fullmatch(file_id))
            or offset is not None and (type(offset) is not int or not 0 <= offset <= 2**53 - 1)
            or type(limit) is not int or not 1 <= limit <= 65536
            or (file_id is not None and (attempt_id is None or offset is None))
            or (offset not in (None, 0) and file_id is None)):
            raise ValueError('Invalid log cursor')
        observed = self.native.call('attempt_log_reference', {'submit_key': binding['dispatchId'], 'attempt_id': attempt_id})
        if observed is None:
            return None
        job, attempt = observed['job'], observed['attempt']
        expected = {'submit_key': binding['dispatchId'], 'submit_digest': binding['nativeDigest'],
                    'owner': binding['nativeOwner'], 'name': binding['nativeName'], 'gpu_count': binding['nativeMaxGpus']}
        if type(job['gpu_count']) is not int or any(job[key] != value for key, value in expected.items()):
            raise LogReadError('TASK_LOG_UNAVAILABLE')
        if attempt is None:
            return None
        if (not ID.fullmatch(job['job_id']) or not ID.fullmatch(attempt['id'])
            or (attempt_id is not None and attempt['id'] != attempt_id)):
            raise LogReadError('TASK_LOG_UNAVAILABLE')
        name = f"{job['job_id']}-{attempt['id']}.log"
        if attempt['log_path'] is None or Path(attempt['log_path']) != self.root / name:
            raise LogReadError('TASK_LOG_UNAVAILABLE')
        with ExitStack() as handles:
            root_fd = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            handles.callback(os.close, root_fd)
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=root_fd)
            handles.callback(os.close, fd)
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid():
                raise LogReadError('TASK_LOG_UNAVAILABLE')
            identity = hashlib.sha256(json.dumps([job['job_id'], attempt['id'], before.st_dev, before.st_ino]).encode()).hexdigest()
            start = max(0, before.st_size - limit) if offset is None else offset
            if (file_id is not None and file_id != identity) or start > before.st_size:
                raise LogReadError('TASK_LOG_CHANGED')
            count = min(limit, before.st_size - start)
            data = os.pread(fd, count, start)
            if len(data) != count or os.fstat(fd).st_size < before.st_size:
                raise LogReadError('TASK_LOG_CHANGED')
        return {'nativeReceipt': {key: job[key] for key in ('job_id', 'submit_key', 'submit_digest', 'owner', 'name', 'gpu_count')},
                'attemptId': attempt['id'], 'ordinal': attempt['ordinal'], 'attemptState': attempt['state'],
                'fileId': identity, 'offset': start, 'nextOffset': start + len(data), 'observedSize': before.st_size,
                'dataBase64': base64.b64encode(data).decode('ascii')}


def main():
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('Request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'socketPath', 'logRoot', 'binding', 'request'}:
            raise ValueError('Invalid log envelope')
        path = Path(value['socketPath'])
        if not path.is_absolute():
            raise ValueError('Invalid configured socket')
        result = NativeJobLogs(native=Client(path, timeout=5), root=value['logRoot']).read(value['binding'], value['request'])
        print(json.dumps({'result': result}))
        return 0
    except LogReadError as error:
        code = error.code
    except Exception as error:
        code = 'TASK_READ_TIMEOUT' if isinstance(error.__cause__, TimeoutError) else 'TASK_LOG_UNAVAILABLE'
    print(json.dumps({'error': {'code': code}}))
    return 1


if __name__ == '__main__':
    raise SystemExit(main())

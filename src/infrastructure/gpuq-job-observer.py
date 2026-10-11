"""Fixed one-job read; never falls back to full status, show, submit or a file path."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.protocol import Client


def main():
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'socketPath', 'submitKey'}:
            raise ValueError('Invalid observation query')
        path = Path(value['socketPath'])
        if not path.is_absolute():
            raise ValueError('Expected configured absolute socket')
        result = Client(path, timeout=5).call('job_observation', {'submit_key': value['submitKey']})
        print(json.dumps({'result': result}))
        return 0
    except Exception:
        print(json.dumps({'error': {'code': 'GPUQ_JOB_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

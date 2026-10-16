"""Per-attempt GPU samples from the scheduler's existing hardware poll."""
import json
import math
import os
from pathlib import Path
import stat
import tempfile

from .constants import ACTIVE_ATTEMPT_STATES

FILE_NAME = 'gpu-metrics.json'


def _number(value):
    return value if (type(value) is int or type(value) is float and math.isfinite(value)) and value >= 0 else None


def read_metrics(attempt, now, *, available=True):
    result = {'attemptId': attempt['id'] if attempt else None, 'sampledAt': None, 'gpus': []}
    if not attempt:
        return result
    saved = {}
    try:
        fd = os.open(Path(attempt['control_dir']) / FILE_NAME, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd) as stream:
            record = json.loads(stream.read(64 * 1024)) if stat.S_ISREG(os.fstat(stream.fileno()).st_mode) else {}
        result['sampledAt'] = _number(record.get('sampledAt'))
        saved = {row['uuid']: row for row in record.get('gpus', []) if isinstance(row, dict) and 'uuid' in row}
    except (OSError, ValueError, TypeError, AttributeError, RecursionError):
        pass
    current = (available and attempt.get('state') in ACTIVE_ATTEMPT_STATES
               and result['sampledAt'] is not None and now - result['sampledAt'] <= 30)
    for index, uuid in zip(attempt['gpu_indices'], attempt['gpu_uuids']):
        row = saved.get(uuid, {})
        result['gpus'].append({'index': index, 'uuid': uuid,
                              'utilization': _number(row.get('utilization')) if current else None,
                              'memoryUsedMiB': _number(row.get('memoryUsedMiB')) if current else None,
                              'memoryPeakMiB': _number(row.get('memoryPeakMiB'))})
    return result


def observe(attempt, devices, now):
    """Diagnostics are best effort, never a scheduling or launch condition."""
    result = read_metrics(attempt, now)
    by_uuid = {device.uuid: device for device in devices}
    for row in result['gpus']:
        device = by_uuid.get(row['uuid'])
        used = _number(device.memory_used_mib) if device else None
        row['utilization'] = _number(device.utilization_percent) if device else None
        row['memoryUsedMiB'] = used
        if used is not None:
            row['memoryPeakMiB'] = max(used, row['memoryPeakMiB']) if row['memoryPeakMiB'] is not None else used
    result['sampledAt'] = now
    temporary = None
    try:
        # One small replaceable sample in the existing attempt directory. No
        # fsync per hardware poll: losing a diagnostic sample cannot lose data.
        with tempfile.NamedTemporaryFile(mode='w', dir=attempt['control_dir'], prefix='.gpu-metrics-', delete=False) as stream:
            temporary = Path(stream.name)
            json.dump(result, stream)
        os.replace(temporary, Path(attempt['control_dir']) / FILE_NAME)
    except OSError:
        pass
    finally:
        if temporary is not None:
            try: temporary.unlink(missing_ok=True)
            except OSError: pass

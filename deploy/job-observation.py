#!/usr/bin/python3
"""Bounded native retry evidence. No submit, cancel, lease or journal writes."""
from contextlib import closing
import fcntl
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import stat
import time

STATES = {'PENDING', 'STARTING', 'RUNNING', 'PREEMPTING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'LOST'}


def observe_dispatch(root, database, job):
    """Read only: verify no same-ID dispatcher holds its existing job lock.

    Portal must also wait beyond its original request deadline. A later explicit
    retry keeps this exact submit_key, so GPUQ's existing unique key and job
    flock still serialize any delayed original request with that retry.
    """
    result = {'protocol': 'job-dispatch-observation-v1', 'jobId': job['id'],
              'userId': job['userId'], 'submitKey': job['id'],
              'state': 'UNKNOWN', 'requestFinished': False, 'observedAt': time.time()}
    fd = None
    try:
        folder = Path(root) / 'jobs'
        try:
            fd = os.open(folder / (job['id'] + '.lock'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                return result
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except FileNotFoundError:
            pass  # Never create a lock or a job spec for this read.
        spec = folder / (job['id'] + '.json')
        if os.path.lexists(spec):
            with open(spec, 'r') as stream:
                if json.load(stream) != job:
                    return result
        if any(os.path.lexists(folder / (job['id'] + suffix)) for suffix in
               ('.dataset-dispatch-attempted', '.canceled')):
            return result
        with closing(sqlite3.connect(Path(database).resolve().as_uri() + '?mode=ro', uri=True, timeout=2)) as db:
            if db.execute('SELECT id FROM jobs WHERE submit_key=?', (job['id'],)).fetchone():
                return result
        rejected = folder / (job['id'] + '.dataset-not-submitted.json')
        if os.path.lexists(rejected):
            with rejected.open() as stream:
                if json.load(stream) != {'schema': 1, 'jobId': job['id'], 'failureCode': 'DATASET_NOT_READY'}:
                    return result
            if any(os.path.lexists(path) for path in (folder / (job['id'] + '.datasets.json'),
                                                      Path(root) / 'storage-leases' / 'training' / job['id'])):
                return result
            return {**result, 'state': 'REJECTED', 'requestFinished': True, 'observedAt': time.time()}
        return {**result, 'state': 'NOT_SUBMITTED', 'requestFinished': True, 'observedAt': time.time()}
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        return result
    finally:
        if fd is not None:
            os.close(fd)


def observe(root, database, job, data, expected_node_id):
    unavailable = {'protocol': 'native-observation-v1', 'status': 'UNKNOWN'}
    try:
        if not isinstance(expected_node_id, str) or not re.fullmatch(r'J[a-f0-9]{12}', expected_node_id):
            return unavailable
        fd = os.open(Path(root) / 'jobs' / (job['id'] + '.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                return unavailable
            if json.loads(os.read(fd, 65537)) != job:
                return unavailable
        finally:
            os.close(fd)
        native = data.get('job')
        if (not isinstance(native, dict) or native.get('id') != expected_node_id
                or native.get('submit_key') != job['id'] or native.get('state') not in STATES
                or type(native.get('version')) is not int or not 0 <= native['version'] <= 2**53 - 1):
            return unavailable
        # The show snapshot is already serialized by GPUQ's coordinator lock.
        # Recheck its revision in one read-only snapshot with the retry event;
        # any intervening transition yields UNKNOWN, never a mixed generation.
        uri = Path(database).resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(uri, uri=True, timeout=2)) as db:
            db.execute('BEGIN')
            row = db.execute('SELECT id,submit_key,state,version FROM jobs WHERE id=?', (expected_node_id,)).fetchone()
            if row != (expected_node_id, job['id'], native['state'], native['version']):
                return unavailable
            event = db.execute("SELECT id,created_at FROM events WHERE job_id=? AND event_type='JOB_RETRIED' ORDER BY id DESC LIMIT 1", (expected_node_id,)).fetchone()
        observed = time.time()
        if event and (type(event[0]) is not int or not 0 < event[0] <= 2**53 - 1
                      or type(event[1]) not in (int, float) or not math.isfinite(event[1]) or not 0 < event[1] <= observed):
            return unavailable
        attempts = data.get('attempts')
        if not isinstance(attempts, list):
            return unavailable
        latest = attempts[0] if attempts else None
        if latest is not None and (not isinstance(latest, dict) or latest.get('job_id') != expected_node_id
                                   or not isinstance(latest.get('id'), str) or type(latest.get('ordinal')) is not int or latest['ordinal'] < 1):
            return unavailable
        return {'protocol': 'native-observation-v1', 'status': 'CONFIRMED',
                'jobId': job['id'], 'userId': job['userId'], 'nodeJobId': expected_node_id,
                'submitKey': native['submit_key'], 'specVerified': True,
                'state': native['state'], 'nativeVersion': native['version'], 'observedAt': observed,
                'latestRetry': {'eventId': event[0], 'createdAt': event[1]} if event else None,
                'latestAttempt': {key: latest.get(key) for key in ('id', 'ordinal', 'state', 'exit_code', 'failure_reason', 'started_at', 'finished_at')} if latest else None,
                'progress': data.get('progress')}
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error):
        return unavailable

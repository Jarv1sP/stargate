"""Read one immutable node-private launch. No schema repair, preparation or submit.

The database path and runner prefix come from the node service configuration;
only dispatch ID and plan digest are per-task command-line inputs. Hash the
stored UTF-8 bytes so Python never needs to reproduce JavaScript JSON encoding.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'gpuq'))
from gpuq.store import normalized_submission_digest


class RuntimePlanError(RuntimeError):
    code = 'NODE_RUNTIME_PLAN_UNAVAILABLE'


class NodeRuntimePlans:
    def __init__(self, *, database, machine_id, runner):
        self._database = Path(database)
        if not self._database.is_absolute() or not runner or not Path(runner[0]).is_absolute():
            raise ValueError('Invalid node runtime configuration')
        self._machine_id, self._runner = machine_id, list(runner)

    def load(self, *, dispatch_id, plan_digest):
        if (not isinstance(dispatch_id, str) or not re.fullmatch(r'[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}', dispatch_id)
                or not isinstance(plan_digest, str) or not re.fullmatch(r'[a-f0-9]{64}', plan_digest)):
            raise RuntimePlanError('Invalid launch reference')
        try:
            with closing(sqlite3.connect(self._database.as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
                db.execute('PRAGMA query_only=ON')
                row = db.execute('''SELECT b.binding_json, s.submission_json, p.plan_json, p.plan_digest
                    FROM v2_node_dispatch_bindings b JOIN v2_node_launch_specs s USING(dispatch_id)
                    JOIN v2_node_runtime_plans p USING(dispatch_id) WHERE b.dispatch_id=?''', (dispatch_id,)).fetchone()
            if row is None:
                raise RuntimePlanError('Original runtime plan was not observed')
            binding, submission, plan = (json.loads(text) for text in row[:3])
            identity = plan['identity']
            fields = ('dispatchId', 'jobId', 'accountId', 'machineId', 'gpuCount', 'requestHash')
            expected_argv = self._runner + ['--dispatch-id', dispatch_id, '--plan-digest', plan_digest]
            if (plan['schema'] != 1 or hashlib.sha256(row[2].encode('utf-8')).hexdigest() != plan_digest
                    or row[3] != plan_digest or binding['machineId'] != self._machine_id
                    or binding['dispatchId'] != dispatch_id or any(identity[key] != binding[key] for key in fields)
                    or submission['submit_key'] != dispatch_id or submission['argv'] != expected_argv
                    or submission['owner'] != binding['nativeOwner'] or submission['name'] != binding['nativeName']
                    or submission['gpu_count'] != binding['nativeMaxGpus']
                    or normalized_submission_digest(submission) != binding['nativeDigest']):
                raise RuntimePlanError('Stored launch identities differ')
            return {'binding': binding, 'plan': plan}
        except (OSError, sqlite3.Error, ValueError, TypeError, KeyError) as error:
            raise RuntimePlanError('Original runtime plan could not be read') from error

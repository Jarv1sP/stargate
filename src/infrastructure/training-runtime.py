"""Guard the complete input lifetime with the fixed native execution identity.

The caller supplies the plan read from NodeRuntimePlans, not public request
fields. Container execution and stopped-consumer release are separate stages.
"""
from contextlib import contextmanager
from copy import deepcopy


class TrainingRuntime:
    def __init__(self, *, authority, inputs, plan):
        self._authority, self._inputs = authority, inputs
        self._plan = deepcopy(plan)
        if plan['schema'] != 1:
            raise ValueError('Unsupported runtime plan')

    @contextmanager
    def open(self):
        identity = self._authority.require_current()
        plan = self._plan
        if (identity.dispatch_id != plan['identity']['dispatchId'] or identity.job_id != plan['identity']['jobId']
                or identity.account_id != plan['identity']['accountId']):
            raise RuntimeError('Runtime plan belongs to another execution')
        project = {key: plan['project'][key] for key in ('project', 'release', 'projectUUID', 'generation')}
        with self._inputs.open(user_id=identity.account_id, job_id=identity.job_id,
                              project=project, inputs=deepcopy(plan['inputs'])) as resources:
            if resources['runtime'] != plan['project']['runtime']:
                raise RuntimeError('Runtime environment differs from the original plan')
            if self._authority.require_current() != identity:
                raise RuntimeError('Native execution identity changed while opening inputs')
            yield {**resources, 'execution': identity, 'command': deepcopy(plan['submission']['execution'])}

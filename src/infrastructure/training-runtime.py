"""Guard the complete input lifetime with the fixed native execution identity.

The caller supplies the plan read from NodeRuntimePlans, not public request
fields. The injected engine owns container supervision; confirmed-consumer
resource release remains a separate scheduler operation.
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

    def run(self, *, budget, command, engine):
        """Keep inputs and control views open through the engine's synchronous run.

        Apply limits before passing any user command to the engine. A changed
        attempt during preparation must not execute the old payload. Returning
        an exit code closes handles, not durable leases or scheduler claims.
        """
        with self.open() as resources, budget.open(resources['execution']) as limits, \
                command.open(resources, sharing=self._plan['submission']['resources']['sharing']) as payload:
            if self._authority.require_current() != resources['execution']:
                raise RuntimeError('Native execution identity changed before container launch')
            return engine.run(resources=resources, command=payload, budget=limits)

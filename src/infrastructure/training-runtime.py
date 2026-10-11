"""Guard the complete input lifetime with the fixed native execution identity.

The caller supplies the node's immutable project/data plan, not public request
fields. Container execution and stopped-consumer release are separate stages.
"""
from contextlib import contextmanager
from copy import deepcopy


class TrainingRuntime:
    def __init__(self, *, authority, inputs, project, data):
        self._authority, self._inputs = authority, inputs
        self._project, self._data = deepcopy(project), deepcopy(data)

    @contextmanager
    def open(self):
        identity = self._authority.require_current()
        with self._inputs.open(user_id=identity.account_id, job_id=identity.job_id,
                              project=deepcopy(self._project), inputs=deepcopy(self._data)) as resources:
            if self._authority.require_current() != identity:
                raise RuntimeError('Native execution identity changed while opening inputs')
            yield {**resources, 'execution': identity}

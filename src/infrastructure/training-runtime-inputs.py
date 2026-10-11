"""One execution scope owns both project and data handles, not their durable leases.

Only the trusted runner may call this after resolving the immutable task and
its current native attempt. This does not start a container, allocate GPUs,
create missing run directories, or release resources after a failure.
"""
from contextlib import contextmanager


class TrainingRuntimeInputs:
    def __init__(self, *, projects, data):
        self._projects, self._data = projects, data

    @contextmanager
    def open(self, *, user_id, job_id, project, inputs):
        if not isinstance(project, dict) or set(project) != {'project', 'release', 'projectUUID', 'generation'}:
            raise ValueError('Invalid project run reference')
        with self._projects.open_run(user_id, project['project'], project['release'], job_id,
                project_uuid=project['projectUUID'], generation=project['generation']) as prepared:
            with self._data.open(user_id=user_id, job_id=job_id, inputs=inputs) as mounts:
                yield {**prepared, 'dataMounts': mounts}

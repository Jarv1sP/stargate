"""Container-only command and checkpoint IPC for an opened TrainingRuntime.

The runtime owns project/data handles; this scope owns only the attempt/SDK
handles. Engines must execute argv/cwd/env inside their container and keep both
scopes open through execution. Nothing here executes on the host or releases
durable claims/leases when the scope exits.
"""
from contextlib import contextmanager
import os
from pathlib import Path


class TrainingCommand:
    def __init__(self, control, *, config, environment=None):
        self._control = control
        self._config = dict(config)
        self._environment = dict(os.environ if environment is None else environment)

    @contextmanager
    def open(self, resources, *, sharing):
        identity, command = resources['execution'], resources['command']
        expected = str(Path(self._config['controlRoot']) / identity.attempt_id)
        if identity.control_dir != expected:
            raise RuntimeError('Control configuration differs from the authorized attempt')
        # Resolve resume paths against the already-open, job-bound directories.
        persistent = {target: '/proc/self/fd/' + str(resources['descriptors'][name])
                      for name, target in [('code', '/workspace'), ('home', '/home/gpuq'), ('output', '/outputs')]}
        placement = {} if sharing is None or sharing['hami'] is None else {
            'hami': True, 'vramMiB': sharing['vramMiB'], 'smPercent': sharing['hami']['smPercent']}
        files, scheduler = self._control.open_attempt(self._config,
            job_id=identity.native_job_id, task_id=identity.job_id, attempt_id=identity.attempt_id,
            environment=self._environment, mounts=persistent, placement=placement)
        try:
            environment = {**command['env'], **scheduler, 'GPUQ_CONSOLE_DISPATCH_ID': identity.dispatch_id}
            if command['env'].get('PYTHONPATH'):
                environment['PYTHONPATH'] += ':' + command['env']['PYTHONPATH']
            cwd = '/workspace' if command['workingDirectory'] == '.' else '/workspace/' + command['workingDirectory']
            yield {'argv': list(command['argv']), 'workingDirectory': cwd, 'environment': environment, 'mounts': files}
        finally:
            for descriptor, _, _ in files:
                os.close(descriptor)

"""Apply the actual allocation's budget to its existing native systemd unit.

Caller supplies NativeExecutionAuthority's current identity and its fixed
systemd_runner, not user argv/environment. This scope owns only container view
handles; it neither launches a unit nor releases scheduler resources on exit.
"""
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import subprocess


class TrainingBudget:
    def __init__(self, resources, *, systemd, cgroup_root=Path('/sys/fs/cgroup')):
        self._resources = resources
        self._systemd = systemd
        self._root = Path(cgroup_root)

    @contextmanager
    def open(self, identity):
        uuids = [gpu for gpu, _ in identity.assignments]
        requested = self._resources.allocation_limits(len(uuids))
        unit = 'gpuq-' + identity.attempt_id.lower() + '.service'
        self._systemd(['/usr/bin/systemctl', '--user', 'set-property', '--runtime', '--', unit,
            'MemoryMax=' + str(requested['memory']), 'CPUQuota=' + str(requested['cpu'] * 100) + '%',
            'TasksMax=' + str(requested['pids'])], check=True, timeout=10,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        # Reuse the kernel reader: a successful systemctl reply alone is not the budget.
        budget = self._resources.read_allocation_budget(identity.job_id, identity.process.control_group,
                                                       uuids, root=self._root)
        with ExitStack() as handles:
            group = self._resources.cgroup_path(identity.process.control_group, self._root)
            cgroup_fd = os.open(group, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            handles.callback(os.close, cgroup_fd)
            metadata_fd = os.memfd_create('gpuq-resources', os.MFD_CLOEXEC)
            handles.callback(os.close, metadata_fd)
            # dup lets the file object handle partial writes without owning our mount FD.
            with os.fdopen(os.dup(metadata_fd), 'w', encoding='utf-8') as stream:
                json.dump(budget, stream, sort_keys=True)
            os.lseek(metadata_fd, 0, os.SEEK_SET)
            yield {'budget': budget, 'environment': self._resources.resource_environment(budget),
                   'metadataFd': metadata_fd, 'cgroupFd': cgroup_fd}

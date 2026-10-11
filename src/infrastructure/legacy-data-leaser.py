"""Narrow existing-data lease adapter, not publication/copy orchestration.

The caller must authorize the job identity first. This adapter retains native
owner ACL checks; it does not inherit metadata-only coordinator delegation.
"""


class LegacyDataLeaser:
    def __init__(self, module, *, root, kind, mount_point=None, lock_timeout=2.0):
        if kind not in ('cache', 'warehouse'):
            raise ValueError('Invalid managed lease kind')
        self._kind, self._module = kind, module
        self._cache = module.DatasetCache(root, mount_point=mount_point, lock_timeout=lock_timeout, initialize=False)

    def acquire(self, *, user_id, job_id, dataset, version, kind):
        if kind != self._kind:
            raise ValueError('Managed lease differs from configured kind')
        lease = self._cache.acquire_lease(self._module.Principal(user_id, False), dataset, version, job_id,
                                         require_protected=kind == 'warehouse')
        return {'leaseId': lease['leaseId'], 'jobId': job_id, 'accountId': user_id, 'dataset': dataset,
                'version': version, 'kind': kind, 'readOnly': True}

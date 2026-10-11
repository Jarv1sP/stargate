"""Narrow existing-data lease adapter, not publication/copy orchestration.

The caller must authorize job ownership and current data access first. Native
ACL checks remain the default; exact-version lease delegation is separate from
metadata-only delegation and can only come from trusted node configuration.
"""


class LegacyDataLeaser:
    def __init__(self, module, *, root, kind, mount_point=None, lock_timeout=2.0, lease_version=None):
        if kind not in ('cache', 'warehouse'):
            raise ValueError('Invalid managed lease kind')
        self._kind, self._module = kind, module
        if lease_version is not None:
            if not isinstance(lease_version, dict) or set(lease_version) != {'dataset', 'version'}:
                raise ValueError('Invalid delegated lease version')
            module._identifier(lease_version['dataset'])
            module._identifier(lease_version['version'], module.HASH_RE)
        self._lease_version = dict(lease_version) if lease_version is not None else None
        self._cache = module.DatasetCache(root, mount_point=mount_point, lock_timeout=lock_timeout, initialize=False)

    def acquire(self, *, user_id, job_id, dataset, version, kind):
        return self._call('acquire', user_id=user_id, job_id=job_id, dataset=dataset, version=version, kind=kind)

    def lookup(self, *, user_id, job_id, dataset, version, kind):
        return self._call('lookup', user_id=user_id, job_id=job_id, dataset=dataset, version=version, kind=kind)

    def _call(self, operation, *, user_id, job_id, dataset, version, kind):
        if kind != self._kind:
            raise ValueError('Managed lease differs from configured kind')
        delegated = self._lease_version == {'dataset': dataset, 'version': version}
        method = self._cache.acquire_lease if operation == 'acquire' else self._cache.lookup_lease
        lease = method(self._module.Principal(user_id, delegated), dataset, version, job_id, require_protected=kind == 'warehouse')
        if lease is None:
            return None
        return {'leaseId': lease['leaseId'], 'jobId': job_id, 'accountId': user_id, 'dataset': dataset,
                'version': version, 'kind': kind, 'readOnly': True}


def main():
    import importlib.util
    import json
    from pathlib import Path
    import sys
    sys.dont_write_bytecode = True
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Lease request too large')
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {'config', 'request', 'operation'} or value['operation'] not in ('acquire', 'lookup'):
            raise ValueError('Invalid lease envelope')
        config, request = value['config'], value['request']
        if not isinstance(config, dict) or set(config) != {'root', 'kind', 'mountPoint', 'leaseVersion'}:
            raise ValueError('Invalid lease configuration')
        if not isinstance(request, dict) or set(request) != {'userId', 'jobId', 'dataset', 'version', 'kind'}:
            raise ValueError('Invalid lease request')
        spec = importlib.util.spec_from_file_location('v2_dataset_lease_store', Path(__file__).resolve().parents[2] / 'deploy/dataset-cache.py')
        module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module; spec.loader.exec_module(module)
        leaser = LegacyDataLeaser(module, root=config['root'], kind=config['kind'], mount_point=config['mountPoint'], lease_version=config['leaseVersion'])
        method = leaser.acquire if value['operation'] == 'acquire' else leaser.lookup
        result = method(user_id=request['userId'], job_id=request['jobId'], dataset=request['dataset'], version=request['version'], kind=request['kind'])
        print(json.dumps({'result': result}))
        return 0
    except Exception as error:
        print(json.dumps({'error': {'code': 'FORBIDDEN' if isinstance(error, PermissionError) else 'MANAGED_DATA_LEASE_UNAVAILABLE'}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

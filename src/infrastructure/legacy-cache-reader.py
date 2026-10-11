"""Read-only adapter for existing cache publication metadata.

This compatibility boundary reuses manifest, ownership, deletion and READY
checks, not node-executor or its workspace/quota/preparation orchestration.
Retire it when the publication catalogue is migrated, not by guessing READY.
The injected module is the installed, trusted dataset-cache implementation.
"""


class LegacyCacheReader:
    def __init__(self, module, *, root, kind, mount_point=None, lock_timeout=2.0, coordinator_version=None):
        if kind not in ('cache', 'warehouse'):
            raise ValueError('Invalid configured managed source kind')
        self._kind = kind
        self._module = module
        if coordinator_version is not None:
            if not isinstance(coordinator_version, dict) or set(coordinator_version) != {'dataset', 'version'}:
                raise ValueError('Invalid coordinator-owned version')
            module._identifier(coordinator_version['dataset'])
            module._identifier(coordinator_version['version'], module.HASH_RE)
        self._coordinator_version = dict(coordinator_version) if coordinator_version is not None else None
        self._cache = module.DatasetCache(
            root, mount_point=mount_point, lock_timeout=lock_timeout, initialize=False)

    def inspect(self, *, user_id, dataset, version, kind):
        if kind != self._kind:
            raise ValueError('Managed source differs from configured kind')
        # Only a node-configured exact version delegates ACL decisions to V2.
        # This service privilege is for immutable metadata inspection only; it
        # does not promote the user or enable any cache mutation API.
        delegated = self._coordinator_version == {'dataset': dataset, 'version': version}
        actor = self._module.Principal(user_id, delegated)
        status, _ = self._cache._status_snapshot(
            actor, dataset, version, require_protected=kind == 'warehouse')
        return {'dataset': dataset, 'version': version, 'kind': kind,
                'availability': 'available' if status['state'] == 'READY' else 'unavailable',
                **({} if status['state'] == 'READY' else {'reason': 'not-ready'})}

    def export_access(self, *, user_id, dataset, version, kind):
        """Legacy ACL snapshot for migration review, never permission delegation."""
        import hashlib
        if kind != self._kind:
            raise ValueError('Managed source differs from configured kind')
        actor = self._module.Principal(user_id, False)
        _, identity = self._cache._record_snapshot(actor, dataset, version, _read_only=True)
        with self._cache._locked():
            self._cache._check_snapshot(actor, dataset, version, identity, _read_only=True)
            fence = self._cache._retirement_fence(dataset, version)
            if fence is not None and fence['state'] != 'RESTORED':
                raise self._module.CacheError('Cannot export retiring version authorization')
            owners = self._cache._owners(self._cache._dataset(actor, dataset)['owners'])
            snapshot = dict(dataset=dataset, version=version, kind=kind, owners=owners,
                            root=list(self._cache._root_identity), registration=list(identity))
            digest = hashlib.sha256(self._module._json_bytes(snapshot)).hexdigest()
        return dict(dataset=dataset, version=version, kind=kind, legacyOwners=owners, snapshotId=digest)


def main():
    """Private local process protocol; configuration comes from the node adapter."""
    import importlib.util
    import json
    from pathlib import Path
    import sys

    sys.dont_write_bytecode = True
    module = None
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise ValueError('Request too large')
        envelope = json.loads(raw)
        if not isinstance(envelope, dict) or set(envelope) != {'config', 'request', 'operation'}:
            raise ValueError('Invalid inspection envelope')
        config, request = envelope['config'], envelope['request']
        if not isinstance(config, dict) or set(config) != {'root', 'kind', 'mountPoint', 'coordinatorVersion'}:
            raise ValueError('Invalid configured source')
        if not isinstance(request, dict) or set(request) != {'userId', 'dataset', 'version', 'kind'}:
            raise ValueError('Invalid inspection request')
        module_path = Path(__file__).resolve().parents[2] / 'deploy' / 'dataset-cache.py'
        spec = importlib.util.spec_from_file_location('v2_published_cache', module_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        reader = LegacyCacheReader(module, root=config['root'], kind=config['kind'], mount_point=config['mountPoint'],
                                   coordinator_version=config['coordinatorVersion'])
        operations = {'inspect': reader.inspect, 'export-access': reader.export_access}
        if envelope['operation'] not in operations:
            raise ValueError('Invalid inspection operation')
        result = operations[envelope['operation']](user_id=request['userId'], dataset=request['dataset'], version=request['version'], kind=request['kind'])
        print(json.dumps({'result': result}))
        return 0
    except PermissionError:
        print(json.dumps({'error': {'code': 'FORBIDDEN'}}))
        return 1
    except Exception as error:
        # No paths, manifests, passwords or tracebacks cross this local boundary.
        code = 'SOURCE_BUSY' if isinstance(error, getattr(module, 'CacheBusy', ())) else 'SOURCE_UNAVAILABLE'
        print(json.dumps({'error': {'code': code}}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())

"""Runner-owned input descriptors, never RPC receipts or data preparation.

The caller supplies the authorized immutable task's inputs and holds this scope
through container execution. Raw directories remain mutable external inputs;
managed versions require their original durable lease. The runtime must mount
every returned descriptor read-only and close all consumers before lease release.
"""
from contextlib import ExitStack, contextmanager
import importlib.util
import os
from pathlib import Path


_spec = importlib.util.spec_from_file_location('v2_mount_leaser', Path(__file__).with_name('legacy-data-leaser.py'))
_adapter = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_adapter)


class TrainingDataMounts:
    def __init__(self, cache_module, shared_module, *, directories, roots, lease_versions=()):
        self._cache_module, self._shared_module = cache_module, shared_module
        self._roots = {}
        for root in roots:
            if (not isinstance(root, dict) or set(root) not in ({'kind', 'root'}, {'kind', 'root', 'mountPoint'})
                    or root['kind'] not in ('cache', 'warehouse') or root['kind'] in self._roots):
                raise ValueError('Invalid managed mount root')
            self._roots[root['kind']] = {**root, 'root': str(cache_module._absolute(root['root']))}
        policy = {'sharedDataDirectories': directories}
        for kind, name in [('cache', 'datasets'), ('warehouse', 'storageWarehouse')]:
            if kind in self._roots:
                policy[name] = {'root': self._roots[kind]['root']}
        self._directories = dict(shared_module.configured(policy))
        self._delegated = frozenset(self._managed_key(source) for source in lease_versions)
        if any(kind not in self._roots for kind, _, _ in self._delegated):
            raise ValueError('Delegated mount has no configured root')

    def _managed_key(self, source):
        if (not isinstance(source, dict) or set(source) != {'kind', 'datasetId', 'version'}
                or source['kind'] not in ('cache', 'warehouse')):
            raise ValueError('Invalid managed mount reference')
        self._cache_module._identifier(source['datasetId'])
        self._cache_module._identifier(source['version'], self._cache_module.HASH_RE)
        return source['kind'], source['datasetId'], source['version']

    def _plan(self, inputs):
        if not isinstance(inputs, list) or len(inputs) > 100:
            raise ValueError('Invalid training inputs')
        plan = []
        for value in inputs:
            if not isinstance(value, dict) or not isinstance(value.get('source'), dict):
                raise ValueError('Invalid training input')
            source = value['source']
            if source.get('kind') == 'directory':
                if set(value) != {'source'} or set(source) != {'kind', 'sourceId'}:
                    raise ValueError('Invalid directory mount reference')
                name = source['sourceId']
                if not isinstance(name, str) or name not in self._directories:
                    raise ValueError('Directory mount is not configured')
                plan.append(('directory', name, None, None, '/datasets/' + name))
            else:
                if set(value) != {'source', 'leaseId'}:
                    raise ValueError('Managed mount requires its original lease')
                kind, dataset, version = self._managed_key(source)
                if kind not in self._roots:
                    raise ValueError('Managed mount root is not configured')
                plan.append((kind, dataset, version, value['leaseId'], '/data2/' + dataset))
        paths = [row[-1] for row in plan]
        if len(set(paths)) != len(paths):
            raise ValueError('Training input mount paths conflict')
        return plan

    @contextmanager
    def open(self, *, user_id, job_id, inputs):
        self._cache_module._identifier(user_id, self._cache_module.USER_RE)
        self._cache_module._identifier(job_id, self._cache_module.USER_RE)
        plan = self._plan(inputs)
        with ExitStack() as handles:
            mounts = []
            for kind, name, version, lease_id, target in plan:
                if kind == 'directory':
                    descriptor = self._shared_module.open_directory(self._directories[name])
                    handles.callback(os.close, descriptor)
                else:
                    root = self._roots[kind]
                    delegated = (kind, name, version) in self._delegated
                    leaser = _adapter.LegacyDataLeaser(self._cache_module, root=root['root'], kind=kind,
                        mount_point=root.get('mountPoint'), lease_version={'dataset': name, 'version': version} if delegated else None)
                    descriptor = handles.enter_context(leaser.open_mount(user_id=user_id, job_id=job_id,
                        dataset=name, version=version, kind=kind, lease_id=lease_id))
                mounts.append((descriptor, target))
            yield mounts

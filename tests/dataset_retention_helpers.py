"""Real isolated protected READY original for ordinary cache-removal tests.

Tests whose purpose is lease/ACL/cleanup behavior must have a second complete
original now. This builds actual immutable bytes and a permanent seal, rather
than mocking a positive receipt or bypassing last-copy protection. The separate
retirement tests deliberately do not install this guard.
"""
import contextlib
import hashlib
import importlib.util
from pathlib import Path
import threading


def protected_original(cache, module, root, *, source_trees=None):
    spec = importlib.util.spec_from_file_location('retention_fixture_tier',
        Path(__file__).resolve().parents[1]/'node'/'dataset-tier.py')
    tier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tier)
    spec = importlib.util.spec_from_file_location('retention_fixture_cache',
        Path(__file__).resolve().parents[1]/'node'/'dataset-cache.py')
    original = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(original)
    backing = original.DatasetCache(Path(root), reserve_bytes=0)
    local = tier.LocalAuthority(backing)
    sealed = {}
    sealing = threading.RLock()

    def seal_copy(actor, dataset, version):
        with sealing:
            return seal_copy_locked(actor, dataset, version)

    def seal_copy_locked(actor, dataset, version):
        internal = module.Principal(actor.user_id, True)
        source_actor = original.Principal(actor.user_id, True)
        key = (dataset, version)
        if key not in sealed:
            record, registered = cache._record_snapshot(internal, dataset, version)
            with cache._locked():
                cache._check_snapshot(internal, dataset, version, registered)
                owners = cache._dataset(internal, dataset)['owners']
            source_id = 'fixture-' + hashlib.sha256((dataset+version).encode()).hexdigest()[:32]
            backing.sources[source_id] = (source_trees or {}).get(key,cache._paths(dataset, version)['ready']/'data')
            backing.register_manifest(source_actor, dataset, record['manifest'], owners, _version_name=version)
            backing.attach_source(source_actor, dataset, version, source_id)
            backing.materialize(source_actor, dataset, version)
            pin = 'authority-fixture-' + hashlib.sha256((dataset+version).encode()).hexdigest()[:32]
            sealed[key] = local.seal(source_actor, dataset, version, pin)

    # Complete the second original at publication time, before removal tests
    # inject faults into rename/locks. Removal never manufactures its own proof.
    def keep_original(method):
        def publish(actor, dataset, version, *args, **kwargs):
            result = method(actor, dataset, version, *args, **kwargs)
            with cache._locked():
                record = cache._record(actor, dataset, version)
                ready = cache._ready(cache._paths(dataset, version), record['manifest'], version)
            if ready:
                seal_copy(actor, dataset, version)
            return result
        return publish

    internal = module.Principal('fixture-admin', True)
    for dataset in sorted((cache.root/'ready').iterdir()):
        for version in sorted(dataset.iterdir()):
            seal_copy(internal, dataset.name, version.name)

    @contextlib.contextmanager
    def guard(actor, dataset, version):
        internal = original.Principal(actor.user_id, True)
        if (dataset, version) not in sealed:
            raise module.CacheError('no protected fixture original was sealed')
        with local.guard(internal, sealed[(dataset, version)], _hold_global=False):
            yield

    def bind(target):
        if target._root_identity != cache._root_identity:
            raise ValueError('Retention fixture must not guard another cache root')
        target.materialize=keep_original(target.materialize)
        target.publish=keep_original(target.publish)
        target.rebuild_guard=guard
        return target

    bind(cache)
    # Fresh executor adapters share disk state but must still execute their
    # real constructor/mount checks. This binds the same actual sealed original
    # after construction, rather than substituting a positive guard response.
    backing.bind_cache=bind
    backing.seal_cache=seal_copy
    return backing


def protected_executor_original(node, root):
    """Keep the actual constructor/mount/identity path for every fresh adapter."""
    factory = node.dataset_cache
    module, cache = factory()
    backing = protected_original(cache, module, root)

    def storage():
        module, current = factory()
        return module, backing.bind_cache(current)

    node.dataset_cache = storage
    return backing

"""Private fixed-volume training admission snapshot; never reclaim or reserve.

The Portal obtains immutable footprints through the trusted execution bridge;
public job callers cannot provide these fields. This module checks local READY
data, actual pinned volumes, existing dataset reservations and kernel quotas.
Ordinary writers still enforce their live guards after this snapshot.
"""
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time

MAX = 2**53-1
ID = re.compile(r'[A-Za-z0-9][A-Za-z0-9_-]{0,63}\Z')
SLUG = re.compile(r'[a-z][a-z0-9_-]{0,47}\Z')
OWNER = re.compile(r'(builtin-admin|demo-user-[0-9]+)\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
UUID = re.compile(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\Z')


def need(ok, message):
    if not ok:
        raise ValueError(message)


def integer(value):
    return type(value) is int and 0 <= value <= MAX


def total(*values):
    need(all(integer(value) for value in values), 'Unknown storage capacity')
    value = sum(values)
    need(integer(value), 'Storage capacity overflow')
    return value


def load(executor, name):
    spec = importlib.util.spec_from_file_location('gpuq_training_'+name.replace('-', '_'),
                                                 executor.HERE/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def validate(args):
    fields = {'userId', 'hostAdmin', 'datasets', 'datasetReadMode', 'projectFootprint', 'datasetFootprints'}
    need(isinstance(args, dict) and fields <= set(args) <= fields | {'project', 'release', 'workspace'}
         and OWNER.fullmatch(args.get('userId', '')) and args['hostAdmin'] is False
         and args['datasetReadMode'] in ('cache', 'warehouse'), 'Invalid private training storage fields')
    live = 'workspace' in args
    if live:
        need(args['workspace'] is True and 'project' in args and 'release' not in args,
             'Invalid live workspace identity')
    else:
        need(('project' in args) == ('release' in args), 'Incomplete fixed project identity')
    project = args.get('project')
    footprint = args['projectFootprint']
    if project is None:
        need(footprint is None, 'Unexpected project footprint')
    elif live:
        need(isinstance(project, str) and SLUG.fullmatch(project) and footprint is None,
             'Live workspace must not request a project copy')
    else:
        need(isinstance(project, str) and SLUG.fullmatch(project)
             and isinstance(args['release'], str) and HASH.fullmatch(args['release'])
             and isinstance(footprint, dict) and set(footprint) == {
                 'sourceMachine', 'image', 'architecture', 'codeBytes', 'codeEntries', 'imageUnpackedBytes', 'imageEntries'}
             and isinstance(footprint['sourceMachine'], str) and ID.fullmatch(footprint['sourceMachine'])
             and isinstance(footprint['image'], str) and re.fullmatch(r'sha256:[a-f0-9]{64}', footprint['image'])
             and footprint['architecture'] in ('amd64', 'arm64')
             and all(integer(footprint[key]) for key in ('codeBytes', 'codeEntries', 'imageUnpackedBytes'))
             and footprint['imageUnpackedBytes'] > 0
             and (footprint['imageEntries'] is None or integer(footprint['imageEntries'])),
             'Unknown fixed project footprint')
    refs, footprints = args['datasets'], args['datasetFootprints']
    need(isinstance(refs, list) and len(refs) <= 8 and isinstance(footprints, list)
         and len(footprints) == len(refs), 'Invalid dataset footprint list')
    seen = set()
    for ref, value in zip(refs, footprints):
        need(isinstance(ref, dict) and set(ref) == {'dataset', 'version'}
             and isinstance(ref['dataset'], str) and ID.fullmatch(ref['dataset'])
             and isinstance(ref['version'], str) and HASH.fullmatch(ref['version'])
             and ref['dataset'] not in seen, 'Invalid fixed dataset identity')
        seen.add(ref['dataset'])
        need(isinstance(value, dict) and set(value) == {'dataset', 'version', 'bytes', 'files', 'directories', 'manifestBytes'}
             and all(value[key] == ref[key] for key in ('dataset', 'version'))
             and all(integer(value[key]) for key in ('bytes', 'files', 'directories', 'manifestBytes'))
             and 0 < value['manifestBytes'] <= 64*1024**2, 'Unknown dataset footprint')
        total(value['bytes'], total(value['files'], value['directories'])*4096, 8192)
    return args


def digest(args):
    return hashlib.sha256(json.dumps(args, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()


def _project_need(executor, args):
    if 'project' not in args:
        return 65536, 16
    store = executor.projects().store
    if args.get('workspace') is True:
        store.admit(args['userId'], args['project'])
        need(store._project(args['userId'], args['project'])[1].get('runtime') == 'workspace',
             'Workspace has not been initialized')
        return 65536, 16
    try:
        release = store.release(args['userId'], args['project'], args['release'])
    except Exception as error:
        if getattr(error, 'code', None) != 'not_found':
            raise
    else:
        meta, expected = release['meta'], args['projectFootprint']
        need(meta.get('environmentMode') == 'oci' and meta.get('bytes') == expected['codeBytes']
             and meta.get('entries') == expected['codeEntries'], 'Local project footprint changed')
        image = store._oci(args['userId']).portable_image(args['project'], meta['oci'])
        need(image['image'] == expected['image'] and image['architecture'] == expected['architecture'],
             'Local project image changed')
        return 65536, 16
    footprint = args['projectFootprint']
    need(integer(footprint['imageEntries']) and footprint['imageEntries'] > 0, 'Unknown immutable image inode footprint')
    # Receive the archive and retain it while importing the full image. Code
    # is moved, not counted twice. Never assume deduplicated layers or reclaim.
    image = total(footprint['imageUnpackedBytes']*11//10, 16*1024**2)
    return total(footprint['codeBytes'], footprint['codeEntries']*4096, image, image, 65536), total(footprint['codeEntries'], footprint['imageEntries'], 32)


def _volume(fd, reserve, roles, required_bytes, required_inodes, reserved_bytes=0, reserved_inodes=0):
    info, space = os.fstat(fd), os.fstatvfs(fd)
    need(space.f_files > 0 and 0 <= space.f_favail <= space.f_files, 'Unknown storage inode capacity')
    read_only = bool(space.f_flag & getattr(os, 'ST_RDONLY', 1))
    need(not read_only, 'Required training data volume is read-only')
    available = max(0, space.f_bavail)*(space.f_frsize or space.f_bsize)
    reserve_inodes = 1024
    total(available, reserve, reserved_bytes, required_bytes)
    total(space.f_favail, reserve_inodes, reserved_inodes, required_inodes)
    return {'volumeDeviceId': hashlib.sha256(str(info.st_dev).encode()).hexdigest(),
            'roles': list(roles), 'guarded': True, 'readOnly': False,
            'availableBytes': available, 'reserveBytes': reserve,
            'activeReservedBytes': reserved_bytes, 'requiredBytes': required_bytes,
            'usableBytes': max(0, available-reserve-reserved_bytes),
            'availableInodes': space.f_favail, 'reserveInodes': reserve_inodes,
            'activeReservedInodes': reserved_inodes, 'requiredInodes': required_inodes,
            'usableInodes': max(0, space.f_favail-reserve_inodes-reserved_inodes)}


def _fits(volume):
    return (volume['availableBytes'] >= total(volume['reserveBytes'], volume['activeReservedBytes'], volume['requiredBytes'])
            and volume['availableInodes'] >= total(volume['reserveInodes'], volume['activeReservedInodes'], volume['requiredInodes']))


def _quota(executor, owner, volumes):
    value = load(executor, 'storage-quota').training_status(executor.CONFIG, owner)
    need(isinstance(value, dict) and value.get('owner') == owner and type(value.get('enabled')) is bool,
         'Unknown personal quota')
    if value['enabled'] is False:
        need(value.get('enforcement') is None and value.get('volumes') is None, 'Unknown disabled personal quota')
        return {'enabled': False, 'volumes': None}
    need(value.get('enforcement') == 'kernel-project-quota' and isinstance(value.get('volumes'), list),
         'Unknown personal quota enforcement')
    rows = []
    for volume in volumes:
        matches = [row for row in value['volumes'] if row.get('volumeDeviceId') == volume['volumeDeviceId']]
        need(len(matches) == 1, 'Unknown personal quota volume identity')
        row = matches[0]
        need(all(integer(row.get(key)) for key in ('remainingBytes', 'remainingInodes')), 'Unknown personal quota counters')
        rows.append({'volumeDeviceId': volume['volumeDeviceId'], 'remainingBytes': row['remainingBytes'],
                     'remainingInodes': row['remainingInodes'],
                     'requiredBytes': volume['requiredBytes'], 'requiredInodes': volume['requiredInodes']})
    return {'enabled': True, 'volumes': rows}


def _copy_stamp(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid,
            info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _copy_json(folder, name):
    """Read existing protected copy metadata; never create a lock or receipt."""
    fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
    try:
        before = os.fstat(fd)
        need(stat.S_ISREG(before.st_mode) and before.st_uid == os.geteuid()
             and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1
             and before.st_size <= 65536, 'Unknown project copy commitment')
        raw = os.read(fd, 65537)
        need(len(raw) == before.st_size and _copy_stamp(os.fstat(fd)) == _copy_stamp(before), 'Project copy journal changed')
        return json.loads(raw)
    finally:
        os.close(fd)


def _project_copies_idle(executor, s):
    """Original journals only. Unmeasured live/unknown copies fail closed.

    Final payload bytes already belong to statvfs. A terminal receipt alone
    cannot prove that an import/export or its descendants have stopped. Reuse
    the original unit/cgroup probe and existing worker lock without status(),
    which can repair/write receipts. No second reservation ledger is created.
    """
    root = executor.ROOT/'project-copies'
    try:
        folder = os.open(root, s.DIR_FLAGS)
    except FileNotFoundError:
        return
    deadline = time.monotonic()+5
    try:
        identity = os.fstat(folder)
        need(identity.st_uid == os.geteuid() and stat.S_IMODE(identity.st_mode) == 0o700,
             'Unknown project copy journal')
        names = []
        with os.scandir(folder) as entries:
            for entry in entries:
                need(len(names) < 100000 and time.monotonic() < deadline, 'Project copy journal read limit reached')
                names.append(entry.name)
        keys = [name[:-5] for name in names if name.endswith('.json') and UUID.fullmatch(name[:-5])]
        need(len(keys) <= 20000, 'Project copy journal read limit reached')
        slots_name = '00000000-0000-0000-0000-000000000000.slots.json'
        if slots_name in names:
            slots = _copy_json(folder, slots_name)
            need(isinstance(slots, dict) and set(slots) == {'slots'} and isinstance(slots['slots'], list)
                 and len(slots['slots']) <= 4, 'Unknown project copy admission journal')
            for slot in slots['slots']:
                need(isinstance(slot, dict) and set(slot) == {'id', 'userId'}
                     and isinstance(slot['id'], str) and slot['id'] in keys
                     and isinstance(slot['userId'], str) and OWNER.fullmatch(slot['userId']),
                     'Unconfirmed project copy admission')
        if not keys:
            return
        module = load(executor, 'project-copy')
        copies = module.ProjectCopies.__new__(module.ProjectCopies)
        copies.n, copies.root = executor, root  # Do not run the writing constructor.
        for key in keys:
            need(time.monotonic() < deadline, 'Project copy journal read limit reached')
            spec = _copy_json(folder, key+'.json')
            need(isinstance(spec, dict) and spec.get('id') == key
                 and spec.get('role') in ('import', 'export')
                 and isinstance(spec.get('userId'), str) and OWNER.fullmatch(spec['userId'])
                 and isinstance(spec.get('project'), str) and SLUG.fullmatch(spec['project'])
                 and isinstance(spec.get('release'), str) and HASH.fullmatch(spec['release'])
                 and type(spec.get('attempt')) is int and 1 <= spec['attempt'] <= 1000,
                 'Unknown project copy commitment')
            payload = {k: v for k, v in spec.items() if k not in ('id', 'digest', 'attempt', 'createdAt')}
            fields = {'role', 'userId', 'project', 'release'} | (
                {'sourceMachine', 'source'} if spec['role'] == 'import' else {'targetMachine'})
            need(set(payload) == fields and spec.get('digest') == module.t.digest(payload),
                 'Project copy commitment changed')
            try:
                result = _copy_json(folder, key+'.result.json')
                started = _copy_json(folder, key+'.started-'+str(spec['attempt']))
            except FileNotFoundError:
                result = started = None
            final = {'SUCCEEDED', 'FAILED', 'CANCELED'} if spec['role'] == 'import' else {'READY', 'FAILED', 'CANCELED'}
            finished = (isinstance(result, dict) and type(result.get('attempt')) is int
                        and result['attempt'] == spec['attempt'] and result.get('state') in final
                        and isinstance(started, dict) and type(started.get('attempt')) is int
                        and started == {'attempt': spec['attempt']})
            if not finished:
                # Normal cancel can reap a never-started copy without a worker
                # result. Its permanent owner fence prevents any delayed launch
                # from writing payload; the original cleanup receipt alone is
                # insufficient without that fence and the live stop checks below.
                try:
                    canceled = _copy_json(folder, key+'.cancel')
                    cleaned = _copy_json(folder, key+'.cleanup.json')
                except FileNotFoundError:
                    raise ValueError('Unconfirmed project copy commitment') from None
                need(isinstance(canceled, dict) and set(canceled) == {'userId', 'at'}
                     and canceled['userId'] == spec['userId']
                     and isinstance(cleaned, dict) and set(cleaned) == {'at', 'transportFilesReleased'}
                     and cleaned['transportFilesReleased'] is True
                     and all(type(row['at']) in (int, float) and 0 <= row['at'] <= MAX for row in (canceled, cleaned)),
                     'Unconfirmed project copy commitment')
            need(copies.activity(copies.unit(key, spec['attempt'])) is False
                 and time.monotonic() < deadline, 'Active or unconfirmed project copy commitment')
            try:
                worker = os.open(key+'.worker.lock', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=folder)
            except FileNotFoundError:
                raise ValueError('Unconfirmed project copy worker') from None
            try:
                info = os.fstat(worker)
                need(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
                     and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                     'Unknown project copy worker')
                try:
                    fcntl.flock(worker, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    raise ValueError('Active or unconfirmed project copy commitment') from None
            finally:
                os.close(worker)
        need(_copy_stamp(os.fstat(folder)) == _copy_stamp(identity), 'Project copy journal changed')
        with s.directory(root) as current:
            need(_copy_stamp(os.fstat(current)) == _copy_stamp(identity), 'Project copy journal identity changed')
    finally:
        os.close(folder)


def _workspace_dataset_commitments(executor, s, workspace):
    """Unused cache roles can still have future writes on the project device."""
    config = executor.CONFIG.get('datasets')
    if config is None:
        return 0, 0, 0
    need(isinstance(config, dict), 'Unknown configured cache commitment')
    with s.directory(Path(config.get('root', '/data2/datasets'))) as fd:
        if os.fstat(fd).st_dev != workspace.st_dev:
            return 0, 0, 0  # Unused, separate volumes cannot spend project space.
    d, cache = executor.dataset_cache()
    with cache._locked(), d._directory(cache.root) as fd:
        info = os.fstat(fd)
        need(cache.mount is not None and (info.st_dev, info.st_ino) == cache._root_identity
             and info.st_dev == workspace.st_dev, 'Training cache commitment root changed')
        return cache._reserved(), cache._reserved_inodes(), cache.reserve_bytes


def plan(executor, args, *, _existing_upload=None):
    validate(args)
    machine = executor.CONFIG.get('machine')
    need(isinstance(machine, str) and ID.fullmatch(machine), 'Unknown training machine')
    s = load(executor, 'project-store')
    guard = s.check_platform_root(executor.ROOT)
    need(isinstance(guard, dict) and guard.get('guarded') is True, 'Training workspace root is not guarded')
    project_bytes, project_inodes = _project_need(executor, args)
    reserve = s.workspace_start_reserve(executor.CONFIG) if args.get('workspace') else s.workspace_reserve_bytes(executor.CONFIG)
    cache_budget = {'enabled': False, 'budgetBytes': None, 'usedOrReservedBytes': 0, 'requiredBytes': 0}
    with s.directory(executor.ROOT) as workspace:
        workspace_identity = os.fstat(workspace)
        reserved_bytes = reserved_inodes = cache_reserve = 0
        if args['datasetReadMode'] != 'cache' or not args['datasets']:
            reserved_bytes, reserved_inodes, cache_reserve = _workspace_dataset_commitments(executor, s, workspace_identity)
        project = _volume(workspace, max(reserve, cache_reserve), ['project'], project_bytes, project_inodes,
                          reserved_bytes, reserved_inodes)
        volumes = [project]
        if args['datasetReadMode'] == 'warehouse':
            for ref, expected in zip(args['datasets'], args['datasetFootprints']):
                state = executor.dataset_training_sources().status({'userId': args['userId'], 'hostAdmin': False,
                                                                   **ref, 'datasetReadMode': 'warehouse'})
                need(state.get('protocol') == 'dataset-training-source-v1' and state.get('state') == 'READY'
                     and state.get('datasetReadMode') == 'warehouse' and state.get('machine') == machine
                     and state.get('warehouseReady') is True
                     and state.get('authority') == executor.CONFIG.get('storageArchive', {}).get('authority')
                     and isinstance(state.get('authority'), str) and state['authority']
                     and all(state.get(key) == ref[key] for key in ('dataset', 'version'))
                     and all(state.get(key) == expected[key] for key in ('bytes', 'files', 'directories', 'manifestBytes')),
                     'Fixed local warehouse source is not READY')
        elif args['datasets']:
            d, cache = executor.dataset_cache()
            actor = d.Principal(args['userId'], False)
            required_bytes = required_inodes = budget_delta = 0
            # Resolve current fixed bindings/ACL outside the cache-global lock.
            states = []
            for ref, expected in zip(args['datasets'], args['datasetFootprints']):
                try:
                    state = executor.dataset_training_sources().status({'userId': args['userId'], 'hostAdmin': False,
                                                                       **ref, 'datasetReadMode': 'cache'})
                except FileNotFoundError:
                    state = None  # Only private Portal-proved future source footprints.
                if state is not None:
                    need(state.get('protocol') == 'dataset-training-source-v1' and state.get('datasetReadMode') == 'cache'
                         and state.get('machine') == machine and all(state.get(key) == ref[key] for key in ('dataset', 'version'))
                         and all(state.get(key) == expected[key] for key in ('bytes', 'files', 'directories', 'manifestBytes')),
                         'Local dataset footprint changed')
                physical = state.get('reference', ref) if state else ref
                need(isinstance(physical, dict) and set(physical) == {'dataset', 'version'}
                     and physical['version'] == ref['version'] and isinstance(physical['dataset'], str)
                     and ID.fullmatch(physical['dataset']), 'Invalid fixed cache reference')
                record = identity = None
                if state is not None:
                    try:
                        record, identity = cache._record_snapshot(actor, physical['dataset'], physical['version'])
                    except FileNotFoundError:
                        need(state.get('state') != 'READY', 'Cache READY registration is missing')
                states.append((state, physical, record, identity))
            with cache._locked(), d._directory(cache.root) as cachefd:
                need(cache.mount is not None and (os.fstat(cachefd).st_dev, os.fstat(cachefd).st_ino) == cache._root_identity,
                     'Training cache is not on its guarded data mount')
                for ref, expected, observation in zip(args['datasets'], args['datasetFootprints'], states):
                    state, physical, record, identity = observation
                    paths = cache._paths(physical['dataset'], physical['version'])
                    if record is not None:
                        cache._check_snapshot(actor, physical['dataset'], physical['version'], identity)
                        manifest = record['manifest']
                        need(sum(item['size'] for item in manifest['files']) == expected['bytes']
                             and len(manifest['files']) == expected['files']
                             and len(manifest['directories']) == expected['directories']
                             and len(d._json_bytes(manifest)) == expected['manifestBytes'],
                             'Immutable dataset footprint changed')
                    if state and state.get('state') == 'READY':
                        need(cache._ready(paths, record['manifest'], physical['version']), 'Cache READY changed')
                        continue
                    # An existing immutable staging reservation is already
                    # charged by both _reserved and _budget_usage. No double count.
                    if paths['.staging'].exists():
                        stage = cache._transfer(paths['.staging'])
                        need(record is not None and stage['totalBytes'] == expected['bytes'], 'Staging source changed')
                        continue
                    # Private detached-worker adapter only: an upload may have
                    # its full atomic reservation before a manifest registry or
                    # staging tree exists. The callback verifies that ORIGINAL
                    # session + reservation under this same cache lock. Public
                    # RPC fields cannot provide a credit or select this hook.
                    if _existing_upload is not None and _existing_upload(physical, expected):
                        continue
                    if state and state.get('canPrepare') is True:
                        footprint = total(expected['bytes'], total(expected['files'], expected['directories'])*4096, 8192)
                    else:
                        # Cross-node dataset copies enter the ordinary upload
                        # protocol. Its manifest/session metadata is a larger
                        # peak commitment than the final cache footprint.
                        footprint = total(expected['bytes'], expected['manifestBytes']*4,
                                          total(expected['files'], expected['directories'])*8192, 65536)
                    required_bytes = total(required_bytes, footprint)
                    required_inodes = total(required_inodes, expected['files'], expected['directories'], 16)
                    budget_delta = total(budget_delta, footprint)
                reserved_bytes = cache._reserved()
                reserved_inodes = cache._reserved_inodes()
                budget_usage = cache._budget_usage() if cache.budget_bytes is not None else 0
                cache_budget = {'enabled': cache.budget_bytes is not None, 'budgetBytes': cache.budget_bytes,
                                'usedOrReservedBytes': budget_usage, 'requiredBytes': budget_delta}
                if os.fstat(cachefd).st_dev == workspace_identity.st_dev:
                    volumes = [_volume(workspace, max(reserve, cache.reserve_bytes), ['project', 'cache'],
                                       total(project_bytes, required_bytes), total(project_inodes, required_inodes),
                                       reserved_bytes, reserved_inodes)]
                else:
                    volumes.append(_volume(cachefd, cache.reserve_bytes, ['cache'], required_bytes, required_inodes,
                                           reserved_bytes, reserved_inodes))
        # Recheck path/root identities while the actual snapshot descriptors live.
        guard = s.check_platform_root(executor.ROOT)
        need(isinstance(guard, dict) and guard.get('guarded') is True, 'Training workspace root guard changed')
        with s.directory(executor.ROOT) as current:
            identity = os.fstat(current)
            need((identity.st_dev, identity.st_ino) == (workspace_identity.st_dev, workspace_identity.st_ino),
                 'Training workspace root identity changed')
    _project_copies_idle(executor, s)
    quota = _quota(executor, args['userId'], volumes)
    fits = all(_fits(volume) for volume in volumes)
    if cache_budget['enabled']:
        fits = fits and total(cache_budget['usedOrReservedBytes'], cache_budget['requiredBytes']) <= cache_budget['budgetBytes']
    if quota['enabled']:
        fits = fits and all(row['remainingBytes'] >= row['requiredBytes'] and row['remainingInodes'] >= row['requiredInodes']
                            for row in quota['volumes'])
    return {'protocol': 'training-storage-plan-v1', 'machine': machine, 'owner': args['userId'],
            'requestSHA256': digest(args), 'checkedAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            'noReclaim': True, 'fits': fits, 'volumes': volumes, 'cacheBudget': cache_budget, 'quota': quota}

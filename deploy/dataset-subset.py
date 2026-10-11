"""Dataset subset protocol and private copy views; no public RPC in this stage.

The trusted adapter must hold the source lease/version proof and target space
reservation for the lifetime of guard(). Its yielded checkpoint revalidates ACL,
fences, cancellation and free space. No caller paths or hardlinks are accepted
through a node RPC. Capability remains disabled until transfer/training adapters
are connected; full-version cache/authority semantics stay unchanged.
"""
from contextlib import contextmanager
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import stat
import time
import uuid

PROTOCOL = 'dataset-subset-v1'
LIMITS = {'include': 64, 'exclude': 64, 'rules': 64, 'ruleBytes': 1024, 'files': 100000,
          'filesBytes': 8 * 1024 * 1024, 'pathBytes': 4096, 'selectionBytes': 16 * 1024 * 1024,
          'chunkBytes': 256 * 1024}
HASH = re.compile(r'[a-f0-9]{64}\Z')
_spec = importlib.util.spec_from_file_location('subset_cache_primitives', Path(__file__).with_name('dataset-cache.py'))
D = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(D)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def path(value):
    if not isinstance(value, str) or re.match(r'^[A-Za-z]:', value):
        raise ValueError('Invalid relative dataset path')
    try:
        value.encode('utf-8')
    except UnicodeError:
        raise ValueError('Invalid relative dataset path') from None
    return D._relative(value)


def _segment(pattern):
    tokens = []
    i = 0
    while i < len(pattern):
        c = pattern[i]
        if c == '*':
            if not tokens or tokens[-1][0] != 'star':
                tokens.append(('star',))
        elif c == '?':
            tokens.append(('any',))
        elif c == '[':
            end = pattern.find(']', i + 1)
            if end < 0:
                raise ValueError('Unclosed glob character class')
            chars = pattern[i + 1:end]
            negated = chars.startswith('!')
            if negated:
                chars = chars[1:]
            if not chars or '[' in chars:
                raise ValueError('Invalid glob character class')
            ranges, j = [], 0
            while j < len(chars):
                low = high = ord(chars[j])
                if j + 2 < len(chars) and chars[j + 1] == '-':
                    j += 2
                    high = ord(chars[j])
                if low > high:
                    raise ValueError('Invalid glob character range')
                ranges.append((low, high))
                j += 1
            tokens.append(('class', negated, ranges))
            i = end
        elif c == ']':
            raise ValueError('Unmatched glob character class')
        else:
            tokens.append(('literal', c))
        i += 1
    return tokens


def _compile(pattern):
    return [None if part == '**' else _segment(part) for part in path(pattern).split('/')]


def _character(token, char):
    if token[0] == 'any':
        return True
    if token[0] == 'literal':
        return token[1] == char
    inside = any(low <= ord(char) <= high for low, high in token[2])
    return not inside if token[1] else inside


def _match_parts(pattern, names, match):
    i = j = retry = 0
    star = -1
    while i < len(names):
        if j < len(pattern) and pattern[j] is not None and match(pattern[j], names[i]):
            i += 1
            j += 1
        elif j < len(pattern) and pattern[j] is None:
            star = j
            j += 1
            retry = i
        elif star >= 0:
            retry += 1
            i = retry
            j = star + 1
        else:
            return False
    while j < len(pattern) and pattern[j] is None:
        j += 1
    return j == len(pattern)


def _matches(parts, value):
    def match_segment(tokens, text):
        return _match_parts([None if t[0] == 'star' else t for t in tokens], text, _character)
    return _match_parts(parts, value.split('/'), match_segment)


def parse_files_from(raw):
    if not isinstance(raw, bytes) or len(raw) > LIMITS['filesBytes']:
        raise ValueError('files-from exceeds 8 MiB')
    try:
        text = raw.decode('utf-8-sig').replace('\r\n', '\n')
    except UnicodeError:
        raise ValueError('files-from must be UTF-8') from None
    lines = text.split('\n')
    if lines[-1] == '':
        lines.pop()
    if len(lines) > LIMITS['files']:
        raise ValueError('files-from exceeds 100000 lines')
    result = [path(line) for line in lines if line != '']
    if not result:
        raise ValueError('files-from is empty')
    return result


def normalize_selection(value):
    if not isinstance(value, dict) or set(value) - {'include', 'exclude', 'files'}:
        raise ValueError('Invalid subset selection fields')
    result = {}
    for key in ('include', 'exclude', 'files'):
        values = value.get(key, [])
        if not isinstance(values, list) or len(values) > LIMITS[key]:
            raise ValueError('Too many subset ' + key + ' entries')
        for item in values:
            path(item)
            if key != 'files':
                if len(item.encode()) > LIMITS['ruleBytes']:
                    raise ValueError('Subset glob exceeds 1024 bytes')
                _compile(item)
        if key == 'files' and len('\n'.join(values).encode()) > LIMITS['filesBytes']:
            raise ValueError('files-from exceeds 8 MiB')
        result[key] = sorted(set(values), key=lambda p: p.encode('utf-8'))
    if sum(len(value.get(key, [])) for key in ('include', 'exclude')) > LIMITS['rules']:
        raise ValueError('Too many subset glob rules')
    if not any(result.values()):
        raise ValueError('Empty subset selection rules')
    if len(canonical(result)) > LIMITS['selectionBytes']:
        raise ValueError('Subset selection exceeds 16 MiB')
    return result


def resolve_selection(manifest, version, selection, *, checkpoint=lambda: None):
    if not callable(checkpoint):
        raise ValueError('Invalid subset checkpoint')
    deadline = time.monotonic() + 5
    def check():
        checkpoint()
        if time.monotonic() > deadline:
            raise ValueError('Subset resolution exceeded its work budget')
    check()
    if not isinstance(manifest, dict) or type(manifest.get('schema')) is not int:
        raise ValueError('Invalid fixed version manifest')
    manifest = D._manifest(manifest)
    # JSON numbers are consumed by JS too. Do not round immutable byte counts.
    if any(file['size'] > 2**53 - 1 for file in manifest['files']):
        raise ValueError('Invalid manifest file size')
    for name in manifest['directories'] + [f['path'] for f in manifest['files']]:
        path(name)
    if not isinstance(version, str) or not HASH.fullmatch(version) or digest(manifest) != version:
        raise ValueError('Fixed version manifest SHA mismatch')
    rules = normalize_selection(selection)
    include, exclude = ([_compile(p) for p in rules[key]] for key in ('include', 'exclude'))
    exact, selected, present = set(rules['files']), [], set()
    for index, file in enumerate(manifest['files']):
        if index % 256 == 0:
            check()
        name = file['path']
        if name in exact:
            present.add(name)
        if ((not include and not exact or name in exact or any(_matches(p, name) for p in include))
                and not any(_matches(p, name) for p in exclude)):
            selected.append(file)
    if present != exact:
        raise ValueError('A files-from path is not in this fixed version')
    if not selected:
        raise ValueError('Subset selection is empty')
    files_sha = digest([[f['path'], f['size'], f['sha256']] for f in selected])
    selection_id = digest([PROTOCOL, version, rules, files_sha])
    directories = set()
    for file in selected:
        parts = file['path'].split('/')
        directories.update('/'.join(parts[:i]) for i in range(1, len(parts)))
    size = sum(f['size'] for f in selected)
    if size > 2**53 - 1:
        raise ValueError('Subset byte count exceeds safe integer range')
    check()
    return {'protocol': PROTOCOL, 'version': version, 'selectionId': selection_id,
            'filesSha256': files_sha, 'rules': rules, 'fileCount': len(selected), 'bytes': size,
            'manifest': {'schema': 1, 'directories': sorted(directories), 'files': selected}}


def _receipt(descriptor):
    return {key: descriptor[key] for key in ('protocol', 'dataset', 'version', 'selectionId', 'filesSha256', 'fileCount', 'bytes')} | {
        'kind': 'SUBSET', 'state': 'READY', 'fullVersionReady': False,
        'logicalBytes': descriptor['bytes'], 'physicalBytes': None}


@contextmanager
def _view_lock(root, selection_id):
    D._mkdir(root / '.locks')
    with D._directory(root / '.locks') as parent:
        fd = os.open(selection_id + '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=parent)
        try:
            info = D._regular(fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o600:
                raise ValueError('Unsafe subset lock')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise D.CacheBusy('subset view is busy; retry the original selection') from None
            yield
        finally:
            os.close(fd)


def inspect_view(folder, descriptor):
    """Private metadata check, no payload scan; adapter checks ACL/lease first."""
    with D._directory(folder) as fd:
        if os.fstat(fd).st_mode & 0o222:
            raise ValueError('Subset view must remain read-only')
    if D._read_json(folder / 'selection.json') != descriptor or D._read_json(folder / 'READY.json') != _receipt(descriptor):
        raise ValueError('Subset READY identity differs')
    with D._directory(folder / 'data') as fd:
        if os.fstat(fd).st_mode & 0o222:
            raise ValueError('Subset data must remain read-only')
    return _receipt(descriptor)


def materialize_view(source, root, manifest, version, selection, *, owner, operation_id, dataset, machine, guard):
    """Copy only selected paths under a trusted caller-owned lease/reservation.

    guard is mandatory, entered BEFORE creating directories; it yields a callable
    checkpoint which validates current policy and reserves remaining bytes/inodes.
    The integration adapter, not an RPC argument, supplies both paths and guard.
    READY is a subset receipt and can never be consumed as a full-version READY.
    """
    descriptor = resolve_selection(manifest, version, selection)
    D._identifier(owner, D.USER_RE)
    D._identifier(dataset)
    D._identifier(machine)
    descriptor = {'dataset': dataset, **descriptor}
    if not isinstance(operation_id, str) or str(uuid.UUID(operation_id)) != operation_id:
        raise ValueError('Invalid original subset operation UUID')
    binding = {'owner': owner, 'operationId': operation_id, 'dataset': dataset, 'machine': machine, 'readMode': 'cache',
               'version': version, 'selectionId': descriptor['selectionId'], 'filesSha256': descriptor['filesSha256']}
    source, root = D._absolute(source), D._absolute(root)
    if source == root or source in root.parents or root in source.parents:
        raise ValueError('Subset source and destination must be separate trees')
    with guard() as checkpoint:
        if not callable(checkpoint):
            raise ValueError('Trusted subset checkpoint required')
        checkpoint(0, 0)
        # No-follow every ancestor before creating or opening any view entry.
        with D._directory(source):
            pass
        D._mkdir(root)
        with _view_lock(root, 'op-' + operation_id), _view_lock(root, descriptor['selectionId']):
            folder = root / descriptor['selectionId']
            try:
                result = inspect_view(folder, descriptor)
            except FileNotFoundError:
                if os.path.lexists(folder):
                    raise ValueError('Published subset has incomplete metadata') from None
            else:
                checkpoint(0, 0)
                return result
            stage = root / ('.staging-' + operation_id)
            D._mkdir(stage)
            try:
                if D._read_json(stage / 'selection.json') != descriptor:
                    raise ValueError('Subset staging identity differs')
            except FileNotFoundError:
                # A preexisting data tree without its intent is unconfirmed.
                with D._directory(stage) as fd:
                    if os.listdir(fd):
                        raise ValueError('Subset staging has no durable selection intent') from None
                D._write_json(stage / 'selection.json', descriptor)
            try:
                if D._read_json(stage / 'operation.json') != binding:
                    raise ValueError('Subset operation owner, UUID or fixed reference differs')
            except FileNotFoundError:
                with D._directory(stage) as fd:
                    if set(os.listdir(fd)) != {'selection.json'}:
                        raise ValueError('Subset staging has no durable operation binding') from None
                D._write_json(stage / 'operation.json', binding)
            if os.path.lexists(stage / 'READY.json'):
                if D._read_json(stage / 'READY.json') != _receipt(descriptor) or D._scan(stage / 'data') != descriptor['manifest']:
                    raise ValueError('Interrupted subset READY proof differs')
                D._modes(stage, True)
                checkpoint(0, 0)
                D._rename_new(stage, folder)
                return inspect_view(folder, descriptor)
            D._mkdir(stage / 'data')
            D._mkdir(stage / '.acks')
            binding_sha = digest(binding)
            acknowledgments = {}
            for entry in descriptor['manifest']['files']:
                ack_path = stage / '.acks' / (hashlib.sha256(entry['path'].encode()).hexdigest() + '.json')
                try:
                    ack = D._read_json(ack_path)
                except FileNotFoundError:
                    ack = {'bindingSha256': binding_sha, 'path': entry['path'], 'offset': 0,
                           'sha256': hashlib.sha256(b'').hexdigest()}
                if (not isinstance(ack, dict) or set(ack) != {'bindingSha256', 'path', 'offset', 'sha256'}
                        or ack['bindingSha256'] != binding_sha or ack['path'] != entry['path']
                        or type(ack['offset']) is not int or not 0 <= ack['offset'] <= entry['size']
                        or not isinstance(ack['sha256'], str) or not HASH.fullmatch(ack['sha256'])):
                    raise ValueError('Subset persistent ACK identity differs')
                acknowledgments[entry['path']] = (ack_path, ack)
            remaining = sum(e['size'] - acknowledgments[e['path']][1]['offset'] for e in descriptor['manifest']['files'])
            inodes = 2 * descriptor['fileCount'] + len(descriptor['manifest']['directories']) + 4
            checkpoint(remaining, inodes)
            for name in sorted(descriptor['manifest']['directories'], key=lambda p: (p.count('/'), p)):
                D._mkdir(stage / 'data' / name)
            for entry in descriptor['manifest']['files']:
                checkpoint(remaining, inodes)
                filename, output = source / entry['path'], stage / 'data' / entry['path']
                with D._directory(filename.parent) as src_parent, D._directory(output.parent) as dst_parent:
                    src = os.open(filename.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=src_parent)
                    try:
                        before = D._regular(src)
                        if before.st_size != entry['size']:
                            raise ValueError('Selected source size differs from manifest')
                        dst = os.open(output.name, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=dst_parent)
                        try:
                            ack_path, ack = acknowledgments[entry['path']]
                            written = ack['offset']
                            if D._regular(dst).st_size < written:
                                raise ValueError('Subset persistent ACK exceeds the durable payload')
                            if D._digest_fd(dst, written)[0] != ack['sha256']:
                                raise ValueError('Subset durable prefix differs from persistent ACK')
                            # Bytes written without an ACK never advance the resume
                            # offset; recover only this operation's uncommitted tail.
                            os.ftruncate(dst, written)
                            os.fsync(dst)
                            offset, sha = 0, hashlib.sha256()
                            while offset < entry['size']:
                                checkpoint(remaining, inodes)
                                data = os.read(src, min(D.CHUNK_BYTES, entry['size'] - offset))
                                if not data:
                                    raise ValueError('Selected source changed during copy')
                                sha.update(data)
                                prefix = min(len(data), max(0, written - offset))
                                if prefix and os.pread(dst, prefix, offset) != data[:prefix]:
                                    raise ValueError('Subset partial file is not the original prefix')
                                tail = memoryview(data)[prefix:]
                                position = offset + prefix
                                while tail:
                                    n = os.pwrite(dst, tail, position)
                                    if not n:
                                        raise OSError('Subset copy made no progress')
                                    tail, position = tail[n:], position + n
                                os.fsync(dst)
                                offset += len(data)
                                if offset > written:
                                    D._write_json(ack_path, {'bindingSha256': binding_sha, 'path': entry['path'],
                                                          'offset': offset, 'sha256': sha.hexdigest()})
                                    remaining -= len(data) - prefix
                            if sha.hexdigest() != entry['sha256']:
                                raise ValueError('Selected file SHA differs from fixed manifest')
                            if D._stamp(before) != D._stamp(D._regular(src)):
                                raise ValueError('Selected source identity changed during copy')
                            if entry['size'] == 0:
                                D._write_json(ack_path, ack)
                            os.fsync(dst)
                            os.fsync(dst_parent)
                        finally:
                            os.close(dst)
                    finally:
                        os.close(src)
                inodes -= 1
            checkpoint(0, 0)
            if D._scan(stage / 'data') != descriptor['manifest']:
                raise ValueError('Subset payload differs from selected manifest')
            D._write_json(stage / 'READY.json', _receipt(descriptor))
            D._modes(stage, True)
            checkpoint(0, 0)
            D._rename_new(stage, folder)
            return inspect_view(folder, descriptor)

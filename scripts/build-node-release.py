#!/usr/bin/env python3
"""Build offline common-source node packages. Does not install or bind profiles."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import stat
import subprocess
import zipfile

PROFILES = ('7IM', 'R6t', 'FGK', '1zz', 'fiJU', 'peer')
HELPERS = {'node/gpuq-network', 'node/gpuq-ray'}
SERVICES = {'7IM': '--storage-collect', 'R6t': '--container-usage-refresh', 'FGK': '--direct-upload-daemon',
            '1zz': '--direct-upload-daemon', 'peer': '--transfer-peer-daemon'}
PYTHON = ['/usr/bin/python3', '-I', '-B']


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + '\n').encode()


def sources(root):
    """Only tracked Python and the two retained helpers; never private files."""
    names = subprocess.check_output(['git', '-C', str(root), 'ls-files', '-z', '--', 'node', 'gpuq']).decode().split('\0')
    result = {}
    for name in sorted(filter(None, names)):
        path = Path(name)
        if '__pycache__' in path.parts or not (path.suffix in ('.py','.mjs') or name in HELPERS):
            continue
        info = (root / name).lstat()
        if not stat.S_ISREG(info.st_mode):
            raise ValueError('Source must be a regular file: ' + name)
        result[name] = ((root / name).read_bytes(), bool(info.st_mode & 0o111))
    if 'node/core-entry.py' not in result or 'gpuq/__main__.py' not in result:
        raise ValueError('Tracked node/ and gpuq/ sources are required')
    return result


def gpuq_archive(payload):
    """Same deterministic zip format as scripts/build-gpuq.py; source only."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
        for name, (data, _) in sorted(payload.items()):
            if name.startswith('gpuq/'):
                info = zipfile.ZipInfo(name.removeprefix('gpuq/'), (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, data)
    return buffer.getvalue()


def config_template(machine):
    # Structure only. Installer must preserve each existing identity's full
    # private config; null is not a guessed path, budget, role or memory pool.
    return dict(machine=machine,cards=None,root=None,datasetsRoot=None,workspacesRoot=None,
                dataMountPoints=[],database=None,gpu=None,gpuqArchive=None,controlRoot=None,
                jobMemoryGiBPerCard=None,memoryPool=None,
                personalOci=dict(baseImage=None,cdiSpec=None),directUpload=None,
                transferPeer=None,transferPeers=None,cloudFiles=None)



def profile_manifest(name, template):
    return dict(
        configTemplate=f'profiles/{name}/node-config.template.json',
        installedConfig=f'profiles/{name}/node-config.json',
        templateSHA256=digest(template),
        privateConfig=dict(status='not-filled', sha256=None, summary=None),
        binding='not-wired',
        entryCommand=None if name == 'peer' else [*PYTHON, '{release}/node/core-entry.py', '--profile', name],
        serviceCommands=[] if name not in SERVICES else [
            [*PYTHON, '{release}/node/core-service.py', '--profile', name, SERVICES[name]]])


def write(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('xb') as stream:
        stream.write(data)
    path.chmod(mode)


def build(root, output, machines):
    root, output = Path(root).resolve(), Path(output).absolute()
    if not machines or len(set(machines)) != len(machines) or any(
            not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*', name) for name in machines):
        raise ValueError('Provide unique machine IDs without path separators')
    if output.exists():
        raise ValueError('Output already exists; choose a new directory')
    if output == root or root in output.parents and output.parts[len(root.parts)] in ('node', 'gpuq'):
        raise ValueError('Output must not replace source directories')
    revision = subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.run(['git', '-C', str(root), 'diff', '--quiet', 'HEAD', '--', 'node', 'gpuq']).returncode
    payload = sources(root)
    if 'node/cloud-files-worker.mjs' in payload:
        # Bundle the existing grpc transport; the installer supplies only credentials.
        result=subprocess.run(['node',str(root/'scripts/build-cloud-files-node.mjs')],cwd=root,capture_output=True,check=True)
        payload['node/cloud-files-worker.mjs']=(result.stdout,False)
    pyz = gpuq_archive(payload)
    node = {name: digest(data) for name, (data, _) in payload.items() if name.startswith('node/')}
    with zipfile.ZipFile(io.BytesIO(pyz)) as archive:
        members = {name: digest(archive.read(name)) for name in archive.namelist()}
    common = dict(nodeFiles=node, gpuq=dict(path='gpuq.pyz', sha256=digest(pyz), members=members))
    source_hash = digest(encoded(dict(nodeFiles=node, gpuqMembers=members)))
    for machine in machines:
        release = output / machine
        for name, (data, executable) in payload.items():
            if name.startswith('node/'):
                write(release / name, data, 0o555 if executable else 0o444)
        write(release / 'gpuq.pyz', pyz, 0o444)
        profiles = {}
        for name in PROFILES:
            template = encoded(config_template(machine))
            profiles[name] = profile_manifest(name, template)
            write(release / profiles[name]['configTemplate'], template, 0o600)
        manifest = dict(protocol='lean-node-release-v1', machine=machine,
                        sourceRevision=revision, sourceDirty=bool(dirty), sourceSHA256=source_hash,
                        stage='templates-only', scopeReview='pending', profiles=profiles, **common,
                        rollback=dict(releaseDirectory=None, gpuqArchive=None,
                                      profileEntries={name: None for name in PROFILES}))
        write(release / 'manifest.json', encoded(manifest), 0o644)
    return dict(output=str(output), machines=machines, sourceSHA256=source_hash,
                sourceRevision=revision, nodeFiles=len(node), gpuqMembers=len(members),
                gpuqSHA256=digest(pyz), scopeReview='pending')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path, required=True, help='New local directory; existing output is never overwritten')
    parser.add_argument('--machine', action='append', required=True, help='Machine ID from inventory; repeat for each package')
    args = parser.parse_args()
    print(json.dumps(build(args.source_root, args.output, args.machine), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

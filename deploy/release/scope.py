"""Choose changed release components from the last successful deployment."""
from pathlib import PurePosixPath
import json
import subprocess
import sys


def release_scope(paths):
    nodes = portal = False
    for name in paths:
        path = PurePosixPath(name)
        if name == 'docs/USER_GUIDE.md':
            portal = True
            continue
        if name.startswith(('docs/', 'tests/')) or path.suffix == '.md' or name.endswith('_test.go'):
            continue
        node = name.startswith(('node/', 'gpuq/', 'deploy/node/')) or name in (
            'scripts/build-node-release.py', 'scripts/build-cloud-files-node.mjs')
        shared = name in ('package.json', 'package-lock.json')
        nodes |= node or shared
        portal |= shared or not node and (
            len(path.parts) == 1 and path.suffix == '.mjs' or
            name.startswith(('dist/', 'accounts/', 'tasks/', 'native/', 'proto/', 'deploy/release/', 'deploy/vps/')) or
            name in ('.dockerignore', 'deploy/Dockerfile', 'deploy/install-client.sh', 'deploy/install-client.ps1',
                     'scripts/build-client.mjs', 'scripts/build-campus-native.mjs', 'scripts/build-frontend-vendor.mjs'))
    return dict(nodesChanged=nodes, portalChanged=portal, deploy=nodes or portal)


def changed_scope(previous, revision):
    result = subprocess.run(['git', 'merge-base', '--is-ancestor', revision, previous],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if result.returncode == 0:
        return release_scope([])
    if result.returncode > 1:
        return dict(nodesChanged=True, portalChanged=True, deploy=True)
    paths = subprocess.check_output(['git', 'diff', '--name-only', '--no-renames', previous, revision], text=True).splitlines()
    return release_scope(paths)


if __name__ == '__main__':
    print(json.dumps(changed_scope(sys.argv[1], sys.argv[2])))

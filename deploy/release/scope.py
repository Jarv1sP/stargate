"""Choose changed release components from the last successful deployment."""
from pathlib import PurePosixPath
import json
import subprocess
import sys


def release_scope(paths):
    nodes = portal = False
    for name in paths:
        path = PurePosixPath(name)
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


if __name__ == '__main__':
    paths = subprocess.check_output(['git', 'diff', '--name-only', sys.argv[1], sys.argv[2]], text=True).splitlines()
    print(json.dumps(release_scope(paths)))

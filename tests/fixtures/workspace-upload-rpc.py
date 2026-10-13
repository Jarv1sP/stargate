"""Real on-disk workspace upload protocol with a substituted systemd launcher.

No container, GPU, publication or network is started. Each request reopens the
helper on disk; selected faults discard a reply after it committed.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('workspace_uploads', Path(__file__).parents[2] / 'deploy/data-uploads.py')
uploads = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploads)

folder, fault = Path(sys.argv[1]), sys.argv[2]
root = folder / 'project' / 'code'
root.mkdir(parents=True)
config = {'personalDataRoot': str(folder / 'personal')}
Path(config['personalDataRoot']).mkdir()
lost, launches = False, 0


def call(operation, args):
    global lost, launches
    store = uploads.Uploads(config, 'demo-user-1', root=root)
    if operation == 'fixture.proof':
        row = store.process('status', args)
        contents = (root / args['path']).read_bytes()
        other = uploads.Uploads(config, 'demo-user-2')
        denied = False
        try:
            other.process('chunk', {'key': row['key'], 'offset': 0, 'data': ''})
        except FileNotFoundError:
            denied = True
        return {**row, 'sha256': hashlib.sha256(contents).hexdigest(), 'bytes': len(contents),
                'unfinished': len(list(store.folder.glob('*.part'))), 'verifierLaunches': launches,
                'otherAccountState': other.process('status', args)['state'], 'otherAccountDenied': denied}
    assert args.pop('machine') == 'gpu-1'
    assert args.pop('project') == 'alpha'
    assert operation.startswith('data.upload.')
    action = operation.removeprefix('data.upload.')
    with patch.object(uploads, 'active', return_value=False), patch.object(uploads.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as launch:
        result = store.process(action, args)
        launches += launch.call_count
    if action == 'finish' and result['state'] == 'VERIFYING':
        if fault == 'target-edit':
            (root / result['path']).write_bytes(b'edited in terminal')
        save = uploads.save

        def lose(path, row):
            if fault == 'rename' and row['state'] == 'COMPLETE':
                raise OSError('lost rename receipt')
            save(path, row)

        with patch.object(uploads, 'save', side_effect=lose):
            store.verify(args['key'])
        result = store.process('status', {'key': args['key']})
    if not lost and ((fault == 'middle' and action == 'chunk') or (fault == 'finish' and action == 'finish')):
        lost = True
        raise OSError('lost ' + fault + ' receipt')
    return result


for line in sys.stdin:
    try:
        request = json.loads(line)
        response = {'result': call(request['operation'], request['args'])}
    except Exception as error:
        response = {'error': str(error), 'status': 502 if isinstance(error, OSError) else 400}
    print(json.dumps(response), flush=True)

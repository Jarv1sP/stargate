#!/usr/bin/env python3
"""Real node/CLI/RPC/SQLite submission, with a synthetic busy GPU and no CUDA.

The existing terminal fixture supplies a running unrelated task. New tasks go
through node-executor, the native CLI parser, Unix RPC and Coordinator. Only
execution start/drain is simulated; no user training command is executed.
"""
from contextlib import redirect_stdout
from dataclasses import replace
import importlib.util
import io
import json
from pathlib import Path
import shutil
import sys
import threading
import uuid
from unittest.mock import patch


root = Path(__file__).resolve().parents[2]
source = root / 'tests/node-terminal.test.py'
definition = importlib.util.spec_from_file_location('workspace_native_fixture', source)
module = importlib.util.module_from_spec(definition)
definition.loader.exec_module(module)
case = module.NativeTerminal()
case.setUp()
case.running()
blocker = {'job': case.native, 'attempt': case.attempt}
case.patch.stop()

from gpuq import cli
from gpuq.rpc import _ThreadingUnixServer

case.core.config = replace(case.core.config, socket_path=case.root / 'native.sock')
case.core._set_health('ok')
server = _ThreadingUnixServer(case.core.config.socket_path, case.core.handle_api,
                             case.core.config.allowed_uid, case.core.config.max_request_bytes)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()

for name in ('project-ops.py', 'project-store.py', 'project-lifecycle.py', 'local-data.py', 'sandbox-runner.py'):
    shutil.copy2(root / 'deploy' / name, case.root / name)
base = case.root / 'base'
(base / 'bin').mkdir(parents=True)
(base / 'bin/python').write_text('fixture interpreter; never executed')
(base / 'conda-meta').mkdir()
(base / 'conda-meta/python.json').write_text(json.dumps({'name': 'python', 'version': '3.12.1'}))
(base / 'lib').mkdir()
personal = case.root / 'personal-data'
personal.mkdir()
data = case.root / 'original-data'
data.mkdir()
(data / 'sample').write_text('original input')
case.node.CONFIG.update(conda=str(base), personalDataRoot=str(personal),
                        localDataDirectories={'hdd': str(data)}, workspaceReserveBytes=0)
owner, project = 'demo-user-1', 'training'
case.node.workspace(owner)
case.node.process('projects.create', {'userId': owner, 'project': project})
store = case.node.projects().store
paths = store.workspace_paths(owner, project)
(paths['code'] / 'train.py').write_text('print("fixture only")\n')
(paths['output'] / 'keep.txt').write_text('existing output')
project_path, _ = store._project(owner, project)
commands = []


def gpu(*args):
    commands.append(args)
    output = io.StringIO()
    with patch.object(cli.Config, 'from_json', return_value=case.core.config), redirect_stdout(output):
        code = cli.main(['--json', *args])
    result = json.loads(output.getvalue())
    if code:
        raise RuntimeError(result)
    return result


case.node.gpu = gpu


def facts(job_id=None):
    rows = case.store.list_jobs(limit=100)
    selected = next((job for job in rows if job['submit_key'] == job_id), None)
    detail = case.core._api_show({'job_id': selected['id']}) if selected else None
    busy = case.core._api_show({'job_id': blocker['job']['id']})
    return {'job': selected, 'attempts': detail['attempts'] if detail else [],
            'leases': detail['leases'] if detail else [],
            'blockerState': busy['job']['state'], 'blockerLeases': len(busy['leases']),
            'nativeJobs': len(rows), 'submits': sum(args[0] == 'submit' for args in commands),
            'project': {'codeInode': paths['code'].stat().st_ino,
                        'outputInode': paths['output'].stat().st_ino,
                        'code': (paths['code'] / 'train.py').read_text(),
                        'output': (paths['output'] / 'keep.txt').read_text(),
                        'inputInode': (data / 'sample').stat().st_ino,
                        'input': (data / 'sample').read_text(),
                        'runs': len(list((project_path / 'runs').iterdir())),
                        'releases': len(list((project_path / 'releases').iterdir()))}}


print(json.dumps({'ready': True, 'owner': owner, 'project': project, 'initial': facts()}), flush=True)
try:
    with patch.object(store, 'publish', side_effect=AssertionError('submission must not publish')), \
            patch.object(store, 'release', side_effect=AssertionError('submission must not require a release')), \
            patch.object(case.node, 'acquire_datasets', side_effect=AssertionError('submission must not prepare datasets')), \
            patch.object(shutil, 'copytree', side_effect=AssertionError('submission must not copy data')):
        for line in sys.stdin:
            request = json.loads(line)
            try:
                operation, args = request['operation'], request['args']
                if operation == 'facts':
                    result = facts(args.get('jobId'))
                elif operation == 'start-target':
                    # Explicit simulation of the execution backend, after the
                    # unrelated consumer is drained through native finalization.
                    case.core._api_cancel({'job_id': blocker['job']['id']})
                    case.drain()
                    case.native = facts(args['jobId'])['job']
                    attempt_id = 'A' + uuid.uuid4().hex
                    control = case.root / 'control' / attempt_id
                    control.mkdir()
                    log = case.root / 'logs' / attempt_id
                    log.touch()
                    case.attempt = case.store.create_attempt(case.native['id'], attempt_id=attempt_id,
                        state='RUNNING', gpu_uuids=['GPU-test'], gpu_indices=[3],
                        unit_name='gpuq-' + attempt_id.lower(), unit_token=uuid.uuid4().hex,
                        invocation_id=uuid.uuid4().hex, boot_id='test-boot',
                        control_dir=str(control), log_path=str(log))
                    case.store.acquire_leases(case.native['id'], attempt_id, {'GPU-test': 3})
                    case.store.update_job(case.native['id'], state=module.JobState.RUNNING)
                    result = facts(args['jobId'])
                elif operation == 'drain-target':
                    case.drain()
                    result = facts(args['jobId'])
                else:
                    assert operation in ('projects.workspace', 'sync', 'watch', 'cancel'), operation
                    before = len(commands)
                    result = {'node': case.node.process(operation, args), 'commands': commands[before:]}
                reply = {'id': request['id'], 'ok': True, 'result': result}
            except Exception as error:
                reply = {'id': request['id'], 'ok': False, 'error': str(error)}
            print(json.dumps(reply), flush=True)
finally:
    server.shutdown()
    server.server_close()
    thread.join(5)
    case.doCleanups()

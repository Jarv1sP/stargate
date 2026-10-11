"""Real stored plan and input handles; native execution authority is a test double.

No project interpreter, wrapper, user code or GPU is executed here.
"""
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import sys

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


P = load('plan_input_projects', 'deploy/project-store.py')
D = load('plan_input_cache', 'deploy/dataset-cache.py')
S = load('plan_input_shared', 'deploy/shared-data.py')
M = load('plan_input_mounts', 'src/infrastructure/training-data-mounts.py')
I = load('plan_input_scope', 'src/infrastructure/training-runtime-inputs.py')
R = load('plan_input_runtime', 'src/infrastructure/training-runtime.py')
N = load('plan_input_reader', 'src/infrastructure/node-runtime-plan.py')
config = json.load(sys.stdin)
launch = N.NodeRuntimePlans(database=config['database'], machine_id='node-1', runner=config['runner']).load(
    dispatch_id=config['dispatchId'], plan_digest=config['planDigest'])
binding = launch['binding']
calls = []


def mock_current():
    calls.append(True)
    return SimpleNamespace(dispatch_id=binding['dispatchId'], job_id=binding['jobId'], account_id=binding['accountId'])


projects = P.ProjectStore(config['root'], config['basePath'], initialize=False)
mounts = M.TrainingDataMounts(D, S, directories=config['directories'], roots=config['roots'])
inputs = I.TrainingRuntimeInputs(projects=projects, data=mounts)
runtime = R.TrainingRuntime(authority=SimpleNamespace(require_current=mock_current), inputs=inputs, plan=launch['plan'])
with runtime.open() as resources:
    handles = [*resources['descriptors'].values(), *(fd for fd, _ in resources['dataMounts'])]
    reads = []
    for fd, target in resources['dataMounts']:
        with os.fdopen(os.open('sample.txt', os.O_RDONLY, dir_fd=fd)) as sample:
            reads.append({'target': target, 'sample': sample.read(), 'inode': os.fstat(fd).st_ino})
    result = {'reads': reads, 'release': resources['project']['meta']['release'], 'command': resources['command']}
for fd in handles:
    try:
        os.fstat(fd)
    except OSError:
        continue
    raise AssertionError('runtime scope leaked a descriptor')
assert len(calls) == 2
print(json.dumps({'result': result}))

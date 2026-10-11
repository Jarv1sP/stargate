"""Exercise the real read-only node plan loader; never execute the stored argv."""
import importlib.util
import json
from pathlib import Path
import sys

spec = importlib.util.spec_from_file_location('runtime_plan_reader',
    Path(__file__).resolve().parents[2] / 'src/infrastructure/node-runtime-plan.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
database, machine, dispatch, digest, *runner = sys.argv[1:]
try:
    result = module.NodeRuntimePlans(database=database, machine_id=machine, runner=runner).load(
        dispatch_id=dispatch, plan_digest=digest)
    print(json.dumps({'result': result}))
except module.RuntimePlanError as error:
    print(json.dumps({'error': error.code}))

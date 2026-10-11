"""Real native Store/RPC and synthetic execution state; never launches user code."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading
import uuid

spec = importlib.util.spec_from_file_location('job_reader_fixture', Path(__file__).resolve().parents[1] / 'gpuq-priority.test.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from gpuq.rpc import _ThreadingUnixServer

config = json.loads(sys.stdin.readline())
fixture = module.SchedulerPriorityTests()
fixture.setUp()
try:
    raw = {'submit_key': config['dispatchId'], 'name': 'node-task', 'owner': 'node-owner', 'priority': 2,
        'dispatch_mode': 'queue', 'yield_policy': 'never', 'checkpoint_capability': 'none', 'restart_policy': 'never',
        'gpu_count': 4, 'min_gpu_count': 1, 'elastic_gpu_count': True, 'placement': 'any', 'requested_gpu_uuids': [],
        'argv': [sys.executable, '-c', 'private-never-executed'], 'cwd': str(fixture.root), 'env': {'PRIVATE_KEY': 'not-in-observation'}}
    accepted = fixture.coordinator.handle_api('submit_managed', {'submission': raw, 'grant_id': config['dispatchId'], 'max_gpu_count': 2})
    job_id = accepted['job_id']
    attempt_id = 'A' + uuid.uuid4().hex
    log_path = fixture.config.log_dir / f'{job_id}-{attempt_id}.log'
    log_path.write_bytes(config.get('logText', '第一轮训练 🙂\nepoch 3/10\n').encode('utf-8'))
    log_path.chmod(0o600)
    fixture.store.create_attempt(job_id, attempt_id=attempt_id, state='RUNNING', gpu_uuids=['GPU-0', 'GPU-1'], gpu_indices=[0, 1],
        unit_name='fixture-no-unit', unit_token='fixture-no-token', boot_id='fixture-boot', log_path=str(log_path))
    fixture.store.update_job(job_id, state='RUNNING')
    fixture.store.accept_attempt_progress({'version': 1, 'job_id': job_id, 'attempt_id': attempt_id, 'sequence': 1,
        'phase': 'train', 'epochs_completed': 3, 'epochs_total': 10, 'steps_completed': 30, 'steps_total': 100,
        'metrics': {'loss': 0.25}, 'eta_seconds': 60, 'stall_timeout_seconds': 30, 'severity': 'info', 'message': None}, observed_at=100)
    fixture.coordinator.clock = lambda: 110
    if config.get('terminal'):
        fixture.store.update_attempt(attempt_id, state='EXITED_SUCCESS', exit_code=0)
        fixture.store.update_job(job_id, state='SUCCEEDED')
    path = fixture.root / 'observe.sock'
    server = _ThreadingUnixServer(path, fixture.coordinator.handle_api, os.getuid(), 262144)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        receipt = fixture.store.get_submission_receipt(config['dispatchId'])
        print(json.dumps({'socketPath': str(path), 'logRoot': str(fixture.config.log_dir), 'attemptId': attempt_id,
            'nativeDigest': receipt['submit_digest'], 'nodeJobId': job_id,
            'nativeOwner': raw['owner'], 'nativeName': raw['name'], 'nativeMaxGpus': 4}), flush=True)
        # Independent reads must still succeed while the coordinator work lock is held.
        with fixture.coordinator._lock:
            sys.stdin.read()
    finally:
        server.shutdown(); server.server_close(); thread.join(5)
finally:
    fixture.doCleanups()

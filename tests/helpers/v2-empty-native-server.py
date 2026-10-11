"""Disposable real native RPC/store; no scheduler tick or process launch."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import threading

spec = importlib.util.spec_from_file_location('empty_native_fixture', Path(__file__).resolve().parents[1] / 'gpuq-priority.test.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
from gpuq.rpc import _ThreadingUnixServer

fixture = module.SchedulerPriorityTests()
fixture.setUp()
try:
    path = fixture.root / 'submit.sock'
    server = _ThreadingUnixServer(path, fixture.coordinator.handle_api, os.getuid(), 262144)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        print(json.dumps({'socketPath': str(path), 'controlRoot': str(fixture.config.control_dir)}), flush=True)
        sys.stdin.read()
        assert fixture.store.list_attempts() == [], 'fixture must not launch training attempts'
    finally:
        server.shutdown(); server.server_close(); thread.join(5)
finally:
    fixture.doCleanups()

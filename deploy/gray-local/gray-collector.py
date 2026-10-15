"""每 20 秒发布一次原子快照，失败如实记为不可达。"""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('gray-bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

while True:
    hosts = []
    for node in json.loads(Path('/run-config/inventory.json').read_text())['nodes']:
        host = dict(id=node['id'], reachable=False)
        try:
            result = subprocess.run(bridge.ssh(node, 'collector'), input='', text=True,
                                    capture_output=True, timeout=30, check=True)
            host = {**json.loads(result.stdout), 'id': node['id'], 'reachable': True}
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
        hosts.append(host)
    snapshot = dict(version=1, checkedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), hosts=hosts)
    path = Path('/opt/gray/status/snapshot.json')
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(snapshot)+'\n')
    os.chown(temporary, 0, 1000)
    temporary.chmod(0o640)
    temporary.replace(path)
    time.sleep(20)

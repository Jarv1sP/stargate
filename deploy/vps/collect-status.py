#!/usr/bin/python3
"""Read-only collector, separated from the public web process and its credentials."""
import concurrent.futures
import datetime
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

SETTINGS = json.loads(Path(os.environ.get('STARGATE_VPS_CONFIG', '/etc/stargate/vps.json')).read_text())['collector']
ROOT = Path(SETTINGS['credentialDirectory'])
TARGET = Path(SETTINGS['target'])
HOSTS = SETTINGS['hosts']
SSH_CONFIG = SETTINGS.get('sshConfig', '/dev/null')


def collect(item):
    name, host = item
    deadline = time.monotonic() + 25
    command = [
            "/usr/bin/ssh", "-F", SSH_CONFIG, "-T", "-i", str(ROOT / "id_ed25519"),
            "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
            "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3",
            "-o", "ControlMaster=no", "-o", "ControlPath=none",
            "-o", "StrictHostKeyChecking=yes", "-o", f"UserKnownHostsFile={ROOT / 'known_hosts'}",
            f"{host['user']}@{host['address']}", "status"]
    for attempt in (1, 2):
        started = time.monotonic()
        remaining = deadline - started
        if remaining <= 0:
            break
        reason, phase, retry = 'PROBE_INVALID', 'response', False
        try:
            phase = 'ssh'
            result = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True,
                text=True, timeout=remaining / 2 if attempt == 1 else remaining)
            if result.returncode:
                text = result.stderr.lower()
                retry = not any(word in text for word in ('permission denied', 'authentication failed', 'host key verification failed'))
                reason = 'SSH_CONNECT_TIMEOUT' if 'timed out' in text else 'SSH_FAILED'
                raise ValueError('collector SSH failed')
            phase = 'response'
            if len(result.stdout) > 2_000_000:
                raise ValueError("collector SSH failed")
            data = json.loads(result.stdout)
            if data.get("version") != 1 or not isinstance(data.get("gpus"), list):
                raise ValueError("bad snapshot")
            return {**data, "id": name, "reachable": True}
        except (ValueError, OSError, subprocess.SubprocessError) as error:
            if isinstance(error, subprocess.TimeoutExpired):
                reason, retry = 'PROBE_TIMEOUT', True
            elif isinstance(error, (OSError, subprocess.SubprocessError)):
                reason, retry = 'SSH_FAILED', True
            print(json.dumps({'host': name, 'reason': reason, 'phase': phase, 'attempt': attempt,
                              'elapsedMs': round((time.monotonic() - started) * 1000)}), flush=True)
            if not retry:
                break
    return {"id": name, "reachable": False, "error": "当前无法读取机器状态", "gpus": [],
            "gpuq": {"connected": False, "jobs": []}}


def main():
    os.umask(0o027)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        hosts = list(pool.map(collect, HOSTS.items()))
    checked = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        previous = json.loads(TARGET.read_text())
    except (OSError, ValueError):
        previous = {}
    for index, host in enumerate(hosts):
        if host['reachable']:
            host.update(checkedAt=checked, samplingStale=False)
        else:
            last = next((h for h in previous.get('hosts', []) if h.get('id') == host['id']), None)
            if last and last.get('reachable') and last.get('gpus'):
                hosts[index] = {**last, 'samplingStale': True,
                                'checkedAt': last.get('checkedAt', previous.get('checkedAt')),
                                'hostCommand': {'version': 1, 'available': False}}
    snapshot = {"version": 1, "checkedAt": checked, "hosts": hosts}
    fd, name = tempfile.mkstemp(prefix=".snapshot-", dir=TARGET.parent)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(snapshot, output, ensure_ascii=False)
            output.flush()
            os.fsync(output.fileno())
        os.chmod(name, 0o640)
        os.chown(name, SETTINGS['targetUid'], SETTINGS['targetGid'])
        os.replace(name, TARGET)
    finally:
        if os.path.exists(name):
            os.unlink(name)
    print(json.dumps({"reachable": sum(h["reachable"] for h in hosts),
                      "gpuq": sum(h["gpuq"]["connected"] for h in hosts),
                      "retained": sum(h.get('samplingStale', False) for h in hosts), "hosts": len(hosts)}))


if __name__ == "__main__":
    main()

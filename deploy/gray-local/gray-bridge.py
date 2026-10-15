"""仅供隔离灰度栈使用的一行 JSON SSH 桥；已发请求不重试。"""
import json
import os
import socketserver
import subprocess
from pathlib import Path

BASE = Path('/opt/gray')


def ssh(node, role):
    return ['ssh', '-F', '/dev/null', '-T', '-o', 'BatchMode=yes',
            '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentitiesOnly=yes',
            '-o', 'ConnectTimeout=8', '-o', f'UserKnownHostsFile={BASE}/{role}/known_hosts',
            '-i', str(BASE / role / 'id_ed25519'), f"gpuops@{node['address']}"]


def failure(code, status, error):
    return dict(ok=False, code=code, status=status, error=error)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        try:
            raw = self.rfile.readline(2_000_001)
            if len(raw) > 2_000_000 or not raw.endswith(b'\n'):
                raise ValueError('invalid request')
            request = json.loads(raw)
            inventory = json.loads(Path('/run-config/inventory.json').read_text())
            node = next((n for n in inventory['nodes'] if n['id'] == request['machine']), None)
            if node is None:
                reply = dict(ok=False, error='unknown machine')
            else:
                result = subprocess.run(ssh(node, 'executor'), input=json.dumps({
                    'operation': request['operation'], 'args': request['args']})+'\n',
                    text=True, capture_output=True, timeout=30)
                if result.returncode == 255:
                    reply = failure('NODE_CONNECT_FAILED', 503, 'node connect failed')
                else:
                    try:
                        reply = json.loads(result.stdout.strip().splitlines()[-1])
                        if not isinstance(reply, dict) or not isinstance(reply.get('ok'), bool):
                            raise ValueError()
                    except (ValueError, IndexError):
                        reply = failure('NODE_RESPONSE_INVALID', 502, 'invalid node response')
        except subprocess.TimeoutExpired:
            reply = failure('NODE_RESPONSE_TIMEOUT', 504, 'node timeout')
        except (ValueError, KeyError, OSError) as error:
            reply = dict(ok=False, error=str(error)[:200])
        self.wfile.write((json.dumps(reply)+'\n').encode())


if __name__ == '__main__':
    path = Path('/bridge/bridge.sock')
    path.unlink(missing_ok=True)
    with socketserver.ThreadingUnixStreamServer(str(path), Handler) as server:
        server.daemon_threads = True
        os.chown(path, 0, 1000)
        path.chmod(0o660)
        server.serve_forever()

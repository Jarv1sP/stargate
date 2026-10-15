#!/usr/bin/python3
"""Receive a release from the production environment's forced SSH command."""
import fcntl
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import time
sys.path.insert(0, str(Path(__file__).resolve().parent))
from resource_guard import ResourceGuard

ROOT = Path('/opt/stargate-release')


def receive(stream, directory):
    # System-path isolation: uploaded archives cannot escape their run directory.
    with tarfile.open(fileobj=stream, mode='r|') as archive:
        for member in archive:
            name = PurePosixPath(member.name)
            if name.is_absolute() or '..' in name.parts:
                raise PermissionError('Release archive must stay inside its directory')
            target = directory.joinpath(*name.parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.extractfile(member) as source, target.open('xb') as output:
                    shutil.copyfileobj(source, output)
                target.chmod(member.mode & 0o777)
            else:
                raise PermissionError('Release archive may only contain files and directories')


def main(root=ROOT):
    os.umask(0o077)
    revision = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise PermissionError('Pass one release commit as the SSH command')
    with (root/'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        run = root/'runs'/(revision+'-'+str(time.time_ns()))
        run.mkdir(parents=True)
        guard = ResourceGuard(run/'load-memory.jsonl')
        try:
            guard.start()
            receive(sys.stdin.buffer, run)
            guard.checkpoint('stream-received')
            with (run/'image.tar.gz').open('rb') as image:
                process = subprocess.Popen(['docker', 'load'], stdin=image)
                try:
                    while process.poll() is None:
                        guard.checkpoint('image-load')
                        try: process.wait(timeout=1)
                        except subprocess.TimeoutExpired: pass
                    if process.returncode: raise RuntimeError('docker load failed')
                    guard.checkpoint('image-loaded')
                except BaseException:
                    if process.poll() is None:
                        process.terminate(); process.wait(timeout=10)
                    raise
        finally: guard.close()
        subprocess.run([sys.executable, '-I', '-B', str(run/'release/deploy.py'), str(run), revision], check=True)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        print('Deployment stopped: '+str(error), file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/python3
"""The deployment key may only release a commit reachable from origin/main."""
import fcntl
import os
from pathlib import Path
import re
import subprocess
import sys
import time

ROOT = Path('/opt/stargate-release')


def main(root=ROOT):
    os.umask(0o077)
    revision = os.environ.get('SSH_ORIGINAL_COMMAND', '')
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise PermissionError('Pass one main commit as the SSH command')
    with (root/'deploy.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        repo = root/'repository'
        subprocess.run(['git','-C',str(repo),'fetch','origin','main'], check=True)
        subprocess.run(['git','-C',str(repo),'merge-base','--is-ancestor',revision,'origin/main'], check=True)
        subprocess.run(['git','-C',str(repo),'checkout','--detach',revision], check=True)
        run=root/'runs'/(revision+'-'+str(time.time_ns()))
        run.mkdir(parents=True)
        sys.path.insert(0,str(repo/'deploy/release'))
        from resource_guard import ResourceGuard
        guard = ResourceGuard(run/'load-memory.jsonl')
        try:
            guard.start()
            process = subprocess.Popen(['docker','load'], stdin=sys.stdin.buffer)
            try:
                while process.poll() is None:
                    guard.checkpoint('image-load')
                    try: process.wait(timeout=1)
                    except subprocess.TimeoutExpired: pass
                if process.returncode: raise RuntimeError('docker load failed')
                guard.checkpoint('image-loaded')
            except BaseException:
                if process.poll() is None:
                    process.terminate();process.wait(timeout=10)
                raise
        finally: guard.close()
        subprocess.run([sys.executable,'-I','-B',str(repo/'deploy/release/deploy.py'),str(run),revision], check=True)


if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Deployment stopped: '+str(error),file=sys.stderr)
        raise SystemExit(1)

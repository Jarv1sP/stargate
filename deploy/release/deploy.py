#!/usr/bin/python3
"""Release a loaded main image using the existing hold/activate handoff."""
import json
import os
from pathlib import Path
import subprocess
import sys
import time
sys.path.insert(0,str(Path(__file__).resolve().parent))
from docker_backend import DockerBackend
from resource_guard import MAX_CONTAINER, ResourceGuard


def require_portal_only(root, repo, revision):
    previous=(root/'deployed-sha').read_text().strip()
    diff=subprocess.run(['git','-C',str(repo),'diff','--quiet',previous,revision,'--','node/','gpuq/'])
    if diff.returncode==1:
        raise RuntimeError('节点有改动，需要安装；deploy/node/install.py 自动接线尚未启用')
    if diff.returncode:raise RuntimeError('Cannot read the deployed node change range')


def switch(backend, resources):
    old=new=hold=None
    try:
        resources.start()
        old=backend.preflight()
        new=backend.create_stopped(MAX_CONTAINER)
        hold=backend.hold()
        backend.drain(old,hold)
        before=resources.checkpoint('old-before-stop')['available']
        backend.stop(old,hold)
        resources.before_start(MAX_CONTAINER,old_stopped=not backend.running(old),
            available_before_stop=before,running_portals=backend.running_portals())
        backend.start(new,hold)
        backend.healthy(new,hold)
        backend.command(['docker','exec',new,'node','build/gpuctl.mjs','--help'])
        backend.release(hold,new)
        return new
    except BaseException:
        # Restore service only; submitted business requests are never replayed.
        hold=hold or backend.active_hold
        if old:
            backend.stopping_after_failure=True
            if not backend.running(old):
                if not hold or hold.get('released'):hold=backend.hold()
                backend.stop_budget(hold)
                if new:backend.stop(new,hold)
                resources.fault=None
                resources.checkpoint('new-stopped')
                backend.restore_old()
                backend.healthy(old,hold)
            if hold:backend.release(hold,old)
        raise
    finally:resources.close()


def main(run, revision):
    os.umask(0o077)
    root=run.parent.parent;repo=root/'repository'
    require_portal_only(root,repo,revision)
    manifest={'revision':revision,'tag':'stargate:auto-'+revision,'rollback':'stargate:previous'}
    (run/'manifest.json').write_text(json.dumps(manifest))
    resource_log=run/'memory.jsonl'
    resources=ResourceGuard(resource_log)
    backend=DockerBackend(run,resources)
    started=time.monotonic();status='FAILED'
    try:
        identity=switch(backend,resources)
        temporary=root/'deployed-sha.tmp';temporary.write_text(revision+'\n');temporary.replace(root/'deployed-sha')
        status='DEPLOYED'
        return identity
    finally:
        readings=[]
        for name in ('load-memory.jsonl','memory.jsonl'):
            path=run/name
            if path.exists():readings.extend(json.loads(line)['available'] for line in path.read_text().splitlines())
        result={'status':status,'revision':revision,'seconds':round(time.monotonic()-started,3),
                'minimumAvailableBytes':min(readings) if readings else None}
        (run/'result.json').write_text(json.dumps(result)+'\n')
        print(json.dumps(result),flush=True)


if __name__=='__main__':main(Path(sys.argv[1]),sys.argv[2])

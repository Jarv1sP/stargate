#!/usr/bin/python3
"""Release a loaded main image using the existing hold/activate handoff."""
import json
import os
from pathlib import Path
import sys
import subprocess
import tarfile
import time
sys.path.insert(0,str(Path(__file__).resolve().parent))
from docker_backend import DockerBackend
from resource_guard import MAX_CONTAINER, ResourceGuard


def install_nodes(run, root, resources):
    if not json.loads((run/'release.json').read_text())['nodesChanged']:
        return
    targets={node['machine']: node['destination'] for node in json.loads((root/'nodes.json').read_text())}
    for package in sorted((run/'nodes').iterdir()):
        machine=package.name
        print('Installing node '+machine, flush=True)
        resources.checkpoint('node '+machine+' begin')
        try:
            command=['ssh', '-T', '-F', str(root/'node-ssh.conf'),
                 '-i', str(root/'node-release-ed25519'), '-o', 'IdentitiesOnly=yes',
                 '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes',
                 '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
                 '-o', 'ServerAliveCountMax=3', targets[machine]]
            with (run/('node-'+machine+'.private.log')).open('ab') as log:
                process=subprocess.Popen(command, stdin=subprocess.PIPE, stdout=log, stderr=log)
                try:
                    with process.stdin as stream, tarfile.open(fileobj=stream, mode='w|') as archive:
                        archive.add(run/'install.py', arcname='install.py')
                        archive.add(package, arcname='package')
                    while process.poll() is None:
                        resources.checkpoint('node '+machine+' install')
                        try: process.wait(timeout=1)
                        except subprocess.TimeoutExpired: pass
                    if process.returncode:
                        raise RuntimeError('SSH/安装返回码 '+str(process.returncode))
                    resources.checkpoint('node '+machine+' installed')
                except BaseException:
                    if process.poll() is None:
                        process.terminate();process.wait(timeout=10)
                    raise
        except Exception as error:
            raise RuntimeError('节点 '+machine+' 安装失败（'+type(error).__name__+
                               '）；门户未切换，之前安装成功的节点保留；详情见 VPS 发布日志') from None
        print('Installed node '+machine, flush=True)


def switch(backend, resources, prepare_nodes=lambda: None):
    old=new=hold=None
    try:
        resources.start()
        prepare_nodes()
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
    finally:
        try:backend.cleanup_staged()
        finally:resources.close()


def main(run, revision):
    os.umask(0o077)
    root=run.parent.parent
    manifest={'revision':revision,'tag':'stargate:auto-'+revision,'rollback':'stargate:previous'}
    (run/'manifest.json').write_text(json.dumps(manifest))
    resource_log=run/'memory.jsonl'
    resources=ResourceGuard(resource_log)
    backend=None
    scope=json.loads((run/'release.json').read_text())
    started=time.monotonic();status='FAILED'
    try:
        if scope['portalChanged']:
            backend=DockerBackend(run,resources)
            identity=switch(backend,resources,lambda: install_nodes(run,root,resources))
        else:
            try:
                resources.start()
                install_nodes(run,root,resources)
                identity=None
            finally:resources.close()
        temporary=root/'deployed-sha.tmp';temporary.write_text(revision+'\n');temporary.replace(root/'deployed-sha')
        status='DEPLOYED'
        return identity
    finally:
        readings=[]
        for name in ('load-memory.jsonl','memory.jsonl'):
            path=run/name
            if path.exists():readings.extend(json.loads(line)['available'] for line in path.read_text().splitlines())
        result={'status':status,'revision':revision,'seconds':round(time.monotonic()-started,3),
                'minimumAvailableBytes':min(readings) if readings else None,'drain':backend.drain_result if backend else None,
                'portalChanged':scope['portalChanged'],'nodesChanged':scope['nodesChanged']}
        (run/'result.json').write_text(json.dumps(result)+'\n')
        print(json.dumps(result),flush=True)


if __name__=='__main__':main(Path(sys.argv[1]),sys.argv[2])

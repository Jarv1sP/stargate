"""Run in a project's existing writable rootfs, inside Podman's user namespace.

Only the trusted runner invokes this helper. No image commit, export, copy or
publication occurs. The temporary execution container owns the GPU lease;
the development container owns the filesystem and is not removed on exit.
"""
import contextlib
import ctypes
import json
import importlib.util
import os
from pathlib import Path
import stat
import signal
import subprocess
import sys
import tempfile


def thread_environment(image_env, defaults):
    # Defaults precede the workspace image ENV; explicit runner flags follow
    # both. User image settings and per-command `env KEY=value` win unchanged.
    environment = dict(defaults)
    environment.update(value.split('=', 1) for value in image_env
                       if isinstance(value, str) and '=' in value and '\x00' not in value)
    return environment


@contextlib.contextmanager
def output_mount(flags, folder):
    index=next((i for i,value in enumerate(flags) if value.endswith(':/outputs:rw')),None)
    if index is None:
        yield flags;return
    libc=ctypes.CDLL(None,use_errno=True)
    def invoke(name,*args):
        if getattr(libc,name)(*args):
            error=ctypes.get_errno();raise OSError(error,'输出目录挂载失败：'+os.strerror(error))
    namespace=os.open('/proc/self/ns/mnt',os.O_RDONLY)
    fd=None;anchor=None;mounted=False
    try:
        # Keep Podman's shared rootfs mount in its original namespace. Only this
        # execution's output anchor is private, so a writable shared directory
        # cannot redirect the engine to a different host path after opening it.
        invoke('unshare',0x00020000)  # CLONE_NEWNS
        invoke('mount',None,b'/',None,ctypes.c_ulong(16384|262144),None)  # MS_REC|MS_PRIVATE
        fd=os.open(flags[index].removesuffix(':/outputs:rw'),os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        anchor=tempfile.mkdtemp(prefix='output-',dir=folder)
        invoke('mount',os.fsencode('/proc/self/fd/'+str(fd)),os.fsencode(anchor),None,ctypes.c_ulong(4096),None)  # MS_BIND
        mounted=True
        private=list(flags);private[index]=anchor+':/outputs:rw'
        yield private
    finally:
        try:
            if mounted:invoke('umount2',os.fsencode(anchor),2)  # MNT_DETACH
        finally:
            if fd is not None:os.close(fd)
            try:
                invoke('setns',namespace,0)
            finally:
                os.close(namespace)
                if anchor is not None:os.rmdir(anchor)


def execute(request):
    prefix=request['engine']
    if not isinstance(prefix,list) or not prefix or prefix[0]!='/usr/bin/podman':
        raise ValueError('Expected the managed local OCI engine')
    mapping=[tuple(map(int,line.split())) for line in Path('/proc/self/uid_map').read_text().splitlines()]
    if os.getuid()!=0 or (0,request['hostUid'],1) not in mapping or request['hostUid']==0:
        raise ValueError('Workspace rootfs requires the existing rootless namespace')
    container=request['container']
    inspected=subprocess.run([*prefix,'container','inspect',container],check=True,capture_output=True,text=True)
    rows=json.loads(inspected.stdout)
    mounted=subprocess.run([*prefix,'mount',container],check=True,capture_output=True,text=True)
    try:
        root=Path(mounted.stdout.strip()).resolve(strict=True)
        graph=Path(request['graph']).resolve(strict=True)
        if not root.is_relative_to(graph) or root==graph:
            raise ValueError('Workspace rootfs is outside the managed graph')
        # No :O suffix: a per-run disposable overlay would discard installs.
        # Image ENV is preserved explicitly because --rootfs has no image config.
        environment=[]
        for key,value in thread_environment(rows[0].get('Config',{}).get('Env',[]) or [],request.get('threadDefaults',{})).items():
            environment+=['--env',key+'='+value]
        flags=[value for value in request['flags'] if value!='--pull=never']
        with output_mount(flags,graph.parent/'tmp') as flags:
            command=[*prefix,'run','--rm','--name',request['execution'],
                *environment,*flags,'--rootfs','--entrypoint',request['argv'][0],str(root),*request['argv'][1:]]
            if request.get('terminalSocket'):
                spec=importlib.util.spec_from_file_location('workspace_shell',Path(__file__).with_name('workspace-shell.py'))
                shell=importlib.util.module_from_spec(spec);spec.loader.exec_module(shell)
                return shell.serve(command,request['terminalSocket'])
            return subprocess.call(command)
    finally:
        # Drop only our mount reference. Never commit or delete the workspace.
        result=subprocess.run([*prefix,'unmount',container],capture_output=True)
        if result.returncode:print('Workspace mount reference cleanup needs inspection; files retained',file=sys.stderr)


def main(path):
    # GPUQ cancels the entire cgroup. Give normal SIGTERM a chance to release
    # our mount reference; SIGKILL remains an abrupt stop, never a save promise.
    def terminate(signum, frame):raise SystemExit(128+signum)
    signal.signal(signal.SIGTERM,terminate)
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode&0o077 or info.st_size>1024**2:
            raise ValueError('Invalid private workspace execution request')
        with os.fdopen(os.dup(fd)) as stream:request=json.load(stream)
    finally:os.close(fd)
    return execute(request)


if __name__=='__main__':
    if len(sys.argv)!=2:raise SystemExit('Expected a trusted workspace execution request')
    raise SystemExit(main(sys.argv[1]))

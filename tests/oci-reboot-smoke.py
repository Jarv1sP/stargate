"""Real rootless Podman grey test, in a disposable user/container/VM."""
import importlib.util,json,os,tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('personal_oci',ROOT/'node/personal-oci.py')
oci=importlib.util.module_from_spec(spec);spec.loader.exec_module(oci)


def main():
    # Use a disposable OS user in an isolated container/VM, plus a separate,
    # writable /grey fixture mount. Never run as a production service user.
    with tempfile.TemporaryDirectory(prefix='oci-reboot-',dir='/grey') as tmp:
        base=Path(tmp);base.chmod(0o700)
        config={'root':str(base/'state'),'workspacesRoot':str(base/'workspaces'),
                'datasetsRoot':str(base/'datasets'),'dataMountPoints':['/grey'],
                'personalOci':{'baseImage':'quay.io/libpod/alpine:latest'}}
        for name in ('root','workspacesRoot','datasetsRoot'):Path(config[name]).mkdir(mode=0o700)
        engine=oci.PersonalOCI(config,'alice')
        store=engine.s.ProjectStore(engine.root,config=config);store.create('alice','demo')
        head=engine.workspace_container('demo')
        version=engine.run('--version')
        engine.workspace_command('alice','demo',['/bin/sh','-c',
            'mkdir -p /opt/reboot-grey; printf dependency > /opt/reboot-grey/package; '
            'printf code > /workspace/train.py; printf home > /home/gpuq/settings'])
        container=head['container']
        checks=[]
        try:
            for cycle in range(2):
                # Podman's pause process is shared by the OS user. This test
                # therefore requires a disposable user/container/VM.
                engine.run('system','migrate')
                (engine.folder/'tmp/alive').write_text('00000000-0000-0000-0000-000000000000\n')
                for name in ('run','tmp'):(engine.folder/name/'previous-boot').write_text('stale')
                try:engine.run('ps')
                except ValueError as error:
                    if 'current system boot ID differs from cached boot ID' not in str(error):raise
                else:raise AssertionError('Grey test did not reproduce Podman boot-ID failure')
                engine=oci.PersonalOCI(config,'alice')
                if engine.load('demo')['container']!=container:raise AssertionError('Container was replaced')
                result=engine.workspace_command('alice','demo',['/bin/sh','-c',
                    'cat /opt/reboot-grey/package /workspace/train.py /home/gpuq/settings'])
                if result!='dependencycodehome':raise AssertionError('Persistent project data changed')
                for name in ('run','tmp'):
                    if (engine.folder/name/'previous-boot').exists():raise AssertionError('Old runtime retained')
                for _ in range(3):
                    engine=oci.PersonalOCI(config,'alice')
                    result=engine.workspace_command('alice','demo',['/bin/sh','-c',
                        'cat /opt/reboot-grey/package /workspace/train.py /home/gpuq/settings'])
                    if result!='dependencycodehome':raise AssertionError('Repeated startup changed files')
                checks.append({'rebootCycle':cycle+1,'failureReproduced':True,
                               'sameContainer':True,'persistentFilesPreserved':True,'repeatStarts':3})
            print(json.dumps({'engine':version,'checks':checks,'status':'PASS'}))
        finally:
            # Drop the scratch container and this disposable user's pause process.
            engine.run('rm','--force',container)
            engine.run('system','migrate')


if __name__=='__main__':main()

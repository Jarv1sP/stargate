"""G16-only kernel experiment in disposable quota disks; never production."""
import importlib.util,json,os,subprocess,sys
from pathlib import Path

def load(name):
    s=importlib.util.spec_from_file_location(name,Path('/usr/local/libexec/stargate')/(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

cfg=json.load(open('/etc/gpuq-console/node-install.json'));profile=cfg['profiles']['7IM']
q=load('quota-ids');limits=load('quota-limits');sampler=load('quota-sample');kernel=limits.Kernel()
uid=1001;cap=8*1024**2
rows=[];kinds=Path('/run/gray-node-quota').read_text().splitlines()
# The program shipped by the installer must remain disabled in the normal stack.
unit=Path('/etc/systemd/system/stargate-quota-limits.service').read_text()
assert '"--enabled"' not in unit,unit
probe="""import errno,json,os
from pathlib import Path
p=Path('/workspace/probe');result={}
try:
 with p.open('wb',buffering=0) as f:
  for i in range(20):f.write(b'x'*1024**2)
 result['errno']=None
except OSError as e:result.update(errno=e.errno,message=e.strerror)
finally:
 try:p.unlink()
 except FileNotFoundError:pass
v=os.statvfs('/workspace');result.update(total=v.f_blocks*v.f_frsize,available=v.f_bavail*v.f_frsize)
print(json.dumps(result))
"""
runner="""import importlib.util,json,sys
from pathlib import Path
node=Path(sys.argv[1])/'current'/'node'
def load(name):
 s=importlib.util.spec_from_file_location(name,node/(name+'.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
config=json.loads(load('runtime-profile').read_private(node.parent/'profiles'/'7IM'/'node-config.json'))
e=load('personal-oci').PersonalOCI(config,'gray-quota-probe')
print(e.run('run','--rm','--network=none','--memory=256m','--entrypoint=python3','--volume',sys.argv[2]+':/workspace:rw',e.policy['baseImage'],'-c',sys.argv[3],timeout=180))
"""
def container(path):
    out=subprocess.check_output(['runuser','-u','gpuops','--','env','XDG_RUNTIME_DIR=/run/user/1001','HOME=/home/gpuops','python3','-I','-B','-c',runner,cfg['releaseRoot'],str(path),probe],text=True,timeout=240)
    return json.loads(out)

table=sampler.mounts(Path('/proc/self/mountinfo').read_text())
for line in kinds:
    point,kind=line.split();path=Path(point)/'gray-limit-lab';path.mkdir(mode=0o700);os.chown(path,uid,uid)
    registry=Path(profile['root'])/'quota';key='p:gray-limit-lab/'+kind+point[-1]+':files';number=q.allocate(registry,[key])[key]
    q.tag_dir(path,number)
    info=os.stat(point);device_number=f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}'
    device=next(src for mount,dev,src in table if mount==point and dev==device_number)
    zero=kernel.get(device,0);before=(zero.bhardlimit,zero.bsoftlimit)
    try:
        kernel.set(device,number,cap)
        initial=sampler.enforcement(device)
        if kind=='ext4' and initial is False:
            pre=container(path);assert pre['errno'] is None,pre
        else:pre=None
        if kind=='ext4':kernel.enable(device);kernel.enable(device)
        assert sampler.enforcement(device) is True,(kind,'enforcement flag')
        post=container(path)
        expected=122 if kind=='ext4' else 28
        assert post['errno']==expected,(kind,post)
        assert 0<post['total']<=cap,(kind,post)
        # The real target is only 8 MiB, but the disk still has >64 GiB available.
        code="""import importlib.util,json,sys
from pathlib import Path
node=Path(sys.argv[1])/'current'/'node';s=importlib.util.spec_from_file_location('store',node/'project-store.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.require_workspace_space(Path(sys.argv[2]),needed=1024)))
"""
        reserve=json.loads(subprocess.check_output(['runuser','-u','gpuops','--','python3','-I','-B','-c',code,cfg['releaseRoot'],str(path)],text=True))
        assert reserve['availableBytes']>=64*1024**3,reserve
        after=kernel.get(device,0);assert before==(after.bhardlimit,after.bsoftlimit),'ID 0 changed'
        rows.append({'filesystem':kind,'beforeEnforced':initial,'before':pre,'after':post,'diskReserve':reserve,'idZeroUnchanged':True})
    finally:
        kernel.set(device,number,0)
        path.rmdir()
assert any(row['filesystem']=='ext4' and row['before'] is not None for row in rows),'ext4 quotaon transition not exercised'
assert any(row['filesystem']=='xfs' for row in rows),'XFS unavailable: this run cannot verify XFS limits'
print(json.dumps({'defaultOff':True,'cases':rows}))

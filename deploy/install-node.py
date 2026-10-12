#!/usr/bin/env python3
"""Run as the GPUQ service user. Add scoped keys; never overwrite a GPUQ DB."""
import argparse,fcntl,importlib.util,ipaddress,json,os,pwd,re,shlex,shutil,subprocess,sys,time
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--inventory',required=True);p.add_argument('--node',required=True);p.add_argument('--collector-key',required=True);p.add_argument('--executor-key',required=True);p.add_argument('--initialize-gpuq',action='store_true');p.add_argument('--enable-host-root',action='store_true');p.add_argument('--configure-cpu-delegation',action='store_true');p.add_argument('--runtime-profile',choices=('common-p0','ray-p0'));a=p.parse_args()
if os.getuid()==0:raise SystemExit('Run as the dedicated GPUQ user, not root')
source=Path(__file__).resolve().parents[1];inventory=json.loads(Path(a.inventory).read_text());node=next(n for n in inventory['nodes'] if n['id']==a.node)
sys.path.insert(0,str(source/'deploy'))
import node_runtime
installed_runner=Path.home()/'.local/libexec/gpuq-console/sandbox-runner.py'
if a.runtime_profile is None:a.runtime_profile=node_runtime.detected_profile(installed_runner.read_bytes()) if installed_runner.is_file() else 'common-p0'
if a.configure_cpu_delegation and a.runtime_profile!='ray-p0':p.error('--configure-cpu-delegation requires --runtime-profile ray-p0')
runtime_plan,runtime_payloads=node_runtime.preflight(source/'deploy',a.runtime_profile)
if pwd.getpwuid(os.getuid()).pw_name!=node['user']:raise SystemExit('Wrong OS service user')
ip=str(ipaddress.IPv4Address(inventory['vpsTailIP']))
for key in ('workspaceRoot','gpuqRoot','conda'):
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+',node[key]) or '..' in Path(node[key]).parts or node[key]=='/':raise SystemExit('Unsafe node path')
def run(*cmd):return subprocess.run(cmd,check=True,text=True,capture_output=True).stdout
for binary in ('bwrap','slirp4netns','nvidia-smi','systemd-run','python3','ssh-keygen'):
    if not shutil.which(binary):raise SystemExit('Missing prerequisite: '+binary)
help_bwrap=run('bwrap','--help')
if '--bind-fd' not in help_bwrap:raise SystemExit('bubblewrap must support --bind-fd; install a recent distro build')
if not Path('/sys/fs/cgroup/cgroup.controllers').exists():raise SystemExit('cgroup v2 is required')
if not Path(node['conda'],'bin/python').is_file():raise SystemExit('Read-only Python/Conda distribution missing')
# Preflight before copying any runner or touching scheduler state. The explicit
# root step writes only this service UID's delegation drop-in; it never reexecs
# an active user manager. The real kernel probe, not systemctl show, is decisive.
delegation=source/'deploy/cpu-delegation.py'
if a.runtime_profile=='ray-p0':
    if a.configure_cpu_delegation:print(run('sudo','/usr/bin/python3',str(delegation),'--configure',str(os.getuid())).strip())
    try:run('/usr/bin/python3',str(delegation),'--check')
    except subprocess.CalledProcessError as error:
        raise SystemExit('CPU/memory/PID enforcement preflight failed; existing runner and scheduler are unchanged.\n'+(error.stderr or '')+'\nSee docs/RAY_RESOURCES.md; administrator confirmation is required before refreshing an active user manager.')
os.umask(0o077);home=Path.home();dest=home/'.local/libexec/gpuq-console';dest.mkdir(parents=True,exist_ok=True)
root=Path(node['workspaceRoot']);root.mkdir(parents=True,exist_ok=True,mode=0o700)
scheduler=Path(node['gpuqRoot']);config=scheduler/'config.json';binary=home/'bin/gpu'
if not config.exists():
    if not a.initialize_gpuq:raise SystemExit('GPUQ absent: review and rerun with --initialize-gpuq')
    if binary.exists():raise SystemExit('Refusing to overwrite an existing gpu command')
    archive=source/'build/gpuq.pyz'
    if not archive.is_file():raise SystemExit('Build GPUQ first: python3 scripts/build-gpuq.py')
    scheduler.mkdir(parents=True,exist_ok=True,mode=0o700);current=scheduler/'current';current.mkdir(exist_ok=True)
    shutil.copy2(archive,current/'gpuq.pyz')
    ids=run('nvidia-smi','--query-gpu=uuid','--format=csv,noheader').strip().splitlines()
    if len(ids)!=node['cards']:raise SystemExit('Inventory card count differs from hardware; review before activation')
    cfg={'root':str(scheduler),'db_path':str(scheduler/'state/gpuq.db'),'log_dir':str(scheduler/'logs'),'control_dir':str(scheduler/'control'),'socket_path':f'/run/user/{os.getuid()}/gpuq/gpuq.sock','managed_gpu_uuids':ids,'allowed_uid':os.getuid(),'observe_only':True,'archive_path':str(current/'gpuq.pyz')}
    config.write_text(json.dumps(cfg,indent=2))
    run('/usr/bin/python3',str(current/'gpuq.pyz'),'--config',str(config),'_init')
    binary.parent.mkdir(exist_ok=True);binary.write_text('#!/bin/sh\nexec /usr/bin/python3 '+shlex.quote(str(current/'gpuq.pyz'))+' --config '+shlex.quote(str(config))+' "$@"\n');binary.chmod(0o700)
    units=home/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True)
    unit='[Unit]\nDescription=GPUQ scheduler\nAfter=default.target\n[Service]\nExecStart=/usr/bin/python3 '+str(current/'gpuq.pyz')+' --config '+str(config)+' daemon\nRestart=on-failure\nRuntimeDirectory=gpuq\nRuntimeDirectoryMode=0700\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=default.target\n'
    (units/'gpuq.service').write_text(unit);run('systemctl','--user','daemon-reload');run('systemctl','--user','enable','--now','gpuq.service')
else:
    if a.initialize_gpuq:print('Existing GPUQ preserved; no upgrade or database initialization performed')
    if not binary.is_file():raise SystemExit('Existing GPUQ requires its managed ~/bin/gpu command')
cfg=json.loads(config.read_text())
previous=json.loads((dest/'node-config.json').read_text()) if (dest/'node-config.json').exists() else {}
if type(previous.get('hostRoot',False)) is not bool:raise SystemExit('Existing hostRoot must be an explicit boolean')
for item,_ in runtime_plan:
    node_runtime.atomic_install(runtime_payloads[item],dest/item)
host_root=previous.get('hostRoot',False)
if a.enable_host_root:
    # This is a deliberately explicit, high-trust host-root capability.
    run('sudo','install','-D','-o','root','-g','root','-m','755',str(source/'deploy/gpuq-console-root-shell'),'/usr/local/libexec/gpuq-console-root-shell')
    run('sudo','install','-D','-o','root','-g','root','-m','755',str(source/'deploy/admin-command.py'),'/usr/local/libexec/gpuq-console-admin-command')
    sudoers=dest/'sudoers.pending';sudoers.write_text(node['user']+' ALL=(root) NOPASSWD: /usr/local/libexec/gpuq-console-root-shell\n'+node['user']+' ALL=(root) NOPASSWD: /usr/local/libexec/gpuq-console-admin-command ""\n');sudoers.chmod(0o600)
    run('sudo','visudo','-cf',str(sudoers));run('sudo','install','-o','root','-g','root','-m','440',str(sudoers),'/etc/sudoers.d/gpuq-console');sudoers.unlink();host_root=True
node_config={'machine':a.node,'cards':node['cards'],'root':str(root),'gpu':str(binary),'database':cfg['db_path'],'slirp':shutil.which('slirp4netns'),'conda':node['conda'],'hostRoot':host_root}
node_config.update(trainingControlProtocol=1,controlRoot=cfg.get('control_dir',str(scheduler/'control')),gpuqArchive=cfg.get('archive_path',str(scheduler/'current/gpuq.pyz')))
node_config={**previous,**node_config}
for key in ('localDataDirectories','personalDataRoot'):
    if key not in node:raise SystemExit('Configure '+key+' explicitly before installing the direct-storage runtime')
    node_config[key]=node[key]
retention=node.get('diagnosticsRetentionDays',previous.get('diagnosticsRetentionDays',30))
if type(retention) is not int or not 1<=retention<=365:raise SystemExit('Invalid diagnostics retention days (1..365)')
node_config['diagnosticsRetentionDays']=retention
datasets=node.get('datasets',previous.get('datasets'))
if datasets is not None:
    if not isinstance(datasets,dict) or set(datasets)-{'root','mountPoint','sources','reserveBytes','uploads','archiveUpload'}:raise SystemExit('Invalid node dataset configuration')
    if datasets.get('mountPoint','/data2')!='/data2' or datasets.get('root','/data2/datasets')!='/data2/datasets':raise SystemExit('Managed dataset storage must use /data2/datasets on the verified /data2 mount')
    if '--ro-bind-fd' not in help_bwrap:raise SystemExit('Datasets require bubblewrap --ro-bind-fd support')
    module=importlib.util.spec_from_file_location('gpuq_install_dataset_cache',dest/'dataset-cache.py');cache_module=importlib.util.module_from_spec(module);sys.modules[module.name]=cache_module;module.loader.exec_module(cache_module)
    cache_module.DatasetCache('/data2/datasets',sources=datasets.get('sources',{}),reserve_bytes=datasets.get('reserveBytes',10*1024**3))
    node_config['datasets']=datasets
(dest/'node-config.json').write_text(json.dumps(node_config,indent=2))
units=home/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True)
for item in node_runtime.manifest(source/'deploy')['units']:shutil.copy2(source/'deploy'/item,units/item)
run('systemctl','--user','daemon-reload');run('systemctl','--user','enable','--now','gpuq-diagnostics-gc.timer')
ssh=home/'.ssh';ssh.mkdir(mode=0o700,exist_ok=True);auth=ssh/'authorized_keys'
if auth.is_symlink() or (auth.exists() and (not auth.is_file() or auth.stat().st_uid!=os.getuid())):raise SystemExit('Unsafe authorized_keys')
with auth.open('a+') as f:
    fcntl.flock(f,fcntl.LOCK_EX);f.seek(0);content=f.read();entries=[]
    for keyfile,program in [(a.collector_key,'node-probe.py'),(a.executor_key,'node-executor.py')]:
        key=Path(keyfile).read_text().strip();fields=key.split()
        if len(fields) not in (2,3) or fields[0]!='ssh-ed25519' or '\n' in key:raise SystemExit('Expected Ed25519 public key')
        run('ssh-keygen','-lf',keyfile)
        entry=f'restrict,from="{ip}",command="/usr/bin/python3 {dest}/{program}" {key}'
        if fields[1] in content and entry not in content.splitlines():raise SystemExit('This key exists with different restrictions; review manually')
        if entry not in content.splitlines():entries.append(entry)
    if entries:
        if content:backup=ssh/('authorized_keys.before-console-'+str(int(time.time())));backup.write_text(content);backup.chmod(0o600)
        f.write(('\n' if content and not content.endswith('\n') else '')+'\n'.join(entries)+'\n');f.flush();os.fsync(f.fileno())
auth.chmod(0o600)
print(json.dumps({'node':a.node,'runtimeProfile':a.runtime_profile,'rootTerminalEnabled':host_root,'gpuqObserveOnly':cfg.get('observe_only',True),'next':'Enable linger as administrator; inspect GPUQ before activating execution'}))

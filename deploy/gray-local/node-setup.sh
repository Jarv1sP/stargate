#!/bin/sh
# 只在本轮特权灰度节点内部运行，不访问宿主目录。
set -eu
/usr/bin/python3 --version > /run/gray-node-python
mount --make-rshared /
# Keep one complete proc view: the simulated driver and systemd add submounts to /proc.
install -d /run/gray-proc
mount -t proc proc /run/gray-proc
install -d -m 755 /keys/hostkeys
cp /etc/ssh/ssh_host_ed25519_key.pub /keys/hostkeys/gray-node-1.pub
install -m 755 /opt/gray-sim/nvidia-smi /usr/bin/nvidia-smi
python3 - <<'PY'
import json
from pathlib import Path
for gpu in json.loads(Path('/etc/gray-sim/gpus.json').read_text()):
    path=Path('/opt/gray-sim/procdriver/nvidia/gpus')/gpu['pci']
    path.mkdir(parents=True,exist_ok=True)
    (path/'information').write_text(f"Model: Gray Simulated GPU\nGPU UUID: {gpu['uuid']}\nDevice Minor: {gpu['minor']}\n")
PY
mount --bind /opt/gray-sim/procdriver /proc/driver
for i in 0 1; do mknod -m 666 "/dev/nvidia$i" c 195 "$i"; done
mknod -m 666 /dev/nvidiactl c 195 255
mknod -m 666 /dev/nvidia-uvm c 235 0
mknod -m 666 /dev/nvidia-uvm-tools c 235 1
i=0
until [ -s /keys/executor.pub ] && [ -s /keys/collector.pub ]; do
  i=$((i+1)); [ "$i" -lt 300 ] || exit 1; sleep 1
done
install -d /etc/gpuq-console/cdi /etc/containers/certs.d/172.30.77.30:5000
cp /registry-ca/ca.crt /etc/containers/certs.d/172.30.77.30:5000/ca.crt
# Only this simulated node's private values; the common installer owns setup.
python3 - <<'PY'
import json,os,pwd
from pathlib import Path
os.umask(0o077)
gpus=json.loads(Path('/etc/gray-sim/gpus.json').read_text())
uid=pwd.getpwnam('gpuops').pw_uid
scheduler=dict(root='/data1/stargate/scheduler',db_path='/data1/stargate/scheduler/state/gpuq.db',log_dir='/data1/stargate/scheduler/logs',control_dir='/data1/stargate/gpuq-control',socket_path=f'/run/user/{uid}/gpuq/gpuq.sock',managed_gpu_uuids=[g['uuid'] for g in gpus],allowed_uid=uid,observe_only=False)
config=dict(machine='gray-node-1',cards=2,root='/data1/stargate/state',datasetsRoot='/data2/datasets',workspacesRoot='/data1/stargate/workspaces',jobMemoryGiBPerCard=2,memoryPool=None,personalOci=dict(baseImage='172.30.77.30:5000/gray/python:3',cdiSpec='/etc/gpuq-console/cdi/gpuq-nvidia.json'),directUpload=None,transferPeer=None,transferPeers=None,cloudFiles=None)
keys=[dict(publicKey=Path('/keys',role+'.pub').read_text().strip(),profile='7IM',collector=role=='collector') for role in ('executor','collector')]
private=dict(account='gpuops',releaseRoot='/data1/stargate/releases',dataMountPoints=['/data1','/data2'],gpuq=scheduler,profiles={'7IM':config,'R6t':config},authorizedKeys=keys,services=[dict(name='stargate-storage-collect.service',profile='7IM',seconds=3600),dict(name='storage-container-observer.service',profile='R6t',seconds=60)])
Path('/etc/gpuq-console/node-install.json').write_text(json.dumps(private))
spec={'cdiVersion':'0.6.0','kind':'nvidia.com/gpu','devices':[{'name':g['uuid'],'containerEdits':{'deviceNodes':[{'path':f"/dev/nvidia{g['minor']}"}]}} for g in gpus],'containerEdits':{'deviceNodes':[{'path':'/dev/nvidiactl'},{'path':'/dev/nvidia-uvm'}],'mounts':[{'hostPath':'/usr/bin/nvidia-smi','containerPath':'/usr/bin/nvidia-smi','options':['ro','bind']}]}}
Path('/etc/gpuq-console/cdi/gpuq-nvidia.json').write_text(json.dumps(spec))
PY
# 基础镜像已自带模拟卡清单，CDI 仅挂驱动工具与分配设备。
python3 - <<'PY'
import ssl,time,urllib.request
context=ssl.create_default_context(cafile='/etc/containers/certs.d/172.30.77.30:5000/ca.crt')
for attempt in range(60):
    try:
        with urllib.request.urlopen('https://172.30.77.30:5000/v2/',context=context,timeout=2) as response:
            if response.status==200:break
    except OSError:
        if attempt==59:raise
        time.sleep(1)
PY
skopeo copy --dest-cert-dir /etc/containers/certs.d/172.30.77.30:5000 oci-archive:/opt/gray-python.oci.tar docker://172.30.77.30:5000/gray/python:3
python3 -I -B /opt/node-install.py /opt/gray-release --config /etc/gpuq-console/node-install.json
touch /run/gray-node-ready

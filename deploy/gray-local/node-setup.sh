#!/bin/sh
# 只在本轮特权灰度节点内部运行，不访问宿主目录。
set -eu
/usr/bin/python3 --version > /run/gray-node-python
mount --make-rshared /
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
mountpoint -q /data1
mountpoint -q /data2
install -d -o gpuops -g gpuops -m 700 /data1/stargate /data1/stargate/state /data1/stargate/workspaces /data2/datasets
install -d -o gpuops -g gpuops -m 755 /srv/stargate/releases
cp -a /opt/gray-release /srv/stargate/releases/r1
chown -R gpuops:gpuops /srv/stargate/releases/r1
find /srv/stargate/releases/r1 -type d -exec chmod 755 {} +
ln -sfn releases/r1 /srv/stargate/current
install -d -o gpuops -g gpuops -m 700 /srv/gpuq /srv/gpuq/current /srv/gpuq/state /srv/gpuq/logs /data1/stargate/gpuq-control
cp /opt/gray-release/gpuq.pyz /srv/gpuq/current/gpuq.pyz
chown gpuops:gpuops /srv/gpuq/current/gpuq.pyz
i=0
until [ -s /keys/executor.pub ] && [ -s /keys/collector.pub ]; do
  i=$((i+1)); [ "$i" -lt 300 ] || exit 1; sleep 1
done
loginctl enable-linger gpuops
i=0
until [ -S /run/user/1001/bus ]; do
  i=$((i+1)); [ "$i" -lt 60 ] || exit 1; sleep 1
done
as_gpuops() { runuser -u gpuops -- env XDG_RUNTIME_DIR=/run/user/1001 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus HOME=/home/gpuops "$@"; }
as_gpuops python3 - <<'PY'
import json,os
from pathlib import Path
os.umask(0o077)
gpus=json.loads(Path('/etc/gray-sim/gpus.json').read_text())
cfg=dict(root='/srv/gpuq',db_path='/srv/gpuq/state/gpuq.db',log_dir='/srv/gpuq/logs',control_dir='/data1/stargate/gpuq-control',socket_path='/run/user/1001/gpuq/gpuq.sock',managed_gpu_uuids=[g['uuid'] for g in gpus],allowed_uid=1001,observe_only=True,archive_path='/srv/gpuq/current/gpuq.pyz')
Path('/srv/gpuq/config.json').write_text(json.dumps(cfg))
home=Path.home(); (home/'bin').mkdir(exist_ok=True)
gpu=home/'bin/gpu'
gpu.write_text('#!/bin/sh\nexec /usr/bin/python3 /srv/gpuq/current/gpuq.pyz --config /srv/gpuq/config.json "$@"\n');gpu.chmod(0o700)
units=home/'.config/systemd/user';units.mkdir(parents=True,exist_ok=True)
(units/'gpuq.service').write_text('[Unit]\nDescription=Gray GPUQ\nAfter=default.target\n[Service]\nExecStart=/home/gpuops/bin/gpu daemon\nRestart=on-failure\nRuntimeDirectory=gpuq\nRuntimeDirectoryMode=0700\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=default.target\n')
config=dict(machine='gray-node-1',cards=2,root='/data1/stargate/state',datasetsRoot='/data2/datasets',workspacesRoot='/data1/stargate/workspaces',dataMountPoints=['/data1','/data2'],database='/srv/gpuq/state/gpuq.db',gpu=str(gpu),gpuqArchive='/srv/gpuq/current/gpuq.pyz',controlRoot='/data1/stargate/gpuq-control',jobMemoryGiBPerCard=2,memoryPool=None,personalOci=dict(baseImage='172.30.77.30:5000/gray/python:3',cdiSpec='/etc/gpuq-console/cdi/gpuq-nvidia.json'),directUpload=None,transferPeer=None,transferPeers=None,cloudFiles=None)
path=Path('/srv/stargate/releases/r1/profiles/7IM/node-config.json');path.write_text(json.dumps(config));path.chmod(0o600)
ssh=home/'.ssh';ssh.mkdir(mode=0o700,exist_ok=True)
commands={'executor':'/usr/bin/python3 -I -B /srv/stargate/current/node/core-entry.py --profile 7IM','collector':'/usr/bin/env STARGATE_CORE_PROFILE=7IM /usr/bin/python3 -I -B /srv/stargate/current/node/node-probe.py'}
(ssh/'authorized_keys').write_text(''.join(f'restrict,command="{command}" '+Path('/keys',role+'.pub').read_text().strip()+'\n' for role,command in commands.items()))
(ssh/'authorized_keys').chmod(0o600)
PY
as_gpuops /home/gpuops/bin/gpu _init
as_gpuops systemctl --user daemon-reload
as_gpuops systemctl --user enable --now gpuq.service
i=0
until as_gpuops /home/gpuops/bin/gpu health >/dev/null 2>&1; do
  i=$((i+1)); [ "$i" -lt 60 ] || { as_gpuops /home/gpuops/bin/gpu health; exit 1; }; sleep 2
done
as_gpuops /home/gpuops/bin/gpu set-mode --active
install -d /etc/gpuq-console/cdi /etc/containers/certs.d/172.30.77.30:5000
cp /registry-ca/ca.crt /etc/containers/certs.d/172.30.77.30:5000/ca.crt
python3 - <<'PY'
import json
from pathlib import Path
gpus=json.loads(Path('/etc/gray-sim/gpus.json').read_text())
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
touch /run/gray-node-ready

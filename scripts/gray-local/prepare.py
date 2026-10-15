"""生成仅属于本轮的配置和本地 Git 仓库；所有秘密留在 out。"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys

run, trusted = map(Path, sys.argv[1:3])
mode = sys.argv[3] if len(sys.argv) > 3 else '--runtime'
def execute(*args):
    subprocess.run(args, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

os.umask(0o077)
if mode == '--identity':
    (run/'identity').mkdir()
    (run/'identity-credentials.json').write_text(json.dumps(dict(password=(run/'admin-password').read_text().strip(),bridgeKey=secrets.token_urlsafe(32))))
    stack=json.loads((run/'stack.json').read_text())
    (run/'identity-stack.json').write_text(json.dumps({**stack,'identityMode':True,'composeFile':'identity-compose.yml'}))
    sys.exit(0)
if mode == '--build':
    for folder in ('node-context', 'base-context'):
        (run/folder).mkdir()
    gpus=[dict(index=i,uuid=f'GPU-00000000-0000-0000-0000-00000000000{i+1}',name='Gray Simulated GPU',minor=i,pci=f'0000:0{i+1}:00.0') for i in range(2)]
    for folder in ('node-context','base-context'):
        (run/folder/'gpus.json').write_text(json.dumps(gpus))
        (run/folder/'gpus.json').chmod(0o644)
    (run/'machines.js').write_text('export const MACHINES=Object.freeze('+json.dumps([dict(id='gray-node-1',model='Gray Simulated GPU',cards=2,memory='8 GB')])+');\n')
    (run/'machines.js').chmod(0o644)
    sys.exit(0)
for folder in ('portal', 'registry', 'git', 'fixture'):
    (run/folder).mkdir()
password = secrets.token_urlsafe(30)
(run/'admin-password').write_text(password+'\n')
(run/'portal/bootstrap.json').write_text(json.dumps(dict(username='admin',password=password)))
(run/'inventory.json').write_text(json.dumps({'nodes':[dict(id='gray-node-1',address='172.30.77.21',user='gpuops',cards=2)]}))
(run/'machines.js').write_text('export const MACHINES=Object.freeze('+json.dumps([dict(id='gray-node-1',model='Gray Simulated GPU',cards=2,memory='8 GB')])+');\n')
for path in (run/'portal',run/'portal/bootstrap.json',run/'machines.js',run/'inventory.json'):
    path.chmod(0o755 if path.is_dir() else 0o644)
cert=run/'registry'
execute('openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','2','-subj','/CN=Gray Local CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',str(cert/'ca.key'),'-out',str(cert/'ca.crt'))
execute('openssl','req','-newkey','rsa:2048','-nodes','-subj','/CN=172.30.77.30','-keyout',str(cert/'registry.key'),'-out',str(cert/'registry.csr'))
(cert/'extensions').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nsubjectAltName=IP:172.30.77.30\nextendedKeyUsage=serverAuth\n')
execute('openssl','x509','-req','-in',str(cert/'registry.csr'),'-CA',str(cert/'ca.crt'),'-CAkey',str(cert/'ca.key'),'-CAcreateserial','-days','2','-extfile',str(cert/'extensions'),'-out',str(cert/'registry.crt'))
(cert/'ca.crt').chmod(0o644)
fixture=run/'fixture'
for name in ('train.py','sleeper.py'):
    (fixture/name).write_bytes((trusted/'tests/gray/fixtures'/name).read_bytes())
(fixture/'README.md').write_text('STARGATE 本地灰度训练夹具。\n')
execute('git','-C',str(fixture),'init','-q')
execute('git','-C',str(fixture),'add','-A')
execute('git','-C',str(fixture),'-c','user.name=gray','-c','user.email=gray@example.invalid','commit','-qm','gray fixture')
execute('git','clone','--bare',str(fixture),str(run/'git/fixture.git'))
execute('git','-C',str(run/'git/fixture.git'),'update-server-info')

"""Local Node.process NDJSON bridge; only mount/device/space facts are synthetic."""
import importlib.util,json,os,shutil,sqlite3,sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
base=Path(sys.argv[1]).resolve();base.mkdir(mode=0o700,parents=True,exist_ok=True)
source=Path(__file__).resolve().parents[1]/'node';code=base/'runtime';code.mkdir(mode=0o700,exist_ok=True)
config={'root':str(base/'state'),'datasetsRoot':str(base/'datasets'),'workspacesRoot':str(base/'workspaces'),
        'dataMountPoints':[str(base)],'machine':'test-node','cards':2,'gpu':'/test-only/gpu',
        'database':str(base/'gpuq.sqlite'),'jobMemoryGiBPerCard':16}
for field in ('root','datasetsRoot','workspacesRoot'):Path(config[field]).mkdir(mode=0o700,exist_ok=True)
for file in source.glob('*.py'):shutil.copy2(file,code/file.name)
(code/'node-config.json').write_text(json.dumps(config));(code/'node-config.json').chmod(0o600)
with sqlite3.connect(config['database']) as db:db.execute('create table if not exists jobs(id text,submit_key text)')
stat_original=os.stat;read_original=Path.read_text
def stat_mount(path,*a,**k):
    info=stat_original(path,*a,**k)
    if os.fspath(path)=='/':return os.stat_result([info.st_mode,info.st_ino,info.st_dev+1,info.st_nlink,info.st_uid,info.st_gid,info.st_size,info.st_atime,info.st_mtime,info.st_ctime])
    return info
def mount_info(path,*a,**k):
    if str(path)=='/proc/self/mountinfo':return f'1 0 0:1 / / rw - ext4 root rw\n2 1 0:2 / {base} rw - ext4 data rw\n'
    return read_original(path,*a,**k)
with patch('os.stat',stat_mount),patch.object(Path,'read_text',mount_info),patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=100*1024**3,f_frsize=1,f_blocks=200*1024**3,f_bfree=100*1024**3)):
    spec=importlib.util.spec_from_file_location('directory_node',code/'node-executor.py');node=importlib.util.module_from_spec(spec);sys.modules[spec.name]=node;spec.loader.exec_module(node)
    for line in sys.stdin:
        try:request=json.loads(line);print(json.dumps({'result':node.process(request['operation'],request.get('args',{}))},ensure_ascii=False),flush=True)
        except Exception as error:print(json.dumps({'error':str(error)},ensure_ascii=False),flush=True)

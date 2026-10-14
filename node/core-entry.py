#!/usr/bin/python3
"""Fixed installed channel profile; one shared node dispatcher."""
import importlib.util,json,os,sys,time
from pathlib import Path
HERE=Path(__file__).resolve().parent


def load(name):
    spec=importlib.util.spec_from_file_location(name,HERE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value);return value


runtime=load('runtime-profile')

def fixed_arguments(argv):
    if len(argv)!=3 or argv[1]!='--profile' or argv[2] not in runtime.PROFILES:raise ValueError('安装入口缺少固定profile。')
    return argv[2],None

def main():
    fixed_arguments(sys.argv)
    runtime=load('runtime-profile');selected=sys.argv[2];runtime.activate(selected);runtime.check_directories(selected)
    node=load('node-executor');node.platform_root_check()
    reader=node.BoundedRPCInput(sys.stdin.fileno());first=reader.line(1600000,time.monotonic()+27)
    try:request=json.loads(first)
    except ValueError:request=None
    if isinstance(request,dict) and request.get('protocol')==node.TERMINAL_STREAM_PROTOCOL:
        node.serve_terminal_stream(request,reader,node.write_rpc_line);return None
    request=json.loads(reader.rest(first,1600000));operation=request['operation']
    scopes={'fiJU':('sync','watch','logs','cancel','priority','diagnostics','tasks.display.'),
            'FGK':('files.','data.upload.'),'1zz':('data.upload.','files.direct.'),
            'R6t':('projects.','files.','data.upload.','terminal.')}
    if selected in scopes and not operation.startswith(scopes[selected]):raise PermissionError('请通过已登录的平台操作。')
    return node.process(operation,request['args'])

if __name__=='__main__':
    os.umask(0o077)
    try:
        value=main()
        if value is not None:print(json.dumps({'ok':True,'result':value}))
    except Exception as error:print(json.dumps({'ok':False,'error':str(error)[:400]}))

"""Service-account desired list; only the independent root unit applies caps."""
import fcntl,importlib.util,os,re
from pathlib import Path

def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

def sync(config,args):
    if args.get('actor',{}).get('isAdmin') is not True:raise PermissionError('项目文件上限只有管理员能修改。')
    rows=args.get('limits')
    if not isinstance(rows,list):raise ValueError('请提供整份项目限额清单。')
    s=module('project-store');d=s.data();limits=[]
    for row in rows:
        owner=row['ownerId'];project=row['project'];amount=row['bytes']
        if not isinstance(owner,str) or not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}',owner):raise ValueError('项目所属账号编号无效，请从项目列表重新选择。')
        if not isinstance(project,str) or not s.SLUG.fullmatch(project):raise ValueError('项目目录名称无效。')
        if type(amount) is not int or not 0<amount<=2**53-1:raise ValueError('项目文件上限须为正整数字节数。')
        limits.append({'ownerId':owner,'project':project,'bytes':amount})
    folder=s.quota().folder(config);fd=os.open(folder/'limits.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX);s.atomic_json(folder/'limits.json',{'limits':limits})
    finally:os.close(fd)
    return {'synced':True,'count':len(limits)}

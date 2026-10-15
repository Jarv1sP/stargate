"""Ordinary HDD directories, with descriptor-relative browsing/downloads."""
import base64,os,stat,time
from pathlib import Path
import importlib.util

def data():
    s=importlib.util.spec_from_file_location('dataset_local',Path(__file__).with_name('local-data.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

def datasets(config):
    d=data();root=d.root(config,'datasetsRoot');rows=[];complete=True
    for folder in sorted(root.iterdir()):
        try:
            if folder.name.startswith('.') or folder.is_symlink() or not folder.is_dir():continue
            info=folder.stat()
        except OSError:complete=False;continue
        uploader=None
        records=Path(config['root'])/'dataset-uploaders'
        try:uploader=d.module('project-store').read_json(records/(folder.name+'.json')).get('userId')
        except (OSError,ValueError):pass
        rows.append({'name':folder.name,'dataset':folder.name,**d.size(folder,partial=True),
                     'uploadedBy':uploader,'modifiedAt':info.st_mtime})
    return {'datasets':rows,'complete':complete}

def process(config,operation,args,root=None):
    d=data();root=d.dataset_root(config,args['dataset']) if root is None else d.require_data_path(config,root)
    path=d.relative(args.get('path',''),empty=True)
    if operation=='files.list':
        fd=d.open_directory(root);device=os.fstat(fd).st_dev
        try:
            for part in path.split('/') if path else []:
                child=os.open(part,d.DIR_FLAGS,dir_fd=fd)
                if os.fstat(child).st_dev!=device:os.close(child);raise ValueError('路径不能跨出此数据盘。')
                os.close(fd);fd=child
            entries=[]
            for e in sorted(os.scandir(fd),key=lambda e:e.name):
                if e.name.startswith(('.upload-','.trash')):continue
                i=e.stat(follow_symlinks=False)
                if i.st_dev!=device or not (stat.S_ISDIR(i.st_mode) or stat.S_ISREG(i.st_mode)):continue
                entries.append({'name':e.name,'path':(path+'/' if path else '')+e.name,
                    'directory':stat.S_ISDIR(i.st_mode),'type':'directory' if stat.S_ISDIR(i.st_mode) else 'file',
                    'size':i.st_size if stat.S_ISREG(i.st_mode) else None,'modifiedAt':i.st_mtime})
            start=int(args.get('offset',0));limit=min(200,max(1,int(args.get('limit',200))))
            if start<0:raise ValueError('文件列表偏移不能为负数。')
            return {'path':path,'entries':entries[start:start+limit],'total':len(entries),
                    'nextOffset':start+limit if start+limit<len(entries) else None}
        finally:os.close(fd)
    if operation in ('files.get','files.stat'):
        if not path:
            if operation=='files.stat':return {'path':'','type':'directory','size':d.size(root)}
            raise ValueError('这是目录，请使用目录下载。')
        with d.parent(root,path) as (parent,name):
            fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=parent)
            try:
                info=os.fstat(fd)
                if stat.S_ISDIR(info.st_mode):
                    if operation=='files.stat':return {'path':path,'type':'directory','size':d.size(Path(root)/path)}
                    raise ValueError('这是目录，请使用目录下载。')
                if not stat.S_ISREG(info.st_mode) or info.st_dev!=os.fstat(parent).st_dev:raise ValueError('请选择此数据盘内的普通文件。')
                if operation=='files.stat':return {'path':path,'size':info.st_size,'totalSize':info.st_size}
                offset=int(args.get('offset',0));length=min(16*1024**2,int(args.get('length',1024**2)))
                if not 0<=offset<=info.st_size or length<0:raise ValueError('下载偏移超出文件大小。')
                raw=os.pread(fd,length,offset)
                return {'data':base64.b64encode(raw).decode(),'offset':offset,'nextOffset':offset+len(raw),
                        'size':info.st_size,'totalSize':info.st_size,'eof':offset+len(raw)>=info.st_size}
            finally:os.close(fd)
    raise ValueError('此文件操作不存在。')


def listing(node,args):return process(node.CONFIG,'files.list',args)

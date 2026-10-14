"""One original-key upload; size + durable offset + same-directory rename."""
import base64,contextlib,fcntl,importlib.util,os,stat,time,uuid
from pathlib import Path

def module(name):
    s=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m

class Uploads:
    def __init__(self,config,user,*,root=None,config_path=None):
        self.config,self.user=config,user;self.d=module('local-data');self.s=module('project-store')
        self.root=None if root is None else self.d.require_data_path(config,root)
        self.folder=self.s.private_dir(self.d.root(config,'root')/'uploads',create=True)

    def record(self,key):
        if not isinstance(key,str) or str(uuid.UUID(key))!=key:raise ValueError('请使用原上传UUID。')
        return self.folder/(key+'.json')

    @contextlib.contextmanager
    def locked(self,key):
        file=self.record(key);fd=os.open(file.with_suffix('.lock'),os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
        try:self.s.wait_project_lock(fd,fcntl.LOCK_EX,'上传忙，请查询原编号后重试。');yield file
        finally:os.close(fd)

    def view(self,row):
        return {k:row.get(k) for k in ('key','state','path','offset','totalSize','dataset')}

    def target(self,args):
        if self.root is not None:return self.root
        return self.d.dataset_root(self.config,args['dataset'],create=True)

    def process(self,action,args):
        key=args['key']
        with self.locked(key) as record:
            if action=='begin':
                root=self.target(args);path=self.d.relative(args['path']);size=args['totalSize']
                if type(size) is not int or size<0:raise ValueError('上传大小必须为非负字节数。')
                request={'root':str(root),'path':path,'totalSize':size,'executable':bool(args.get('executable',False))}
                if record.exists():
                    row=self.s.read_json(record)
                    if row['request']!=request:raise ValueError('原上传编号已用于不同请求，请恢复原请求或开始新上传。')
                    return self.view(row)
                with self.d.parent(root,path,create=True) as (fd,name):
                    self.s.require_workspace_space(root,needed=size,target_fd=fd)
                    temp='.upload-'+key;part=os.open(temp,os.O_RDWR|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600,dir_fd=fd);os.close(part);os.fsync(fd)
                row={**request,'request':request,'key':key,'state':'UPLOADING','offset':0,'temp':temp,
                     'dataset':args.get('dataset'),'actor':args.get('actor',{'userId':self.user}),'createdAt':time.time()}
                self.s.atomic_json(record,row);return self.view(row)
            if action=='status' and not record.exists():return {'key':key,'state':'ABSENT','offset':0,'totalSize':None}
            row=self.s.read_json(record);root=self.d.require_data_path(self.config,row['root'])
            if action in ('status','resume','routes'):return self.view(row)
            if row['state'] in ('COMPLETE','CANCELED'):return self.view(row)
            with self.d.parent(root,row['path']) as (fd,name):
                if action in ('cancel','discard'):
                    try:os.unlink(row['temp'],dir_fd=fd)
                    except FileNotFoundError:pass
                    os.fsync(fd);row['state']='CANCELED'
                elif action=='chunk':
                    raw=base64.b64decode(args['data'],validate=True);offset=args['offset']
                    if type(offset) is not int or offset<0 or offset+len(raw)>row['totalSize'] or len(raw)>1024**2:raise ValueError('上传分块大小或偏移超出范围。')
                    part=os.open(row['temp'],os.O_RDWR|os.O_NOFOLLOW,dir_fd=fd)
                    try:
                        current=os.fstat(part).st_size
                        if offset>current:raise ValueError('上传偏移不连续，请查询原编号后续传。')
                        if offset+len(raw)>current:
                            self.s.require_workspace_space(root,needed=offset+len(raw)-current,target_fd=fd)
                            # A retry may overwrite an unacknowledged tail at the same offset.
                            at=0
                            while at<len(raw):at+=os.pwrite(part,raw[at:],offset+at)
                            os.fsync(part)
                        row['offset']=os.fstat(part).st_size
                    finally:os.close(part)
                elif action=='finish':
                    if 'executable' in args:row['executable']=bool(args['executable'])
                    try:part=os.open(row['temp'],os.O_RDWR|os.O_NOFOLLOW,dir_fd=fd)
                    except FileNotFoundError:
                        # COMMITTING is durable before rename. Inspect final size after a crash.
                        if row['state']!='COMMITTING':raise
                        final=os.stat(name,dir_fd=fd,follow_symlinks=False)
                        if not stat.S_ISREG(final.st_mode) or final.st_size!=row['totalSize']:raise ValueError('上传结果未知，请按原编号查询。')
                    else:
                        try:
                            if os.fstat(part).st_size!=row['totalSize']:raise ValueError('上传尚未完成，请沿原偏移续传。')
                            os.fchmod(part,0o700 if row['executable'] else 0o600);os.fsync(part)
                            row['state']='COMMITTING';self.s.atomic_json(record,row)
                        finally:os.close(part)
                        os.replace(row['temp'],name,src_dir_fd=fd,dst_dir_fd=fd);os.fsync(fd)
                    row.update(state='COMPLETE',offset=row['totalSize'])
                    if row.get('dataset'):
                        folder=self.s.private_dir(self.d.root(self.config,'root')/'dataset-uploaders',create=True)
                        self.s.atomic_json(folder/(row['dataset']+'.json'),{'userId':row['actor'].get('userId'), 'modifiedAt':time.time()})
                else:raise ValueError('此上传操作不存在。')
            self.s.atomic_json(record,row);return self.view(row)


def dispatch(config,operation,args,*,root=None,config_path=None):
    return Uploads(config,args['userId'],root=root,config_path=config_path).process(operation.removeprefix('data.upload.'),args)

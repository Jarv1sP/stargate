"""Trusted data disks and descriptor-relative file access."""
import contextlib
import importlib.util
import os
from pathlib import Path
import re
import stat

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC

def module(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

def data_mount_points(config):
    points=config.get('dataMountPoints')
    if not isinstance(points,list) or not points: raise ValueError('节点数据盘尚未配置，请联系安装者。')
    return [Path(p).resolve(strict=True) for p in points]

def require_data_path(config,path):
    target=Path(path).resolve(strict=True)
    points=[]
    for line in Path('/proc/self/mountinfo').read_text().splitlines():
        fields=line.split(' - ',1)[0].split()
        point=Path(re.sub(r'\\([0-7]{3})',lambda m:chr(int(m[1],8)),fields[4]))
        if point==target or point in target.parents: points.append(point)
    if not points: raise ValueError('数据盘暂时不可用，请稍后重试。')
    point=max(points,key=lambda p:len(p.parts))
    if point not in data_mount_points(config) or os.stat(target).st_dev==os.stat('/').st_dev:
        raise ValueError('平台只能访问配置的数据盘，不能访问系统盘。')
    return target

def open_directory(path):
    path=Path(path)
    if not path.is_absolute() or '..' in path.parts: raise ValueError('数据路径必须位于配置的数据盘内。')
    fd=os.open('/',DIR_FLAGS)
    try:
        for part in path.parts[1:]:
            child=os.open(part,DIR_FLAGS,dir_fd=fd);os.close(fd);fd=child
        return fd
    except BaseException: os.close(fd);raise

def name(value):
    if not isinstance(value,str) or not value or value in ('.','..') or value.startswith('.') or len(value.encode())>255 or re.search(r'[/\\\x00-\x1f\x7f]',value):
        raise ValueError('名称不能包含路径分隔符或隐藏目录。')
    return value

def relative(value,empty=False):
    if empty and value in ('','.'):return ''
    if not isinstance(value,str) or not value or len(value.encode())>4096 or any(p in ('','.','..') or p.startswith('.trash') or len(p.encode())>255 for p in value.split('/')) or re.search(r'[\\\x00-\x1f\x7f]',value):
        raise ValueError('请使用目录内的相对路径，不能越出数据目录。')
    return value

@contextlib.contextmanager
def parent(root,path,create=False):
    path=relative(path);fd=open_directory(root);device=os.fstat(fd).st_dev
    try:
        for part in path.split('/')[:-1]:
            if create:
                try:os.mkdir(part,0o700,dir_fd=fd)
                except FileExistsError:pass
            child=os.open(part,DIR_FLAGS,dir_fd=fd)
            if os.fstat(child).st_dev!=device:os.close(child);raise ValueError('路径不能跨出此数据盘。')
            os.close(fd);fd=child
        yield fd,path.rsplit('/',1)[-1]
    finally:os.close(fd)

def root(config,field):
    return require_data_path(config,config[field])

def dataset_root(config,dataset,create=False):
    base=root(config,'datasetsRoot');dataset=name(dataset)
    fd=open_directory(base)
    try:
        if create:
            try:os.mkdir(dataset,0o700,dir_fd=fd)
            except FileExistsError:pass
        child=os.open(dataset,DIR_FLAGS,dir_fd=fd)
        try:
            if os.fstat(child).st_dev!=os.fstat(fd).st_dev:raise ValueError('数据集不能跨出配置的数据盘。')
        finally:os.close(child)
    finally:os.close(fd)
    return base/dataset

def size(path):
    total=0
    fd=open_directory(path)
    try:
        device=os.fstat(fd).st_dev
        for entry in os.scandir(fd):
            info=entry.stat(follow_symlinks=False)
            if info.st_dev!=device:continue
            if stat.S_ISREG(info.st_mode):total+=info.st_size
            elif stat.S_ISDIR(info.st_mode):total+=size(Path(path)/entry.name)
    finally:os.close(fd)
    return total

def disk_samples(config):
    result=[]
    for mount in data_mount_points(config):
        row={'mountPoint':str(mount),'totalBytes':None,'usedBytes':None,'availableBytes':None}
        try:
            require_data_path(config,mount);v=os.statvfs(mount)
            row.update(totalBytes=v.f_blocks*v.f_frsize,usedBytes=(v.f_blocks-v.f_bfree)*v.f_frsize,availableBytes=v.f_bavail*v.f_frsize)
        except (OSError,ValueError):pass
        result.append(row)
    return result

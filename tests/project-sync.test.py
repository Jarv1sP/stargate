"""Real tar/filesystem merges, with no container or host-path escape."""
import importlib.util,os,stat,tarfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class Merge(unittest.TestCase):
    setUp=f.DirectoryContract.setUp
    key=f.DirectoryContract.key

    def fixture(self):
        self.sync=f.module('project-sync');self.bundle=self.base/'bundle';self.bundle.mkdir()
        self.paths={name:self.base/name for name in ('rootfs','code','home')}
        for path in self.paths.values():path.mkdir()
        self.source=self.base/'source';self.source.mkdir()

    def prepare(self):
        with tarfile.open(self.bundle/'workspace.tar','w',format=tarfile.PAX_FORMAT) as archive:archive.add(self.source,arcname='workspace')
        self.sync.index(self.bundle)
        request={'paths':{key:str(value) for key,value in self.paths.items() if key!='rootfs'},'index':str(self.bundle/'index.jsonl'),
                 'plan':str(self.bundle/'plan.jsonl'),'bundle':str(self.bundle),'key':self.key()}
        self.sync.plan(request,self.paths['rootfs']);return request

    def test_type_changes_keep_old_tree_and_never_follow_target_link_to_the_host(self):
        self.fixture();outside=self.base/'host';outside.mkdir();(outside/'keep').write_text('system-data')
        (self.paths['code']/'folder').symlink_to(outside);(self.source/'folder').mkdir();(self.source/'folder/new').write_text('new')
        (self.paths['code']/'was-directory').mkdir();(self.paths['code']/'was-directory/keep').write_text('original-data')
        (self.source/'was-directory').write_text('file-now');(self.paths['code']/'target-only').write_text('keep')
        request=self.prepare();self.sync.backup(request,self.paths['rootfs']);self.sync.apply(request,self.paths['rootfs'])
        self.assertEqual((outside/'keep').read_text(),'system-data');self.assertFalse((outside/'new').exists())
        self.assertEqual((self.paths['code']/'folder/new').read_text(),'new')
        self.assertEqual((self.paths['code']/'was-directory').read_text(),'file-now')
        self.assertEqual((self.paths['code']/'target-only').read_text(),'keep')
        with tarfile.open(self.paths['code']/'.copy-backups'/(request['key']+'.tar')) as saved:
            self.assertEqual(saved.extractfile('code/was-directory/keep').read(),b'original-data')
            self.assertEqual(saved.getmember('code/folder').linkname,str(outside))

    def test_hardlinks_empty_directories_modes_and_nanosecond_mtimes_survive_and_second_plan_is_empty(self):
        self.fixture();(self.source/'tool').write_text('same');(self.source/'tool').chmod(0o751)
        os.utime(self.source/'tool',ns=(1790000000123456789,1790000000123456789))
        os.link(self.source/'tool',self.source/'linked');(self.source/'entry').symlink_to('tool');(self.source/'empty').mkdir()
        request=self.prepare();self.sync.apply(request,self.paths['rootfs'])
        code=self.paths['code'];self.assertEqual((code/'tool').stat().st_ino,(code/'linked').stat().st_ino)
        self.assertEqual((code/'tool').stat().st_mode&0o777,0o751);self.assertTrue((code/'empty').is_dir())
        self.assertEqual((code/'entry').readlink(),Path('tool'))
        self.sync.plan(request,self.paths['rootfs']);self.assertEqual(list(self.sync.entries(request['plan'])),[])

    def test_rootfs_runtime_and_bind_mount_paths_are_excluded_from_incremental_index(self):
        self.fixture()
        with tarfile.open(self.bundle/'rootfs.tar','w') as archive:
            for path in ('proc/a','sys/a','dev/a','run/a','tmp/a','workspace/a','home/gpuq/a','outputs/a','job-outputs/a','etc/hosts','opt/dependency'):
                info=tarfile.TarInfo(path);archive.addfile(info)
        with tarfile.open(self.bundle/'workspace.tar','w') as archive:
            archive.addfile(tarfile.TarInfo('workspace/.copy-backups/old.tar'))
        self.sync.index(self.bundle,rootfs=True)
        self.assertEqual([row['path'] for row in self.sync.entries(self.bundle/'index.jsonl')],['opt/dependency'])

    def test_new_file_install_reserves_its_second_copy_even_without_old_contents_to_backup(self):
        self.fixture();(self.source/'new-file').write_bytes(b'x'*1024**2);request=self.prepare()
        with patch('os.fstatvfs',return_value=SimpleNamespace(f_bavail=64*1024**3+100000,f_frsize=1)):
            with self.assertRaises(ValueError):self.sync.backup(request,self.paths['rootfs'])
        self.assertFalse((self.paths['code']/'new-file').exists())

    def test_export_mode_with_file_type_bits_does_not_force_retransmission(self):
        self.fixture();target=self.paths['code']/'dependency';target.write_text('same');target.chmod(0o640);os.utime(target,(100,100))
        with tarfile.open(self.bundle/'workspace.tar','w') as archive:
            info=tarfile.TarInfo('workspace/dependency');info.mode=stat.S_IFREG|0o640;info.size=4
            info.uid=os.getuid();info.gid=os.getgid();info.mtime=100
            with target.open('rb') as stream:archive.addfile(info,stream)
        self.sync.index(self.bundle)
        request={'paths':{k:str(v) for k,v in self.paths.items() if k!='rootfs'},'index':str(self.bundle/'index.jsonl'),'plan':str(self.bundle/'plan.jsonl')}
        self.sync.plan(request,self.paths['rootfs']);self.assertEqual(list(self.sync.entries(request['plan'])),[])

    def test_interrupted_merge_never_exposes_an_executable_with_temporary_permissions(self):
        self.fixture();(self.source/'a-tool').write_text('#!/bin/sh\nexit 0\n');(self.source/'a-tool').chmod(0o751)
        os.utime(self.source/'a-tool',ns=(1790000000123456700,1790000000123456700))
        (self.source/'z-later').write_text('later');request=self.prepare();replace=os.replace
        observed=[]
        def interrupt(source,target,**kwargs):
            result=replace(source,target,**kwargs)
            if target=='a-tool':
                info=(self.paths['code']/'a-tool').stat();observed.append((stat.S_IMODE(info.st_mode),info.st_mtime_ns))
                raise OSError('interrupted after the first replacement')
            return result
        with patch.object(self.sync.os,'replace',side_effect=interrupt):
            with self.assertRaises(OSError):self.sync.apply(request,self.paths['rootfs'])
        self.assertEqual(observed,[(0o751,1790000000123456700)])
        self.assertEqual((self.paths['code']/'a-tool').read_text(),'#!/bin/sh\nexit 0\n')

    def test_interrupted_merge_exposes_new_directories_with_their_final_permissions(self):
        self.fixture();(self.source/'folder').mkdir(mode=0o755);(self.source/'folder/file').write_text('new')
        request=self.prepare();replace=os.replace;observed=[]
        def interrupt(source,target,**kwargs):
            result=replace(source,target,**kwargs)
            if target=='folder':
                observed.append(stat.S_IMODE((self.paths['code']/'folder').stat().st_mode))
                raise OSError('interrupted after publishing the directory')
            return result
        with patch.object(self.sync.os,'replace',side_effect=interrupt):
            with self.assertRaises(OSError):self.sync.apply(request,self.paths['rootfs'])
        self.assertEqual(observed,[0o755])

    def test_resumed_backup_preserves_original_and_later_edits_before_overwriting(self):
        self.fixture();(self.source/'x').write_text('source-x');(self.source/'y').write_text('source-y');os.utime(self.source/'y',(100,100))
        (self.paths['code']/'x').write_text('original-x')
        __import__('shutil').copy2(self.source/'y',self.paths['code']/'y')
        request=self.prepare();self.sync.backup(request,self.paths['rootfs'])
        (self.paths['code']/'x').write_text('edited-x-after-interruption');(self.paths['code']/'y').write_text('edited-y-after-interruption')
        self.sync.plan(request,self.paths['rootfs']);self.sync.backup(request,self.paths['rootfs']);self.sync.apply(request,self.paths['rootfs'])
        with tarfile.open(self.paths['code']/'.copy-backups'/(request['key']+'.tar')) as archive:
            self.assertEqual(archive.extractfile('code/x').read(),b'original-x')
            retries=[name for name in archive.getnames() if name.startswith('retries/') and name.endswith('/code/x')]
            self.assertEqual(len(retries),1);self.assertEqual(archive.extractfile(retries[0]).read(),b'edited-x-after-interruption')
            self.assertEqual(archive.extractfile('code/y').read(),b'edited-y-after-interruption')
        self.assertEqual((self.paths['code']/'x').read_text(),'source-x');self.assertEqual((self.paths['code']/'y').read_text(),'source-y')

    def test_interrupted_backup_extension_leaves_the_first_archive_intact(self):
        self.fixture();(self.source/'x').write_text('new');(self.paths['code']/'x').write_text('original')
        request=self.prepare();self.sync.backup(request,self.paths['rootfs'])
        archive=self.paths['code']/'.copy-backups'/(request['key']+'.tar');original=archive.read_bytes()
        (self.paths['code']/'x').write_text('later-edit');replace=os.replace
        def interrupt(source,target,**kwargs):
            if target==request['key']+'.tar':raise OSError('archive publication interrupted')
            return replace(source,target,**kwargs)
        with patch.object(self.sync.os,'replace',side_effect=interrupt):
            with self.assertRaises(OSError):self.sync.backup(request,self.paths['rootfs'])
        self.assertEqual(archive.read_bytes(),original);self.assertEqual((self.paths['code']/'x').read_text(),'later-edit')

    def test_resume_removes_retired_directory_even_when_the_new_file_is_already_current(self):
        self.fixture();(self.source/'x').write_text('new-file');(self.paths['code']/'x').mkdir();(self.paths['code']/'x/old').write_text('old-data')
        request=self.prepare();self.sync.backup(request,self.paths['rootfs']);replace=os.replace
        def interrupt(source,target,**kwargs):
            result=replace(source,target,**kwargs)
            if target=='x':raise OSError('stopped after publishing the replacement')
            return result
        with patch.object(self.sync.os,'replace',side_effect=interrupt):
            with self.assertRaises(OSError):self.sync.apply(request,self.paths['rootfs'])
        self.sync.plan(request,self.paths['rootfs']);self.sync.apply(request,self.paths['rootfs'])
        self.assertEqual((self.paths['code']/'x').read_text(),'new-file')
        self.assertEqual(sorted(path.name for path in self.paths['code'].iterdir()),['.copy-backups','x'])

    def test_resume_removes_unpublished_temporary_inode(self):
        self.fixture();(self.source/'x').write_text('new-file');(self.paths['code']/'x').write_text('original')
        request=self.prepare();self.sync.backup(request,self.paths['rootfs']);replace=os.replace
        def interrupt(source,target,**kwargs):
            if target=='x':raise OSError('stopped before publishing the replacement')
            return replace(source,target,**kwargs)
        with patch.object(self.sync.os,'replace',side_effect=interrupt):
            with self.assertRaises(OSError):self.sync.apply(request,self.paths['rootfs'])
        self.sync.plan(request,self.paths['rootfs']);self.sync.apply(request,self.paths['rootfs'])
        self.assertEqual((self.paths['code']/'x').read_text(),'new-file')
        self.assertEqual(sorted(path.name for path in self.paths['code'].iterdir()),['.copy-backups','x'])


if __name__=='__main__':unittest.main()

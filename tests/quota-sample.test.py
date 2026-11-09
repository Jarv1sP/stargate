"""Root quota sampler: quotactl iteration, device de-duplication and the file the node reads."""
import ctypes,errno,importlib.util,json,os,stat,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)
sampler=f.module('quota-sample')


class Libc:
    """Q_GETNEXTQUOTA over a fixed table; ENOENT after the last ID, like the kernel."""
    def __init__(self,table,error=None):self.table=dict(sorted(table.items()));self.error=error;self.calls=[]
    def quotactl(self,command,device,current,pointer):
        self.calls.append((command,device,current))
        if self.error:ctypes.set_errno(self.error);return -1
        found=next((key for key in self.table if key>=current),None)
        if found is None:ctypes.set_errno(errno.ENOENT);return -1
        row=pointer._obj;row.id=found;row.curspace,row.curinodes=self.table[found];return 0


class Sampler(unittest.TestCase):
    setUp=f.DirectoryContract.setUp

    def test_getnextquota_walks_every_id_and_stops_at_enoent(self):
        libc=Libc({0:(4096,3),1000:(10,1),1005:(7,2)})
        self.assertEqual(sampler.usage('/dev/sdb1',libc),{0:(4096,3),1000:(10,1),1005:(7,2)})
        self.assertEqual([c[2] for c in libc.calls],[0,1,1001,1006]);self.assertEqual(libc.calls[0][0],(0x800009<<8)|2)
        self.assertEqual(libc.calls[0][1],b'/dev/sdb1')
        with self.assertRaises(OSError) as caught:sampler.usage('/dev/sdb1',Libc({},error=errno.ESRCH))
        self.assertEqual(caught.exception.errno,errno.ESRCH)

    def test_limit_fields_and_enforcement_flag_are_published(self):
        class WithLimit(Libc):
            def quotactl(self,*args):
                result=super().quotactl(*args)
                if result==0:args[-1]._obj.bhardlimit=100;args[-1]._obj.bsoftlimit=50
                return result
        self.assertEqual(sampler.usage('/dev/test',WithLimit({1000:(5,1)}),limits=True)[1000],
                         {'bytes':5,'inodes':1,'limitBytes':102400,'softLimitBytes':51200})
        class State:
            def quotactl(self,command,device,number,row):
                self.command=command;row._obj[2]=b'\x20';return 0
        state=State();self.assertTrue(sampler.enforcement('/dev/test',state))
        self.assertEqual(state.command,(((ord('X')<<8)+8)<<8)|2)

    def test_enoent_before_any_id_is_an_error_not_an_empty_quota_enabled_table(self):
        with self.assertRaises(OSError) as caught:sampler.usage('/dev/loop7',Libc({}))
        self.assertEqual(caught.exception.errno,errno.ENOENT)
        info=os.stat(self.base);number=f'{os.major(info.st_dev)}:{os.minor(info.st_dev)}'
        mountinfo=f'1 0 {number} / {self.base} rw - ext4 /dev/loop7 rw'
        rows=sampler.filesystems([str(self.base)],mountinfo,read=lambda device:sampler.usage(device,Libc({})))
        self.assertEqual((rows[0]['quota'],rows[0]['error']),(False,'ENOENT'))

    def test_bind_aliases_share_one_row_and_quota_off_is_reported_not_zero(self):
        alias=self.base/'alias';alias.mkdir();number=f'{os.major(os.stat(self.base).st_dev)}:{os.minor(os.stat(self.base).st_dev)}'
        info=f'1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 {number} / {self.base} rw - ext4 /dev/loop7 rw,prjquota\n'
        rows=sampler.filesystems([str(self.base),str(alias)],info,read=lambda device:{0:(5,1),1000:(9,2)})
        self.assertEqual(len(rows),1);self.assertEqual(rows[0]['mountPoints'],[str(self.base),str(alias)])
        self.assertEqual((rows[0]['device'],rows[0]['quota']),('/dev/loop7',True))
        self.assertEqual(rows[0]['ids'],{'0':{'bytes':5,'inodes':1},'1000':{'bytes':9,'inodes':2}})
        self.assertTrue(all(type(rows[0][k]) is int for k in ('totalBytes','usedBytes','availableBytes')))
        def off(device):raise OSError(errno.ESRCH,'quota off')
        rows=sampler.filesystems([str(self.base)],info,read=off)
        self.assertEqual((rows[0]['quota'],rows[0]['ids'],rows[0]['error']),(False,{},'ESRCH'))
        self.assertEqual(sampler.filesystems([str(self.base/'missing')],info)[0]['quota'],False)

    def test_publish_is_owned_by_the_service_account_and_readable_by_the_node(self):
        value={'checkedAt':'2026-11-07T00:00:00+00:00','filesystems':[{'mountPoints':[str(self.base)],'device':'/dev/loop7','quota':True,
               'ids':{'0':{'bytes':10,'inodes':1}},'totalBytes':100,'usedBytes':10,'availableBytes':90}]}
        with patch.object(sampler.os,'fchown') as owner,patch.object(sampler.os,'chown'):
            sampler.publish(self.config['root'],value,(1234,5678))
        owner.assert_called_once();self.assertEqual(owner.call_args.args[1:],(1234,5678))
        file=Path(self.config['root'])/'samples'/'quota.json'
        self.assertEqual(stat.S_IMODE(file.stat().st_mode),0o600);self.assertEqual(json.loads(file.read_text()),value)
        ops=f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=Path(self.config['root'])))
        disk=ops.process('projects.list',{'includeUsage':True})['disks'][0]
        self.assertEqual((disk['accounting'],disk['usedBytes'],disk['items']),('quota',10,[{'kind':'untracked','bytes':10},{'kind':'filesystem','bytes':0}]))

    def test_publish_never_follows_a_replaced_samples_link(self):
        target=self.base/'elsewhere';target.mkdir();(Path(self.config['root'])/'samples').symlink_to(target)
        with patch.object(sampler.os,'fchown'),self.assertRaises(OSError):sampler.publish(self.config['root'],{},(1,1))
        self.assertEqual(list(target.iterdir()),[])

    def test_publish_never_follows_a_root_that_became_a_link(self):
        target=self.base/'elsewhere';target.mkdir();alias=self.base/'alias';alias.symlink_to(target)
        with patch.object(sampler.os,'fchown'),self.assertRaises(OSError):sampler.publish(str(alias),{},(1,1))
        self.assertEqual(list(target.iterdir()),[])

    def test_main_keeps_installer_roots_and_reads_registry_next_before_sampling(self):
        account=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid());written=[];events=[]
        r1=self.base/'r1';r2=self.base/'r2';r1.mkdir();r2.mkdir();alias=self.base/'alias';alias.symlink_to(r1)
        def read_next(root):events.append('registry');return 1009 if root==str(r1) else 1012
        def sample(*args):events.append('sample');return []
        def publish(root,value,owner):written.append((root,value['next']))
        with (
            patch.object(sampler.pwd,'getpwnam',return_value=account),patch.object(sampler,'filesystems',side_effect=sample),
            patch.object(sampler,'registry_next',side_effect=read_next),patch.object(sampler,'publish',side_effect=publish),
            patch.object(sampler.Path,'read_text',return_value=''),
        ):
            code=sampler.main(['--account','nodeops','--root',str(alias),'--root',str(r1),'--root',str(r1),'--root',str(r2),str(self.base)])
        # Roots are used exactly as the installer resolved them: a link is not followed here.
        self.assertEqual((code,written),(0,[(str(alias),1012),(str(r1),1009),(str(r2),1012)]))
        self.assertEqual(events,['registry','registry','registry','sample'])

    def test_registry_next_is_read_without_following_registry_links(self):
        root=Path(self.config['root']);(root/'quota').mkdir()
        (root/'quota'/'ids.json').write_text('{"next":1003,"ids":{}}')
        self.assertEqual(sampler.registry_next(root),1003)
        (root/'quota'/'ids.json').unlink();(root/'quota'/'ids.json').symlink_to(self.base/'other')
        with self.assertRaises(OSError):sampler.registry_next(root)


if __name__=='__main__':unittest.main()

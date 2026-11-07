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

    def test_main_writes_each_distinct_root_once(self):
        account=SimpleNamespace(pw_uid=os.getuid(),pw_gid=os.getgid());written=[]
        with patch.object(sampler.pwd,'getpwnam',return_value=account),patch.object(sampler,'filesystems',return_value=[]),\
             patch.object(sampler,'publish',side_effect=lambda root,value,owner:written.append(root)),\
             patch.object(sampler.Path,'read_text',return_value=''):
            code=sampler.main(['--account','nodeops','--root','/r1','--root','/r1','--root','/r2','/data0','/data1'])
        self.assertEqual((code,written),(0,['/r1','/r2']))


if __name__=='__main__':unittest.main()

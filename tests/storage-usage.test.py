"""Disk readings are independent of partial directory-size observations."""
import importlib.util,os,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)

class StorageUsage(unittest.TestCase):
    setUp=f.DirectoryContract.setUp

    def ops(self):
        return f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=Path(self.config['root'])))

    def deny(self,name):
        original=os.open
        def opened(path,*args,**kwargs):
            if Path(path).name==name:raise PermissionError(13,'Permission denied',name)
            return original(path,*args,**kwargs)
        return patch('os.open',opened)

    def test_quota_reads_shared_filesystem_once_per_root_without_directory_scans(self):
        ops=self.ops();v=SimpleNamespace(f_blocks=1000,f_bfree=400,f_bavail=350,f_frsize=4096,f_fsid=2**63+7)
        with patch('os.statvfs',return_value=v) as read,patch('os.scandir',side_effect=AssertionError('quota scanned files')):
            result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual([str(c.args[0]) for c in read.call_args_list],[self.config['workspacesRoot'],self.config['datasetsRoot']])
        self.assertEqual(result,{'volumes':[{'kind':'shared','fs':str(v.f_fsid),'totalBytes':4096000,'usedBytes':2457600,'availableBytes':1433600}]})

    def test_equal_capacity_disks_keep_distinct_filesystem_ids(self):
        ops=self.ops();disks=[SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=fs) for fs in (11,12)]
        with patch('os.statvfs',side_effect=disks):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual([row['fs'] for row in result['volumes']],['11','12'])
        self.assertEqual(result['volumes'][0]['totalBytes'],result['volumes'][1]['totalBytes'])

    def test_real_filesystem_id_is_stable_across_roots_and_queries(self):
        ops=self.ops();expected=str(os.statvfs(self.config['workspacesRoot']).f_fsid)
        for _ in range(2):
            result=ops.process('projects.quota',{'userId':'alice'})
            self.assertEqual([row['fs'] for row in result['volumes']],[expected])
            self.assertEqual(result['volumes'][0]['kind'],'shared')

    def test_zero_filesystem_id_is_known_but_failed_readings_are_not_merged(self):
        ops=self.ops();v=SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=0)
        with patch('os.statvfs',return_value=v):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual([(row['kind'],row['fs']) for row in result['volumes']],[('shared','0')])
        with patch('os.statvfs',side_effect=OSError('offline')):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertEqual(result['volumes'],[{'kind':kind,'fs':None,'totalBytes':None,'usedBytes':None,'availableBytes':None} for kind in ('workspace','datasets')])

    def test_one_unavailable_disk_keeps_the_other_reading(self):
        ops=self.ops();v=SimpleNamespace(f_blocks=100,f_bfree=50,f_bavail=40,f_frsize=4096,f_fsid=12)
        with patch('os.statvfs',side_effect=[OSError('offline'),v]):result=ops.process('projects.quota',{'userId':'alice'})
        self.assertIsNone(result['volumes'][0]['usedBytes']);self.assertEqual(result['volumes'][1]['availableBytes'],40*4096)
        self.assertEqual([row['fs'] for row in result['volumes']],[None,'12'])

    def test_unreadable_project_keeps_disk_readings_and_an_unknown_project_size(self):
        ops=self.ops()
        with patch.object(ops.store,'_project',side_effect=PermissionError('project unavailable')):
            result=ops.process('projects.quota',{'userId':'alice','project':'demo'})
        self.assertEqual(result['projectUsage'],{'project':'demo','ownerId':'alice','size':None,'complete':False})
        self.assertTrue(all(row['totalBytes'] is not None for row in result['volumes']))

    def test_size_preserves_lower_bound_unknown_empty_and_link_boundary(self):
        root=Path(self.config['datasetsRoot']);healthy=root/'images';healthy.mkdir();(healthy/'ok.bin').write_bytes(b'abc')
        partial=healthy/'partial';partial.mkdir();(partial/'hidden.bin').write_bytes(b'hidden');partial.chmod(0)
        self.addCleanup(partial.chmod,0o700)
        (healthy/'escape').symlink_to('/etc',target_is_directory=True)
        empty=root/'empty';empty.mkdir()
        with self.deny('partial'):
            self.assertEqual(self.data.size(healthy,partial=True),{'size':3,'complete':False})
            self.assertEqual(self.data.size(partial,partial=True),{'size':None,'complete':False})
            with self.assertRaises(PermissionError):self.data.size(healthy)
        self.assertEqual(self.data.size(empty,partial=True),{'size':0,'complete':True})

    def test_bad_dataset_keeps_healthy_siblings_and_metadata(self):
        root=Path(self.config['datasetsRoot']);a=root/'images';a.mkdir();(a/'ok').write_bytes(b'abc');(a/'partial').mkdir()
        b=root/'motion';b.mkdir();(b/'ok').write_bytes(b'abcd')
        with self.deny('partial'):rows=self.files.datasets(self.config)['datasets']
        self.assertEqual([(r['dataset'],r['size'],r['complete']) for r in rows],[('images',3,False),('motion',4,True)])
        self.assertTrue(all('uploadedBy' in r and 'modifiedAt' in r for r in rows))

    def test_projects_only_scan_on_request_and_never_walk_shared_engine_storage(self):
        ops=self.ops();ops.store.create('alice','demo');ops.store.create('bob','demo')
        path=ops.store._project('alice','demo')[0];(path/'code'/'ok').write_bytes(b'abc');(path/'code'/'partial').mkdir()
        engine=ops.store.path/'.oci';engine.mkdir();(engine/'partial').mkdir()
        with patch('os.scandir',side_effect=AssertionError('ordinary project list scanned bytes')):
            rows=ops.process('projects.list',{'userId':'alice'})['projects']
        self.assertEqual(len(rows),2);self.assertTrue(all('size' not in row for row in rows))
        with self.deny('partial'):
            result=ops.process('projects.list',{'userId':'alice','includeUsage':True})
            quota=ops.process('projects.quota',{'userId':'alice','project':'demo'})
        rows={r['ownerId']:r for r in result['projects']}
        self.assertFalse(rows['alice']['complete']);self.assertGreaterEqual(rows['alice']['size'],3);self.assertTrue(rows['bob']['complete'])
        self.assertEqual(quota['projectUsage'],{'project':'demo','ownerId':'alice','size':rows['alice']['size'],'complete':False})
        self.assertTrue(all(r['usedBytes'] is not None for r in quota['volumes']))

    def test_unreadable_list_root_is_unknown_instead_of_an_empty_success(self):
        original=Path.iterdir
        def listed(path):
            if str(path)==self.config['datasetsRoot']:raise PermissionError('unreadable root')
            return original(path)
        with patch.object(Path,'iterdir',listed):
            with self.assertRaises(PermissionError):self.files.datasets(self.config)

    def test_unreadable_container_remains_in_project_list_with_unknown_size(self):
        ops=self.ops();ops.store.create('alice','unreadable');ops.store.create('bob','healthy')
        (ops.store.dev_paths('bob','healthy')['code']/'file').write_bytes(b'abc')
        with self.deny('unreadable'):result=ops.process('projects.list',{'userId':'alice','includeUsage':True})
        rows={row['project']:row for row in result['projects']}
        self.assertEqual(rows['unreadable'],{'project':'unreadable','ownerId':'alice','size':None,'complete':False})
        self.assertFalse(result['complete']);self.assertGreaterEqual(rows['healthy']['size'],3)

if __name__=='__main__':unittest.main()

"""Owned original-session discovery; no host, service, socket or PTY calls."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid


class ProjectTerminalDiscovery(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        deploy = Path(__file__).resolve().parents[1]/'deploy'
        for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py',
                     'project-ops.py','project-store.py','project-lifecycle.py'):
            shutil.copy2(deploy/name, self.base/name)
        conda = self.base/'conda'
        for name in ('bin','lib','conda-meta'): (conda/name).mkdir(parents=True)
        (conda/'bin/python').write_text('fixture only')
        (self.base/'node-config.json').write_text(json.dumps({'root':str(self.base/'state'),'conda':str(conda)}))
        spec = importlib.util.spec_from_file_location('terminal_discovery_fixture', self.base/'node-executor.py')
        self.n = importlib.util.module_from_spec(spec); sys.modules[spec.name] = self.n; spec.loader.exec_module(self.n)
        self.args = {'userId':'demo-user-1','project':'vision'}
        self.n.workspace(self.args['userId'])
        self.ops = self.n.projects(); self.ops.store.reserve_bytes = 0
        self.n.process('projects.create', self.args)
        self.folder = self.n.ROOT/'terminals'; self.folder.mkdir(mode=0o700)
        self.prefix = hashlib.sha256(b'demo-user-1private:project:vision').hexdigest()[:20]

    def tearDown(self):
        self.temp.cleanup()

    def record(self, *, user='demo-user-1', project='vision', legacy=False, receipt=True, state='OPEN'):
        jid = str(uuid.uuid4())
        prefix = hashlib.sha256((user+'private:project:'+project).encode()).hexdigest()[:20]
        pointer = self.folder/(prefix+('' if legacy else '.'+jid)+'.current')
        pointer.write_text(jid)
        self.n.atomic_json(self.folder/(jid+'.json'), {'userId':user,'username':'alice','project':project,'hostAdmin':False})
        if receipt:
            self.n.atomic_json(self.folder/(jid+'.session.json'), {'schema':2,'state':state,'leaseExpiresAt':0,
                'writerToken':'private-token-never-return','clientId':str(uuid.uuid4())})
        return jid, pointer

    def tree(self):
        return {str(path.relative_to(self.n.ROOT)):(path.lstat().st_mode,
            path.readlink().as_posix() if path.is_symlink() else path.read_bytes() if path.is_file() else None)
            for path in self.n.ROOT.rglob('*')}

    def discover(self):
        before = self.tree()
        with patch.object(self.n, 'workspace', side_effect=AssertionError('No workspace creation')), \
             patch.object(self.n, 'atomic_json', side_effect=AssertionError('No writes')), \
             patch.object(self.n, 'run', side_effect=AssertionError('No execution')), \
             patch.object(self.n.subprocess, 'run', side_effect=AssertionError('No systemctl')), \
             patch.object(self.n, 'terminal_alive', side_effect=AssertionError('No socket probe')), \
             patch.object(self.n, 'stop_terminal', side_effect=AssertionError('No stop')):
            result = self.ops.development_terminals(self.args)
        self.assertEqual(self.tree(), before)
        self.assertNotIn('private-token', str(result)); self.assertNotIn(str(self.folder), str(result))
        return result

    def test_two_same_owner_sessions_and_closed_metadata_remain_discoverable_without_stop_claim(self):
        a, _ = self.record(state='CLOSED'); b, _ = self.record(state='OPEN')
        value = self.discover()
        self.assertTrue(value['complete']); self.assertEqual(value['state'], 'CONFIRMED')
        rows = {item['id']:item for item in value['sessions']}
        self.assertEqual(set(rows), {a,b}); self.assertEqual(rows[a]['attachmentState'], 'CLOSED')
        self.assertEqual(rows[b]['attachmentState'], 'OPEN')
        self.assertTrue(all(row['state']=='UNCONFIRMED' and row['requiresStatus'] for row in rows.values()))
        self.assertTrue(all(row['writerLeaseExpired'] for row in rows.values()))

    def test_real_new_session_and_metadata_only_close_keep_original_fences_and_other_session(self):
        opened = []
        def launch(command):
            jid = command[-1]; opened.append(jid); (self.folder/(jid+'.sock')).touch()
        context = {**self.args, 'username':'alice','hostAdmin':False}
        with patch.object(self.n, 'run', side_effect=launch):
            first = self.n.process('terminal.open', {**context,'mode':'new','key':str(uuid.uuid4()),'clientId':str(uuid.uuid4())})
            second = self.n.process('terminal.open', {**context,'mode':'new','key':str(uuid.uuid4()),'clientId':str(uuid.uuid4())})
        self.assertEqual(set(item['id'] for item in self.discover()['sessions']), set(opened))
        path = self.folder/(first['id']+'.session.json')
        receipt = json.loads(path.read_text()); receipt.update(state='DETACHED',leaseExpiresAt=0); self.n.atomic_json(path, receipt)
        (self.folder/(first['id']+'.sock')).unlink()
        proof = ({'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlGroup':'','InvocationID':''}, None, True)
        with patch.object(self.n, 'terminal_unit_observation', return_value=proof), \
             patch.object(self.n, 'stop_terminal', side_effect=AssertionError('Metadata cleanup must not stop')):
            closed = self.n.process('terminal.close', {**context,'id':first['id']})
        self.assertTrue(closed['metadataOnly'])
        value = self.discover(); self.assertEqual(len(value['sessions']),2)
        self.assertEqual(next(row for row in value['sessions'] if row['id']==first['id'])['attachmentState'],'CLOSED')
        with patch.object(self.n, 'terminal_alive', side_effect=lambda _,jid:jid==second['id']), \
             patch.object(self.n, 'stop_terminal'), patch.object(self.ops, 'terminal_stopped', return_value=True):
            with self.assertRaisesRegex(ValueError, 'Workspace projects run directly'):
                self.ops.process('projects.publish', self.args)
        self.assertTrue((self.folder/(second['id']+'.sock')).exists())

    def test_legacy_without_receipt_and_duplicate_pointer_have_one_original_id(self):
        jid, _ = self.record(legacy=True, receipt=False)
        (self.folder/(self.prefix+'.'+jid+'.current')).write_text(jid)
        value = self.discover(); self.assertTrue(value['complete']); self.assertEqual(len(value['sessions']),1)
        row = value['sessions'][0]; self.assertEqual(row['id'],jid); self.assertTrue(row['legacy'])
        self.assertEqual(row['attachmentState'],'UNKNOWN'); self.assertIsNone(row['writerLeaseExpired'])

    def test_other_owner_project_root_and_data_records_are_not_read_or_disclosed(self):
        wanted, _ = self.record(); other, _ = self.record(user='demo-user-2'); project, _ = self.record(project='other')
        real = os.open
        def opened(path,*args,**kwargs):
            self.assertNotIn(other,str(path)); self.assertNotIn(project,str(path)); return real(path,*args,**kwargs)
        with patch.object(os,'open',side_effect=opened):
            value = self.ops.development_terminals(self.args)
        self.assertEqual([row['id'] for row in value['sessions']],[wanted])
        self.assertTrue(value['complete'])
        for field in ('hostAdmin','dataWorkspace'):
            self.n.atomic_json(self.folder/(wanted+'.json'), {**self.args,field:True})
            value = self.discover(); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])

    def test_pointer_into_other_owner_or_project_never_returns_that_id_or_receipt(self):
        for fields in ({'user':'demo-user-2'},{'project':'other'}):
            jid,_ = self.record(**fields)
            target = self.folder/(self.prefix+'.'+jid+'.current'); target.write_text(jid)
            real = os.open
            def opened(path,*args,**kwargs):
                self.assertNotEqual(str(path),jid+'.session.json'); return real(path,*args,**kwargs)
            with patch.object(os,'open',side_effect=opened): value = self.ops.development_terminals(self.args)
            self.assertFalse(value['complete']); self.assertNotIn(jid,str(value)); target.unlink()

    def test_malformed_missing_uuid_or_oversize_pointer_keeps_partial_directory(self):
        good,_ = self.record(); invalid = self.folder/(self.prefix+'.bad.current')
        for data in ('invalid','x'*37,str(uuid.uuid4())):
            invalid.write_text(data)
            value = self.discover(); self.assertFalse(value['complete']); self.assertEqual([row['id'] for row in value['sessions']],[good])
        invalid.unlink()
        jid,pointer = self.record(); pointer.write_text(str(uuid.uuid4()))
        value = self.discover(); self.assertFalse(value['complete']); self.assertNotIn(jid,str(value))

    def test_symlink_hardlink_foreign_owner_and_permissions_are_unconfirmed(self):
        for target in ('pointer','spec','receipt'):
            jid,pointer = self.record()
            path = pointer if target=='pointer' else self.folder/(jid+('.json' if target=='spec' else '.session.json'))
            original = path.read_bytes(); backup = self.base/'saved'; backup.write_bytes(original)
            path.unlink(); path.symlink_to(backup)
            value = self.discover(); self.assertFalse(value['complete']); self.assertNotIn(jid,str(value))
            path.unlink(); os.link(backup,path)
            value = self.discover(); self.assertFalse(value['complete']); self.assertNotIn(jid,str(value))
            path.unlink(); path.write_bytes(original); path.chmod(0o666)
            value = self.discover(); self.assertFalse(value['complete']); self.assertNotIn(jid,str(value))
            for item in self.folder.iterdir(): item.unlink()

    def test_corrupt_spec_receipt_or_oversize_metadata_does_not_claim_empty_confirmed(self):
        for suffix in ('.json','.session.json'):
            for raw in (b'[]',b'{',b'x'*16385):
                jid,_ = self.record(); path = self.folder/(jid+suffix); path.write_bytes(raw)
                value = self.discover(); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])
                for item in self.folder.iterdir(): item.unlink()

    def test_missing_directory_is_confirmed_empty_without_creating_it(self):
        self.folder.rmdir(); value = self.discover()
        self.assertTrue(value['complete']); self.assertEqual(value['sessions'],[]); self.assertFalse(self.folder.exists())

    def test_symlink_directory_or_ancestor_is_unconfirmed(self):
        moved = self.base/'moved'; self.folder.rename(moved); self.folder.symlink_to(moved)
        value = self.discover(); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])
        self.folder.unlink(); moved.rename(self.folder)
        original = self.n.ROOT; linked = self.base/'root-link'; linked.symlink_to(original)
        self.n.ROOT = linked
        self.assertFalse(self.ops.development_terminals(self.args)['complete'])
        self.n.ROOT = original

    def test_record_change_during_read_discards_the_entire_snapshot(self):
        jid,_ = self.record(); path = self.folder/(jid+'.session.json'); real = os.read; changed = False
        def read(fd,count):
            nonlocal changed
            data = real(fd,count)
            if b'private-token' in data and not changed:
                changed = True; value = json.loads(path.read_text()); value['state']='DETACHED'; self.n.atomic_json(path,value)
            return data
        with patch.object(os,'read',side_effect=read): value = self.ops.development_terminals(self.args)
        self.assertTrue(changed); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])

    def test_new_pointer_during_snapshot_never_hides_a_new_session_as_complete(self):
        self.record(); real = os.scandir; calls = 0
        def scan(fd):
            nonlocal calls
            calls += 1
            if calls == 2: self.record()
            return real(fd)
        with patch.object(os,'scandir',side_effect=scan): value = self.ops.development_terminals(self.args)
        self.assertEqual(calls,2); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])

    def test_bounded_session_scan_and_invalid_identity(self):
        for _ in range(257): self.record(receipt=False)
        value = self.discover(); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])
        for fields in ({'userId':'../other'},{'project':'../other'},{'userId':None},{'project':[] } ):
            with self.assertRaises(ValueError): self.ops.development_terminals({**self.args,**fields})

    def test_bounded_total_history_and_foreign_file_uid_are_unconfirmed(self):
        class Scan:
            def __enter__(self): return iter(SimpleNamespace(name='unrelated-'+str(i)) for i in range(20001))
            def __exit__(self,*args): pass
        with patch.object(os,'scandir',return_value=Scan()): value = self.ops.development_terminals(self.args)
        self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])
        jid,_ = self.record(); real = os.fstat
        def stat_fd(fd):
            info = real(fd)
            if info.st_size == 36 and __import__('stat').S_ISREG(info.st_mode):
                fields = {name:getattr(info,name) for name in ('st_dev','st_ino','st_mode','st_uid','st_nlink','st_size','st_mtime_ns','st_ctime_ns')}
                return SimpleNamespace(**{**fields,'st_uid':info.st_uid+1})
            return info
        with patch.object(os,'fstat',side_effect=stat_fd): value = self.ops.development_terminals(self.args)
        self.assertFalse(value['complete']); self.assertNotIn(jid,str(value))

    def test_malformed_attachment_state_or_lease_never_proves_stop_or_empty(self):
        jid,_ = self.record(); path = self.folder/(jid+'.session.json')
        for changes in ({'state':'STOPPED'},{'schema':1},{'leaseExpiresAt':True},
                        {'leaseExpiresAt':float('nan')},{'leaseExpiresAt':-1},{'leaseExpiresAt':'0'},
                        {'leaseExpiresAt':10**1000}):
            self.n.atomic_json(path, {'schema':2,'state':'DETACHED','leaseExpiresAt':0,**changes})
            value = self.discover(); self.assertFalse(value['complete']); self.assertEqual(value['sessions'],[])

    def test_normal_project_status_and_list_preserve_discovery_without_changing_ready_state(self):
        jid,_ = self.record()
        for result in (self.n.process('projects.status',self.args),
                       self.n.process('projects.list',{'userId':self.args['userId']})['projects'][0]):
            self.assertEqual(result['state'],'DRAFT'); self.assertEqual(result['developmentTerminals']['sessions'][0]['id'],jid)
            self.assertEqual(result['developmentTerminals']['sessions'][0]['state'],'UNCONFIRMED')


if __name__ == '__main__': unittest.main()

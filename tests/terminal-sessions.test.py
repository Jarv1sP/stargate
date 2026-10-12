"""Local two-client PTY ownership tests; never starts a unit or connects a host."""
import base64
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid
from types import SimpleNamespace


def uid(): return str(uuid.uuid4())


class TerminalSessions(unittest.TestCase):
    def setUp(self):
        __import__('runpy').run_path(str(Path(__file__).with_name('storage_test_helpers.py')))['isolated_platform_pin'](self)
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name).resolve()
        deploy=Path(__file__).resolve().parents[1]/'deploy'
        for name in ('platform-root-guard.py','node-executor.py','scheduling-policy.py','project-ops.py','project-store.py','project-lifecycle.py','local-data.py'):
            shutil.copy2(deploy/name,self.base/name)
        conda=self.base/'conda'
        for name in ('bin','lib','conda-meta'):(conda/name).mkdir(parents=True)
        (conda/'bin/python').write_text('fixture only')
        (self.base/'personal-data').mkdir()
        (self.base/'node-config.json').write_text(json.dumps({'root':str(self.base/'state'),'personalDataRoot':str(self.base/'personal-data'),'hostRoot':True,'conda':str(conda)}))
        spec=importlib.util.spec_from_file_location('terminal_fixture',self.base/'node-executor.py')
        self.n=importlib.util.module_from_spec(spec);sys.modules[spec.name]=self.n;spec.loader.exec_module(self.n)
        self.context={'userId':'demo-user-1','username':'alice','hostAdmin':True}
        self.n.workspace(self.context['userId'])
        self.alive=set();self.inputs=[];self.stops=[];self.starts=[]
        def start(command):
            jid=command[-1];self.starts.append(jid);self.alive.add(jid)
            (self.n.ROOT/'terminals'/(jid+'.sock')).touch()
        self.launch=start
        def stop(jid):self.stops.append(jid);self.alive.discard(jid)
        outer=self
        class Socket:
            def __enter__(self):return self
            def __exit__(self,*args):pass
            def settimeout(self,*args):pass
            def connect(self,path):self.jid=Path(path).stem
            def sendall(self,data):outer.inputs.append((self.jid,json.loads(data)))
            def recv(self,size):return b'{"offset":0,"data":"","exited":false}\n'
        self.original_stop=self.n.stop_terminal
        self.patches=[patch.object(self.n,'run',side_effect=start),patch.object(self.n,'stop_terminal',side_effect=stop),
                      patch.object(self.n,'terminal_alive',side_effect=lambda folder,jid:jid in self.alive),
                      patch.object(self.n.socket,'socket',side_effect=lambda *a:Socket())]
        for item in self.patches:item.start()

    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        self.temp.cleanup()

    def open(self,context=None,**fields):
        request={**(context or self.context),'mode':'new','key':uid(),'clientId':uid(),**fields}
        return request,self.n.process('terminal.open',request)

    def connection(self,request,result):
        return {**{k:request[k] for k in ('userId','username','hostAdmin','project') if k in request},
                'id':result['id'],'clientId':request['clientId'],'writerToken':result['writerToken']}

    def reconnect(self,connection,**fields):
        request={**connection,'mode':'reconnect','key':uid(),**fields}
        return request,self.n.process('terminal.open',request)

    def test_shared_memory_routes_only_user_terminals_into_the_workload_pool(self):
        self.n.CONFIG['memoryPool']={'cgroup':'/user.slice/gpuq-workloads.slice','maxBytes':128*1024**3}
        with patch.object(self.n,'run',side_effect=self.launch) as launch:
            self.open({**self.context,'hostAdmin':False})
            ordinary=launch.call_args.args[0]
            self.assertIn('--slice=gpuq-workloads.slice',ordinary)
            self.assertIn('--property=OOMPolicy=kill',ordinary)
            self.open()
            root=launch.call_args.args[0]
            self.assertNotIn('--slice=gpuq-workloads.slice',root)
            self.assertNotIn('--property=OOMPolicy=kill',root)

    def test_two_same_account_clients_get_independent_root_sessions_and_close_is_local(self):
        a,ar=self.open();b,br=self.open();ca,cb=self.connection(a,ar),self.connection(b,br)
        self.assertNotEqual(ar['id'],br['id'])
        for conn,text in ((ca,b'first'),(cb,b'second')):
            self.n.process('terminal.exchange',{**conn,'input':base64.b64encode(text).decode()})
        self.assertEqual([item[0] for item in self.inputs],[ar['id'],br['id']])
        self.n.process('terminal.close',cb)
        self.assertEqual(self.stops,[br['id']]);self.assertIn(ar['id'],self.alive)
        self.n.process('terminal.exchange',ca)

    def test_simultaneous_same_account_new_requests_never_alias_sessions(self):
        gate=threading.Barrier(2);results=[];errors=[]
        def start(command):
            gate.wait(timeout=2)
            self.launch(command)
        def open_client():
            try:results.append(self.open())
            except BaseException as error:errors.append(error)
        with patch.object(self.n,'run',side_effect=start):
            workers=[threading.Thread(target=open_client) for _ in range(2)]
            for worker in workers:worker.start()
            for worker in workers:worker.join(3)
        self.assertTrue(all(not worker.is_alive() for worker in workers));self.assertEqual(errors,[])
        self.assertEqual(len(results),2);self.assertEqual(len({result['id'] for _,result in results}),2)
        self.assertEqual(len(self.n.terminal_pointers(self.context)),2)

    def test_active_writer_reconnect_requires_explicit_takeover_and_fences_old_close(self):
        request,result=self.open();old=self.connection(request,result)
        other={**old,'clientId':uid()};other.pop('writerToken')
        with self.assertRaisesRegex(ValueError,'active writer'):self.reconnect(other)
        attach,new=self.reconnect(other,takeover=True);current=self.connection(attach,new)
        self.assertEqual(result['id'],new['id']);self.assertNotEqual(result['writerToken'],new['writerToken'])
        for operation in ('terminal.exchange','terminal.close','terminal.detach'):
            with self.assertRaisesRegex(ValueError,'lease'):self.n.process(operation,old)
        self.assertEqual(self.stops,[])
        self.n.process('terminal.exchange',current)

    def test_lease_expiry_never_stops_pty_and_old_token_cannot_close(self):
        request,result=self.open();old=self.connection(request,result)
        with patch.object(self.n.time,'time',return_value=result['leaseExpiresAt']+1):
            for operation in ('terminal.exchange','terminal.close'):
                with self.assertRaisesRegex(ValueError,'expired'):self.n.process(operation,old)
            with self.assertRaisesRegex(ValueError,'reconnect explicitly'):self.n.process('terminal.open',request)
            attach,new=self.reconnect({**old,'clientId':uid()})
            self.n.process('terminal.exchange',self.connection(attach,new))
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[result['id']])

    def test_detach_releases_writer_without_stopping_and_reconnect_rotates_token(self):
        request,result=self.open();old=self.connection(request,result)
        self.assertTrue(self.n.process('terminal.detach',old)['detached'])
        self.assertEqual(self.stops,[])
        attach,new=self.reconnect({**old,'clientId':uid()})
        self.assertEqual(new['id'],result['id'])
        with self.assertRaises(ValueError):self.n.process('terminal.close',old)
        self.n.process('terminal.close',self.connection(attach,new))

    def test_new_and_reconnect_keys_are_idempotent_without_relaunch_or_token_churn(self):
        request,result=self.open()
        self.assertEqual(self.n.process('terminal.open',request)['writerToken'],result['writerToken'])
        attach,new=self.reconnect(self.connection(request,result))
        self.assertEqual(self.n.process('terminal.open',attach)['writerToken'],new['writerToken'])
        self.assertEqual(self.starts,[result['id']])

    def test_legacy_session_is_not_silently_reused_or_stopped_and_requires_takeover(self):
        self.n.workspace(self.context['userId']);folder=self.n.ROOT/'terminals';folder.mkdir()
        old=uid();(folder/(old+'.json')).write_text(json.dumps(self.context))
        pointer=self.n.terminal_pointer(self.context);pointer.write_text(old);self.alive.add(old)
        request,new=self.open();self.assertNotEqual(new['id'],old)
        self.assertEqual(pointer.read_text(),old);self.assertEqual(self.stops,[])
        old_context={**self.context,'id':old,'clientId':uid()}
        with self.assertRaisesRegex(ValueError,'Legacy'):self.reconnect(old_context)
        attach,taken=self.reconnect(old_context,takeover=True)
        self.n.process('terminal.exchange',self.connection(attach,taken))
        self.assertEqual(self.stops,[])

    def test_cross_account_context_and_key_collision_are_rejected_even_with_writer_token(self):
        request,result=self.open();own=self.connection(request,result)
        for changes in ({'userId':'demo-user-2'},{'hostAdmin':False},{'project':'other','hostAdmin':False}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.n.terminal_op('terminal.close',{**own,**changes})
        with self.assertRaisesRegex(ValueError,'not owned'):
            self.open({**self.context,'userId':'demo-user-2'},key=result['id'])
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[result['id']])

    def test_legacy_client_missing_lease_is_rejected_without_mutation(self):
        with self.assertRaisesRegex(ValueError,'upgrade'):
            self.n.process('terminal.open',{**self.context,'key':uid()})
        self.assertEqual(self.starts,[]);self.assertEqual(self.stops,[])

    def test_gpu_shell_close_waits_for_its_native_attempt_without_stopping_other_units(self):
        jid=uid();folder=self.n.ROOT/'terminals';folder.mkdir(exist_ok=True)
        job={'id':jid,'userId':'demo-user-1','interactive':True}
        self.n.atomic_json(folder/(jid+'.json'),job)
        jobs=self.n.ROOT/'jobs';jobs.mkdir(exist_ok=True);self.n.atomic_json(jobs/(jid+'.json'),job)
        with patch.object(self.n,'process',return_value={'state':'CANCELING'}) as cancel, \
                patch.object(self.n,'terminal_unit_observation',side_effect=[({},None,False),({},None,True)]) as observe, \
                patch.object(self.n.time,'sleep'),patch.object(self.n.subprocess,'run',side_effect=AssertionError('No unrelated unit stop')):
            self.original_stop(jid)
        cancel.assert_called_once_with('cancel',{'job':job})
        self.assertEqual(observe.call_count,2)

    def test_workspace_adoption_preserves_independent_sessions_and_disables_publication(self):
        context={**self.context,'hostAdmin':False,'project':'test'}
        self.n.process('projects.create',{'userId':context['userId'],'project':'test'})
        a,ar=self.open(context);b,br=self.open(context)
        self.assertEqual(len(self.n.terminal_pointers(context)),2)
        with patch.object(self.n.projects(),'terminal_stopped',return_value=True):
            self.n.process('terminal.close',self.connection(a,ar))
        with self.assertRaisesRegex(ValueError,'Workspace projects run directly'):
            self.n.process('projects.publish',{'userId':context['userId'],'project':'test'})
        self.assertIn(br['id'],self.alive)
        self.assertEqual(self.n.projects().store.status(context['userId'],'test')['workspace']['protocol'],1)

    def test_new_key_does_not_replace_a_dead_or_unknown_existing_key(self):
        request,result=self.open();self.alive.clear()
        with self.assertRaisesRegex(ValueError,'not reachable'):self.n.process('terminal.open',request)
        self.assertEqual(self.starts,[result['id']]);self.assertEqual(self.stops,[])

    def quiet_unit(self,**changes):
        props={'LoadState':'not-found','ActiveState':'inactive','SubState':'dead','MainPID':'0','ControlGroup':'','InvocationID':''}
        props.update(changes)
        return SimpleNamespace(returncode=1 if props['LoadState']=='not-found' else 0,stdout='\n'.join(k+'='+v for k,v in props.items())+'\n')

    def stopped(self):
        request,result=self.open();conn=self.connection(request,result)
        self.n.process('terminal.detach',conn);self.alive.discard(result['id'])
        (self.n.ROOT/'terminals'/(result['id']+'.sock')).unlink()
        own={**self.context,'id':result['id']}
        return request,result,own

    def test_status_is_read_only_and_stopped_owner_can_close_original_id_without_writer(self):
        request,result,own=self.stopped();folder=self.n.ROOT/'terminals'
        original={p.name:p.read_bytes() for p in folder.iterdir()};pointers=self.n.terminal_pointers(self.context)
        with patch.object(self.n.subprocess,'run',return_value=self.quiet_unit()):
            observed=self.n.process('terminal.status',own)
            self.assertEqual(observed['state'],'STOPPED');self.assertTrue(observed['canCloseStopped'])
            self.assertEqual({p.name:p.read_bytes() for p in folder.iterdir()},original)
            with patch.object(self.n,'workspace',side_effect=AssertionError('status/cleanup must not create workspaces')):
                self.n.process('terminal.status',own)
                closed=self.n.process('terminal.close',own)
                self.assertEqual(closed['id'],result['id']);self.assertTrue(closed['metadataOnly'])
                self.assertEqual(self.n.process('terminal.close',own),closed)
        self.assertEqual(self.stops,[]);self.assertEqual(self.inputs,[]);self.assertEqual(self.starts,[result['id']])
        self.assertTrue((folder/(result['id']+'.json')).exists());self.assertTrue(all(p.exists() for p in pointers))
        self.assertNotIn('writerToken',observed);self.assertNotIn('ControlGroup',str(observed))
        with self.assertRaisesRegex(ValueError,'ended'):self.n.process('terminal.open',request)

    def test_status_and_no_writer_close_reject_other_owner_and_scope_without_probe(self):
        _,_,own=self.stopped()
        for changes in ({'userId':'demo-user-2'},{'hostAdmin':False},{'project':'other','hostAdmin':False},{'dataWorkspace':True,'hostAdmin':False}):
            with patch.object(self.n.subprocess,'run') as command:
                for operation in ('terminal.status','terminal.close'):
                    with self.assertRaises(ValueError):self.n.process(operation,{**own,**changes})
                command.assert_not_called()
        self.assertEqual(self.stops,[])

    def test_no_writer_close_never_stops_live_unknown_or_unexpired_session(self):
        request,result=self.open();own={**self.context,'id':result['id']}
        with patch.object(self.n.subprocess,'run',return_value=self.quiet_unit(LoadState='loaded',ActiveState='active',SubState='running',MainPID='123',InvocationID='a'*32)):
            self.assertEqual(self.n.process('terminal.status',own)['state'],'ALIVE')
            with self.assertRaisesRegex(ValueError,'lease required'):self.n.process('terminal.close',own)
        self.alive.clear();(self.n.ROOT/'terminals'/(result['id']+'.sock')).unlink()
        for proof in (self.quiet_unit(),self.quiet_unit(MainPID='123'),self.quiet_unit(LoadState='error'),SimpleNamespace(returncode=0,stdout='MainPID=0\n')):
            with patch.object(self.n.subprocess,'run',return_value=proof):
                with self.assertRaisesRegex(ValueError,'lease required'):self.n.process('terminal.close',own)
        self.assertEqual(self.stops,[]);self.assertEqual(self.starts,[result['id']])

    def test_unit_identity_drift_pid_reuse_timeout_and_stale_socket_remain_unknown(self):
        _,result,own=self.stopped();first=self.quiet_unit(LoadState='loaded',InvocationID='a'*32)
        second=self.quiet_unit(LoadState='loaded',InvocationID='b'*32)
        for values in ([first,second],[self.quiet_unit(),self.quiet_unit(MainPID='999')]):
            with patch.object(self.n.subprocess,'run',side_effect=values):
                self.assertEqual(self.n.process('terminal.status',own)['state'],'UNKNOWN')
        with patch.object(self.n.subprocess,'run',side_effect=self.n.subprocess.TimeoutExpired('systemctl',5)):
            self.assertEqual(self.n.process('terminal.status',own)['state'],'UNKNOWN')
        (self.n.ROOT/'terminals'/(result['id']+'.sock')).touch()
        with patch.object(self.n.subprocess,'run',return_value=self.quiet_unit()):
            self.assertEqual(self.n.process('terminal.status',own)['state'],'UNKNOWN')
            with self.assertRaises(ValueError):self.n.process('terminal.close',own)
        self.assertEqual(self.stops,[])

    def test_unknown_cgroup_and_live_descendants_never_confirm_stop(self):
        _,result,own=self.stopped();unit='amax-term-'+result['id']+'.service'
        for group in ('/wrong.service','/../'+unit,'/user.slice/'+unit):
            with patch.object(self.n.subprocess,'run',return_value=self.quiet_unit(ControlGroup=group)),patch.object(Path,'read_text',return_value='populated 1\n'):
                self.assertEqual(self.n.process('terminal.status',own)['state'],'UNKNOWN')
        self.assertEqual(self.stops,[])

    def test_close_rechecks_unit_and_receipt_race_without_mutation(self):
        _,result,own=self.stopped();path=self.n.ROOT/'terminals'/(result['id']+'.session.json');before=path.read_bytes()
        proofs=[self.quiet_unit(),self.quiet_unit(),self.quiet_unit(MainPID='456'),self.quiet_unit(MainPID='456')]
        with patch.object(self.n.subprocess,'run',side_effect=proofs):
            with self.assertRaisesRegex(ValueError,'changed'):self.n.process('terminal.close',own)
        self.assertEqual(path.read_bytes(),before);self.assertEqual(self.stops,[])
        real=self.n.terminal_status;calls=0
        def drift(args):
            nonlocal calls
            result=real(args);calls+=1
            if calls==1:
                value=json.loads(path.read_text());value['clientId']=uid();self.n.atomic_json(path,value)
            return result
        with patch.object(self.n.subprocess,'run',return_value=self.quiet_unit()),patch.object(self.n,'terminal_status',side_effect=drift):
            with self.assertRaisesRegex(ValueError,'changed'):self.n.process('terminal.close',own)
        self.assertEqual(json.loads(path.read_text())['state'],'DETACHED');self.assertEqual(self.stops,[])

    def test_legacy_unconfirmed_lease_and_symlink_lock_fail_closed(self):
        _,result,own=self.stopped();folder=self.n.ROOT/'terminals';receipt=folder/(result['id']+'.session.json')
        for value in ({'state':'DETACHED','leaseExpiresAt':0},{'schema':2,'state':'DETACHED','leaseExpiresAt':'0'},{'schema':2,'state':'DETACHED','leaseExpiresAt':float('nan')}):
            receipt.write_text(json.dumps(value))
            with patch.object(self.n.subprocess,'run',return_value=self.quiet_unit()):
                with self.assertRaisesRegex(ValueError,'lease required'):self.n.process('terminal.close',own)
        lock=folder/(result['id']+'.lock');lock.unlink();lock.symlink_to(receipt)
        with self.assertRaises(OSError):self.n.process('terminal.close',own)
        self.assertEqual(self.stops,[])


if __name__=='__main__':unittest.main()

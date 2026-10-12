"""Temporary owner stores and pinned localhost TLS; no real workers or GPUs."""
import fcntl
import hashlib
import importlib.util
from http.server import HTTPServer
import os
from pathlib import Path
import ssl
import subprocess
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

HERE=Path(__file__).resolve().parent
def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
F=module('portable_fixture',HERE/'portable-project.test.py')
C=module('project_copy_test',HERE.parent/'deploy/project-copy.py')
P=module('project_copy_peer',HERE.parent/'deploy/transfer-peer.py')
USER,PROJECT=F.USER,F.PROJECT


class ProjectCopyTests(unittest.TestCase):
    def setUp(self):
        self.fixture=F.PortableProjectTests();self.fixture.setUp();self.addCleanup(self.fixture.doCleanups)
        self.key=str(uuid.uuid4());self.calls=[]
        def node(store,machine):
            return SimpleNamespace(ROOT=store.root,HERE=HERE.parent/'deploy',ENV={},
                CONFIG={'machine':machine,'datasets':{},'transferPeers':{}},
                projects=lambda:SimpleNamespace(store=store),workspace=lambda user:None,
                atomic_json=F.s.atomic_json,run=lambda command,**kw:self.calls.append(command),
                platform_root_check=lambda:None,dataset_mount_check=lambda args:None)
        self.source=node(self.fixture.source,'gpu-1');self.target=node(self.fixture.target,'gpu-2')
        self.src,self.dst=C.ProjectCopies(self.source),C.ProjectCopies(self.target)
        self.states={}
        for copies in (self.src,self.dst):copies.activity=lambda unit:self.states.get(unit,False)
        self.release=self.fixture.release
        cert,key=self.fixture.path/'cert.pem',self.fixture.path/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-keyout',str(key),'-out',str(cert),'-subj','/CN=fixture','-days','1'],check=True,capture_output=True)
        self.source.CONFIG['transferPeer']={'bind':'127.0.0.1','port':1024,'certificate':str(cert),'privateKey':str(key)}
        with patch.object(P.ThreadingHTTPServer,'server_bind',autospec=True) as bind:
            def ephemeral(server):server.server_address=('127.0.0.1',0);HTTPServer.server_bind(server)
            bind.side_effect=ephemeral
            self.server=P.create_server(self.source,None,copies=lambda:self.src)
        thread=threading.Thread(target=self.server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(self.server.shutdown(),self.server.server_close(),thread.join(2)))
        self.target.CONFIG['transferPeers']={'gpu-1':{'address':'127.0.0.1','port':self.server.server_port,
            'certificateSha256':hashlib.sha256(ssl.PEM_cert_to_DER_cert(cert.read_text())).hexdigest()}}

    def control(self,key=None):return {'id':key or self.key,'userId':USER}
    def prepare(self,key=None):
        key=key or self.key
        args={**self.control(key),'project':PROJECT,'release':self.release,'targetMachine':'gpu-2'}
        first=self.src.prepare(args);self.assertIn(first['state'],('UNKNOWN','READY'))
        self.assertEqual(self.src.worker(key,1),0)
        return self.src.prepare(args)
    def start(self,key=None):
        key=key or self.key;ticket=self.prepare(key)['source']
        args={**self.control(key),'project':PROJECT,'release':self.release,'sourceMachine':'gpu-1','source':ticket}
        self.dst.start(args);return args

    def test_fixed_ready_probe_includes_real_code_and_image_storage_footprint(self):
        value=self.src.probe({'userId':USER,'project':PROJECT,'release':self.release})
        fixed=self.fixture.source.release(USER,PROJECT,self.release)
        image=self.fixture.source._oci(USER).portable_image(PROJECT,fixed['meta']['oci'])
        self.assertTrue(value['releaseReady'])
        self.assertEqual(value['codeBytes'],fixed['meta']['bytes'])
        self.assertEqual(value['codeEntries'],fixed['meta']['entries'])
        self.assertEqual(value['imageUnpackedBytes'],image['unpackedBytes'])
        self.assertEqual(value['image'],image['image'])
        self.assertIsNone(value['imageEntries'])  # legacy fixture has no additive inode sampler
        target=self.dst.probe({'userId':USER,'project':PROJECT,'from':'gpu-1'})
        self.assertFalse(target['releaseReady'])
        for field in ('codeBytes','codeEntries','imageUnpackedBytes'):
            self.assertNotIn(field,target)

    def test_real_pinned_tls_copy_is_immutable_and_reclaims_transport_packages(self):
        args=self.start();before=len(self.calls)
        self.dst.start(args);self.assertEqual(len(self.calls),before)
        self.assertEqual(self.dst.worker(self.key,1),0)
        self.assertEqual(self.dst.status(self.control())['state'],'SUCCEEDED')
        release=self.fixture.target.release(USER,PROJECT,self.release)
        self.assertIn('fixture',(release['code']/'train.py').read_text())
        self.assertEqual(os.listdir(self.fixture.target.dev_paths(USER,PROJECT)['code']),[])
        self.assertFalse((self.dst.portable.folder(USER,'imports')/self.key).exists())
        parent=self.src.portable.folder(USER,'exports',PROJECT)
        self.assertTrue((parent/self.release).exists())
        self.assertFalse(self.src.release(self.control())['cleaned']) # READY ticket still live
        self.assertTrue(self.src.cancel(self.control())['cleaned'])
        self.assertFalse((parent/self.release).exists())
        with self.assertRaises(ValueError):self.src.read({'id':self.key,'action':'info'},args['source']['token'])
        self.assertTrue(self.dst.release(self.control())['cleaned'])
        self.assertTrue(release['code'].exists())

    def test_target_admission_does_not_depend_on_removed_manifest_quota_constant(self):
        ticket=self.prepare()['source']
        args={**self.control(),'project':PROJECT,'release':self.release,'sourceMachine':'gpu-1','source':ticket}
        portable=SimpleNamespace(**{key:value for key,value in vars(C.p).items() if key!='MAX_MANIFEST'})
        with patch.object(C,'p',portable):
            first=self.dst.start(args)
            launches=len(self.calls)
            again=self.dst.start(args)
        self.assertEqual(first['id'],self.key)
        self.assertEqual(again['id'],self.key)
        self.assertEqual(len(self.calls),launches)
        self.assertEqual(self.dst.worker(self.key,1),0)
        self.assertEqual(self.dst.status(self.control())['state'],'SUCCEEDED')

    def test_manifest_byte_count_is_exact_integer_not_arbitrary_capacity_quota(self):
        ticket=self.prepare()['source']
        args={**self.control(),'project':PROJECT,'release':self.release,'sourceMachine':'gpu-1','source':ticket}
        with patch.object(self.dst,'start_spec',return_value={'validated':True}) as start:
            for size in (True,0,-1,1.5,2**53):
                with self.subTest(size=size),self.assertRaisesRegex(ValueError,'source grant'):
                    self.dst.start({**args,'source':{**ticket,'manifestBytes':size}})
            start.assert_not_called()
            self.assertEqual(self.dst.start({**args,'source':{**ticket,'manifestBytes':64*1024**2+1}}),{'validated':True})

    def test_shared_export_cache_waits_for_all_references(self):
        first=self.prepare();other=str(uuid.uuid4());second=self.prepare(other)
        parent=self.src.portable.folder(USER,'exports',PROJECT)
        self.assertTrue(self.src.cancel(self.control())['cleaned']);self.assertTrue((parent/self.release).exists())
        self.assertEqual(self.src.read({'id':other,'action':'info'},second['source']['token'])['release'],self.release)
        self.assertTrue(self.src.cancel(self.control(other))['cleaned']);self.assertFalse((parent/self.release).exists())

    def test_revoke_fences_ticket_without_stopping_or_deleting_shared_export(self):
        first=self.prepare();other=str(uuid.uuid4());second=self.prepare(other)
        parent=self.src.portable.folder(USER,'exports',PROJECT);before=len(self.calls)
        result=self.src.revoke(self.control())
        self.assertTrue(result['sourceRevoked']);self.assertTrue(result['fenced'])
        self.assertEqual(len(self.calls),before);self.assertTrue((parent/self.release).exists())
        with self.assertRaisesRegex(ValueError,'invalid or expired'):
            self.src.read({'id':self.key,'action':'info'},first['source']['token'])
        self.assertEqual(self.src.read({'id':other,'action':'info'},second['source']['token'])['release'],self.release)
        self.assertTrue(self.src.cancel(self.control(other))['cleaned'])
        self.assertTrue((parent/self.release).exists()) # revoked is not cleaned/stopped
        self.assertFalse(self.src.release(self.control())['cleaned'])
        self.assertTrue(self.src.cancel(self.control())['cleaned'])
        self.assertFalse((parent/self.release).exists())

    def test_revoke_before_prepare_is_owner_bound_and_permanently_fences_late_dispatch(self):
        self.assertTrue(self.src.revoke(self.control())['fenced'])
        with self.assertRaisesRegex(ValueError,'revoked'):
            self.src.prepare({**self.control(),'project':PROJECT,'release':self.release,'targetMachine':'gpu-2'})
        for action in (self.src.revoke,self.src.cancel):
            with self.assertRaisesRegex(ValueError,'Different copy owner'):
                action({**self.control(),'userId':'demo-user-24'})
        self.assertEqual(self.calls,[])

    def test_revoked_oci_cohort_does_not_block_existing_operation_fence_and_cleanup(self):
        self.start()
        # Policy removal must not require reopening a dev container or passing
        # compute admission merely to fence/clean an existing owner-bound copy.
        for node in (self.source,self.target):
            node.CONFIG['personalOci']={'enabled':False,'owners':[]}
        with patch.object(self.fixture.source,'_oci',side_effect=ValueError('OCI owner removed')), \
             patch.object(self.fixture.target,'_oci',side_effect=ValueError('OCI owner removed')):
            src,dst=C.ProjectCopies(self.source),C.ProjectCopies(self.target)
            src.activity=dst.activity=lambda unit:False
            self.assertTrue(src.revoke(self.control())['fenced'])
            self.assertTrue(dst.cancel(self.control())['cleaned'])
            self.assertTrue(src.cancel(self.control())['cleaned'])
            with self.assertRaisesRegex(ValueError,'different account'):
                src.revoke({**self.control(),'userId':'demo-user-24'})

    def test_revoke_during_export_prevents_later_ticket_without_deleting_package(self):
        args={**self.control(),'project':PROJECT,'release':self.release,'targetMachine':'gpu-2'}
        self.src.prepare(args)
        original=self.src.portable.export
        def revoked_in_export(*args,**kwargs):
            result=original(*args,**kwargs)
            self.assertTrue(self.src.revoke(self.control())['fenced'])
            return result
        with patch.object(self.src.portable,'export',side_effect=revoked_in_export):
            self.assertEqual(self.src.worker(self.key,1),0)
        self.assertTrue((self.src.portable.folder(USER,'exports',PROJECT)/self.release).exists())
        with self.assertRaisesRegex(ValueError,'revoked'):self.src.prepare(args)
        self.assertFalse(self.src.path(self.key,'.grant.json').exists())

    def test_failed_export_can_retry_as_new_explicit_operation_after_cleanup(self):
        args={**self.control(),'project':PROJECT,'release':self.release,'targetMachine':'gpu-2'}
        self.src.prepare(args)
        with patch.object(self.src.portable,'export',side_effect=ValueError('synthetic export failure')):
            self.assertEqual(self.src.worker(self.key,1),1)
        self.assertEqual(self.src.status(self.control())['state'],'FAILED')
        self.assertTrue(self.src.revoke(self.control())['fenced'])
        self.assertTrue(self.src.cancel(self.control())['cleaned'])
        self.assertTrue(self.dst.cancel(self.control())['cleaned'])
        new=str(uuid.uuid4());newargs=self.start(new)
        self.assertEqual(self.dst.worker(new,1),0)
        self.assertEqual(self.dst.status(self.control(new))['state'],'SUCCEEDED')
        self.assertNotEqual(new,self.key)
        self.assertEqual(self.fixture.target.release(USER,PROJECT,self.release)['meta']['release'],self.release)

    def test_unknown_and_live_workers_or_worker_lock_never_clean(self):
        self.start();spec=self.dst.load(self.key)
        folder=self.dst.portable.folder(USER,'imports')/self.key;folder.mkdir();(folder/'partial').write_bytes(b'x')
        unit=self.dst.unit(self.key,1)
        for state in (None,True):
            self.states[unit]=state
            self.assertFalse(self.dst.cancel(self.control())['cleaned']);self.assertTrue(folder.exists())
        self.states[unit]=False
        fd=os.open(self.dst.path(self.key,'.worker.lock'),os.O_CREAT|os.O_RDWR,0o600)
        try:
            fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
            self.assertFalse(self.dst.release(self.control())['cleaned']);self.assertTrue(folder.exists())
        finally:os.close(fd)
        self.assertTrue(self.dst.release(self.control())['cleaned']);self.assertFalse(folder.exists())

    def test_failure_cleans_partial_and_does_not_publish(self):
        self.start()
        original=C.ProjectPeer.call
        def broken(client,action,**fields):
            if action=='get' and fields.get('path')=='image.oci.tar':raise ValueError('synthetic checksum failure')
            return original(client,action,**fields)
        with patch.object(C.ProjectPeer,'call',broken):self.assertEqual(self.dst.worker(self.key,1),1)
        self.assertEqual(self.dst.status(self.control())['state'],'FAILED')
        self.assertFalse((self.dst.portable.folder(USER,'imports')/self.key).exists())
        with self.assertRaises(ValueError):self.fixture.target.release(USER,PROJECT,self.release)
        self.assertTrue(self.src.cancel(self.control())['cleaned'])

    def test_wrong_pin_rejects_before_ticket_or_payload(self):
        self.start();self.target.CONFIG['transferPeers']['gpu-1']['certificateSha256']='f'*64
        # A deliberately rejected TLS pin closes before the HTTP request.
        with patch.object(self.server,'handle_error'):
            self.assertEqual(self.dst.worker(self.key,1),1)
        self.assertIn('certificate',self.dst.status(self.control())['error'])

    def test_cancel_before_dispatch_fences_late_start(self):
        self.assertEqual(self.dst.cancel(self.control())['state'],'CANCELED')
        ticket=self.prepare()['source']
        with self.assertRaisesRegex(ValueError,'canceled'):
            self.dst.start({**self.control(),'project':PROJECT,'release':self.release,'sourceMachine':'gpu-1','source':ticket})
        self.assertEqual(len([c for c in self.calls if 'systemd-run' in c[0]]),1)

    def test_wrong_owner_and_changed_binding_never_reuse_an_operation(self):
        args=self.start()
        with self.assertRaises(ValueError):self.dst.status({**self.control(),'userId':'demo-user-24'})
        with self.assertRaises(ValueError):self.dst.start({**args,'project':'other'})
        with self.assertRaises(ValueError):self.dst.start({**args,'hostAdmin':True})
        with self.assertRaises(ValueError):self.dst.cancel({**self.control(),'userId':'demo-user-24'})
        self.assertFalse(self.dst.path(self.key,'.cancel').exists())

    def test_probe_does_not_create_project_or_launch_workers(self):
        before=len(self.calls)
        self.assertEqual(self.dst.probe({'userId':USER,'project':PROJECT,'from':'gpu-1'})['sources'],['gpu-1'])
        self.assertEqual(self.fixture.target.list(USER),[])
        self.assertEqual(len(self.calls),before)
        self.fixture.target.create(USER,PROJECT,environment_mode='isolated')
        with self.assertRaisesRegex(ValueError,'not OCI'):self.dst.probe({'userId':USER,'project':PROJECT})

    def test_source_release_probe_needs_no_operation_id(self):
        before=len(self.calls)
        result=self.src.probe({'userId':USER,'project':PROJECT,'release':self.release})
        self.assertTrue(result['releaseReady'])
        self.assertEqual(result['release'],self.release)
        self.assertEqual(len(self.calls),before)
        self.assertEqual(list(self.src.root.glob('*.json')),[])
        with self.assertRaisesRegex(ValueError,'Invalid immutable project release'):
            self.src.probe({'userId':USER,'project':PROJECT,'release':'latest'})

    def test_lost_final_receipt_recovers_exact_published_release_without_relaunch(self):
        args=self.start();self.assertEqual(self.dst.worker(self.key,1),0)
        self.dst.path(self.key,'.result.json').unlink();before=len(self.calls)
        status=self.dst.status(self.control());self.assertEqual(status['state'],'SUCCEEDED')
        self.assertTrue(self.dst.load(self.key,'.result.json')['recoveredFromImmutableRelease'])
        self.assertEqual(len(self.calls),before)

    def test_failed_source_export_and_killed_partial_have_explicit_cleanup(self):
        args={**self.control(),'project':PROJECT,'release':self.release,'targetMachine':'gpu-2'}
        self.src.prepare(args)
        parent=self.src.portable.folder(USER,'exports',PROJECT)
        folder=parent/('.stage-'+self.key);folder.mkdir();(folder/'big-partial').write_bytes(b'partial')
        self.states[self.src.unit(self.key,1)]=None
        self.assertFalse(self.src.cancel(self.control())['cleaned']);self.assertTrue(folder.exists())
        self.states[self.src.unit(self.key,1)]=False
        self.assertTrue(self.src.release(self.control())['cleaned']);self.assertFalse(folder.exists())

    def test_export_space_admission_happens_before_image_save(self):
        with patch.object(self.fixture.source,'_space',side_effect=ValueError('reserve')):
            with self.assertRaisesRegex(ValueError,'reserve'):self.src.portable.export(USER,PROJECT,self.release)
        self.assertFalse((self.src.portable.folder(USER,'exports',PROJECT)/self.release).exists())


if __name__=='__main__':unittest.main()

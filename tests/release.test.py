import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE=Path(__file__).resolve().parents[1]/'deploy/release'
sys.path.insert(0,str(SOURCE))
from resource_guard import MIB, ResourceGuard, ResourceLimit


def load(name):
    spec=importlib.util.spec_from_file_location('release_'+name,SOURCE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


deploy=load('deploy');entry=load('entry')


class Containers:
    def __init__(self, failure=None):
        self.failure=failure;self.live={'old'};self.calls=[];self.active_hold=None
        self.available=650*MIB;self.time=0;self.stopping_after_failure=False

    def snapshot(self):
        self.time+=1
        return {'at':self.time,'available':self.available,'swap':0}

    def log(self, name):
        if len(self.live)>1:raise AssertionError('two Portal owners')
        self.calls.append(name)

    def preflight(self):self.log('preflight');return 'old'
    def create_stopped(self,limit):
        assert limit==512*MIB;self.log('create-stopped');return 'new'
    def hold(self):self.log('hold');self.active_hold={'released':False};return self.active_hold
    def drain(self,old,hold):
        self.log('drain')
        if self.failure=='busy':raise RuntimeError('business RPC busy')
    def running(self,identity):return identity in self.live
    def running_portals(self):return list(self.live)
    def stop(self,identity,hold):
        self.log('stop-'+identity);self.live.discard(identity);self.available=950*MIB
    def start(self,identity,hold):
        if self.live:raise AssertionError('old still running')
        self.live.add(identity);self.available=650*MIB;self.log('start-'+identity)
    def healthy(self,identity,hold):
        self.log('healthy-'+identity)
        if identity=='new' and self.failure=='health':raise RuntimeError('candidate unhealthy')
        if identity=='new' and self.failure=='memory':self.available=199*MIB
    def command(self,argv):
        self.log('cli-help')
        self.resources.checkpoint('CLI help')
        if self.failure=='cli':raise RuntimeError('CLI failed')
    def release(self,hold,identity):
        self.log('release-'+identity);hold['released']=True;self.active_hold=None
    def stop_budget(self,hold):self.log('stop-budget')
    def restore_old(self):
        if self.live:raise AssertionError('new still running')
        self.live.add('old');self.available=650*MIB;self.log('restore-old')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def switch(self,failure=None):
        backend=Containers(failure)
        guard=ResourceGuard(self.root/'memory.jsonl',backend.snapshot)
        backend.resources=guard
        if failure:
            reason={'busy':'business RPC busy','health':'candidate unhealthy','cli':'CLI failed','memory':'MemAvailable below 200MiB'}[failure]
            with self.assertRaisesRegex(RuntimeError,reason):deploy.switch(backend,guard)
        else:self.assertEqual(deploy.switch(backend,guard),'new')
        return backend

    def test_handoff_preserves_single_owner_and_releases_after_health_and_cli(self):
        backend=self.switch()
        self.assertEqual(backend.live,{'new'})
        self.assertLess(backend.calls.index('hold'),backend.calls.index('stop-old'))
        self.assertLess(backend.calls.index('stop-old'),backend.calls.index('start-new'))
        self.assertLess(backend.calls.index('healthy-new'),backend.calls.index('cli-help'))
        self.assertLess(backend.calls.index('cli-help'),backend.calls.index('release-new'))

    def test_unhealthy_candidate_restores_old_before_releasing_requests(self):
        backend=self.switch('health');self.assertEqual(backend.live,{'old'})
        self.assertLess(backend.calls.index('stop-new'),backend.calls.index('restore-old'))
        self.assertLess(backend.calls.index('healthy-old'),backend.calls.index('release-old'))
        self.assertNotIn('release-new',backend.calls)

    def test_bad_cli_keeps_previous_portal(self):
        backend=self.switch('cli');self.assertEqual(backend.live,{'old'})
        self.assertNotIn('release-new',backend.calls)

    def test_busy_business_rpc_does_not_stop_old(self):
        backend=self.switch('busy');self.assertEqual(backend.live,{'old'})
        self.assertNotIn('stop-old',backend.calls);self.assertNotIn('start-new',backend.calls)

    def test_memory_floor_stops_candidate_before_restoring_old(self):
        backend=self.switch('memory');self.assertEqual(backend.live,{'old'})
        self.assertIn('stop-new',backend.calls)

    def test_node_changes_fail_before_any_portal_action(self):
        (self.root/'release.json').write_text(json.dumps({'nodesChanged': True}))
        with self.assertRaisesRegex(RuntimeError, '节点有改动，需要安装'):
            deploy.require_portal_only(self.root)

    def test_unchanged_nodes_allow_portal_update_without_git(self):
        (self.root/'release.json').write_text(json.dumps({'nodesChanged': False}))
        deploy.require_portal_only(self.root)

    def test_deployment_key_rejects_shell_commands_without_docker(self):
        with patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': 'echo forbidden'}), patch.object(entry.subprocess, 'run') as run:
            with self.assertRaises(PermissionError): entry.main(self.root)
        run.assert_not_called()

    def archive(self, name, data=b'release', kind=tarfile.REGTYPE):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            member=tarfile.TarInfo(name);member.type=kind
            if kind == tarfile.REGTYPE: member.size=len(data)
            else: member.linkname='/outside'
            archive.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        stream.seek(0)
        return stream

    def test_offline_stream_preserves_supplied_release_files(self):
        entry.receive(self.archive('./release/deploy.py', b'approved source'), self.root)
        self.assertEqual((self.root/'release/deploy.py').read_bytes(), b'approved source')

    def test_archive_cannot_write_outside_release_directory(self):
        for name in ('../outside', '/outside'):
            with self.subTest(name=name), self.assertRaisesRegex(PermissionError, 'inside its directory'):
                entry.receive(self.archive(name), self.root)

    def test_archive_cannot_install_symlinks_or_hardlinks(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            with self.subTest(kind=kind), self.assertRaisesRegex(PermissionError, 'files and directories'):
                entry.receive(self.archive('link', kind=kind), self.root)

    def test_memory_limit_and_concurrent_portals_block_start(self):
        guard=ResourceGuard(self.root/'limits.jsonl',lambda:{'at':1,'available':950*MIB,'swap':0})
        with self.assertRaisesRegex(ResourceLimit,'at most 512MiB'):guard.before_start(1024*MIB,old_stopped=True,available_before_stop=650*MIB)
        with self.assertRaisesRegex(ResourceLimit,'old Portal must be stopped'):guard.before_start(512*MIB,old_stopped=False,available_before_stop=650*MIB)

    def test_sustained_swap_growth_is_failure(self):
        value={'at':0,'available':950*MIB,'swap':0}
        guard=ResourceGuard(self.root/'swap.jsonl',lambda:dict(value))
        for second in range(4):
            value.update(at=second,swap=second*MIB);guard.observe('tick')
        with self.assertRaisesRegex(ResourceLimit,'swap increased'):guard.checkpoint('start')


if __name__=='__main__':unittest.main()

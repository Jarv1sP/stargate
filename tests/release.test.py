import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

SOURCE=Path(__file__).resolve().parents[1]/'deploy/release'
sys.path.insert(0,str(SOURCE))
from resource_guard import MIB, ResourceGuard, ResourceLimit


def load(name):
    spec=importlib.util.spec_from_file_location('release_'+name,SOURCE/(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


deploy=load('deploy');entry=load('entry');docker_backend=load('docker_backend');scope=load('scope')


class Containers:
    def __init__(self, failure=None):
        self.failure=failure;self.live={'old'};self.calls=[];self.active_hold=None
        self.available=650*MIB;self.time=0;self.stopping_after_failure=False
        self.new=None

    def snapshot(self):
        self.time+=1
        return {'at':self.time,'available':self.available,'swap':0}

    def log(self, name):
        if len(self.live)>1:raise AssertionError('two Portal owners')
        self.calls.append(name)

    def preflight(self):self.log('preflight');return 'old'
    def create_stopped(self,limit):
        assert limit==512*MIB;self.log('create-stopped');self.new='new';return self.new
    def hold(self):self.log('hold');self.active_hold={'released':False};return self.active_hold
    def drain(self,old,hold):
        self.log('drain')
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
    def cleanup_staged(self):
        if self.new and self.new not in self.live:self.log('cleanup-staged')


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)

    def test_documentation_and_tests_skip_deployment(self):
        self.assertEqual(scope.release_scope(['docs/FEATURES.md', 'README.md', 'tests/release.test.py',
                         'native/campus-http/main_test.go', '.github/workflows/gray.yml']),
                         dict(deploy=False, nodesChanged=False, portalChanged=False))

    def test_public_guide_and_mixed_documentation_runtime_changes_deploy_portal(self):
        for paths in [['docs/USER_GUIDE.md'],['README.md','portal-service.mjs'],
                      ['docs/USER_GUIDE.md','tests/release.test.py']]:
            self.assertEqual(scope.release_scope(paths),dict(deploy=True,nodesChanged=False,portalChanged=True))

    def git(self,*args):
        return subprocess.check_output(['git','-C',str(self.root),*args],text=True).strip()

    def git_fixture(self):
        self.git('init','-q');self.git('config','user.name','Release Fixture')
        self.git('config','user.email','fixture@example.invalid')

    def git_scope(self,previous,revision):
        result=subprocess.check_output([sys.executable,str(SOURCE/'scope.py'),previous,revision],cwd=self.root,text=True)
        return json.loads(result)

    def test_runtime_components_are_selected_independently(self):
        for path in ['node/node-executor.py', 'gpuq/scheduler.py', 'deploy/node/install.py',
                     'scripts/build-node-release.py', 'scripts/build-cloud-files-node.mjs']:
            with self.subTest(path=path):
                self.assertEqual(scope.release_scope([path]),dict(deploy=True,nodesChanged=True,portalChanged=False))
        for path in ['portal-service.mjs', 'dist/client.js', 'client-http.mjs', 'accounts/portal.mjs',
                     'native/campus-http/main.go', 'scripts/build-client.mjs', 'deploy/release/deploy.py']:
            with self.subTest(path=path):
                self.assertEqual(scope.release_scope([path]),dict(deploy=True,nodesChanged=False,portalChanged=True))
        self.assertEqual(scope.release_scope(['package-lock.json']),dict(deploy=True,nodesChanged=True,portalChanged=True))

    def test_scope_uses_file_difference_from_last_successful_commit(self):
        self.git_fixture();git=self.git
        (self.root/'portal.mjs').write_text('original');git('add','.');git('commit','-qm','live')
        live=git('rev-parse','HEAD')
        (self.root/'README.md').write_text('help');git('add','.');git('commit','-qm','docs')
        result=subprocess.check_output([sys.executable,str(SOURCE/'scope.py'),live,'HEAD'],cwd=self.root,text=True)
        self.assertFalse(json.loads(result)['deploy'])
        (self.root/'portal.mjs').write_text('updated');git('add','.');git('commit','-qm','portal')
        result=subprocess.check_output([sys.executable,str(SOURCE/'scope.py'),live,'HEAD'],cwd=self.root,text=True)
        self.assertEqual(json.loads(result),dict(deploy=True,nodesChanged=False,portalChanged=True))

    def test_late_ancestor_and_already_deployed_commits_skip(self):
        self.git_fixture()
        (self.root/'portal.mjs').write_text('old');self.git('add','.');self.git('commit','-qm','old')
        old=self.git('rev-parse','HEAD')
        (self.root/'portal.mjs').write_text('current');self.git('add','.');self.git('commit','-qm','current')
        current=self.git('rev-parse','HEAD')
        self.assertFalse(self.git_scope(current,old)['deploy'])
        self.assertFalse(self.git_scope(current,current)['deploy'])

    def test_missing_previous_commit_selects_full_deployment(self):
        self.git_fixture()
        (self.root/'README.md').write_text('help');self.git('add','.');self.git('commit','-qm','current')
        self.assertEqual(self.git_scope('f'*40,'HEAD'),dict(deploy=True,nodesChanged=True,portalChanged=True))

    def test_move_out_of_node_directory_still_installs_nodes(self):
        self.git_fixture();(self.root/'node').mkdir()
        (self.root/'node/executor.py').write_text('runtime\n'*20)
        self.git('add','.');self.git('commit','-qm','node');old=self.git('rev-parse','HEAD')
        self.git('mv','node/executor.py','moved.py');self.git('commit','-qm','move')
        self.assertEqual(self.git_scope(old,'HEAD'),dict(deploy=True,nodesChanged=True,portalChanged=False))

    def test_node_only_release_leaves_running_portal_untouched(self):
        run=self.root/'runs'/'candidate';run.mkdir(parents=True)
        (run/'release.json').write_text(json.dumps(dict(nodesChanged=True,portalChanged=False)))
        with patch.object(deploy,'DockerBackend') as backend,patch.object(deploy,'ResourceGuard'), \
             patch.object(deploy,'install_nodes') as install:
            backend.return_value.prune.return_value={'containersRemoved':0,'imageTagsRemoved':0}
            deploy.main(run,'a'*40)
        install.assert_called_once();backend.return_value.preflight.assert_not_called()
        backend.return_value.prune.assert_called_once()
        self.assertEqual((self.root/'deployed-sha').read_text().strip(),'a'*40)
        self.assertEqual(json.loads((run/'result.json').read_text())['portalChanged'],False)

    def switch(self,failure=None):
        backend=Containers(failure)
        guard=ResourceGuard(self.root/'memory.jsonl',backend.snapshot)
        backend.resources=guard
        if failure:
            reason={'health':'candidate unhealthy','cli':'CLI failed','memory':'MemAvailable below 200MiB'}[failure]
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

    def drain_backend(self):
        (self.root/'manifest.json').write_text(json.dumps({'revision':'a'*40}))
        backend=docker_backend.DockerBackend(self.root,Mock())
        backend.running=Mock(return_value=True)
        return backend

    def test_long_connections_and_queued_requests_do_not_delay_handoff(self):
        backend=self.drain_backend();hold={'deadline':15}
        backend.control=Mock(return_value={'businessForwarding':3,'pending':7,
            'inFlightByType':{'terminal':1,'logs':1,'poll':1,'static':1}})
        with patch.object(docker_backend.time,'monotonic',return_value=0),patch.object(docker_backend.time,'sleep') as sleep:
            backend.drain('old',hold)
        sleep.assert_not_called()
        self.assertEqual(backend.drain_result['remaining'],4)
        self.assertEqual(backend.drain_result['queued'],7)
        self.assertFalse(backend.drain_result['timedOut'])
        self.assertEqual(hold['deadline'],15)

    def test_busy_write_and_long_connections_still_switch_after_thirty_seconds(self):
        backend=Containers();backend.root=self.root
        guard=ResourceGuard(self.root/'memory.jsonl',backend.snapshot);backend.resources=guard
        backend.check=lambda name:guard.checkpoint(name)
        backend.control=Mock(return_value={'pending':2,'inFlightByType':{'write':1,'terminal':1,'logs':1,'poll':1}})
        backend.drain=lambda old,hold:docker_backend.DockerBackend.drain(backend,old,hold)
        clock=[0.0]
        with patch.object(docker_backend.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(docker_backend.time,'sleep',side_effect=lambda delay:clock.__setitem__(0,clock[0]+delay)):
            self.assertEqual(deploy.switch(backend,guard),'new')
        self.assertEqual(clock[0],30)
        self.assertEqual(backend.live,{'new'})
        self.assertTrue(backend.drain_result['timedOut'])
        self.assertEqual(backend.drain_result['byType'],{'write':1,'terminal':1,'logs':1,'poll':1})
        self.assertEqual(json.loads((self.root/'drain.json').read_text()),backend.drain_result)

    def test_first_update_of_old_supervisor_also_continues_after_thirty_seconds(self):
        backend=self.drain_backend();backend.control=Mock(return_value={'businessForwarding':1,'staticForwarding':2,'pending':0})
        clock=[0.0]
        with patch.object(docker_backend.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(docker_backend.time,'sleep',side_effect=lambda delay:clock.__setitem__(0,clock[0]+delay)):
            backend.drain('old',{'deadline':45})
        self.assertEqual(clock[0],30)
        self.assertEqual(backend.drain_result['byType'],{'unclassifiedBusiness':1,'static':2})

    def test_normal_request_finishing_early_does_not_spend_full_budget(self):
        backend=self.drain_backend();backend.control=Mock(side_effect=[{'inFlightByType':{'write':1}},{'inFlightByType':{}}])
        clock=[0.0]
        with patch.object(docker_backend.time,'monotonic',side_effect=lambda:clock[0]), \
             patch.object(docker_backend.time,'sleep',side_effect=lambda delay:clock.__setitem__(0,clock[0]+delay)):
            backend.drain('old',{'deadline':45})
        self.assertEqual(clock[0],.1)
        self.assertFalse(backend.drain_result['timedOut'])

    def test_failed_release_cleans_its_stopped_candidate_after_restoring_old(self):
        backend=self.switch('health')
        self.assertLess(backend.calls.index('release-old'),backend.calls.index('cleanup-staged'))

    def test_memory_floor_stops_candidate_before_restoring_old(self):
        backend=self.switch('memory');self.assertEqual(backend.live,{'old'})
        self.assertIn('stop-new',backend.calls)

    def test_public_image_keeps_private_inventory_in_container_and_compose(self):
        directory=self.root/'runs'/'release';directory.mkdir(parents=True)
        (directory/'manifest.json').write_text(json.dumps({'revision': 'a'*40, 'tag': 'image', 'rollback': 'previous'}))
        backend=docker_backend.DockerBackend(directory, Mock())
        backend.network='portal-net'
        backend.old={'Config': {'Labels': {'com.docker.compose.project.config_files': 'existing.yml'},
                                'Env': ['PUBLIC_ORIGIN=https://portal.invalid']},
                     'HostConfig': {'Binds': ['/private/previous.js:/app/dist/machines.js:ro', '/database:/data']}}
        backend.api=Mock(return_value={'Id': 'new'})
        backend.command=Mock(return_value=b'')
        backend.inspect=Mock(return_value={'State': {'Running': False}})
        backend.create_stopped(512*MIB)
        body=backend.api.call_args.args[2]
        inventory=str(self.root/'private/machines.js')+':/app/dist/machines.js:ro'
        self.assertEqual(body['HostConfig']['Binds'], ['/database:/data', inventory])
        self.assertEqual(body['HostConfig']['Memory'], 512*MIB)
        self.assertEqual(body['HostConfig']['RestartPolicy']['Name'], 'unless-stopped')
        override=json.loads((directory/'portal-image.override.json').read_text())
        self.assertEqual(override['services']['amax-console']['volumes'], [inventory])

    def test_redeploy_same_commit_gets_a_fresh_activation_marker(self):
        revision='a'*40
        (self.root/'manifest.json').write_text(json.dumps({'revision':revision,'tag':'image','rollback':'previous'}))
        backend=docker_backend.DockerBackend(self.root,Mock())
        backend.network='portal-net'
        backend.old={'Config':{'Labels':{'com.docker.compose.project.config_files':'existing.yml'},
                               'Env':['PUBLIC_ORIGIN=https://portal.invalid']},'HostConfig':{}}
        backend.api=Mock(return_value={'Id':'candidate'})
        backend.command=Mock(return_value=b'')
        backend.inspect=Mock(return_value={'State':{'Running':False}})
        backend.create_stopped(512*MIB)
        first=backend.api.call_args.args[2]['Cmd']
        backend.create_stopped(512*MIB)
        second=backend.api.call_args.args[2]['Cmd']
        # A matching /data/portal-rollout/active marker auto-activates on restart.
        # A new candidate must wait for handoff, even for the same source commit.
        self.assertNotEqual(first[3],second[3])
        self.assertEqual(first[:3],second[:3])
        override=json.loads((self.root/'portal-image.override.json').read_text())
        self.assertEqual(override['services']['amax-console']['command'],second)
        self.assertEqual(backend.api.call_args.args[2]['Labels']['org.opencontainers.image.revision'],revision)

    def test_create_removes_only_stopped_staged_name_for_this_release(self):
        (self.root/'manifest.json').write_text(json.dumps({'revision':'b'*40,'tag':'image'}))
        backend=docker_backend.DockerBackend(self.root,Mock());backend.network='portal-net'
        backend.old={'Config':{'Labels':{'com.docker.compose.project.config_files':'existing.yml'},'Env':[]},'HostConfig':{}}
        backend.command=Mock(side_effect=[b'stale-id\n',b''])
        backend.inspect=Mock(return_value={'State':{'Running':False}});backend.api=Mock(return_value={'Id':'candidate'})
        backend.create_stopped(512*MIB)
        self.assertEqual(backend.command.call_args_list[0].args[0],['docker','ps','-aq','--filter','name=^/amax-console-staged-'+('b'*12)+'$'])
        self.assertEqual(backend.command.call_args_list[1].args[0],['docker','rm','stale-id'])

    def test_running_same_name_is_never_removed(self):
        backend=self.drain_backend();backend.command=Mock(return_value=b'active-id\n')
        backend.inspect=Mock(return_value={'State':{'Running':True}});backend.api=Mock()
        with self.assertRaisesRegex(RuntimeError,'still running'):backend.create_stopped(512*MIB)
        self.assertEqual(backend.command.call_count,1);backend.api.assert_not_called()

    def test_cleanup_removes_only_own_stopped_candidate_and_never_active_portal(self):
        backend=self.drain_backend();backend.new='candidate';backend.command=Mock()
        backend.running=Mock(return_value=False)
        backend.inspect=Mock(return_value={'Name':'/amax-console-staged-'+('a'*12)})
        backend.cleanup_staged();backend.command.assert_called_once_with(['docker','rm','candidate'])
        backend.command.reset_mock();backend.running.return_value=True
        backend.cleanup_staged();backend.command.assert_not_called()
        backend.running.return_value=False;backend.inspect.return_value={'Name':'/amax-console'}
        backend.cleanup_staged();backend.command.assert_not_called()

    def test_success_retention_keeps_two_previous_and_all_in_use_images(self):
        backend=self.drain_backend();backend.manifest.update(tag='stargate:auto-incoming',rollback='stargate:previous')
        def container(identity,name,image,finished,running=False):
            return dict(Id=identity,Name='/'+name,Image=image,State=dict(Running=running,FinishedAt=finished))
        containers=[container('live','amax-console','live-image','',True),
            container('first','amax-console-previous-first','first-image','2026-10-26'),
            container('second','amax-console-previous-second','second-image','2026-10-25'),
            container('old','amax-console-previous-old','old-image','2026-10-24'),
            container('rejected','amax-console-rejected-old','rejected-image','2026-10-23'),
            container('busy','amax-console-previous-busy','busy-image','',True),
            container('foreign','another-service','foreign-image','2026-10-20')]
        images=[dict(Repository=repo,Tag=tag,ID=identity)for repo,tag,identity in[
            ('stargate','auto-live','live-image'),('stargate','auto-first','first-image'),
            ('stargate','auto-second','second-image'),('stargate','auto-old','old-image'),
            ('stargate','auto-rejected','rejected-image'),('stargate','auto-busy','busy-image'),
            ('stargate','auto-foreign','foreign-image'),('stargate','auto-incoming','incoming-image'),
            ('stargate','previous','rollback-image'),('stargate','auto-rollback','rollback-image'),
            ('portal','identity','identity-image'),('caddy','latest','caddy-image')]]
        calls=[]
        def command(argv,**kwargs):
            calls.append(argv)
            if argv[:2]==['docker','ps']:return b'container-ids\n'
            if argv[:2]==['docker','inspect']:return json.dumps(containers).encode()
            if argv[:3]==['docker','image','ls']:return ('\n'.join(map(json.dumps,images))).encode()
            return b''
        backend.command=command
        (self.root/'image.tar.gz').write_bytes(b'loaded image')
        (self.root/'nodes').mkdir();(self.root/'nodes/package').write_bytes(b'installed')
        (self.root/'release').mkdir();(self.root/'release/hold_proxy.py').write_text('active relay')
        (self.root/'portal-image.override.json').write_text('{}')
        self.assertEqual(backend.prune(),dict(containersRemoved=2,imageTagsRemoved=2))
        self.assertEqual([c for c in calls if c[:2]==['docker','rm']],
                         [['docker','rm','old'],['docker','rm','rejected']])
        self.assertEqual([c for c in calls if c[:3]==['docker','image','rm']],
                         [['docker','image','rm','stargate:auto-old'],['docker','image','rm','stargate:auto-rejected']])
        self.assertIn(['docker','builder','prune','-af'],calls)
        self.assertFalse((self.root/'image.tar.gz').exists());self.assertFalse((self.root/'nodes').exists())
        self.assertTrue((self.root/'release/hold_proxy.py').exists())
        self.assertTrue((self.root/'portal-image.override.json').exists())

    def test_failed_deployment_does_not_prune_rollback_resources(self):
        run=self.root/'runs'/'candidate';run.mkdir(parents=True)
        (run/'release.json').write_text(json.dumps(dict(nodesChanged=False,portalChanged=True)))
        with patch.object(deploy,'DockerBackend')as backend,patch.object(deploy,'ResourceGuard'), \
             patch.object(deploy,'switch',side_effect=RuntimeError('unhealthy')):
            backend.return_value.drain_result=None
            with self.assertRaisesRegex(RuntimeError,'unhealthy'):deploy.main(run,'a'*40)
        backend.return_value.prune.assert_not_called()
        self.assertFalse((self.root/'deployed-sha').exists())
        self.assertEqual(json.loads((run/'result.json').read_text())['status'],'FAILED')

    def test_cleanup_failure_reports_warning_without_failing_live_release(self):
        run=self.root/'runs'/'candidate';run.mkdir(parents=True)
        (run/'release.json').write_text(json.dumps(dict(nodesChanged=False,portalChanged=False)))
        with patch.object(deploy,'DockerBackend')as backend,patch.object(deploy,'ResourceGuard'):
            backend.return_value.prune.side_effect=RuntimeError('cleanup failed')
            deploy.main(run,'a'*40)
        result=json.loads((run/'result.json').read_text())
        self.assertEqual(result['status'],'DEPLOYED')
        self.assertEqual(result['cleanup'],{'error':'RuntimeError'})

    def node_run(self):
        run=self.root/'runs'/'candidate';run.mkdir(parents=True)
        (run/'release.json').write_text(json.dumps({'nodesChanged': True}))
        (run/'install.py').write_text('# candidate installer')
        machines=['node-a', 'node-b', 'node-c', 'node-d']
        for machine in machines:
            package=run/'nodes'/machine;package.mkdir(parents=True)
            (package/'manifest.json').write_text(json.dumps({'machine': machine}))
            (package/'gpuq.pyz').write_bytes(b'candidate runtime')
        (self.root/'nodes.json').write_text(json.dumps([{'machine': m, 'destination': m+'-release'} for m in machines]))
        return run, machines

    def node_transport(self, run, machines, failure=None):
        real_spawn=subprocess.Popen;calls=[]
        # Real stdin pipe and tar reader; SSH/systemd are intentionally not used.
        script=r"""import json,sys,tarfile
from pathlib import Path
journal=Path(sys.argv[1]);machine=sys.argv[2]
with tarfile.open(fileobj=sys.stdin.buffer,mode='r|') as archive:
    files={item.name:archive.extractfile(item).read() for item in archive if item.isfile()}
assert files['install.py']==b'# candidate installer'
assert files['package/gpuq.pyz']==b'candidate runtime'
assert json.loads(files['package/manifest.json'])['machine']==machine
if sys.argv[3]=='fail':
    print('private-node-detail',file=sys.stderr);sys.exit(7)
with journal.open('a') as output:output.write(machine+'\n')
"""
        def spawn(command, **kwargs):
            number=len(calls)
            if number:
                self.assertEqual((run/'installed').read_text().splitlines(), machines[:number])
            calls.append(command)
            return real_spawn([sys.executable, '-I', '-B', '-c', script, str(run/'installed'),
                               machines[number], 'fail' if machines[number]==failure else 'ok'], **kwargs)
        return spawn, calls

    def test_all_node_packages_install_before_portal_handoff(self):
        run, machines=self.node_run();spawn, calls=self.node_transport(run,machines)
        backend=Containers();guard=ResourceGuard(run/'memory.jsonl', backend.snapshot);backend.resources=guard
        def nodes():
            deploy.install_nodes(run,self.root,guard)
            backend.log('nodes-finished')
        with patch.object(deploy.subprocess, 'Popen', side_effect=spawn):
            self.assertEqual(deploy.switch(backend,guard,nodes),'new')
        self.assertLess(backend.calls.index('nodes-finished'),backend.calls.index('preflight'))
        self.assertEqual((run/'installed').read_text().splitlines(),machines)
        self.assertEqual([command[-1] for command in calls],[m+'-release' for m in machines])
        for command in calls:
            self.assertIn(str(self.root/'node-release-ed25519'),command)
            self.assertIn(str(self.root/'node-ssh.conf'),command)
            self.assertIn('StrictHostKeyChecking=yes',command)

    def test_node_failure_keeps_old_portal_and_previous_successful_nodes(self):
        run,machines=self.node_run();spawn,calls=self.node_transport(run,machines,'node-b')
        backend=Containers();guard=ResourceGuard(run/'memory.jsonl',backend.snapshot)
        with patch.object(deploy.subprocess,'Popen',side_effect=spawn):
            with self.assertRaisesRegex(RuntimeError,'节点 node-b 安装失败') as caught:
                deploy.switch(backend,guard,lambda:deploy.install_nodes(run,self.root,guard))
        self.assertNotIn('private-node-detail',str(caught.exception))
        self.assertIn('private-node-detail',(run/'node-node-b.private.log').read_text())
        self.assertEqual(len(calls),2)
        self.assertEqual((run/'installed').read_text().splitlines(),['node-a'])
        self.assertEqual(backend.calls,[]);self.assertEqual(backend.live,{'old'})

    def test_missing_node_route_is_not_silently_skipped(self):
        run,machines=self.node_run();spawn,calls=self.node_transport(run,machines)
        (self.root/'nodes.json').write_text('[]')
        with patch.object(deploy.subprocess,'Popen',side_effect=spawn), \
             self.assertRaisesRegex(RuntimeError,'节点 node-a 安装失败'):
            deploy.install_nodes(run,self.root,Mock())
        self.assertEqual(calls,[])

    def test_unchanged_nodes_do_not_read_routes_or_launch_ssh(self):
        (self.root/'release.json').write_text(json.dumps({'nodesChanged': False}))
        with patch.object(deploy.subprocess,'Popen') as spawn:
            deploy.install_nodes(self.root,self.root,Mock())
        spawn.assert_not_called()

    def test_deployment_key_rejects_shell_commands_without_docker(self):
        with patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': 'echo forbidden'}), patch.object(entry.subprocess, 'run') as run:
            with self.assertRaises(PermissionError): entry.main(self.root)
        run.assert_not_called()

    def archive(self, name, data=b'release', kind=tarfile.REGTYPE, mode=0o644):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            member=tarfile.TarInfo(name);member.type=kind;member.mode=mode
            if kind == tarfile.REGTYPE: member.size=len(data)
            else: member.linkname='/outside'
            archive.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
        stream.seek(0)
        return stream

    def test_offline_stream_preserves_supplied_release_files(self):
        entry.receive(self.archive('./release/deploy.py', b'approved source'), self.root)
        self.assertEqual((self.root/'release/deploy.py').read_bytes(), b'approved source')

    def test_offline_stream_preserves_node_helper_executable_mode(self):
        entry.receive(self.archive('nodes/node-a/node/gpuq-network', b'helper', mode=0o555), self.root)
        self.assertEqual((self.root/'nodes/node-a/node/gpuq-network').stat().st_mode & 0o777, 0o555)

    def test_offline_entry_loads_image_then_runs_supplied_script_without_git(self):
        stream=io.BytesIO()
        with tarfile.open(fileobj=stream, mode='w') as archive:
            for name, data in [('image.tar.gz', b'image'), ('release/deploy.py', b'approved source')]:
                item=tarfile.TarInfo(name); item.size=len(data); archive.addfile(item, io.BytesIO(data))
        stream.seek(0)
        process=Mock(returncode=0); process.poll.return_value=0
        with patch.dict(os.environ, {'SSH_ORIGINAL_COMMAND': 'a'*40}), \
             patch.object(entry.sys, 'stdin', Mock(buffer=stream)), \
             patch.object(entry.subprocess, 'Popen', return_value=process) as spawn, \
             patch.object(entry.subprocess, 'run') as run:
            entry.main(self.root)
        self.assertEqual(spawn.call_args.args[0], ['docker', 'load'])
        self.assertEqual(run.call_count, 1)
        command=run.call_args.args[0]
        self.assertEqual(command[:3], [sys.executable, '-I', '-B'])
        self.assertEqual(Path(command[3]).read_bytes(), b'approved source')
        self.assertEqual(command[-1], 'a'*40)

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

"""Single-card jobs and terminals share host resources; explicit limits remain."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
GIB = 1024**3


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT/'node'/(name+'.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class SharedResources(unittest.TestCase):
    def setUp(self):
        self.resources = load('job-resources')
        self.pool = {'cgroup': '/user.slice/gpuq-workloads.slice', 'maxBytes': 450*GIB}

    def test_one_gpu_many_gpus_and_terminal_share_the_same_host_budget(self):
        with patch.object(self.resources.os, 'sched_getaffinity', return_value=set(range(128))):
            for spec, terminal in (({'cards': 1}, False), ({'cards': 8}, False), ({}, True)):
                result = self.resources.requested_limits(spec, terminal, {'memoryPool': self.pool})
                self.assertEqual(result, {'cpu': 128, 'memory': 450*GIB, 'pids': 2048})

    def test_explicit_memory_limit_survives_but_never_exceeds_shared_pool(self):
        for requested, expected in ((64, 64), (800, 450)):
            result = self.resources.requested_limits({'cards': 1, 'memoryLimitGiB': requested},
                                                     config={'memoryPool': self.pool})
            self.assertEqual(result['memory'], expected*GIB)

    def test_without_pool_uses_host_memory_and_keeps_system_reserve(self):
        with patch.object(self.resources.os, 'sysconf', side_effect=lambda k: 4096 if k == 'SC_PAGE_SIZE' else 100*GIB//4096):
            for count in (1, 8):
                self.assertEqual(self.resources.requested_limits({'cards': count})['memory'], 90*GIB)

    def test_effective_budget_respects_shared_ancestor_without_reserving_memory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); parent = root/'user.slice/gpuq-workloads.slice'; job = parent/'gpuq-test.service'
            job.mkdir(parents=True)
            for name, value in {'memory.max': str(450*GIB), 'memory.oom.group': '0'}.items():
                (parent/name).write_text(value)
            for name, value in {'cpu.max': '12800000 100000', 'memory.max': str(450*GIB), 'pids.max': '2048'}.items():
                (job/name).write_text(value)
            with patch.object(self.resources.os, 'sched_getaffinity', return_value=set(range(128))):
                budget = self.resources.read_budget({'id':'test', 'cards':1}, '/user.slice/gpuq-workloads.slice/gpuq-test.service',
                    ['GPU-test'], root=root, affinity_count=128, physical_memory=500*GIB, config={'memoryPool':self.pool})
            self.assertEqual(budget['cpuLimit'], 128)
            self.assertEqual(budget['memoryLimitBytes'], 450*GIB)
            self.assertTrue(budget['memoryShared'])

    def test_completed_terminal_does_not_fail_live_refresh(self):
        refresh = load('refresh-resources')
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); (base/'terminals').mkdir()
            (base/'terminals/ended.json').write_text('{}')
            dbfile = base/'gpuq.db'
            with sqlite3.connect(dbfile) as db:
                db.executescript('CREATE TABLE jobs(id TEXT,submit_key TEXT); CREATE TABLE attempts(job_id TEXT,unit_name TEXT,state TEXT);')
            with patch.object(refresh.subprocess, 'check_output', side_effect=[
                    'amax-term-ended.service loaded active running', '/user.slice/ended.service']), \
                    patch.object(refresh.subprocess, 'run') as run:
                run.return_value.returncode = 3
                self.assertEqual(refresh.refresh({'root':str(base),'database':str(dbfile)}, cgroups=base/'cgroups'), [])
                self.assertEqual(run.call_args.args[0], ['systemctl','--user','is-active','--quiet','amax-term-ended.service'])

    def test_queued_and_requeued_jobs_use_current_wrapper_without_changing_submission(self):
        refresh = load('refresh-resources')
        with tempfile.TemporaryDirectory() as tmp:
            dbfile = Path(tmp)/'jobs.db'; runner = Path(tmp)/'releases/current/node/oci-runner.py'
            old = str(Path(tmp)/'releases/release-old/node/oci-runner.py')
            with sqlite3.connect(dbfile) as db:
                db.execute('CREATE TABLE jobs(id TEXT,state TEXT,argv_json TEXT,env_json TEXT,submit_key TEXT,submit_digest TEXT,sequence INTEGER,priority INTEGER)')
                for i, state in enumerate(('PENDING','RUNNING','FAILED')):
                    db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)', (str(i),state,json.dumps(['/usr/bin/python3',old,'job-'+str(i)]),json.dumps({'GPUQ_CONSOLE_OCI':'1'}),'key-'+str(i),'original-submission',i,2))
                db.execute('INSERT INTO jobs VALUES (?,?,?,?,?,?,?,?)', ('native','PENDING','["python", "train.py"]','{}','native-key','native-submit',9,4))
                before = db.execute('SELECT id,state,env_json,submit_key,submit_digest,sequence,priority FROM jobs ORDER BY id').fetchall()
            self.assertEqual(refresh.rebind_runners({'database':str(dbfile)},runner), 2)
            self.assertEqual(refresh.rebind_runners({'database':str(dbfile)},runner), 0)
            with sqlite3.connect(dbfile) as db:
                self.assertEqual(db.execute('SELECT id,state,env_json,submit_key,submit_digest,sequence,priority FROM jobs ORDER BY id').fetchall(), before)
                argv = dict(db.execute('SELECT id,argv_json FROM jobs'))
            for i in ('0','1'):
                self.assertEqual(json.loads(argv[i]), ['/usr/bin/python3',str(runner),'job-'+i])
            self.assertEqual(json.loads(argv['2'])[1], old)
            self.assertEqual(json.loads(argv['native']), ['python','train.py'])

    def test_live_relaxation_preserves_explicit_limits_and_does_not_restart(self):
        refresh = load('refresh-resources')
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp); state = base/'state'; (state/'jobs').mkdir(parents=True); (state/'terminals').mkdir()
            dbfile = base/'gpuq.db'
            with sqlite3.connect(dbfile) as db:
                db.executescript('CREATE TABLE jobs(id TEXT,submit_key TEXT); CREATE TABLE attempts(job_id TEXT,unit_name TEXT,state TEXT);')
                for i in (1, 2):
                    db.execute('INSERT INTO jobs VALUES (?,?)', (str(i), str(i)))
                    db.execute('INSERT INTO attempts VALUES (?,?,?)', (str(i), 'gpuq-a'+str(i), 'STARTING' if i == 1 else 'RUNNING'))
            (state/'jobs/1.json').write_text(json.dumps({'cards':1}))
            (state/'jobs/2.json').write_text(json.dumps({'cards':1, 'memoryLimitGiB':64}))
            (state/'terminals/3.json').write_text('{}')
            units = ['gpuq-a1.service','gpuq-a2.service','amax-term-3.service']
            root = base/'cgroup'
            for unit in units:
                folder = root/'user.slice/gpuq-workloads.slice'/unit
                (folder/'payload').mkdir(parents=True)
                (folder/'memory.max').write_text(str(64*GIB))
                (folder/'cpuset.cpus.effective').write_text('0-127\n')
                (folder/'payload/cpuset.cpus').write_text('0-15')
                (folder/'payload/user-nested').mkdir()
                (folder/'payload/user-nested/cpuset.cpus').write_text('0-1')
            def output(args, **kwargs):
                if 'list-units' in args: return '\n'.join(u+' loaded active running' for u in units)
                return '/user.slice/gpuq-workloads.slice/'+args[3]
            config = {'root':str(state), 'database':str(dbfile), 'memoryPool':self.pool}
            with patch.object(refresh.subprocess, 'check_output', side_effect=output), \
                    patch.object(refresh.subprocess, 'run') as commands:
                self.assertEqual(refresh.refresh(config, cgroups=root), units)
            calls = [call.args[0] for call in commands.call_args_list]
            self.assertTrue(all('set-property' in argv for argv in calls))
            self.assertEqual(calls[0], ['systemctl', '--user', 'set-property', '--runtime',
                                       'gpuq-workloads.slice', 'MemoryMax='+str(450*GIB)])
            self.assertIn('MemoryMax='+str(450*GIB), calls[0])
            self.assertIn('MemoryMax='+str(450*GIB), calls[1])
            self.assertFalse(any(p.startswith('MemoryMax=') for p in calls[2]))
            self.assertIn('MemoryMax='+str(450*GIB), calls[3])
            for unit in units:
                folder = root/'user.slice/gpuq-workloads.slice'/unit
                self.assertEqual((folder/'payload/cpuset.cpus').read_text().strip(), '0-127')
                self.assertEqual((folder/'payload/user-nested/cpuset.cpus').read_text(), '0-1')


if __name__ == '__main__':
    unittest.main()

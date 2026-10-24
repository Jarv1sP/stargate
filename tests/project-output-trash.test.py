"""Project deletion carries only its finished local outputs into the shared trash."""
import contextlib,importlib.util,io,json,os,runpy,shutil,sqlite3,sys,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

s=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)


class ProjectOutputTrash(unittest.TestCase):
    key=f.DirectoryContract.key

    def setUp(self):
        f.DirectoryContract.setUp(self)
        self.root=Path(self.config['root']);self.jobs=self.root/'jobs';self.jobs.mkdir(mode=0o700)
        (self.root/'outputs').mkdir(mode=0o700)
        self.config['database']=str(self.root/'gpuq.sqlite')
        with sqlite3.connect(self.config['database']) as db:
            db.execute('CREATE TABLE jobs (submit_key TEXT PRIMARY KEY,state TEXT)')
        self.purge=f.module('project-purge')
        self.ops=f.module('project-ops').ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=self.root))
        self.ops.store.create('alice','demo');self.ops.store.create('alice','other');self.ops.store.create('bob','demo')

    def job(self,state='SUCCEEDED',owner='alice',project='demo'):
        jid=self.key();record={'id':jid,'userId':'submitter','ownerId':owner}
        if project is not None:record['project']=project
        self.trash.s.atomic_json(self.jobs/(jid+'.json'),record)
        if state is not None:
            with sqlite3.connect(self.config['database']) as db:db.execute('INSERT INTO jobs VALUES (?,?)',(jid,state))
        path=self.root/'outputs'/jid;path.mkdir(mode=0o700);(path/'result.txt').write_bytes(b'result')
        return jid,path

    def delete(self,operation='projects.retire',key=None):
        return self.ops.process(operation,{'ownerId':'alice','userId':'bob','project':'demo','key':key or self.key(),'actor':{'userId':'bob'}})

    def test_delete_and_retire_trash_only_matching_finished_jobs(self):
        finished=[self.job(state) for state in ('SUCCEEDED','FAILED','CANCELED','LOST')]
        untouched=[self.job(state) for state in ('PENDING','STARTING','RUNNING','PREEMPTING',None)]
        untouched.extend((self.job(owner='bob'),self.job(project='other'),self.job(project=None)))
        row=self.delete();self.assertTrue(all(not path.exists() for _,path in finished))
        self.assertEqual(set(row['outputJobs']),{jid for jid,_ in finished})
        self.assertFalse(self.ops.store.path.joinpath('alice/demo').exists())
        for jid,path in finished:
            self.assertFalse(path.exists());child=self.trash.find(self.trash.output_key(row['key'],jid))[1]
            self.assertEqual(child['kind'],'output');self.assertEqual(child['actor'],{'userId':'bob'})
            self.assertEqual(child['projectTrashKey'],row['key']);self.assertEqual(child['retainUntil'],row['retainUntil'])
        self.assertTrue(all(path.exists() for _,path in untouched))
        self.ops.process('projects.retire.restore',{'key':row['key'],'actor':{'userId':'carol'}})
        self.assertTrue(all((path/'result.txt').read_bytes()==b'result' for _,path in finished))
        self.ops.store._project('alice','demo')
        again=self.delete('projects.delete');self.assertEqual(set(again['outputJobs']),{jid for jid,_ in finished})

    def test_original_key_retry_keeps_the_original_output_set_and_expiry(self):
        jid,path=self.job();pending,pending_path=self.job('PENDING');row=self.delete()
        with sqlite3.connect(self.config['database']) as db:db.execute('UPDATE jobs SET state=? WHERE submit_key=?',('SUCCEEDED',pending))
        replay=self.delete(key=row['key'])
        self.assertEqual(replay,row);self.assertTrue(pending_path.exists())
        self.assertEqual(len(self.trash.listing()['items']),2)
        self.trash.restore({'key':row['key']})
        self.assertTrue(path.exists());self.delete(key=row['key']);self.assertTrue(path.exists())

    def test_restore_finishes_a_delete_interrupted_after_moving_the_project(self):
        jid,path=self.job();key=self.key();ops_module=f.module('project-ops');old_module=ops_module.module
        # Interrupt only the output moves, after the project's journal and rename are durable.
        with patch.object(ops_module,'module',side_effect=lambda name:self.purge if name=='project-purge' else old_module(name)):
            ops=ops_module.ProjectOperations(SimpleNamespace(CONFIG=self.config,ROOT=self.root))
            with patch.object(self.purge.Trash,'trash_outputs',side_effect=OSError('interrupted')):
                with self.assertRaises(OSError):ops.process('projects.delete',{'userId':'alice','project':'demo','key':key})
        self.assertTrue(path.exists());self.assertFalse(self.ops.store.path.joinpath('alice/demo').exists())
        self.trash.restore({'key':key,'actor':{'userId':'bob'}})
        self.assertEqual((path/'result.txt').read_bytes(),b'result')
        self.assertEqual(self.trash.find(self.trash.output_key(key,jid))[1]['state'],'RESTORED')

    def test_restore_retry_resumes_children_after_parent_was_already_restored(self):
        jid,path=self.job();row=self.delete();child=self.trash.output_key(row['key'],jid)
        restore=self.trash.restore
        def interrupted(args):
            if args['key']==child:raise OSError('interrupted')
            return restore(args)
        with patch.object(self.trash,'restore',side_effect=interrupted):
            with self.assertRaises(OSError):restore({'key':row['key']})
        self.assertEqual(self.trash.find(row['key'])[1]['state'],'RESTORED');self.assertFalse(path.exists())
        restore({'key':row['key']});self.assertTrue(path.exists())

    def test_admin_purge_and_expiry_remove_project_and_child_payloads(self):
        for automatic in (False,True):
            with self.subTest(automatic=automatic):
                self.ops.store.create('alice','demo');jid,path=self.job();row=self.delete()
                child=self.trash.output_key(row['key'],jid)
                if automatic:
                    with patch('time.time',return_value=row['retainUntil']+1):self.trash.collect()
                else:self.trash.purge({'key':row['key'],'actor':{'userId':'admin','isAdmin':True}})
                for key in (row['key'],child):
                    folder,item=self.trash.find(key);self.assertEqual(item['state'],'PURGED');self.assertFalse((folder/(key+'.data')).exists())

    def test_orphan_preview_lists_sizes_then_execute_is_idempotent_and_restorable(self):
        jid,path=self.job(project='deleted');active,active_path=self.job('RUNNING',project='deleted')
        no_project,no_project_path=self.job(project=None);same_slug,same_slug_path=self.job(owner='bob')
        key=self.key();preview=self.purge.orphan_outputs(self.ops,key)
        self.assertTrue(preview['complete']);self.assertEqual([item['jobId'] for item in preview['items']],[jid])
        self.assertGreaterEqual(preview['items'][0]['size'],6);self.assertTrue(path.exists())
        for _ in range(2):self.purge.trash_orphan_outputs(self.config,preview,{'userId':'operator'})
        self.assertFalse(path.exists());self.assertTrue(all(p.exists() for p in (active_path,no_project_path,same_slug_path)))
        self.trash.restore({'key':preview['items'][0]['key']});self.assertEqual((path/'result.txt').read_bytes(),b'result')

    def test_incomplete_job_or_project_lists_never_move_any_orphans(self):
        jid,path=self.job(project='deleted');broken_job=self.jobs/(self.key()+'.json')
        broken_project=self.ops.store.path/'alice/other/project.json';original=broken_project.read_bytes()
        missing=self.root/'outputs'/self.key()
        for broken in ('job','missing-job','project','owner-directory','jobs-directory','outputs-directory','scheduler'):
            with self.subTest(broken=broken):
                if broken=='job':broken_job.write_text('{')
                if broken=='missing-job':missing.mkdir(mode=0o700)
                if broken=='project':broken_project.write_text('{')
                real_iter=Path.iterdir
                def iterdir(folder):
                    unreadable={'owner-directory':self.ops.store.path/'alice','jobs-directory':self.jobs,'outputs-directory':self.root/'outputs'}
                    if folder==unreadable.get(broken):raise PermissionError('unreadable')
                    return real_iter(folder)
                with patch.object(Path,'iterdir',iterdir),patch.object(self.purge.sqlite3,'connect',side_effect=sqlite3.OperationalError('unavailable')) if broken=='scheduler' else contextlib.nullcontext():
                    preview=self.purge.orphan_outputs(self.ops,self.key())
                self.assertFalse(preview['complete']);self.assertEqual(preview['items'],[])
                result=self.purge.trash_orphan_outputs(self.config,preview,{'userId':'operator'})
                self.assertEqual(result['state'],'SKIPPED');self.assertTrue(path.exists());self.assertEqual(self.trash.listing()['items'],[])
                broken_job.unlink(missing_ok=True);broken_project.write_bytes(original)
                if missing.exists():missing.rmdir()

    def test_local_command_previews_before_execute_and_returns_nonzero_for_partial_lists(self):
        code=self.base/'code';code.mkdir(mode=0o700)
        for source in (f.ROOT/'node').glob('*.py'):shutil.copy2(source,code/source.name)
        (code/'node-config.json').write_text(json.dumps(self.config));key=self.key();jid,path=self.job(project='deleted')
        def command(*extra):
            out=io.StringIO();env={k:v for k,v in os.environ.items() if k!='STARGATE_CORE_PROFILE'}
            with patch.dict(os.environ,env,clear=True),patch.object(sys,'argv',[str(code/'node-executor.py'),'--trash-orphan-outputs','--key',key,'--actor','operator',*extra]),contextlib.redirect_stdout(out),patch('os.setpriority'),patch('subprocess.run'):
                with self.assertRaises(SystemExit) as exited:runpy.run_path(str(code/'node-executor.py'),run_name='__main__')
            return exited.exception.code,[json.loads(line) for line in out.getvalue().splitlines()]
        status,rows=command();self.assertEqual(status,0);self.assertEqual(rows[0]['state'],'PREVIEW');self.assertTrue(path.exists())
        status,rows=command('--execute');self.assertEqual(status,0);self.assertEqual([r['state'] for r in rows],['PREVIEW','TRASHED']);self.assertFalse(path.exists())
        self.trash.restore({'key':rows[-1]['items'][0]['key']});(self.jobs/(self.key()+'.json')).write_text('{')
        status,rows=command('--execute');self.assertEqual(status,1);self.assertEqual(rows[0]['state'],'SKIPPED');self.assertTrue(path.exists())


if __name__=='__main__':unittest.main()

"""Project deletion carries only its finished local outputs into the shared trash."""
import importlib.util,sqlite3,unittest
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


if __name__=='__main__':unittest.main()

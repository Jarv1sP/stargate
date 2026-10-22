"""Read complete scheduler logs using real files; never run or cancel a job."""
import base64,importlib.util,sqlite3,unittest
from pathlib import Path

spec=importlib.util.spec_from_file_location('log_fixture',Path(__file__).with_name('project-security.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class JobLogDownload(unittest.TestCase):
    def setUp(self):
        f.ProjectContract.setUp(self)
        self.node=f.ProjectContract.node(self)
        self.job={'id':f.ProjectContract.key(self),'userId':'alice','project':'demo','cards':1,'argv':['true']}
        with sqlite3.connect(self.config['database']) as db:db.execute('insert into jobs values(?,?)',('J000000000001',self.job['id']))
        self.path=self.base/'scheduler.log';self.content=b'first line\n'+b'x\n'*(1024**2)+b'last line\n\xff'
        self.path.write_bytes(self.content)
        previous=self.base/'previous.log';previous.write_bytes(b'previous attempt\n')
        self.attempts=[{'id':'A'+'2'*32,'log_path':str(self.path)},{'id':'A'+'1'*32,'log_path':str(previous)}]
        self.calls=[]
        def gpu(*args):
            self.calls.append(args);self.assertEqual(args,('show','J000000000001'))
            return {'job':{'state':'CANCELED'},'attempts':self.attempts}
        self.node.gpu=gpu;self.node.run=lambda argv,**kw:'last 200 lines\n'
        self.node.job_log_result=lambda job,data,text:{'text':text}

    def read(self,**args):return self.node.process('logs',{'job':self.job,'download':True,**args})

    def test_complete_log_is_chunked_without_losing_the_beginning_or_raw_bytes(self):
        meta=self.read();self.assertEqual(meta,{'attemptId':self.attempts[0]['id']})
        received=bytearray()
        while True:
            part=self.read(attemptId=meta['attemptId'],offset=len(received),length=100*1024**2,path='/etc/passwd')
            raw=base64.b64decode(part['data']);self.assertLessEqual(len(raw),1024**2)
            self.assertEqual(part['size'],len(self.content));received.extend(raw)
            if part['eof']:break
        self.assertEqual(bytes(received),self.content)

    def test_saved_attempt_can_be_read_after_a_new_attempt_starts(self):
        part=self.read(attemptId=self.attempts[1]['id'],offset=0)
        self.assertEqual(base64.b64decode(part['data']),b'previous attempt\n')
        with self.assertRaisesRegex(ValueError,'日志'):self.read(attemptId='A'+'3'*32,offset=0)

    def test_empty_log_is_distinct_from_an_attempt_that_never_started(self):
        self.path.write_bytes(b'');part=self.read(offset=0)
        self.assertEqual(part['size'],0);self.assertEqual(part['data'],'');self.assertTrue(part['eof'])
        self.attempts=[]
        with self.assertRaisesRegex(ValueError,'日志'):self.read()

    def test_download_keeps_the_existing_system_disk_wall(self):
        self.attempts[0]['log_path']='/etc/passwd'
        with self.assertRaisesRegex(ValueError,'系统盘'):self.read(offset=0)

    def test_default_log_view_remains_the_tail(self):
        self.assertEqual(self.node.process('logs',{'job':self.job}),{'text':'last 200 lines\n'})


if __name__=='__main__':unittest.main()

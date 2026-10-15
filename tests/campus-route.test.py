"""Campus/Portal continuation shares actual node bytes, offsets and output roots."""
import base64,importlib.util,unittest,uuid
from pathlib import Path
s=importlib.util.spec_from_file_location('campus_route_fixture',Path(__file__).with_name('project-security.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)

class CampusRoutes(unittest.TestCase):
    def setUp(self):
        self.case=f.ProjectContract();self.case.setUp();self.addCleanup(self.case.doCleanups)
        self.node=self.case.node();self.node.projects().store.create('peer','demo')
        self.direct=f.f.module('direct-upload').DirectUploads.__new__(f.f.module('direct-upload').DirectUploads)
        self.direct.n=self.node

    def test_output_with_project_and_run_id_reads_output_not_same_named_workspace_file(self):
        code=self.node.projects().store.dev_paths('peer','demo')['code']
        output=self.node.projects().store.runtime_paths({'userId':'peer','project':'demo'},'11111111-1111-4111-8111-111111111111')['output']
        (code/'same.bin').write_bytes(b'workspace');(output/'same.bin').write_bytes(b'output')
        args={'userId':'peer','ownerId':'peer','project':'demo','area':'output','runId':'11111111-1111-4111-8111-111111111111','path':'same.bin','offset':0}
        direct=f.f.module('dataset-files').process(self.case.config,'files.get',args,root=self.direct.root(args))
        portal=self.node.process('files.get',args)
        self.assertEqual(base64.b64decode(direct['data']),b'output');self.assertEqual(direct['data'],portal['data'])

    def test_workspace_direct_chunk_then_portal_continues_same_key_at_confirmed_partial_offset(self):
        args={'userId':'peer','ownerId':'peer','project':'demo','area':'code','path':'source.bin','key':str(uuid.uuid4()),'totalSize':6}
        self.node.process('data.upload.begin',args)
        direct=f.f.module('data-uploads').Uploads(self.case.config,'peer',root=self.direct.root(args))
        direct.process('chunk',{**args,'offset':0,'data':base64.b64encode(b'ab').decode()})
        observed=self.node.process('data.upload.status',args);self.assertEqual(observed['offset'],2)
        self.node.process('data.upload.chunk',{**args,'offset':observed['offset'],'data':base64.b64encode(b'cdef').decode()})
        self.node.process('data.upload.finish',args)
        self.assertEqual(direct.process('status',args)['offset'],6)
        self.assertEqual((self.direct.root(args)/'source.bin').read_bytes(),b'abcdef')

if __name__=='__main__':unittest.main()

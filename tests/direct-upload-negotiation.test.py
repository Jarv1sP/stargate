"""New nodes opt into larger bodies only for explicit negotiation requests."""
import importlib.util,subprocess,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
s=importlib.util.spec_from_file_location('direct_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(s);s.loader.exec_module(f)

class ChunkNegotiation(unittest.TestCase):
    def setUp(self):
        with patch.object(tempfile,'tempdir',str(Path(tempfile.gettempdir()).resolve())):f.DirectoryContract.setUp(self)
        cert=self.base/'cert';key=self.base/'key'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost','-keyout',str(key),'-out',str(cert)],check=True,capture_output=True)
        self.config['directUpload']={'certificate':str(cert),'endpoint':'https://campus.example'}
        self.direct=f.module('direct-upload').DirectUploads(SimpleNamespace(CONFIG=self.config))

    def test_same_upload_key_negotiates_16mib_and_old_client_still_gets_1mib(self):
        key=f.DirectoryContract.key(self);request={'action':'put','uploadId':key,'dataset':'shared','path':'file.bin','totalSize':32*1024**2,'userId':'alice'}
        old=self.direct.issue(request);self.assertEqual(old['chunkBytes'],1024**2);self.assertEqual(old['maxChunkBytes'],1024**2)
        large=self.direct.issue({**request,'maxChunkBytes':16*1024**2})
        self.assertEqual(large['grantId'],key);self.assertEqual(large['ticket'],old['ticket'])
        self.assertEqual(large['chunkBytes'],16*1024**2);self.assertEqual(large['maxChunkBytes'],16*1024**2)
        self.assertEqual(self.direct.s.read_json(self.direct.folder/(key+'.json'))['chunkBytes'],1024**2)
        resumed=self.direct.issue(request);self.assertEqual(resumed['chunkBytes'],1024**2)
        self.assertEqual(self.direct.s.read_json(self.direct.folder/(key+'.json'))['chunkBytes'],1024**2)

    def test_download_stores_the_negotiated_bound_and_default_stays_small(self):
        root=self.direct.d.dataset_root(self.config,'shared',create=True)
        (root/'file.bin').write_bytes(b'content')
        request={'action':'get','dataset':'shared','path':'file.bin','userId':'alice'}
        for chunk in (1024**2,16*1024**2):
            grant=self.direct.issue({**request,**({'maxChunkBytes':chunk} if chunk>1024**2 else {})})
            self.assertEqual(grant['chunkBytes'],chunk);self.assertEqual(grant['maxChunkBytes'],chunk)
            self.assertEqual(self.direct.s.read_json(self.direct.folder/(grant['grantId']+'.json'))['chunkBytes'],chunk)

if __name__=='__main__':unittest.main()

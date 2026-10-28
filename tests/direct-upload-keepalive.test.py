"""The campus TLS file lane sends small replies promptly on a reused socket."""
import http.client,importlib.util,json,shutil,socket,ssl,subprocess,threading,unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


@unittest.skipUnless(shutil.which('openssl'),'openssl is needed for the local TLS fixture')
class DirectKeepalive(unittest.TestCase):
    key=f.DirectoryContract.key

    def setUp(self):
        f.DirectoryContract.setUp(self)
        certificate=self.base/'cert.pem';private=self.base/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
            '-subj','/CN=localhost','-addext','subjectAltName=IP:127.0.0.1',
            '-keyout',str(private),'-out',str(certificate)],check=True,capture_output=True)
        self.config['directUpload']={'bind':'127.0.0.1','port':0,'certificate':str(certificate),'privateKey':str(private)}
        self.root=self.data.dataset_root(self.config,'shared',create=True);self.id=self.key();self.download_id=self.key()
        f.module('data-uploads').Uploads(self.config,'alice',root=self.root).process('begin',{'key':self.id,'path':'sample.bin','totalSize':1024})
        node=SimpleNamespace(CONFIG=self.config);direct=f.module('direct-upload');grants=direct.DirectUploads(node)
        # Authentication is substituted; TLS, HTTP, upload bytes and commit are real.
        grants.authorize=lambda key,token:{'id':key,'root':str(self.root),'path':'sample.bin','userId':'alice','action':'put' if key==self.id else 'get','chunkBytes':1024}
        with patch.object(direct,'DirectUploads',return_value=grants):self.server=direct.create_server(node)
        self.connections=[];base=self.server.RequestHandlerClass;connections=self.connections
        class Handler(base):
            def setup(self):super().setup();connections.append(self.connection)
        self.server.RequestHandlerClass=Handler
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.client=http.client.HTTPSConnection('127.0.0.1',self.server.server_port,timeout=3,context=ssl.create_default_context(cafile=str(certificate)))
        self.addCleanup(self.stop)

    def stop(self):
        self.client.close();self.server.shutdown();self.server.server_close();self.thread.join()

    def request(self,method,path,body=None):
        self.client.request(method,path,body,{'Authorization':'Bearer fixture'})
        response=self.client.getresponse();raw=response.read();self.assertEqual(response.status,200,raw)
        return raw

    def test_chunk_upload_and_download_reuse_a_tls_socket_with_nagle_disabled(self):
        self.assertTrue(json.loads(self.request('GET','/capabilities'))['sourceReady'])
        raw=bytes(range(256))*4
        first=json.loads(self.request('POST',f'/v1/files/{self.id}/put?offset=0',raw[:511]))
        self.assertEqual(first['result']['offset'],511)
        complete=json.loads(self.request('POST',f'/v1/files/{self.id}/put?offset=511&final=true',raw[511:]))
        self.assertEqual(complete['result']['state'],'COMPLETE')
        self.assertEqual(self.request('GET',f'/v1/files/{self.download_id}/get?offset=0&length=1024'),raw)
        self.assertEqual((self.root/'sample.bin').read_bytes(),raw)
        self.assertEqual(len(self.connections),1)
        self.assertEqual(self.connections[0].getsockopt(socket.IPPROTO_TCP,socket.TCP_NODELAY),1)


if __name__=='__main__':unittest.main()

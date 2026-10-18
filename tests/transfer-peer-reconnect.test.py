"""Directory copy survives the source closing an idle keep-alive connection."""
import hashlib,importlib.util,shutil,socket,ssl,subprocess,tempfile,threading,unittest
from pathlib import Path
from types import SimpleNamespace
ROOT=Path(__file__).resolve().parents[1]

def module(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),ROOT/'node'/(name+'.py'))
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result


class Jobs:
    def __init__(self):self.calls=[]
    def read(self,request,token):
        self.calls.append(request['action']);return {'entries':[],'nextOffset':None,'offset':request.get('offset')}


@unittest.skipUnless(shutil.which('openssl'),'openssl is required for a local TLS peer')
class PeerReconnect(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);base=Path(self.tmp.name)
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=peer',
                        '-keyout',str(base/'key.pem'),'-out',str(base/'cert.pem')],check=True,capture_output=True)
        with socket.socket() as probe:probe.bind(('127.0.0.1',0));port=probe.getsockname()[1]
        self.node=SimpleNamespace(CONFIG={'transferPeer':{'bind':'127.0.0.1','port':port,
            'certificate':str(base/'cert.pem'),'privateKey':str(base/'key.pem')}})
        self.peer=module('transfer-peer');self.jobs=Jobs();self.server=None
        der=ssl.PEM_cert_to_DER_cert((base/'cert.pem').read_text())
        self.client=module('transfer-jobs').PeerClient({'address':'127.0.0.1','port':port,
            'certificateSha256':hashlib.sha256(der).hexdigest()},{'id':'copy','token':'token'})
        self.addCleanup(self.client.close);self.addCleanup(self.stop)

    def start(self):
        self.server=self.peer.create_server(self.node,self.jobs);self.open=[]
        base=self.server.RequestHandlerClass;open_connections=self.open
        class Handler(base):
            def setup(self):super().setup();open_connections.append(self.connection)
        self.server.RequestHandlerClass=Handler
        threading.Thread(target=self.server.serve_forever,daemon=True).start()

    def stop(self):
        if self.server:self.server.shutdown();self.server.server_close();self.server=None

    def test_reused_connection_closed_by_source_is_resent_once_on_a_new_connection(self):
        self.start();self.assertEqual(self.client.call('list',offset=0)['offset'],0)
        # Same as the source's 30 s idle timeout or a restart: it closes the kept-alive socket.
        for connection in self.open:connection.shutdown(socket.SHUT_RDWR);connection.close()
        self.assertEqual(self.client.call('list',offset=200)['offset'],200)
        self.assertEqual(self.jobs.calls,['list','list'])

    def test_fresh_connection_failure_is_reported_not_retried(self):
        with self.assertRaises(ConnectionError):self.client.call('list',offset=0)
        self.assertEqual(self.jobs.calls,[])


if __name__=='__main__':unittest.main()

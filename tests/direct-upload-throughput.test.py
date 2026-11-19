"""Real loopback TLS requests, bounded login reuse and durable request offsets."""
import hashlib,http.client,importlib.util,io,json,os,shutil,socket,ssl,stat,subprocess,sys,tempfile,threading,time,unittest
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('direct_fixture',ROOT/'tests/node-friction.test.py')
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class DirectRequests(unittest.TestCase):
    def setUp(self):
        with patch.object(tempfile,'tempdir',str(Path(tempfile.gettempdir()).resolve())):f.DirectoryContract.setUp(self)
        source=Path(os.environ.get('UPLOAD_BENCH_SOURCE',str(ROOT)))
        spec=importlib.util.spec_from_file_location('direct_lane',source/'node/direct-upload.py')
        self.direct=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.direct)
        certificate=self.base/'cert.pem';private=self.base/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=localhost',
            '-addext','subjectAltName=IP:127.0.0.1','-keyout',str(private),'-out',str(certificate)],check=True,capture_output=True)
        context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(certificate,private)
        self.checks=0;case=self
        class Portal(BaseHTTPRequestHandler):
            def log_message(self,*args):pass
            def do_POST(self):
                self.rfile.read(int(self.headers['Content-Length']));case.checks+=1
                time.sleep(getattr(case,'portal_delay',0))
                body=b'{"allowed":true}';self.send_response(200);self.send_header('Content-Length',str(len(body)));self.end_headers();self.wfile.write(body)
        self.portal=ThreadingHTTPServer(('127.0.0.1',0),Portal);self.portal.socket=context.wrap_socket(self.portal.socket,server_side=True)
        self.portal_thread=threading.Thread(target=self.portal.serve_forever,daemon=True);self.portal_thread.start()
        self.addCleanup(self.stop_portal)
        pin=hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate.read_text())).hexdigest()
        self.config['directUpload']={'bind':'127.0.0.1','port':0,'endpoint':'https://127.0.0.1','certificate':str(certificate),'privateKey':str(private),
            'personalFiles':{'portalOrigin':'https://127.0.0.1:'+str(self.portal.server_port),'certificateSha256':pin}}
        self.lane=self.direct.DirectUploads(SimpleNamespace(CONFIG=self.config));self.root=self.lane.d.dataset_root(self.config,'shared',create=True)
        self.key=f.DirectoryContract.key(self)
        self.server=None;self.client=None

    def stop_portal(self):
        if self.client:self.client.close()
        if self.server:self.server.shutdown();self.server.server_close();self.thread.join()
        self.portal.shutdown();self.portal.server_close();self.portal_thread.join()

    def start(self,size):
        self.grant=self.lane.issue({'action':'put','uploadId':self.key,'dataset':'shared','path':'sample.bin','totalSize':size,'userId':'alice'})
        with patch.object(self.direct,'DirectUploads',return_value=self.lane):self.server=self.direct.create_server(SimpleNamespace(CONFIG=self.config))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.client=http.client.HTTPSConnection('127.0.0.1',self.server.server_port,timeout=10,context=ssl._create_unverified_context())

    def request(self,offset,raw,final=False):
        self.client.request('POST',f'/v1/files/{self.key}/put?offset={offset}&final={str(final).lower()}',raw,{'Authorization':'Bearer '+self.grant['ticket']})
        response=self.client.getresponse();body=response.read();self.assertEqual(response.status,200,body)
        return json.loads(body)['result']

    def test_authentication_expiry_ticket_failures_and_cache_bound(self):
        self.start(1);now=time.time();clock=[now];self.lane.control_check=Mock()
        with patch.object(self.direct.time,'time',side_effect=lambda:clock[0]),patch.object(self.direct.time,'monotonic',side_effect=lambda:clock[0]):
            for _ in range(4):self.lane.authorize(self.key,self.grant['ticket'])
            self.assertEqual(self.lane.control_check.call_count,1)
            clock[0]+=31;self.lane.authorize(self.key,self.grant['ticket']);self.assertEqual(self.lane.control_check.call_count,2)
            clock[0]+=31;self.lane.control_check.side_effect=PermissionError('revoked')
            for _ in range(2):
                with self.assertRaises(PermissionError):self.lane.authorize(self.key,self.grant['ticket'])
            self.assertEqual(self.lane.control_check.call_count,4);self.lane.control_check.side_effect=None
            row=self.lane.s.read_json(self.lane.folder/(self.key+'.json'));row.update(ticket='new-ticket',expiresAt=clock[0]+1)
            self.lane.s.atomic_json(self.lane.folder/(self.key+'.json'),row)
            self.lane.authorize(self.key,'new-ticket');self.assertEqual(self.lane.control_check.call_count,5)
            clock[0]+=2
            with self.assertRaises(PermissionError):self.lane.authorize(self.key,'new-ticket')
            self.assertEqual(self.lane.control_check.call_count,5)
        self.lane.checked.update({('other-'+str(i),'t'):time.time()+30 for i in range(1100)})
        row.update(ticket='bounded-ticket',expiresAt=time.time()+300);self.lane.s.atomic_json(self.lane.folder/(self.key+'.json'),row)
        self.lane.authorize(self.key,'bounded-ticket');self.assertLessEqual(len(self.lane.checked),1024)

    def test_16mib_body_syncs_data_and_updates_offset_once_without_base64(self):
        self.start(17*1024**2);raw=b'x'*(16*1024**2)
        uploads=self.direct.module('data-uploads').Uploads(self.config,'alice',root=self.root);store=uploads.s
        inode=(self.root/('.upload-'+self.key)).stat().st_ino;syncs=[];original=os.fsync
        def sync(fd):
            if os.fstat(fd).st_ino==inode:syncs.append(fd)
            return original(fd)
        with patch.object(os,'fsync',side_effect=sync),patch.object(store,'atomic_json',wraps=store.atomic_json) as record,\
             patch.object(store,'require_workspace_space',wraps=store.require_workspace_space) as quota,\
             patch.object(self.direct.base64,'b64decode',side_effect=AssertionError('unnecessary base64')):
            self.assertEqual(self.request(0,raw)['offset'],len(raw))
        self.assertEqual(len(syncs),1);self.assertEqual(record.call_count,1);self.assertEqual(quota.call_count,1)
        self.assertIs(self.direct.module('data-uploads'),self.direct.module('data-uploads'))

    def test_disconnect_and_uncommitted_tail_resume_from_durable_offset(self):
        self.start(4*1024**2)
        context=ssl._create_unverified_context()
        with context.wrap_socket(socket.create_connection(('127.0.0.1',self.server.server_port)),server_hostname='localhost') as connection:
            partial=b'a'*(1024**2+19)
            header=f'POST /v1/files/{self.key}/put?offset=0 HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {self.grant["ticket"]}\r\nContent-Length: {4*1024**2}\r\n\r\n'.encode()
            connection.settimeout(3);connection.sendall(header+partial)
            # A clean TLS close-notify delivers the prefix before EOF. A bare
            # TCP shutdown can discard encrypted records still in flight.
            try:connection.unwrap().close()
            except (ssl.SSLError,TimeoutError):pass
        uploads=self.direct.module('data-uploads').Uploads(self.config,'alice',root=self.root)
        deadline=time.monotonic()+3;offset=0
        while not offset and time.monotonic()<deadline:
            offset=uploads.process('status',{'key':self.key})['offset'];time.sleep(0.01)
        self.assertGreater(offset,0);self.assertLessEqual(offset,len(partial))
        self.assertEqual((self.root/('.upload-'+self.key)).read_bytes(),partial[:offset])
        # Simulate death between pwrite and the durable offset update.
        with open(self.root/('.upload-'+self.key),'ab') as stream:stream.write(b'undurable tail')
        expected=partial+b'b'*(4*1024**2-len(partial));self.request(offset,expected[offset:],final=True)
        self.assertEqual((self.root/'sample.bin').read_bytes(),expected)

    def test_get_reuses_authentication_and_modules(self):
        self.start(1);self.request(0,b'x',final=True)
        grant=self.lane.issue({'action':'get','dataset':'shared','path':'sample.bin','userId':'alice'})
        with patch.object(importlib.util,'spec_from_file_location',wraps=importlib.util.spec_from_file_location) as loads:
            for _ in range(3):
                self.client.request('GET',f'/v1/files/{grant["grantId"]}/get',headers={'Authorization':'Bearer '+grant['ticket']})
                response=self.client.getresponse();self.assertEqual(response.status,200);self.assertEqual(response.read(),b'x')
        self.assertEqual(loads.call_count,0)
        self.assertEqual(self.checks,2)

    def test_empty_final_request_recovers_a_rename_before_completion_record(self):
        self.start(1);self.request(0,b'x')
        uploads=self.direct.module('data-uploads').Uploads(self.config,'alice',root=self.root)
        row=uploads.s.read_json(uploads.record(self.key));row['state']='COMMITTING'
        uploads.s.atomic_json(uploads.record(self.key),row)
        (self.root/row['temp']).replace(self.root/row['path'])
        self.assertEqual(self.request(1,b'',final=True)['state'],'COMPLETE')
        self.assertEqual((self.root/'sample.bin').read_bytes(),b'x')

    def benchmark(self):
        self.portal_delay=0.15;total=256*1024**2;chunk=b'x'*(512*1024);self.start(total)
        began=time.perf_counter()
        for offset in range(0,total,len(chunk)):self.request(offset,chunk)
        self.request(total,b'',final=True)
        seconds=time.perf_counter()-began
        return {'bytes':total,'chunkBytes':len(chunk),'seconds':seconds,'MBps':total/seconds/1000000,'portalChecks':self.checks}

    def test_loopback_tls_256mib_exceeds_30mbps(self):
        result=self.benchmark();print('DIRECT_UPLOAD_BENCH '+json.dumps(result));self.assertGreaterEqual(result['MBps'],30)


if __name__=='__main__':
    if '--benchmark' in sys.argv:
        case=DirectRequests();case.setUp()
        try:print(json.dumps(case.benchmark()),flush=True)
        finally:case.doCleanups()
    else:unittest.main()

"""Real PTY input/output keeps responding even if metadata fsync would stall."""
import base64,json,os,shutil,signal,socket,subprocess,sys,tempfile,time,unittest
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


class HelperIO(unittest.TestCase):
    def test_input_and_output_do_not_wait_for_activity_metadata_fsync(self):
        with tempfile.TemporaryDirectory(dir='/tmp') as temporary:
            base=Path(temporary);code=base/'node';code.mkdir();state=base/'state';folder=state/'terminals';folder.mkdir(parents=True)
            jid='11111111-2222-4333-8444-555555555555'
            for name in ('terminal-helper.py','terminal-output.py'):shutil.copy2(ROOT/'node'/name,code/name)
            # This test replaces the separately-tested mount guard and OCI launcher only.
            (code/'local-data.py').write_text('def require_data_path(config,path):return path\n')
            (code/'node-config.json').write_text(json.dumps({'root':str(state)}))
            (folder/(jid+'.json')).write_text('{}')
            (code/'oci-runner.py').write_text('import signal,sys\nsignal.alarm(5)\nprint("READY",flush=True)\nprint("ACK "+input(),flush=True)\n')
            bootstrap='import os,runpy,sys,time\nos.fsync=lambda fd:time.sleep(10)\nsys.argv=sys.argv[1:]\nrunpy.run_path(sys.argv[0],run_name="__main__")\n'
            env={key:value for key,value in os.environ.items() if key!='STARGATE_CORE_PROFILE'}
            process=subprocess.Popen([sys.executable,'-B','-c',bootstrap,str(code/'terminal-helper.py'),jid],env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
            try:
                deadline=time.monotonic()+3;sock=folder/(jid+'.sock')
                while not sock.exists() and process.poll() is None and time.monotonic()<deadline:time.sleep(0.01)
                self.assertTrue(sock.exists(),process.stderr.read().decode() if process.poll() is not None else 'helper socket not ready')
                began=time.monotonic()
                with socket.socket(socket.AF_UNIX) as connection:
                    connection.settimeout(2);connection.connect(str(sock))
                    connection.sendall((json.dumps({'input':base64.b64encode(b'hello\n').decode(),'offset':0})+'\n').encode())
                    with connection.makefile('rb') as stream:result=json.loads(stream.readline())
                self.assertIn('offset',result);self.assertLess(time.monotonic()-began,2)
                process.wait(timeout=3);self.assertEqual(process.returncode,0,process.stderr.read().decode())
                self.assertIn(b'ACK hello',folder.joinpath(jid+'.output').read_bytes())
                self.assertFalse(folder.joinpath(jid+'.activity.json').exists())
            finally:
                if process.poll() is None:process.kill();process.wait()
                process.stdout.close();process.stderr.close()


if __name__=='__main__':unittest.main()

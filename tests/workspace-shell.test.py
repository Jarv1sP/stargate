"""Real local PTY checks: reconnect preserves shell state and child processes."""
import base64
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest


class WorkspaceShell(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='gpuq-pty-');self.path=Path(self.temp.name)/'shell.sock'
        helper=Path(__file__).parents[1]/'deploy/workspace-shell.py'
        script="import importlib.util,sys; s=importlib.util.spec_from_file_location('shell',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); sys.exit(m.serve(['/bin/bash','--noprofile','--norc','-i'],sys.argv[2]))"
        self.child=subprocess.Popen([sys.executable,'-c',script,str(helper),str(self.path)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.addCleanup(self.cleanup)
        deadline=time.monotonic()+5
        while not self.path.exists() and self.child.poll() is None and time.monotonic()<deadline:time.sleep(.02)
        self.assertTrue(self.path.exists())

    def cleanup(self):
        if self.child.poll() is None:
            self.request({'action':'close'})
        self.child.communicate(timeout=10);self.temp.cleanup()

    def request(self,request):
        with socket.socket(socket.AF_UNIX) as client:
            client.settimeout(3);client.connect(str(self.path));client.sendall((json.dumps(request)+'\n').encode())
            with client.makefile('rb') as stream:return json.loads(stream.readline())

    def command(self,command,expected):
        self.request({'input':base64.b64encode(command.encode()).decode()})
        deadline=time.monotonic()+5;output=''
        while expected not in output and time.monotonic()<deadline:
            output=base64.b64decode(self.request({})['data']).decode(errors='replace');time.sleep(.02)
        self.assertIn(expected,output)

    def test_reconnect_keeps_the_same_shell_environment_and_working_directory(self):
        self.command('export KEEP=retained; cd /; printf "first-%s\\n" "$KEEP"\n','first-retained')
        # Every request opens and closes a new transport connection.
        self.command('printf "second-%s-%s\\n" "$KEEP" "$PWD"\n','second-retained-/')
        self.assertIsNone(self.child.poll())
        self.assertEqual(self.request({'action':'close'}),{'closed':True})
        self.assertEqual(self.child.wait(timeout=10),0)

    def test_bad_request_does_not_kill_the_workspace_process(self):
        self.assertIn('error',self.request({'rows':'invalid'}))
        self.command('printf "still-%s\\n" alive\n','still-alive')
        self.assertIsNone(self.child.poll())


if __name__=='__main__':unittest.main()

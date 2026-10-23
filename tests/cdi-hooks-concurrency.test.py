"""NVIDIA hooks share a persistent rootfs; cache writes must be serialized."""
import concurrent.futures,copy,importlib.util,json,os,shutil,subprocess,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch

HELPER=Path(os.environ.get('CDI_HELPER_UNDER_TEST',Path(__file__).resolve().parents[1]/'node/workspace-rootfs.py'))
spec=importlib.util.spec_from_file_location('workspace_hooks',HELPER)
rootfs=importlib.util.module_from_spec(spec);spec.loader.exec_module(rootfs)


class CDIHookConcurrency(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix='cdi shared root ')
        self.addCleanup(self.temporary.cleanup);self.base=Path(self.temporary.name)

    def test_private_spec_serializes_only_nvidia_hooks_and_preserves_driver_mounts(self):
        nvidia={'hookName':'createContainer','path':'/usr/bin/nvidia-cdi-hook',
                'args':['nvidia-cdi-hook','update-ldcache','--folder','/usr/lib/driver'],
                'env':['NVIDIA_CTK_DEBUG=false']}
        other={'hookName':'createContainer','path':'/fixture/other','args':['other']}
        original={'cdiVersion':'0.8.0','kind':'nvidia.com/gpu','devices':[{'name':'GPU-fixture',
            'containerEdits':{'hooks':[copy.deepcopy(nvidia)]}}],
            'containerEdits':{'mounts':[{'hostPath':'/fixture/driver','containerPath':'/usr/lib/driver',
                                      'options':['ro','nosuid','nodev','bind']}],
                              'hooks':[nvidia,other]}}
        source=self.base/'trusted.json';source.write_text(json.dumps(original))
        folder=self.base/'tmp';folder.mkdir();use=self.base/'use-project.lock'
        prefix=['/usr/bin/podman','--cdi-spec-dir='+str(self.base),'--events-backend=file']
        request={'cdiSpec':str(source),'workspaceLock':str(use)}
        with rootfs.cdi_hooks(request,prefix,folder) as command:
            directory=Path(next(a.split('=',1)[1] for a in command if a.startswith('--cdi-spec-dir=')))
            prepared=json.loads((directory/'nvidia.json').read_text())
            self.assertNotEqual(directory,self.base)
            self.assertEqual(prepared['containerEdits']['mounts'],original['containerEdits']['mounts'])
            self.assertEqual(prepared['containerEdits']['hooks'][1],other)
            for hook in [prepared['containerEdits']['hooks'][0],prepared['devices'][0]['containerEdits']['hooks'][0]]:
                self.assertEqual(hook['path'],sys.executable)
                self.assertEqual(hook['env'],nvidia['env'])
                self.assertEqual(hook['args'][-4:],['/usr/bin/nvidia-cdi-hook','update-ldcache','--folder','/usr/lib/driver'])
                self.assertIn(str(use.with_suffix('.cdi.lock')),hook['args'])
                self.assertNotIn(str(use),hook['args'])
            self.assertEqual(json.loads(source.read_text()),original)
        self.assertFalse(directory.exists())
        with rootfs.cdi_hooks({},prefix,folder) as unchanged:self.assertEqual(unchanged,prefix)

    def test_hook_preserves_oci_stdin_output_and_original_exit_code(self):
        payload='{"pid":123,"bundle":"synthetic"}'
        command=[sys.executable,'-I','-B',str(HELPER),'--cdi-hook',str(self.base/'hook.lock'),
                 sys.executable,'-c','import sys;sys.stdout.write(sys.stdin.read());sys.exit(7)']
        result=subprocess.run(command,input=payload,capture_output=True,text=True,timeout=10)
        self.assertEqual(result.returncode,7,result.stderr);self.assertEqual(result.stdout,payload)

    def test_workspace_execution_passes_the_private_hook_spec_to_the_engine(self):
        graph=self.base/'graph';root=graph/'rootfs';root.mkdir(parents=True);(self.base/'tmp').mkdir()
        source=self.base/'trusted.json';source.write_text(json.dumps({'containerEdits':{'hooks':[
            {'path':'/usr/bin/nvidia-cdi-hook','args':['nvidia-cdi-hook','update-ldcache']}]}}))
        request={'engine':['/usr/bin/podman','--cdi-spec-dir='+str(self.base)],'graph':str(graph),
            'container':'fixture','hostUid':1000,'execution':'fixture-run','argv':['/bin/true'],
            'flags':['--device','nvidia.com/gpu=GPU-fixture'],'cdiSpec':str(source),
            'workspaceLock':str(self.base/'use-project.lock')}
        calls=[];read=Path.read_text
        def text(path,*args,**kwargs):
            return '0 1000 1\n' if str(path)=='/proc/self/uid_map' else read(path,*args,**kwargs)
        def run(command,**kwargs):
            return subprocess.CompletedProcess(command,0,'[{}]' if 'inspect' in command else str(root),'')
        def call(command,**kwargs):
            directory=Path(next(v.split('=',1)[1] for v in command if v.startswith('--cdi-spec-dir=')))
            hook=json.loads((directory/'nvidia.json').read_text())['containerEdits']['hooks'][0]
            self.assertEqual(hook['path'],sys.executable);self.assertIn('--cdi-hook',hook['args'])
            self.assertIn('nvidia.com/gpu=GPU-fixture',command);self.assertEqual(command[-1],str(root))
            calls.append(directory);return 0
        with patch.object(rootfs.os,'getuid',return_value=0),patch.object(Path,'read_text',text),\
             patch.object(rootfs.subprocess,'run',run),patch.object(rootfs.subprocess,'call',call):
            self.assertEqual(rootfs.execute_locked(request),0)
        self.assertEqual(len(calls),1);self.assertFalse(calls[0].exists())

    def test_concurrent_real_ldconfig_calls_update_one_cache_without_rename_failures(self):
        binary=shutil.which('ldconfig') or '/usr/sbin/ldconfig'
        if not Path(binary).is_file():self.skipTest('ldconfig unavailable on this host')
        config=self.base/'ld.so.conf';config.write_text('')
        graph=self.base/'graph';root=graph/'rootfs';root.mkdir(parents=True);(self.base/'tmp').mkdir()
        source=self.base/'nvidia.json';source.write_text(json.dumps({'containerEdits':{'hooks':[
            {'path':'/usr/bin/nvidia-cdi-hook','args':['nvidia-cdi-hook','update-ldcache']}]}}))
        request={'engine':['/usr/bin/podman','--cdi-spec-dir='+str(self.base)],'graph':str(graph),
            'container':'fixture','hostUid':1000,'execution':'fixture-run','argv':['/bin/true'],
            'flags':['--device','nvidia.com/gpu=GPU-fixture'],'cdiSpec':str(source),
            'workspaceLock':str(self.base/'use-project.lock')}
        results=[];read=Path.read_text
        def text(path,*args,**kwargs):
            return '0 1000 1\n' if str(path)=='/proc/self/uid_map' else read(path,*args,**kwargs)
        def run(command,**kwargs):
            return subprocess.CompletedProcess(command,0,'[{}]' if 'inspect' in command else str(root),'')
        def engine(command,**kwargs):
            directory=Path(next(v.split('=',1)[1] for v in command if v.startswith('--cdi-spec-dir=')))
            hook=json.loads((directory/'nvidia.json').read_text())['containerEdits']['hooks'][0]
            command=[hook['path'],*hook['args'][1:]]
            # Simulate just NVIDIA's external hook binary with real ldconfig;
            # the actual workspace entry, rendered CDI and hook proxy execute.
            index=command.index('/usr/bin/nvidia-cdi-hook')
            command[index:]=[binary,'-X','-C',str(self.base/'ld.so.cache'),'-f',str(config)]
            process=subprocess.Popen(command,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            out,err=process.communicate(timeout=20)
            result=subprocess.CompletedProcess(command,process.returncode,out,err);results.append(result)
            return process.returncode
        with patch.object(rootfs.os,'getuid',return_value=0),patch.object(Path,'read_text',text),\
             patch.object(rootfs.subprocess,'run',run),patch.object(rootfs.subprocess,'call',engine),\
             concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            codes=list(pool.map(lambda _:rootfs.execute_locked(request),range(32)))
        self.assertEqual(len(results),32)
        self.assertTrue(all(code==0 for code in codes),[(r.returncode,r.stderr) for r in results if r.returncode])
        self.assertGreater((self.base/'ld.so.cache').stat().st_size,0)


if __name__=='__main__':unittest.main()

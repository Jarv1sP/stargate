"""Execution cleanup never commits or removes the persistent carrier."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('workspace_rootfs',Path(__file__).parents[1]/'deploy/workspace-rootfs.py')
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)


class WorkspaceRootfs(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.graph=Path(self.tmp.name);self.root=self.graph/'rootfs';self.root.mkdir()
        self.request={'engine':['/usr/bin/podman'],'hostUid':1000,'container':'carrier',
                      'owner':'test-owner','project':'example','graph':str(self.graph),
                      'execution':'execution','flags':['--pull=never','--env','HOME=/home/gpuq'],
                      'argv':['/bin/sh','-c','exit 7']}
        self.labels={'io.gpuq.owner':'test-owner','io.gpuq.project':'example'}
        self.calls=[]

    def command(self,argv,**kwargs):
        self.calls.append(argv)
        if 'inspect' in argv:
            value=json.dumps([{'Config':{'Labels':self.labels,'Env':['PATH=/opt/bin']}}])
        elif 'mount' in argv:value=str(self.root)
        else:value=''
        return subprocess.CompletedProcess(argv,0,value,'')

    def invoke(self,child):
        with patch.object(module.os,'getuid',return_value=0), \
                patch.object(module.Path,'read_text',return_value='0 1000 1\n'), \
                patch.object(module.subprocess,'run',side_effect=self.command), \
                patch.object(module.subprocess,'call',child):
            return module.execute(self.request)

    def test_exit_status_environment_and_original_rootfs_are_preserved(self):
        from unittest.mock import Mock
        child=Mock(return_value=7)
        self.assertEqual(self.invoke(child),7)
        argv=child.call_args.args[0]
        self.assertIn(str(self.root),argv);self.assertIn('PATH=/opt/bin',argv)
        self.assertIn('HOME=/home/gpuq',argv);self.assertNotIn('--pull=never',argv)
        self.assertEqual(self.calls[-1],['/usr/bin/podman','unmount','carrier'])
        self.assertFalse(any('commit' in call or 'rm' in call for call in self.calls))

    def test_invalid_root_after_mount_still_releases_own_mount_reference(self):
        from unittest.mock import Mock
        self.request['graph']=str(self.root)
        child=Mock()
        with self.assertRaisesRegex(ValueError,'outside'):self.invoke(child)
        child.assert_not_called()
        self.assertEqual(self.calls[-1],['/usr/bin/podman','unmount','carrier'])

    def test_spawn_failure_releases_mount_without_deleting_carrier(self):
        from unittest.mock import Mock
        with self.assertRaisesRegex(OSError,'spawn failed'):
            self.invoke(Mock(side_effect=OSError('spawn failed')))
        self.assertEqual(self.calls[-1],['/usr/bin/podman','unmount','carrier'])

    def test_wrong_owner_cannot_mount_or_execute(self):
        from unittest.mock import Mock
        self.labels['io.gpuq.owner']='another-owner';child=Mock()
        with self.assertRaisesRegex(ValueError,'ownership'):self.invoke(child)
        child.assert_not_called();self.assertEqual(len(self.calls),1)


if __name__=='__main__':unittest.main()

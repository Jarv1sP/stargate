"""A reboot discards only Podman's volatile state, never project storage."""
import importlib.util,os,unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

spec=importlib.util.spec_from_file_location('directory_fixture',Path(__file__).with_name('node-friction.test.py'))
f=importlib.util.module_from_spec(spec);spec.loader.exec_module(f)


class OCIReboot(unittest.TestCase):
    setUp=f.DirectoryContract.setUp

    def engine(self,owner='alice'):
        self.config['personalOci']={'baseImage':'example.invalid/test:latest'}
        return f.module('personal-oci').PersonalOCI(self.config,owner)

    def stale_runtime(self,engine):
        (engine.folder/'tmp/alive').write_text('00000000-0000-0000-0000-000000000000\n')
        for name in ('run','tmp'):
            (engine.folder/name/'stale').write_bytes(b'previous boot')

    def test_reboot_recovers_runtime_and_preserves_existing_container_and_files(self):
        engine=self.engine();store=engine.s.ProjectStore(engine.root,config=self.config)
        store.create('alice','demo')
        head={'image':'existing-image','container':'existing-container'}
        engine.s.atomic_json(engine.state_path('demo'),head)
        files=[engine.folder/'graph/container-layer',engine.folder/'home/dependency',
               store.dev_paths('alice','demo')['code']/'train.py',Path(self.config['datasetsRoot'])/'input']
        for file in files:file.write_bytes(b'keep original bytes')
        before=[file.stat().st_ino for file in files]
        self.stale_runtime(engine)

        recovered=self.engine()

        for name in ('run','tmp'):
            self.assertTrue((recovered.folder/name).is_dir())
            self.assertFalse((recovered.folder/name/'stale').exists())
        self.assertFalse((recovered.folder/'tmp/alive').exists())
        self.assertEqual(recovered.load('demo'),head)
        self.assertEqual([file.read_bytes() for file in files],[b'keep original bytes']*4)
        self.assertEqual([file.stat().st_ino for file in files],before)

    def test_same_boot_empty_or_missing_alive_keeps_current_runtime(self):
        engine=self.engine();alive=engine.folder/'tmp/alive'
        for cached in (Path('/proc/sys/kernel/random/boot_id').read_bytes(),b'',None):
            with self.subTest(cached=cached):
                if cached is None:alive.unlink(missing_ok=True)
                else:alive.write_bytes(cached)
                marker=engine.folder/'run/current';marker.write_bytes(b'active runtime')
                before=marker.stat().st_ino
                self.engine()
                self.assertEqual(marker.read_bytes(),b'active runtime')
                self.assertEqual(marker.stat().st_ino,before)

    def test_recovery_is_account_local_and_concurrent_initialization_completes(self):
        engine=self.engine();other=self.engine('bob')
        marker=other.folder/'tmp/current';marker.write_bytes(b'other account')
        self.stale_runtime(engine)
        with ThreadPoolExecutor(max_workers=8) as workers:
            engines=list(workers.map(lambda _:self.engine(),range(16)))
        self.assertEqual(len(engines),16)
        self.assertFalse((engine.folder/'tmp/stale').exists())
        self.assertEqual(marker.read_bytes(),b'other account')
        current=engine.folder/'run/current';current.write_bytes(b'new runtime')
        (engine.folder/'tmp/alive').write_bytes(Path('/proc/sys/kernel/random/boot_id').read_bytes())
        self.engine()
        self.assertEqual(current.read_bytes(),b'new runtime')


if __name__=='__main__':unittest.main()

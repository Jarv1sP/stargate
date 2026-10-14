"""Offline release packaging contracts, with only synthetic config and files."""
import ast
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('node_release_builder', ROOT / 'scripts/build-node-release.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


class NodeReleaseBuild(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'repo'
        self.root.mkdir()
        self.output = self.root.parent / 'packages'
        files = {'node/core-entry.py': b'# shared entry\n', 'node/core-service.py': b'# shared service\n',
                 'node/runtime-profile.py': b'# profile selection\n', 'node/gpuq-ray': b'#!/usr/bin/python3\n',
                 'node/node-config.json': b'{"private":"do-not-copy"}', 'node/state.db': b'private database',
                 'node/key.pem': b'private fixture', 'node/ignored.py': b'# untracked\n',
                 'node/__pycache__/private.py': b'# tracked cache entry\n',
                 'gpuq/__main__.py': b'print("synthetic scheduler")\n',
                 'gpuq/gpuq/__init__.py': b'', 'gpuq/gpuq/unused.pyc': b'cache',
                 'gpuq/config.json': b'{"private":true}'}
        for name, data in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        (self.root / 'node/gpuq-ray').chmod(0o755)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        subprocess.run(['git', '-C', str(self.root), 'reset', '-q', '--', 'node/ignored.py'], check=True)
        subprocess.run(['git', '-C', str(self.root), '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
                        '-c', 'commit.gpgsign=false', 'commit', '-qm', 'synthetic sources'], check=True)

    def manifest(self, machine='node-a'):
        return json.loads((self.output / machine / 'manifest.json').read_text())

    def test_four_packages_share_exact_source_bytes_and_pyz(self):
        machines = ['node-a', 'node-b', 'node-c', 'node-d']
        summary = builder.build(self.root, self.output, machines)
        manifests = [self.manifest(machine) for machine in machines]
        self.assertEqual(summary['nodeFiles'], 4)
        self.assertEqual(summary['gpuqMembers'], 2)
        for manifest in manifests:
            self.assertFalse(manifest['sourceDirty'])
            self.assertEqual(manifest['sourceSHA256'], summary['sourceSHA256'])
            self.assertEqual(manifest['nodeFiles'], manifests[0]['nodeFiles'])
            self.assertEqual(manifest['gpuq'], manifests[0]['gpuq'])
            release = self.output / manifest['machine']
            for name, sha in manifest['nodeFiles'].items():
                self.assertEqual(hashlib.sha256((release / name).read_bytes()).hexdigest(), sha)
                self.assertEqual(stat.S_IMODE((release / name).stat().st_mode) & 0o222, 0)
            with zipfile.ZipFile(release / 'gpuq.pyz') as archive:
                self.assertEqual(set(archive.namelist()), {'__main__.py', 'gpuq/__init__.py'})
                for name, sha in manifest['gpuq']['members'].items():
                    self.assertEqual(hashlib.sha256(archive.read(name)).hexdigest(), sha)
        self.assertEqual((self.output / 'node-a/gpuq.pyz').read_bytes(), (self.output / 'node-d/gpuq.pyz').read_bytes())

    def test_private_config_and_generated_files_are_excluded(self):
        builder.build(self.root, self.output, ['node-a'])
        names = {str(path.relative_to(self.output / 'node-a')) for path in (self.output / 'node-a').rglob('*') if path.is_file()}
        self.assertNotIn('node/ignored.py', names)
        self.assertFalse(any('__pycache__' in name or name.endswith(('.pyc', '.pem', '.db')) for name in names))
        self.assertNotIn('node/node-config.json', names)
        self.assertFalse(any(path.name == 'node-config.json' for path in (self.output / 'node-a').rglob('*')))
        for profile in builder.PROFILES:
            template = self.output / 'node-a/profiles' / profile / 'node-config.template.json'
            value = json.loads(template.read_text())
            self.assertEqual(value['machine'], 'node-a')
            for key in ['root', 'database', 'gpu', 'memoryPool', 'datasetsRoot', 'workspacesRoot', 'transferPeers']:
                self.assertIsNone(value[key])
            self.assertEqual(stat.S_IMODE(template.stat().st_mode), 0o600)

    def test_profiles_are_unwired_with_fixed_commands_and_rollback_placeholders(self):
        builder.build(self.root, self.output, ['node-a'])
        manifest = self.manifest()
        self.assertEqual(manifest['stage'], 'templates-only')
        self.assertEqual(manifest['scopeReview'], 'pending')
        self.assertEqual(set(manifest['profiles']), set(builder.PROFILES))
        self.assertEqual(manifest['rollback'], dict(releaseDirectory=None, gpuqArchive=None,
                                                  profileEntries={name: None for name in builder.PROFILES}))
        entry_spec = importlib.util.spec_from_file_location('offline_core_entry', ROOT / 'node/core-entry.py')
        entry = importlib.util.module_from_spec(entry_spec)
        entry_spec.loader.exec_module(entry)
        self.assertEqual(set(builder.PROFILES), set(entry.runtime.PROFILES))
        service_tree = ast.parse((ROOT / 'node/core-service.py').read_text())
        allowed = next(ast.literal_eval(node) for node in ast.walk(service_tree) if isinstance(node, ast.Set))
        service_pairs = set()
        for name, profile in manifest['profiles'].items():
            self.assertEqual(profile['binding'], 'not-wired')
            self.assertIsNone(profile['privateConfig']['sha256'])
            self.assertIsNone(profile['privateConfig']['summary'])
            if name == 'peer':
                self.assertIsNone(profile['entryCommand'])
            else:
                command = profile['entryCommand']
                self.assertEqual(command[:3], ['/usr/bin/python3', '-I', '-B'])
                self.assertEqual(entry.fixed_arguments(['core-entry.py', *command[4:]]), (name, None))
            for command in profile['serviceCommands']:
                service_pairs.add((name, command[-1]))
        self.assertEqual(service_pairs, allowed)

    def test_build_is_reproducible_without_output_overwrite(self):
        builder.build(self.root, self.output, ['node-a'])
        second = self.root.parent / 'second'
        builder.build(self.root, second, ['node-a'])
        for path in (self.output / 'node-a').rglob('*'):
            if path.is_file():
                self.assertEqual(path.read_bytes(), (second / path.relative_to(self.output)).read_bytes())
        with self.assertRaisesRegex(ValueError, 'already exists'):
            builder.build(self.root, self.output, ['node-a'])

    def test_machine_path_escape_and_duplicate_ids_are_rejected(self):
        for machines in [[], ['../escape'], ['/absolute'], ['node-a', 'node-a']]:
            with self.subTest(machines=machines), self.assertRaises(ValueError):
                builder.build(self.root, self.output, machines)
        self.assertFalse(self.output.exists())

    def test_tracked_symlink_is_not_followed(self):
        (self.root / 'node/core-entry.py').unlink()
        (self.root / 'node/core-entry.py').symlink_to(self.root / 'node/key.pem')
        with self.assertRaisesRegex(ValueError, 'regular file'):
            builder.build(self.root, self.output, ['node-a'])
        self.assertFalse(self.output.exists())

    def test_archive_matches_existing_build_gpuq_format(self):
        payload = builder.sources(self.root)
        reference = io.BytesIO()
        with zipfile.ZipFile(reference, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for path in sorted((self.root / 'gpuq').rglob('*.py')):
                info = zipfile.ZipInfo(str(path.relative_to(self.root / 'gpuq')), (2026, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(info, path.read_bytes())
        self.assertEqual(builder.gpuq_archive(payload), reference.getvalue())


if __name__ == '__main__':
    unittest.main()

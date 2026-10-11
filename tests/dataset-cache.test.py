"""Local-only dataset cache acceptance/security tests; no nodes, GPUs or credentials."""
import base64
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from storage_test_helpers import local_data_mounts
from dataset_retention_helpers import protected_original


MODULE_PATH = Path(__file__).resolve().parents[1] / "deploy" / "dataset-cache.py"
SPEC = importlib.util.spec_from_file_location("dataset_cache_test", MODULE_PATH)
cache_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cache_module)
D = cache_module
ADMIN = D.Principal("test-admin", True)
OWNER = D.Principal("demo-user-1")
OTHER = D.Principal("demo-user-2")


class DatasetCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.base = Path(self.temp.name).resolve()
        self.source = self.base / "approved-small-source"
        self.source.mkdir()
        (self.source / "images").mkdir()
        (self.source / "empty-directory").mkdir()
        (self.source / "images" / "样本.bin").write_bytes(b"hello-world")
        (self.source / "labels.txt").write_bytes(b"cat\ndog\n")
        (self.source / "empty").write_bytes(b"")
        self.root = self.base / "cache"
        self.cache = D.DatasetCache(self.root, sources={"sample-source": self.source}, reserve_bytes=1024)
        self.original = protected_original(self.cache, D, self.base/'protected-original')

    def tearDown(self):
        # Published data is deliberately read-only; make only this test's sandbox
        # writable for TemporaryDirectory cleanup, never any real host directory.
        for root, dirs, files in os.walk(self.base, followlinks=False):
            os.chmod(root, 0o700)
            for name in files:
                path = Path(root) / name
                if not path.is_symlink() and path.is_file():
                    os.chmod(path, 0o600)
        self.temp.cleanup()

    def register(self, dataset="sample", owners=None):
        return self.cache.register_source(ADMIN, dataset, "sample-source", owners or [OWNER.user_id])["version"]

    def stage(self, version):
        return self.root / ".staging" / "sample" / version

    def ready(self, version):
        return self.root / "ready" / "sample" / version

    def fill(self, version, actor=OWNER):
        plan = self.cache.plan(actor, "sample", version)
        for entry in plan["files"]:
            content = (self.source / entry["path"]).read_bytes()
            self.cache.put_chunk(actor, "sample", version, entry["path"], entry["offset"], content[entry["offset"]:], plan["token"])
        return plan["token"]

    def publish(self, version):
        token = self.fill(version)
        return self.cache.publish(OWNER, "sample", version, token)

    def test_registration_is_content_addressed_and_private(self):
        version = self.register()
        self.assertRegex(version, r"^[a-f0-9]{64}$")
        self.assertEqual(self.register(), version)
        exported = self.cache.export_manifest(OWNER, "sample", version)
        self.assertEqual(D._version(exported["manifest"]), version)
        self.assertEqual(exported["manifest"]["directories"], ["empty-directory", "images"])
        self.assertNotIn(str(self.source), json.dumps(exported))
        self.assertFalse(self.ready(version).exists())
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        (self.source / "labels.txt").write_bytes(b"a changed version")
        self.assertNotEqual(self.register(), version)

    def test_admin_approves_sources_members_cannot_register_paths(self):
        with self.assertRaises(PermissionError):
            self.cache.register_source(OWNER, "sample", "sample-source", [OWNER.user_id])
        with self.assertRaises(PermissionError):
            self.cache.register_source(ADMIN, "sample", "unapproved", [OWNER.user_id])
        with self.assertRaises(PermissionError):
            self.cache.dispatch(OWNER, {"op": "register_source", "dataset": "sample", "sourceId": str(self.source), "owners": [OWNER.user_id]})
        for source in ["/", "/data2", "/etc/secrets", str(self.root), str(self.root / "child")]:
            with self.subTest(source=source), self.assertRaises(D.CacheError):
                D.DatasetCache(self.root, sources={"source": source})

    def test_owner_authorization_applies_to_every_operation(self):
        version = self.register()
        token = self.fill(version)
        checks = [
            lambda: self.cache.export_manifest(OTHER, "sample", version),
            lambda: self.cache.plan(OTHER, "sample", version),
            lambda: self.cache.prepare(OTHER, "sample", version),
            lambda: self.cache.put_chunk(OTHER, "sample", version, "labels.txt", 0, b"cat", token),
            lambda: self.cache.publish(OTHER, "sample", version, token),
            lambda: self.cache.acquire_lease(OTHER, "sample", version, "job-1"),
            lambda: self.cache.set_owners(OWNER, "sample", [OTHER.user_id]),
            lambda: self.cache.prepare_transfer(OWNER, "sample", version),
            lambda: self.cache.evict(OWNER, "sample", version),
        ]
        for check in checks:
            with self.assertRaises(PermissionError):
                check()
        self.assertEqual(self.cache.list_datasets(OTHER), {"datasets": []})
        self.publish(version)
        with self.assertRaises(PermissionError):
            self.cache.read_chunk(OTHER, "sample", version, "labels.txt")
        with self.assertRaises(PermissionError):
            self.cache.verify(OTHER, "sample", version)

    def test_list_and_prepare_never_reveal_source_path(self):
        version = self.register()
        catalog = self.cache.dispatch(OWNER, {"op": "list"})
        self.assertEqual(catalog["datasets"][0]["versions"][0]["state"], "REGISTERED")
        self.assertNotIn("source", json.dumps(catalog))
        result = self.cache.dispatch(OWNER, {"op": "prepare", "dataset": "sample", "version": version})
        self.assertEqual(result["state"], "READY")
        self.assertNotIn(str(self.source), json.dumps(result))
        self.assertEqual(self.cache.list_datasets(OWNER)["datasets"][0]["versions"][0]["state"], "READY")

    def test_list_owners_only_after_authorization_without_changing_identity(self):
        version = self.register(owners=[OTHER.user_id, OWNER.user_id, OWNER.user_id])
        self.register("private-other", owners=["private-owner"])
        metadata = self.root / ".registry" / "sample" / "dataset.json"
        before = metadata.read_bytes()
        listing = self.cache.list_datasets(OWNER)
        self.assertEqual([item["dataset"] for item in listing["datasets"]], ["sample"])
        self.assertEqual(listing["datasets"][0]["ownerIds"], [OWNER.user_id, OTHER.user_id])
        self.assertEqual(listing["datasets"][0]["versions"][0]["version"], version)
        for forbidden in ("private-other", "private-owner", "sample-source", str(self.source)):
            self.assertNotIn(forbidden, json.dumps(listing))
        self.assertEqual(metadata.read_bytes(), before)
        self.assertEqual(len(self.cache.list_datasets(ADMIN)["datasets"]), 2)

    def test_list_owner_display_bound_does_not_truncate_or_restrict_acl(self):
        owners = [OWNER.user_id] + [f"reader-{i}" for i in range(63)]
        version = self.register(owners=owners)
        self.assertEqual(len(self.cache.list_datasets(OWNER)["datasets"][0]["ownerIds"]), 64)
        self.cache.set_owners(ADMIN, "sample", owners + [OTHER.user_id])
        self.assertIsNone(self.cache.list_datasets(OTHER)["datasets"][0]["ownerIds"])
        self.assertEqual(self.cache.export_manifest(OTHER, "sample", version)["version"], version)

    def test_resume_plan_and_idempotent_chunks(self):
        version = self.register()
        plan = self.cache.plan(OWNER, "sample", version)
        self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 0, b"cat\n", plan["token"])
        result = self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 0, b"cat\n", plan["token"])
        self.assertEqual(result["offset"], 4)
        reopened = D.DatasetCache(self.root, sources={"sample-source": self.source}, reserve_bytes=1024)
        resumed = reopened.plan(OWNER, "sample", version)
        entry = next(f for f in resumed["files"] if f["path"] == "labels.txt")
        self.assertEqual(entry["offset"], 4)
        self.assertEqual(entry["prefixSha256"], hashlib.sha256(b"cat\n").hexdigest())
        self.assertEqual(plan["token"], resumed["token"])
        with self.assertRaises(D.CacheError):
            self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 0, b"BAD!", plan["token"])
        with self.assertRaises(D.CacheError):
            self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 2, b"more", plan["token"])
        with self.assertRaises(PermissionError):
            self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 4, b"dog\n", "bad-token")
        self.assertEqual(self.cache.materialize(OWNER, "sample", version)["state"], "READY")

    def test_atomic_publish_readonly_and_idempotence(self):
        version = self.register()
        token = self.fill(version)
        real_rename = D._rename_new
        observed = []
        def checked_rename(source, destination):
            self.assertFalse(destination.exists())
            self.assertTrue((source / "READY.json").is_file())
            self.assertTrue((source / "data" / "empty-directory").is_dir())
            self.assertEqual((source / "data" / "labels.txt").stat().st_mode & 0o777, 0o444)
            self.assertEqual(source.stat().st_dev, destination.parent.stat().st_dev)
            observed.append(True)
            return real_rename(source, destination)
        with patch.object(D, "_rename_new", side_effect=checked_rename):
            self.cache.publish(OWNER, "sample", version, token)
        self.assertEqual(observed, [True])
        self.assertFalse(self.stage(version).exists())
        self.assertFalse((self.ready(version) / "TRANSFER.json").exists())
        for root, dirs, files in os.walk(self.ready(version)):
            self.assertEqual(Path(root).stat().st_mode & 0o777, 0o555)
            for name in files:
                self.assertEqual((Path(root) / name).stat().st_mode & 0o777, 0o444)
        self.assertTrue(self.cache.verify(OWNER, "sample", version)["verified"])
        self.assertEqual(self.cache.publish(OWNER, "sample", version, token)["state"], "READY")
        with self.assertRaises(D.CacheError):
            self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 0, b"x", token)

    def test_incomplete_and_wrong_checksum_never_ready(self):
        version = self.register()
        plan = self.cache.plan(OWNER, "sample", version)
        with self.assertRaises(D.CacheError):
            self.cache.publish(OWNER, "sample", version, plan["token"])
        with self.assertRaises(D.CacheError):
            self.cache.acquire_lease(OWNER, "sample", version, "job-1")
        self.assertFalse(self.ready(version).exists())
        self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 0, b"xxxxxxxx", plan["token"])
        with self.assertRaises(D.CacheError):
            self.cache.publish(OWNER, "sample", version, plan["token"])
        with self.assertRaises(D.CacheError):
            self.cache.plan(OWNER, "sample", version)
        self.assertFalse(self.ready(version).exists())

    def test_staging_marker_is_not_readiness_and_rename_failure_resumes(self):
        version = self.register()
        token = self.fill(version)
        with patch.object(D, "_rename_new", side_effect=OSError("simulated publication failure")):
            with self.assertRaises(OSError):
                self.cache.publish(OWNER, "sample", version, token)
        self.assertTrue((self.stage(version) / "READY.json").exists())
        self.assertFalse(self.ready(version).exists())
        with self.assertRaises(D.CacheError):
            self.cache.acquire_lease(OWNER, "sample", version, "job-1")
        self.assertEqual(self.cache.plan(OWNER, "sample", version)["state"], "STAGING")
        self.cache.publish(OWNER, "sample", version, token)

    def test_published_destination_cannot_be_overwritten(self):
        first, second = self.base / "first", self.base / "second"
        first.mkdir()
        second.mkdir()
        (second / "preserve").write_bytes(b"keep")
        with self.assertRaises(OSError):
            D._rename_new(first, second)
        self.assertTrue(first.exists())
        self.assertEqual((second / "preserve").read_bytes(), b"keep")

    def test_low_space_fails_before_staging_or_writing(self):
        version = self.register()
        low = SimpleNamespace(f_bavail=0, f_frsize=4096)
        with patch.object(D.os, "fstatvfs", return_value=low), self.assertRaises(D.CacheError):
            self.cache.plan(OWNER, "sample", version)
        self.assertFalse(self.stage(version).exists())
        plan = self.cache.plan(OWNER, "sample", version)
        self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 0, b"cat\n", plan["token"])
        with patch.object(D.os, "fstatvfs", return_value=low), self.assertRaises(D.CacheError):
            self.cache.put_chunk(OWNER, "sample", version, "labels.txt", 4, b"dog\n", plan["token"])
        self.assertEqual((self.stage(version) / "data" / "labels.txt").read_bytes(), b"cat\n")
        self.fill(version)
        with patch.object(D.os, "fstatvfs", return_value=low), self.assertRaises(D.CacheError):
            self.cache.publish(OWNER, "sample", version, plan["token"])
        self.assertFalse(self.ready(version).exists())

    def test_space_reservations_cover_other_planned_transfers(self):
        manifest = {"schema": 1, "directories": [], "files": [{"path": "big", "size": 50000, "sha256": "a" * 64}]}
        for name in ("one", "two"):
            self.cache.register_manifest(ADMIN, name, manifest, [OWNER.user_id])
        version = D._version(manifest)
        available = SimpleNamespace(f_bavail=70000, f_frsize=1)
        with patch.object(D.os, "fstatvfs", return_value=available):
            self.cache.plan(OWNER, "one", version)
            with self.assertRaises(D.CacheError):
                self.cache.plan(OWNER, "two", version)

    def test_crash_accounting_recovers_without_replacing_data(self):
        version = self.register()
        plan = self.cache.plan(OWNER, "sample", version)
        (self.stage(version) / "data" / "labels.txt").write_bytes(b"cat\n")
        before = D._read_json(self.stage(version) / "TRANSFER.json")["remainingBytes"]
        reopened = self.cache.plan(OWNER, "sample", version)
        self.assertEqual(reopened["remainingBytes"], before - 4)
        self.assertEqual(reopened["token"], plan["token"])

    def test_local_source_changes_are_not_silently_published(self):
        version = self.register()
        (self.source / "labels.txt").write_bytes(b"changed")
        with self.assertRaises(D.CacheError):
            self.cache.materialize(OWNER, "sample", version)
        self.assertFalse(self.ready(version).exists())

    def test_cross_node_manifest_chunk_roundtrip_and_privileged_rsync_target(self):
        version = self.register()
        self.cache.materialize(OWNER, "sample", version)
        replica = D.DatasetCache(self.base / "replica", reserve_bytes=1024)
        exported = self.cache.export_manifest(OWNER, "sample", version)
        registered = replica.register_manifest(ADMIN, "sample", exported["manifest"], [OWNER.user_id])
        self.assertEqual(registered["version"], version)
        prepared = replica.prepare_transfer(ADMIN, "sample", version)
        self.assertEqual(Path(prepared["stagingPath"]).parent.parent.parent.parent, replica.root)
        self.assertNotIn(str(self.source), json.dumps(prepared))
        # A trusted rsync transport would write this target and exit. This test
        # uses only the bounded chunk interface, with the administrator transfer owner.
        for entry in prepared["files"]:
            result = self.cache.read_chunk(OWNER, "sample", version, entry["path"])
            replica.put_chunk(ADMIN, "sample", version, entry["path"], 0, base64.b64decode(result["data"]), prepared["token"])
        replica.publish(ADMIN, "sample", version, prepared["token"])
        self.assertTrue(replica.verify(OWNER, "sample", version)["verified"])

    def test_leases_are_persistent_and_never_expire_implicitly(self):
        version = self.register()
        self.publish(version)
        lease = self.cache.acquire_lease(OWNER, "sample", version, "job-1")
        self.assertTrue(lease["readOnly"])
        self.assertEqual(lease["path"], str(self.ready(version) / "data"))
        self.assertEqual(lease, self.cache.acquire_lease(OWNER, "sample", version, "job-1"))
        reopened = D.DatasetCache(self.root, reserve_bytes=1024)
        protected_original(reopened, D, self.base/'reopened-original')
        with patch.object(D.time, "time", return_value=10**15), self.assertRaises(D.CacheError):
            reopened.evict(ADMIN, "sample", version)
        with self.assertRaises(PermissionError):
            reopened.release_lease(OWNER, "sample", version, lease["leaseId"])
        reopened.release_lease(ADMIN, "sample", version, lease["leaseId"])
        self.assertFalse(reopened.release_lease(ADMIN, "sample", version, lease["leaseId"])["released"])
        self.assertTrue(reopened.evict(ADMIN, "sample", version)["evicted"])
        self.assertFalse(self.ready(version).exists())
        self.assertEqual(reopened.export_manifest(OWNER, "sample", version)["version"], version)

    def test_existing_ready_read_lease_does_not_require_publication_headroom(self):
        version = self.register(); self.publish(version)
        before = (self.ready(version) / 'data').stat().st_ino
        with patch.object(self.cache, '_free', side_effect=AssertionError('publication space gate during read lease')), \
                patch.object(self.cache, '_reserved', side_effect=AssertionError('copy reservations during read lease')):
            lease = self.cache.acquire_lease(OWNER, 'sample', version, 'read-with-full-cache-budget')
            self.assertEqual(self.cache.acquire_lease(OWNER, 'sample', version, 'read-with-full-cache-budget'), lease)
        self.assertTrue(lease['readOnly'])
        self.assertEqual((self.ready(version) / 'data').stat().st_ino, before)
        self.assertEqual(len(self.cache._leases('sample', version)), 1)

    def test_read_lease_metadata_write_failure_is_not_reported_as_protected_read(self):
        version = self.register(); self.publish(version)
        original = D._write_json
        lease_folder = self.cache._paths('sample', version)['.leases']
        def fail_lease(path, value, *args, **kwargs):
            if Path(path).parent == lease_folder:
                raise OSError(28, 'fixture metadata volume full')
            return original(path, value, *args, **kwargs)
        with patch.object(D, '_write_json', side_effect=fail_lease):
            with self.assertRaises(OSError):
                self.cache.acquire_lease(OWNER, 'sample', version, 'metadata-full')
        self.assertEqual(self.cache._leases('sample', version), [])

    def test_protected_source_lease_checks_role_inside_the_final_lock(self):
        version = self.register(); self.publish(version)
        with self.cache._locked():
            tier = self.cache._tier('sample', version); tier['role'] = 'protected'
            self.cache._write_tier('sample', version, tier)
        original = self.cache._ready_snapshot
        def change_role(*args, **kwargs):
            result = original(*args, **kwargs)
            with self.cache._locked():
                tier = self.cache._tier('sample', version); tier['role'] = 'cache'
                self.cache._write_tier('sample', version, tier)
            return result
        with patch.object(self.cache, '_ready_snapshot', side_effect=change_role):
            with self.assertRaisesRegex(D.CacheError, 'protected original'):
                self.cache.acquire_lease(OWNER, 'sample', version, 'warehouse-job', require_protected=True)
        self.assertEqual(self.cache._leases('sample', version), [])
        self.assertTrue(self.cache.acquire_lease(OWNER, 'sample', version, 'cache-job')['readOnly'])

    def test_existing_data_leaser_is_narrow_idempotent_and_preserves_owner_acl(self):
        version = self.register(); self.publish(version)
        loader = importlib.util.spec_from_file_location('v2_data_leaser', Path(__file__).resolve().parents[1] / 'src/infrastructure/legacy-data-leaser.py')
        adapter = importlib.util.module_from_spec(loader); loader.loader.exec_module(adapter)
        leaser = adapter.LegacyDataLeaser(D, root=self.root, kind='cache')
        with patch.object(D.DatasetCache, 'materialize', side_effect=AssertionError('must not copy')):
            result = leaser.acquire(user_id=OWNER.user_id, job_id='job-1', dataset='sample', version=version, kind='cache')
            self.assertEqual(leaser.acquire(user_id=OWNER.user_id, job_id='job-1', dataset='sample', version=version, kind='cache'), result)
        self.assertNotIn(str(self.root), json.dumps(result))
        self.assertEqual(result['accountId'], OWNER.user_id)
        with self.assertRaises(PermissionError):
            leaser.acquire(user_id=OTHER.user_id, job_id='job-2', dataset='sample', version=version, kind='cache')
        with self.assertRaisesRegex(ValueError, 'configured kind'):
            leaser.acquire(user_id=OWNER.user_id, job_id='job-2', dataset='sample', version=version, kind='warehouse')
        self.assertEqual(len(self.cache._leases('sample', version)), 1)

    def test_warehouse_leaser_accepts_only_existing_protected_ready_data(self):
        version = self.register(); self.publish(version)
        with self.cache._locked():
            tier = self.cache._tier('sample', version); tier['role'] = 'protected'
            self.cache._write_tier('sample', version, tier)
        loader = importlib.util.spec_from_file_location('v2_warehouse_leaser', Path(__file__).resolve().parents[1] / 'src/infrastructure/legacy-data-leaser.py')
        adapter = importlib.util.module_from_spec(loader); loader.loader.exec_module(adapter)
        leaser = adapter.LegacyDataLeaser(D, root=self.root, kind='warehouse')
        result = leaser.acquire(user_id=OWNER.user_id, job_id='warehouse-job', dataset='sample', version=version, kind='warehouse')
        self.assertEqual(result['kind'], 'warehouse'); self.assertTrue(result['readOnly'])
        with self.cache._locked():
            tier = self.cache._tier('sample', version); tier['role'] = 'cache'
            self.cache._write_tier('sample', version, tier)
        with self.assertRaisesRegex(D.CacheError, 'protected original'):
            leaser.acquire(user_id=OWNER.user_id, job_id='warehouse-job-2', dataset='sample', version=version, kind='warehouse')
        self.assertEqual(len(self.cache._leases('sample', version)), 1)

    def test_revoking_owner_does_not_destroy_existing_lease(self):
        version = self.register()
        self.publish(version)
        lease = self.cache.acquire_lease(OWNER, "sample", version, "job-1")
        self.cache.set_owners(ADMIN, "sample", [OTHER.user_id])
        with self.assertRaises(PermissionError):
            self.cache.acquire_lease(OWNER, "sample", version, "job-2")
        with self.assertRaises(D.CacheError):
            self.cache.evict(ADMIN, "sample", version)
        self.cache.release_lease(ADMIN, "sample", version, lease["leaseId"])
        self.assertTrue(self.cache.verify(OTHER, "sample", version)["verified"])

    def test_corrupt_lease_and_ready_metadata_fail_closed(self):
        version = self.register()
        self.publish(version)
        lease = self.cache.acquire_lease(OWNER, "sample", version, "job-1")
        path = self.root / ".leases" / "sample" / version / (lease["leaseId"] + ".json")
        path.write_text("{broken")
        with self.assertRaises(D.CacheError):
            self.cache.evict(ADMIN, "sample", version)
        marker = self.ready(version) / "READY.json"
        marker.chmod(0o600)
        marker.write_text("{}")
        with self.assertRaises(D.CacheError):
            self.cache.acquire_lease(OWNER, "sample", version, "job-2")

    def test_source_symlinks_hardlinks_and_special_files_rejected(self):
        outside = self.base / "outside"
        outside.write_bytes(b"not registered")
        bad = self.source / "bad"
        bad.symlink_to(outside)
        with self.assertRaises(D.CacheError):
            self.register()
        bad.unlink()
        os.link(outside, bad)
        with self.assertRaises(D.CacheError):
            self.register()
        bad.unlink()
        os.mkfifo(bad)
        with self.assertRaises(D.CacheError):
            self.register()
        bad.unlink()
        link = self.base / "linked-source"
        link.symlink_to(self.source, target_is_directory=True)
        linked = D.DatasetCache(self.base / "linked-cache", sources={"s": link}, reserve_bytes=1024)
        with self.assertRaises(OSError):
            linked.register_source(ADMIN, "sample", "s", [OWNER.user_id])

    def test_staging_symlink_special_file_and_traversal_rejected(self):
        version = self.register()
        plan = self.cache.plan(OWNER, "sample", version)
        for path in ["../x", "/etc/passwd", "a/../b", "a//b", "a\\b", "", ".env"]:
            with self.subTest(path=path), self.assertRaises(D.CacheError):
                self.cache.put_chunk(OWNER, "sample", version, path, 0, b"x", plan["token"])
        (self.stage(version) / "data" / "images").symlink_to(self.source / "images", target_is_directory=True)
        with self.assertRaises(OSError):
            self.cache.put_chunk(OWNER, "sample", version, "images/样本.bin", 0, b"hello", plan["token"])
        with self.assertRaises((D.CacheError, OSError)):
            self.cache.publish(OWNER, "sample", version, plan["token"])
        self.assertEqual((self.source / "images" / "样本.bin").read_bytes(), b"hello-world")

    def test_manifest_validation_and_unauthorized_replica_registration(self):
        version = self.register()
        manifest = self.cache.export_manifest(OWNER, "sample", version)["manifest"]
        with self.assertRaises(PermissionError):
            self.cache.register_manifest(OWNER, "new", manifest, [OWNER.user_id])
        bad = [
            {**manifest, "shell": "anything"},
            {**manifest, "files": [{"path": "../outside", "size": 1, "sha256": "a" * 64}]},
            {**manifest, "files": [{"path": "file", "size": True, "sha256": "a" * 64}]},
            {**manifest, "files": [{"path": "file", "size": 1, "sha256": "not-a-hash"}]},
            {**manifest, "directories": []},
            {**manifest, "directories": ["images", "images"]},
        ]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(D.CacheError):
                self.cache.register_manifest(ADMIN, "new", value, [OWNER.user_id])

    def test_dispatch_rejects_commands_role_injection_and_invalid_chunks(self):
        version = self.register()
        token = self.cache.plan(OWNER, "sample", version)["token"]
        for request in [{"op": "exec", "command": "touch nope"},
                        {"op": "plan", "dataset": "sample", "version": version, "is_admin": True},
                        {"op": "prepare", "dataset": "sample", "version": version, "sourcePath": "/etc"}]:
            with self.assertRaises(D.CacheError):
                self.cache.dispatch(OWNER, request)
        request = {"op": "put_chunk", "dataset": "sample", "version": version, "path": "labels.txt", "offset": 0, "data": "~bad", "token": token}
        with self.assertRaises(D.CacheError):
            self.cache.dispatch(OWNER, request)
        with self.assertRaises(D.CacheError):
            self.cache.dispatch(OWNER, {**request, "data": base64.b64encode(b"x" * (D.CHUNK_BYTES + 1)).decode()})
        with self.assertRaises(D.CacheError):
            self.cache.plan({"user_id": OWNER.user_id, "is_admin": True}, "sample", version)

    def test_privileged_cli_json_contract_without_real_config(self):
        # Config/host mount table are simulated; cache work uses real temp files.
        config = {"root": str(self.root), "mountPoint": str(self.base), "sources": {"sample-source": str(self.source)}, "reserveBytes": 1024}
        request = {"op": "register_source", "dataset": "sample", "sourceId": "sample-source", "owners": [OWNER.user_id]}
        output = io.StringIO()
        stdin = SimpleNamespace(buffer=io.BytesIO(json.dumps(request).encode()))
        with local_data_mounts(self.base), patch.object(D, "_operator_config", return_value=config), patch.object(D.sys, "stdin", stdin), patch.object(D.sys, "stdout", output):
            self.assertEqual(D.main(["--config", str(self.base / "unused-config")]), 0)
        result = json.loads(output.getvalue())
        self.assertTrue(result["ok"])
        self.assertEqual(result["result"]["version"], self.register())
        with patch.object(D.os, "geteuid", return_value=1000), self.assertRaises(PermissionError):
            D._operator_config("/not/read/by/non-root")
        command = subprocess.run([sys.executable, str(MODULE_PATH), "--help"], capture_output=True, text=True, check=True)
        self.assertIn("/data2/datasets", command.stdout)

    def test_trusted_manifest_can_attach_source_without_rescanning(self):
        version = self.register()
        manifest = self.cache.export_manifest(OWNER, "sample", version)["manifest"]
        replica = D.DatasetCache(self.base / "attached", sources={"lan-source": self.source}, reserve_bytes=1024)
        replica.register_manifest(ADMIN, "sample", manifest, [OWNER.user_id])
        with patch.object(D, "_scan", side_effect=AssertionError("must not rescan source")):
            replica.attach_source(ADMIN, "sample", version, "lan-source")
        with self.assertRaises(PermissionError):
            replica.attach_source(OWNER, "sample", version, "lan-source")
        with self.assertRaises(PermissionError):
            replica.attach_source(ADMIN, "sample", version, "unapproved")
        original_scan = D._scan
        scanned = []
        def record_scan(path):
            scanned.append(Path(path))
            return original_scan(path)
        with patch.object(D, "_scan", side_effect=record_scan):
            self.assertEqual(replica.prepare(OWNER, "sample", version)["state"], "READY")
        self.assertEqual(scanned, [replica.root / ".staging" / "sample" / version / "data"])

    def test_existing_ready_version_does_not_require_original_source(self):
        version = self.register()
        self.cache.materialize(OWNER, "sample", version)
        shutil.rmtree(self.source)
        with patch.object(D, "_scan", side_effect=AssertionError("must use immutable replica")):
            self.assertEqual(self.cache.materialize(OWNER, "sample", version)["state"], "READY")

    def test_status_has_no_data_hash_or_staging_side_effect(self):
        version = self.register()
        with patch.object(D, "_scan", side_effect=AssertionError("status must not scan")), patch.object(D, "_digest_fd", side_effect=AssertionError("status must not hash")):
            self.assertEqual(self.cache.status(OWNER, "sample", version)["state"], "REGISTERED")
            self.assertFalse(self.stage(version).exists())
        self.cache.plan(OWNER, "sample", version)
        before = (self.stage(version) / "TRANSFER.json").stat().st_mtime_ns
        with patch.object(D, "_scan", side_effect=AssertionError("status must not scan")), patch.object(D, "_digest_fd", side_effect=AssertionError("status must not hash")):
            self.assertEqual(self.cache.dispatch(OWNER, {"op": "status", "dataset": "sample", "version": version})["state"], "STAGING")
        self.assertEqual((self.stage(version) / "TRANSFER.json").stat().st_mtime_ns, before)

    def existing_reader(self, root=None, kind='cache', lock_timeout=2.0, coordinator_version=None):
        spec = importlib.util.spec_from_file_location('v2_legacy_cache_reader',
            MODULE_PATH.parents[1] / 'src' / 'infrastructure' / 'legacy-cache-reader.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module.LegacyCacheReader(D, root=root or self.root, kind=kind, lock_timeout=lock_timeout,
                                       coordinator_version=coordinator_version)

    def test_existing_reader_never_creates_root_or_repairs_missing_layout(self):
        absent = self.base / 'not-initialized'
        with self.assertRaises(FileNotFoundError):
            self.existing_reader(absent)
        self.assertFalse(absent.exists())
        (self.root / '.reopens').rmdir()
        with self.assertRaises(FileNotFoundError):
            self.existing_reader()
        self.assertFalse((self.root / '.reopens').exists())

    def test_existing_reader_uses_read_only_opens_without_scans_quota_or_preparation(self):
        version = self.register()
        self.cache.materialize(OWNER, 'sample', version)
        before = {str(path.relative_to(self.root)): (path.stat().st_ino, path.stat().st_mtime_ns, path.stat().st_size)
                  for path in self.root.rglob('*')}
        # Load adapter code before auditing dataset I/O, independent of pyc state.
        reader_type = type(self.existing_reader())
        original_open = os.open

        def read_only_open(path, flags, *args, **kwargs):
            self.assertFalse(flags & (os.O_CREAT | os.O_WRONLY | os.O_RDWR | os.O_TRUNC), str(path))
            return original_open(path, flags, *args, **kwargs)

        with patch.object(D.os, 'open', side_effect=read_only_open), \
                patch.object(D, '_mkdir', side_effect=AssertionError('must not initialize')), \
                patch.object(D, '_scan', side_effect=AssertionError('must not scan data')), \
                patch.object(D.DatasetCache, '_free', side_effect=AssertionError('must not check free space')), \
                patch.object(D.DatasetCache, 'plan', side_effect=AssertionError('must not prepare')):
            reader = reader_type(D, root=self.root, kind='cache')
            self.assertEqual(reader.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache'),
                             dict(dataset='sample', version=version, kind='cache', availability='available'))
            exported = reader.export_access(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')
            self.assertEqual(exported['legacyOwners'], [OWNER.user_id])
            self.assertEqual(len(exported['snapshotId']), 64)
        after = {str(path.relative_to(self.root)): (path.stat().st_ino, path.stat().st_mtime_ns, path.stat().st_size)
                 for path in self.root.rglob('*')}
        self.assertEqual(after, before)

    def test_existing_reader_missing_lock_is_not_created_by_observation(self):
        version = self.register()
        (self.root / '.lock').unlink()
        reader = self.existing_reader()
        with self.assertRaises(FileNotFoundError):
            reader.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')
        self.assertFalse((self.root / '.lock').exists())

    def test_existing_reader_checks_owner_readiness_and_protected_warehouse_tier(self):
        version = self.register()
        reader = self.existing_reader()
        self.assertEqual(reader.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')['availability'], 'unavailable')
        with self.assertRaises(PermissionError):
            reader.inspect(user_id=OTHER.user_id, dataset='sample', version=version, kind='cache')
        self.cache.materialize(OWNER, 'sample', version)
        with self.cache._locked():
            tier = self.cache._tier('sample', version)
            tier['role'] = 'cache'
            self.cache._write_tier('sample', version, tier)
        with self.assertRaisesRegex(ValueError, 'configured kind'):
            reader.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='warehouse')
        with self.assertRaisesRegex(D.CacheError, 'protected original'):
            self.existing_reader(kind='warehouse').inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='warehouse')
        original = self.existing_reader(self.base / 'protected-original', kind='warehouse')
        self.assertEqual(original.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='warehouse')['availability'], 'available')

    def test_existing_reader_does_not_accept_corrupt_ready_marker(self):
        version = self.register()
        self.cache.materialize(OWNER, 'sample', version)
        marker = self.ready(version) / 'READY.json'
        marker.chmod(0o600)
        marker.write_text(json.dumps(dict(schema=D.SCHEMA, version='0' * 64)))
        with self.assertRaisesRegex(D.CacheError, 'corrupt'):
            self.existing_reader().inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')

    def test_existing_reader_respects_writer_lock_and_reports_busy_without_repair(self):
        version = self.register()
        reader = self.existing_reader(lock_timeout=0.01)
        with self.cache._locked():
            with self.assertRaises(D.CacheBusy):
                reader.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')
        self.assertEqual(reader.inspect(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')['availability'], 'unavailable')

    def test_coordinator_owned_version_delegates_only_acl_not_integrity_or_other_versions(self):
        version = self.register()
        self.cache.materialize(OWNER, 'sample', version)
        owners = (self.root / '.registry' / 'sample' / 'dataset.json').read_bytes()
        reader = self.existing_reader(coordinator_version={'dataset': 'sample', 'version': version})
        self.assertEqual(reader.inspect(user_id=OTHER.user_id, dataset='sample', version=version, kind='cache')['availability'], 'available')
        self.assertEqual((self.root / '.registry' / 'sample' / 'dataset.json').read_bytes(), owners)
        with self.assertRaises(PermissionError):
            reader.inspect(user_id=OTHER.user_id, dataset='sample', version='0' * 64, kind='cache')
        marker = self.ready(version) / 'READY.json'
        marker.chmod(0o600)
        marker.write_text(json.dumps(dict(schema=D.SCHEMA, version='0' * 64)))
        with self.assertRaisesRegex(D.CacheError, 'corrupt'):
            reader.inspect(user_id=OTHER.user_id, dataset='sample', version=version, kind='cache')

    def test_exported_acl_snapshot_changes_when_legacy_readers_change(self):
        version = self.register()
        reader = self.existing_reader()
        first = reader.export_access(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')
        self.assertEqual(reader.export_access(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache'), first)
        with self.cache._locked():
            D._write_json(self.root / '.registry' / 'sample' / 'dataset.json',
                          dict(schema=D.SCHEMA, owners=[OWNER.user_id, OTHER.user_id]))
        second = reader.export_access(user_id=OWNER.user_id, dataset='sample', version=version, kind='cache')
        self.assertEqual(second['legacyOwners'], [OWNER.user_id, OTHER.user_id])
        self.assertNotEqual(first['snapshotId'], second['snapshotId'])

    def test_long_publish_hash_does_not_block_status_and_lock_wait_is_bounded(self):
        version = self.register()
        token = self.fill(version)
        entered, resume = threading.Event(), threading.Event()
        original_scan = D._scan
        errors = []
        def slow_scan(path):
            entered.set()
            if not resume.wait(3):
                raise AssertionError("test timeout")
            return original_scan(path)
        def publish():
            try:
                self.cache.publish(OWNER, "sample", version, token)
            except BaseException as exc:
                errors.append(exc)
        with patch.object(D, "_scan", side_effect=slow_scan):
            worker = threading.Thread(target=publish)
            worker.start()
            try:
                self.assertTrue(entered.wait(2))
                self.assertEqual(self.cache.status(OWNER, "sample", version)["state"], "STAGING")
                other = D.DatasetCache(self.root, reserve_bytes=1024, lock_timeout=0.02)
                started = time.monotonic()
                with self.assertRaises(D.CacheBusy):
                    other.plan(OWNER, "sample", version)
                self.assertLess(time.monotonic() - started, 0.5)
            finally:
                resume.set()
                worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_unauthorized_requests_do_not_create_version_locks(self):
        version = self.register()
        with self.assertRaises(PermissionError):
            self.cache.plan(OTHER, "sample", version)
        self.assertEqual(list((self.root / ".locks").iterdir()), [])

    def test_missing_data2_mount_is_rejected_before_any_directory_creation(self):
        mount_table = "1 0 8:1 / / rw - ext4 /dev/root rw\n"
        with patch.object(D.Path, "read_text", return_value=mount_table), patch.object(D, "_mkdir") as mkdir:
            with self.assertRaises(D.CacheError):
                D.DatasetCache("/data2/datasets")
            mkdir.assert_not_called()

    def test_data2_mount_guard_rejects_root_disk_remote_readonly_and_submounts(self):
        dev = self.base.stat().st_dev
        device = str(os.major(dev)) + ":" + str(os.minor(dev))
        good = f"1 0 99:99 / / rw - ext4 /dev/root rw\n2 1 {device} / /data2 rw - ext4 /dev/data rw\n"
        original_directory = D._directory
        def directory(path):
            return original_directory(self.base if Path(path) == Path("/data2") else path)
        with patch.object(D, "_directory", side_effect=directory), patch.object(D.Path, "read_text", return_value=good):
            self.assertEqual(D._data2_mount(), ("2", device, dev))
        variants = [good.replace("99:99", device), good.replace("- ext4 /dev/data", "- nfs server:/data"),
                    good.replace("/data2 rw", "/data2 ro"),
                    good + f"3 2 {device} / /data2/datasets/ready rw - ext4 /dev/data rw\n"]
        for table in variants:
            with self.subTest(table=table), patch.object(D.Path, "read_text", return_value=table), self.assertRaises(D.CacheError):
                D._data2_mount()

    def test_mount_identity_change_blocks_existing_instance_operations(self):
        version = self.register()
        self.cache.mount = ("old-mount", "1:2", self.root.stat().st_dev)
        with patch.object(D, "_data2_mount", return_value=("replacement-mount", "1:2", self.root.stat().st_dev)):
            with self.assertRaises(D.CacheError):
                self.cache.plan(OWNER, "sample", version)
        self.assertFalse(self.stage(version).exists())

    def test_interrupted_atomic_metadata_write_can_resume(self):
        version = self.register()
        plan = self.cache.plan(OWNER, "sample", version)
        orphan = self.stage(version) / (".write-" + "a" * 32)
        orphan.write_text("partial metadata")
        reopened = self.cache.plan(OWNER, "sample", version)
        self.assertEqual(reopened["token"], plan["token"])
        self.assertFalse(orphan.exists())
        self.assertEqual(self.cache.materialize(OWNER, "sample", version)["state"], "READY")

    def test_operator_config_is_validated_and_read_through_same_fd(self):
        path = self.base / "admin-config.json"
        path.write_text(json.dumps({"root": str(self.root), "serviceUid": 1000, "serviceGid": 1000}))
        path.chmod(0o600)
        original_regular = D._regular
        original_open = os.open
        opens = []
        def root_owned(fd):
            info = original_regular(fd)
            return SimpleNamespace(st_uid=0, st_mode=info.st_mode, st_size=info.st_size)
        def tracked_open(name, *args, **kwargs):
            if name == path.name:
                opens.append(name)
            return original_open(name, *args, **kwargs)
        with patch.object(D.os, "geteuid", return_value=0), patch.object(D, "_regular", side_effect=root_owned), patch.object(D.os, "open", side_effect=tracked_open):
            self.assertEqual(D._operator_config(path)["root"], str(self.root))
        self.assertEqual(opens, [path.name])


if __name__ == "__main__":
    unittest.main()

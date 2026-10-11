"""No real node, payload or worker. Exercise the complete dispatch function."""
import ast
import hashlib
import json
from pathlib import Path
import re
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

SOURCE=Path(__file__).resolve().parents[1]/'deploy/node-executor.py'
class DataStatusOnce(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.actor=SimpleNamespace(user_id='demo-user-1',is_admin=False)
        self.ref={'dataset':'fixture','version':'a'*64}
        self.cache=Mock();self.cache.status.return_value={**self.ref,'state':'READY'}
        self.warehouse=Mock();self.warehouse.status.return_value={**self.ref,'state':'REGISTERED','warehouseReady':True}
        self.current=Mock(return_value=None)
        tree=ast.parse(SOURCE.read_text())
        ns={'ROOT':Path(self.tmp.name),'DATASET_ID':re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$'),
            'DATASET_VERSION':re.compile(r'^[a-f0-9]{64}$'),'hashlib':hashlib,'json':json,
            'dataset_cache':lambda:(None,self.cache),'dataset_actor':lambda *_:self.actor,
            'storage_warehouse':lambda:self.warehouse,'dataset_current_prepare':self.current,
            'dataset_recovery_configured':lambda *_:False}
        exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_dataset_op'],type_ignores=[]),'offline-router','exec'),ns)
        self.call=lambda:ns['_dataset_op']('datasets.status',dict(self.ref,userId=self.actor.user_id,hostAdmin=False))

    def test_warehouse_status_parses_original_once_without_contains_probe(self):
        self.warehouse.contains.side_effect=AssertionError('duplicate manifest read')
        self.assertEqual(self.call()['state'],'REGISTERED')
        self.warehouse.status.assert_called_once_with(self.actor,self.ref["dataset"],self.ref["version"])
        self.cache.status.assert_not_called()

    def test_definite_missing_original_falls_back_to_cache_once(self):
        self.warehouse.status.side_effect=FileNotFoundError('absent original')
        self.assertEqual(self.call()['state'],'READY')
        self.cache.status.assert_called_once_with(self.actor,self.ref["dataset"],self.ref["version"])
        self.warehouse.status.assert_called_once()

    def test_permission_busy_corrupt_and_io_failures_never_become_absence(self):
        for error in (PermissionError('owner revoked'),RuntimeError('cache busy'),ValueError('corrupt manifest'),OSError('I/O failed')):
            with self.subTest(error=type(error).__name__):
                self.warehouse.status.side_effect=error
                with self.assertRaisesRegex(type(error),str(error)):self.call()
                self.cache.status.assert_not_called()

    def test_missing_cache_remains_missing_without_warehouse(self):
        self.warehouse=None;self.cache.status.side_effect=FileNotFoundError('cache absent')
        with self.assertRaisesRegex(FileNotFoundError,'cache absent'):self.call()
        self.cache.status.assert_called_once()

    def test_non_ready_warehouse_retains_the_existing_worker_lookup(self):
        self.assertEqual(self.call()['warehouseReady'],True)
        self.current.assert_called_once_with(Path(self.tmp.name)/'dataset-ops',self.ref['dataset'],self.ref['version'])

if __name__=='__main__':unittest.main()

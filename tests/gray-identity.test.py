"""Gray identity matches the shared projection permissions and login bridge contract."""
from http.server import ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import secrets
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('gray_identity_fixture', ROOT/'deploy/gray-local/identity-fixture.py')
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)


class IdentityFixtureTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)/'identity'
        self.credentials = dict(password=secrets.token_urlsafe(24), bridgeKey=secrets.token_urlsafe(32))
        # The full gray container initializes as root. These unit tests own only
        # their temporary files; G01 checks the actual different UIDs and group IO.
        with patch.object(FIXTURE.os, 'chown'):
            FIXTURE.initialize(self.root, self.credentials)

    def test_projection_matches_session_storage_and_uses_only_synthetic_accounts(self):
        with sqlite3.connect(self.root/'identity.sqlite') as db:
            self.assertEqual(db.execute('SELECT username,role FROM accounts ORDER BY rowid').fetchall(),
                             [('admin', 'admin'), ('member', 'member')])
            tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            self.assertIn('login_sessions_v2', tables)
            self.assertIn('identity_session_scopes', tables)
            self.assertEqual(db.execute('SELECT salt,password_hash,iterations FROM accounts').fetchall(),
                             [(b'', b'', 0), (b'', b'', 0)])
            self.assertEqual(db.execute('SELECT count(*) FROM login_sessions_v2').fetchone()[0], 0)
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
            self.assertEqual(db.execute("SELECT value FROM account_metadata WHERE key='authority'").fetchone()[0], 'authentik')
        config = json.loads((self.root/'amax-identity.json').read_text())
        self.assertEqual(config['projectionDatabase'], '/accounts/identity.sqlite')
        self.assertEqual(config['bridgeKey'], self.credentials['bridgeKey'])
        self.assertNotIn('password', config)

    def test_directory_and_projection_allow_the_portal_group_to_write_sessions(self):
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o2770)
        self.assertEqual(stat.S_IMODE((self.root/'identity.sqlite').stat().st_mode), 0o660)
        self.assertEqual(stat.S_IMODE((self.root/'amax-identity.json').stat().st_mode), 0o640)
        inherited = self.root/'journal-fixture'
        previous = os.umask(0o077)
        try:
            inherited.write_text('temporary journal')
        finally:
            os.umask(previous)
        self.assertEqual(stat.S_IMODE(inherited.stat().st_mode), 0o660)

    def test_heartbeat_updates_the_same_database_without_widening_permissions(self):
        with sqlite3.connect(self.root/'identity.sqlite') as db:
            with patch.object(FIXTURE.time, 'time', return_value=123456):
                FIXTURE.refresh(db)
            self.assertEqual(db.execute("SELECT value FROM account_metadata WHERE key='updated_at'").fetchone()[0], '123456000')
        self.assertEqual(stat.S_IMODE((self.root/'identity.sqlite').stat().st_mode), 0o660)

    def test_login_bridge_accepts_current_contract_and_ignores_extra_fields(self):
        server = ThreadingHTTPServer(('127.0.0.1', 0), FIXTURE.handler(self.credentials))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join, 2)
        self.addCleanup(server.shutdown)
        endpoint = 'http://127.0.0.1:'+str(server.server_port)+'/internal/clients/amax/login'
        def login(username, password, key):
            request = Request(endpoint, data=json.dumps(dict(username=username, password=password, futureField='ignored')).encode(),
                              headers={'Content-Type': 'application/json', 'Authorization': 'Bearer '+key})
            try:
                with urlopen(request) as response:
                    return response.status, json.load(response)
            except HTTPError as error:
                return error.code, json.load(error)
        for user in FIXTURE.USERS:
            with self.subTest(username=user[1]):
                self.assertEqual(login(user[1], self.credentials['password'], self.credentials['bridgeKey']),
                                 (200, dict(id=user[0], epoch='gray-v1')))
        for username, password, key in [('member', 'wrong', self.credentials['bridgeKey']),
                                        ('unknown', self.credentials['password'], self.credentials['bridgeKey']),
                                        ('member', self.credentials['password'], 'wrong')]:
            self.assertEqual(login(username, password, key)[0], 401)

    def test_preparation_keeps_credentials_out_of_the_report_and_records_the_identity_mode(self):
        run = self.root.parent/'run'
        run.mkdir()
        (run/'admin-password').write_text(self.credentials['password']+'\n')
        (run/'stack.json').write_text(json.dumps(dict(origin='http://127.0.0.1:12345', project='stargate-gray', commit='fixture')))
        result = subprocess.run([sys.executable, '-B', str(ROOT/'scripts/gray-local/prepare.py'), str(run), str(ROOT), '--identity'],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        private = run/'identity-credentials.json'
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
        self.assertEqual(json.loads(private.read_text())['password'], self.credentials['password'])
        stack = json.loads((run/'identity-stack.json').read_text())
        self.assertTrue(stack['identityMode'])
        self.assertEqual(stack['composeFile'], 'identity-compose.yml')
        self.assertNotIn(self.credentials['password'], (run/'identity-stack.json').read_text())


if __name__ == '__main__':
    unittest.main()

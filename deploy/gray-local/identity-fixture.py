"""Isolated identity projection and password bridge; never uses real accounts."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import struct
import sys
import threading
import time

# Synthetic role IDs: the Portal is a different UID and receives only this group.
OWNER = 2000
GROUP = 2000
USERS = [('gray-identity-admin', 'admin', '灰测管理员', 'admin'),
         ('gray-identity-member', 'member', '灰测成员', 'member')]


def initialize(root, credentials):
    root.mkdir(parents=True, exist_ok=True)
    database = root/'identity.sqlite'
    database.unlink(missing_ok=True)
    with closing(sqlite3.connect(database)) as db:
        db.execute('PRAGMA journal_mode=WAL')
        db.executescript('''
            CREATE TABLE account_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE accounts(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE,name TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN ('admin','member')),enabled INTEGER NOT NULL,
                salt BLOB NOT NULL,password_hash BLOB NOT NULL,iterations INTEGER NOT NULL);
            CREATE TABLE identity_users(id TEXT PRIMARY KEY,provider_pk INTEGER NOT NULL,epoch TEXT NOT NULL);
            CREATE TABLE identity_access(user_id TEXT NOT NULL,app_id TEXT NOT NULL,allowed INTEGER NOT NULL,
                expires REAL,PRIMARY KEY(user_id,app_id));
            CREATE TABLE identity_session_scopes(token_hash TEXT PRIMARY KEY,app_id TEXT NOT NULL,epoch TEXT NOT NULL);
            CREATE TABLE login_sessions_v2(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL,username TEXT NOT NULL,
                role TEXT NOT NULL,created_at INTEGER NOT NULL,touched_at INTEGER NOT NULL,expires_at INTEGER NOT NULL);
            CREATE INDEX login_sessions_v2_expiry ON login_sessions_v2(expires_at);
            CREATE INDEX login_sessions_v2_owner ON login_sessions_v2(user_id);
        ''')
        db.executemany('INSERT INTO account_metadata VALUES(?,?)',
                       [('authority', 'authentik'), ('initialized', '1'), ('updated_at', str(int(time.time()*1000)))])
        for index, user in enumerate(USERS, 1):
            # The projection schema retains password columns. Authentication in
            # this mode uses the bridge, so these contain only empty fixtures.
            db.execute("INSERT INTO accounts VALUES(?,?,?,?,1,X'',X'',0)", user)
            db.execute('INSERT INTO identity_users VALUES(?,?,?)', (user[0], index, 'gray-v1'))
            db.execute('INSERT INTO identity_access VALUES(?,?,1,NULL)', (user[0], 'amax'))
        db.commit()
    config = dict(projectionDatabase='/accounts/identity.sqlite',
                  portalOrigin='http://gray-identity:8090',
                  issuer='https://identity.example.test/application/o/amax/',
                  clientId='gray-compute', clientSecret=credentials['bridgeKey'], bridgeKey=credentials['bridgeKey'])
    (root/'amax-identity.json').write_text(json.dumps(config))
    for path in (root, database, root/'amax-identity.json'):
        os.chown(path, OWNER if path == database else 0, GROUP)
        path.chmod(0o2770 if path == root else 0o660 if path == database else 0o640)
    # Give files in the shared directory group access without an ACL package.
    acl = struct.pack('<I', 2)+b''.join(struct.pack('<HHI', tag, mode, 0xffffffff)
                                      for tag, mode in ((1, 7), (4, 7), (32, 0)))
    os.setxattr(root, 'system.posix_acl_default', acl)


def refresh(db):
    with db:
        db.execute("UPDATE account_metadata SET value=? WHERE key='updated_at'", (str(int(time.time()*1000)),))


def handler(credentials):
    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            status, result = 401, dict(error='Login failed')
            if self.path == '/internal/clients/amax/login' and self.headers.get('Authorization') == 'Bearer '+credentials['bridgeKey']:
                try:
                    request = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))))
                    user = next((user for user in USERS if user[1] == request.get('username')), None)
                    if user and request.get('password') == credentials['password']:
                        status, result = 200, dict(id=user[0], epoch='gray-v1')
                except (ValueError, TypeError):
                    status = 400
            raw = json.dumps(result).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def log_message(self, *_):
            pass
    return Handler


def serve(root, credentials, address=('', 8090)):
    # Keep WAL/SHM open under the identity UID while the Portal reads and writes
    # sessions through its supplementary group.
    db = sqlite3.connect(root/'identity.sqlite', check_same_thread=False)
    refresh(db)
    def heartbeat():
        while True:
            refresh(db)
            time.sleep(15)
    threading.Thread(target=heartbeat, daemon=True).start()
    with ThreadingHTTPServer(address, handler(credentials)) as server:
        server.serve_forever()


if __name__ == '__main__':
    os.umask(0o027)
    root = Path('/identity')
    credentials = json.loads(Path('/fixture/identity-credentials.json').read_text())
    if sys.argv[1:] == ['--init']:
        initialize(root, credentials)
    else:
        # The projection belongs to the identity service, never the Portal UID.
        os.setgroups([GROUP])
        os.setgid(GROUP)
        os.setuid(OWNER)
        serve(root, credentials)

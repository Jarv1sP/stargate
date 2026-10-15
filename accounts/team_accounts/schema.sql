PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS accounts (
 id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('admin','member')), enabled INTEGER NOT NULL,
 salt BLOB NOT NULL, password_hash BLOB NOT NULL, iterations INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS account_invites (
 role TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL,
 uses INTEGER NOT NULL DEFAULT 0, max_uses INTEGER, created_at TEXT NOT NULL, code_cipher TEXT
);
CREATE TABLE IF NOT EXISTS login_sessions_v2 (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, username TEXT NOT NULL,
 role TEXT NOT NULL, created_at INTEGER NOT NULL, touched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_sessions_v2_owner ON login_sessions_v2(user_id);
CREATE INDEX IF NOT EXISTS login_sessions_v2_expiry ON login_sessions_v2(expires_at);
CREATE TABLE IF NOT EXISTS account_failures (username TEXT PRIMARY KEY, attempts INTEGER NOT NULL, until_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS account_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);

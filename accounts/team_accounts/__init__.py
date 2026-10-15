"""Direct SQLite client for the shared team account store; no platform HTTP calls."""
import hashlib
import hmac
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager

IDLE_MS = 30 * 86400_000
TOUCH_MS = 3600_000
COOKIE_SECONDS = 365 * 86400


class AccountError(ValueError):
    pass


class TeamAccounts:
    def __init__(self, path):
        self.path = str(path)
        with self.connection() as db:
            if not db.execute("SELECT 1 FROM account_metadata WHERE key='initialized'").fetchone():
                raise AccountError('请先初始化团队账号库。')

    @contextmanager
    def connection(self, write=False):
        # mode=rw prevents a typo in the mount from silently creating a second account store.
        db = sqlite3.connect('file:' + self.path + '?mode=rw', uri=True, timeout=5)
        db.row_factory = sqlite3.Row
        try:
            if write:
                db.execute('BEGIN IMMEDIATE')
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    @staticmethod
    def public(row):
        return {key: row[key] for key in ('id', 'username', 'name', 'role', 'enabled')} if row else None

    @staticmethod
    def issue(db, user):
        now = int(time.time() * 1000)
        db.execute('DELETE FROM login_sessions_v2 WHERE expires_at<=?', (now,))
        total = db.execute('SELECT COUNT(*) FROM login_sessions_v2').fetchone()[0]
        owned = db.execute('SELECT COUNT(*) FROM login_sessions_v2 WHERE user_id=?', (user['id'],)).fetchone()[0]
        if total >= 100000 or owned >= 128:
            raise AccountError('登录会话过多，请退出旧设备或联系账号管理员。')
        token = secrets.token_hex(32)
        db.execute('INSERT INTO login_sessions_v2 VALUES(?,?,?,?,?,?,?)',
                   (hashlib.sha256(token.encode()).hexdigest(), user['id'], user['username'],
                    user['role'], now, now, now + IDLE_MS))
        return token

    def login(self, username, password):
        username = str(username or '').strip()
        if not isinstance(password, str) or len(password) > 128 or len(username) > 24:
            raise AccountError('用户名或密码错误。')
        now = int(time.time() * 1000)
        with self.connection() as db:
            row = db.execute('SELECT * FROM accounts WHERE username=?', (username,)).fetchone()
            failed = db.execute('SELECT * FROM account_failures WHERE username=?', (username,)).fetchone()
        if failed and failed['attempts'] >= 5 and failed['until_ms'] > now:
            raise AccountError('尝试次数过多，请一分钟后重试。')
        actual = hashlib.pbkdf2_hmac('sha256', password.encode(), row['salt'] if row else b'\0' * 16,
                                    row['iterations'] if row else 600000)
        if not row or not hmac.compare_digest(actual, row['password_hash']):
            with self.connection(write=True) as db:
                db.execute('''INSERT INTO account_failures VALUES(?,1,?) ON CONFLICT(username) DO UPDATE SET
                    attempts=CASE WHEN until_ms>? THEN attempts+1 ELSE 1 END,
                    until_ms=CASE WHEN until_ms>? THEN until_ms ELSE excluded.until_ms END''',
                           (username, now + 60000, now, now))
            raise AccountError('用户名或密码错误。')
        with self.connection(write=True) as db:
            current = db.execute('SELECT * FROM accounts WHERE id=?', (row['id'],)).fetchone()
            if not current or not current['enabled']:
                raise AccountError('账号已暂停，请联系账号管理员。')
            if not hmac.compare_digest(current['password_hash'], row['password_hash']):
                raise AccountError('密码已改变，请重新登录。')
            db.execute('DELETE FROM account_failures WHERE username=? OR until_ms<=?', (username, now))
            return self.public(current), self.issue(db, current)

    def register(self, username, password, invite, name=None):
        username = str(username or '').strip()
        valid = (2 <= len(username) <= 24 and (username[0].isascii() and username[0].islower()
                 or '\u3400' <= username[0] <= '\u9fff') and all(
                 'a' <= c <= 'z' or '0' <= c <= '9' or c in '_-' or '\u3400' <= c <= '\u9fff' for c in username))
        if not valid:
            raise AccountError('用户名须为 2–24 位，使用汉字或小写字母开头，可含数字、下划线和短横线。')
        if not isinstance(password, str) or not 8 <= len(password) <= 128:
            raise AccountError('密码需为 8–128 个字符。')
        if not isinstance(invite, str) or len(invite) > 128:
            raise AccountError('请输入团队邀请码。')
        name = str(name or username).strip()
        if not 1 <= len(name) <= 40:
            raise AccountError('姓名需为 1–40 个字符。')
        salt = secrets.token_bytes(16)
        password_hash = hashlib.pbkdf2_hmac('sha256', password.encode(), salt, 600000)
        with self.connection(write=True) as db:
            if db.execute('SELECT 1 FROM accounts WHERE username=?', (username,)).fetchone():
                raise AccountError('这个用户名已存在，请直接登录或换一个。')
            changed = db.execute('''UPDATE account_invites SET uses=uses+1 WHERE role='member' AND digest=?
                AND enabled=1 AND (max_uses IS NULL OR uses<max_uses)''',
                                 (hashlib.sha256(invite.strip().encode()).hexdigest(),)).rowcount
            if changed != 1:
                raise AccountError('邀请码无效、已停用或已用完。')
            user_id = str(uuid.uuid4())
            db.execute('INSERT INTO accounts VALUES(?,?,?,?,?,?,?,?)',
                       (user_id, username, name, 'member', 1, salt, password_hash, 600000))
            row = db.execute('SELECT * FROM accounts WHERE id=?', (user_id,)).fetchone()
            return self.public(row), self.issue(db, row)

    def principal(self, token):
        if not isinstance(token, str) or len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
            return None
        key = hashlib.sha256(token.encode()).hexdigest()
        now = int(time.time() * 1000)
        with self.connection(write=True) as db:
            session = db.execute('SELECT * FROM login_sessions_v2 WHERE token_hash=?', (key,)).fetchone()
            row = db.execute('SELECT * FROM accounts WHERE id=?', (session['user_id'],)).fetchone() if session else None
            if (not session or session['expires_at'] <= now or not row or not row['enabled']
                    or row['username'] != session['username'] or row['role'] != session['role']):
                if session:
                    db.execute('DELETE FROM login_sessions_v2 WHERE token_hash=?', (key,))
                return None
            if now - session['touched_at'] >= TOUCH_MS:
                db.execute('UPDATE login_sessions_v2 SET touched_at=?,expires_at=? WHERE token_hash=?',
                           (now, now + IDLE_MS, key))
            return self.public(row)

    def logout(self, token):
        if token:
            with self.connection(write=True) as db:
                db.execute('DELETE FROM login_sessions_v2 WHERE token_hash=?',
                           (hashlib.sha256(token.encode()).hexdigest(),))

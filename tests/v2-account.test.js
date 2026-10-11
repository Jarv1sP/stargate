import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {sessionFixture, loginRequest} from './helpers/v2-session-fixture.mjs';
import {SessionClient} from '../src/client/session-client.mjs';
import {AccountClient} from '../src/client/account-client.mjs';
import {JsonHttpTransport} from '../src/client/http-transport.mjs';
import {SqliteAccounts} from '../src/infrastructure/sqlite/accounts.mjs';
import {parseAccountChange, parsePasswordReset, parseAccountCreate, parseAccountListQuery, parseAccountListResult} from '../src/contracts/account.mjs';
import {CreateAccount} from '../src/application/create-account.mjs';
import {ResetPassword} from '../src/application/reset-password.mjs';
import {Pbkdf2Passwords} from '../src/infrastructure/passwords.mjs';

const hasCode = code => error => error.code === code;
async function fixture(t) {
  const f = await sessionFixture(); t.after(() => f.close());
  f.database.exec(`UPDATE v2_accounts SET role='admin' WHERE id='alice';
    INSERT INTO v2_accounts(id,username,display_name) VALUES('bob','bob','Bob');
    INSERT INTO v2_credentials SELECT 'bob',salt,hash,iterations,revision FROM v2_credentials WHERE account_id='alice'`);
  async function login(username) {
    const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
    const session = new SessionClient({transport, delivery: 'token'});
    await session.login({...loginRequest, username});
    return {session, accounts: new AccountClient({transport}), transport};
  }
  return {...f, admin: await login('alice'), member: await login('bob'), login};
}
const role = (accountId, revision, value) => ({accountId, revision, kind: 'role', role: value});
const enabled = (accountId, revision, value) => ({accountId, revision, kind: 'enabled', enabled: value});

test('administrator changes role atomically and invalidates the target previous session', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.admin.accounts.change(role('bob', 0, 'admin')), {id: 'bob', role: 'admin', enabled: true, revision: 1});
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  const fresh = await f.login('bob');
  assert.equal((await fresh.session.restore({credential: fresh.transport.session.snapshot().headers.Authorization.slice(7)})).account.role, 'admin');
  await assert.rejects(f.admin.accounts.change(role('bob', 0, 'member')), hasCode('ACCOUNT_CHANGED'));
  assert.equal(f.database.prepare("SELECT role FROM v2_accounts WHERE id='bob'").get().role, 'admin');
});

test('ordinary members cannot change themselves or probe another account through writes', async t => {
  const f = await fixture(t);
  await assert.rejects(f.member.accounts.change(role('bob', 0, 'admin')), hasCode('FORBIDDEN'));
  await assert.rejects(f.member.accounts.change(role('missing', 0, 'admin')), hasCode('FORBIDDEN'));
  assert.equal(f.database.prepare("SELECT auth_revision FROM v2_accounts WHERE id='bob'").get().auth_revision, 0);
});

test('last administrator and own role/disable protections match existing behavior', async t => {
  const f = await fixture(t);
  await assert.rejects(f.admin.accounts.change(role('alice', 0, 'member')), hasCode('LAST_ADMIN'));
  await assert.rejects(f.admin.accounts.change(enabled('alice', 0, false)), hasCode('LAST_ADMIN'));
  await f.admin.accounts.change(role('bob', 0, 'admin'));
  await assert.rejects(f.admin.accounts.change(role('alice', 0, 'member')), hasCode('SELF_ACCOUNT_CHANGE'));
  await assert.rejects(f.admin.accounts.change(enabled('alice', 0, false)), hasCode('SELF_ACCOUNT_CHANGE'));
});

test('disable/re-enable cannot revive old sessions; repeated enabled=true is a no-op', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.accounts.change(enabled('bob', 0, true))).revision, 0);
  await f.member.session.refresh();
  assert.equal((await f.admin.accounts.change(enabled('bob', 0, false))).revision, 1);
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.login('bob'), hasCode('INVALID_CREDENTIALS'));
  await f.admin.accounts.change(enabled('bob', 1, true));
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  await f.login('bob');
});

test('write transaction rechecks revoked administrator and rolls back injected storage failure', async t => {
  const f = await fixture(t);
  const sessionId = f.database.prepare("SELECT id FROM v2_sessions WHERE account_id='alice'").get().id;
  const writer = new SqliteAccounts({database: f.database});
  f.database.prepare('UPDATE v2_sessions SET revoked=1 WHERE id=?').run(sessionId);
  assert.throws(() => writer.change({id: 'alice', sessionId}, role('bob', 0, 'admin'), Date.now()), hasCode('UNAUTHENTICATED'));
  f.database.prepare('UPDATE v2_sessions SET revoked=0 WHERE id=?').run(sessionId);
  f.database.exec("CREATE TRIGGER fail_account BEFORE UPDATE ON v2_accounts BEGIN SELECT RAISE(ABORT,'injected write failure'); END");
  await assert.rejects(f.admin.accounts.change(role('bob', 0, 'admin')), hasCode('INTERNAL_ERROR'));
  const row = f.database.prepare("SELECT role,auth_revision FROM v2_accounts WHERE id='bob'").get();
  assert.equal(row.role, 'member'); assert.equal(row.auth_revision, 0);
  await f.member.session.refresh();
  assert.equal(f.errors.length, 1);
});

test('concurrent administrator writes against the same revision produce one success', async t => {
  const f = await fixture(t);
  const outcomes = await Promise.allSettled([
    f.admin.accounts.change(role('bob', 0, 'admin')),
    f.admin.accounts.change(enabled('bob', 0, false)),
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === 'rejected').reason.code, 'ACCOUNT_CHANGED');
  assert.equal(f.database.prepare("SELECT auth_revision FROM v2_accounts WHERE id='bob'").get().auth_revision, 1);
});

test('account contract accepts only explicit changes and never caller identity', () => {
  for (const input of [{...role('bob', 0, 'admin'), actor: 'alice'}, role('bob', -1, 'admin'), role('bob', 0, 'root'), enabled('bob', 0, 'false')]) {
    assert.throws(() => parseAccountChange(input), hasCode('INVALID_REQUEST'));
  }
});

test('lost write receipt is resolved through a fresh account read, not an automatic replay', async t => {
  const f = await fixture(t);
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, session: f.admin.transport.session, fetch: async (url, options) => {
    await fetch(url, options);
    throw new Error('response lost');
  }});
  await assert.rejects(new AccountClient({transport}).change(role('bob', 0, 'admin')), hasCode('NETWORK_UNAVAILABLE'));
  assert.deepEqual(await f.admin.accounts.get({accountId: 'bob'}), {id: 'bob', role: 'admin', enabled: true, revision: 1});
  assert.equal(f.calls.filter(path => path === '/api/v2/accounts/change').length, 1);
  await assert.rejects(f.member.accounts.get({accountId: 'alice'}), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.admin.accounts.get({accountId: 'missing'}), hasCode('ACCOUNT_NOT_FOUND'));
});

test('password reset invalidates all old sessions and only the new password can sign in', async t => {
  const f = await fixture(t);
  const other = await f.login('bob');
  const result = await f.admin.accounts.resetPassword({accountId: 'bob', revision: 0, password: 'new-password'});
  assert.deepEqual(result, {id: 'bob', role: 'member', enabled: true, revision: 1});
  await assert.rejects(f.member.session.refresh(), hasCode('UNAUTHENTICATED'));
  await assert.rejects(other.session.refresh(), hasCode('UNAUTHENTICATED'));
  await assert.rejects(f.login('bob'), hasCode('INVALID_CREDENTIALS'));
  assert.equal((await f.member.session.login({username: 'bob', password: 'new-password'})).account.id, 'bob');
  const stored = f.database.prepare("SELECT * FROM v2_credentials WHERE account_id='bob'").get();
  assert.equal(stored.revision, 1);
  assert.equal(JSON.stringify(stored).includes('new-password'), false);
  await assert.rejects(f.admin.accounts.resetPassword({accountId: 'bob', revision: 0, password: 'another-password'}), hasCode('ACCOUNT_CHANGED'));
});

test('reset denies members before password work and rechecks administrator/target changes after it', async t => {
  const f = await fixture(t);
  const accounts = new SqliteAccounts({database: f.database});
  const actor = id => ({id, sessionId: f.database.prepare('SELECT id FROM v2_sessions WHERE account_id=?').get(id).id});
  let calls = 0;
  const command = {accountId: 'bob', revision: 0, password: 'new-password'};
  const denied = new ResetPassword({accounts, passwords: {hash: async () => {calls++;}}});
  await assert.rejects(denied.execute(actor('bob'), command), hasCode('FORBIDDEN'));
  assert.equal(calls, 0);
  const original = {...f.database.prepare("SELECT * FROM v2_credentials WHERE account_id='bob'").get()};
  const derived = await new Pbkdf2Passwords().hash('new-password');
  for (const [sql, code] of [
    ["UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='bob'", 'ACCOUNT_CHANGED'],
    ["UPDATE v2_accounts SET enabled=0 WHERE id='alice'", 'UNAUTHENTICATED'],
  ]) {
    const reset = new ResetPassword({accounts, passwords: {hash: async () => {f.database.exec(sql); return derived;}}});
    await assert.rejects(reset.execute(actor('alice'), command), hasCode(code));
    assert.deepEqual({...f.database.prepare("SELECT * FROM v2_credentials WHERE account_id='bob'").get()}, original);
    f.database.exec("UPDATE v2_accounts SET auth_revision=0,enabled=1");
  }
});

test('reset transaction cannot leave changed credentials when account revision write fails', async t => {
  const f = await fixture(t);
  const before = {...f.database.prepare("SELECT * FROM v2_credentials WHERE account_id='bob'").get()};
  f.database.exec("CREATE TRIGGER reject_revision BEFORE UPDATE ON v2_accounts BEGIN SELECT RAISE(ABORT,'injected revision failure'); END");
  await assert.rejects(f.admin.accounts.resetPassword({accountId: 'bob', revision: 0, password: 'new-password'}), hasCode('INTERNAL_ERROR'));
  assert.deepEqual({...f.database.prepare("SELECT * FROM v2_credentials WHERE account_id='bob'").get()}, before);
  await f.member.session.refresh();
  await f.login('bob');
});

test('reset contract preserves password bytes and rejects weak or injected fields', () => {
  const command = {accountId: 'bob', revision: 0, password: ' with spaces '};
  assert.equal(parsePasswordReset(command).password, command.password);
  for (const value of [{...command, password: 'short'}, {...command, password: 'x'.repeat(129)}, {...command, actor: 'alice'}]) {
    assert.throws(() => parsePasswordReset(value), hasCode('INVALID_REQUEST'));
  }
});

test('administrator self-reset is permitted but also invalidates the issuing session', async t => {
  const f = await fixture(t);
  assert.equal((await f.admin.accounts.resetPassword({accountId: 'alice', revision: 0, password: 'new-admin-password'})).revision, 1);
  await assert.rejects(f.admin.session.refresh(), hasCode('UNAUTHENTICATED'));
  await f.admin.session.login({username: 'alice', password: 'new-admin-password'});
  assert.equal((await f.admin.accounts.get({accountId: 'alice'})).role, 'admin');
});

const newAccount = () => ({accountId: randomUUID(), username: '新成员', displayName: '新同学', role: 'member', password: 'new-member-password'});

test('created account can log in with its display name but has no implicit machine/data grants', async t => {
  const f = await fixture(t), command = newAccount();
  const result = await f.admin.accounts.create(command);
  assert.deepEqual(result, {id: command.accountId, role: 'member', enabled: true, revision: 0});
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl});
  const session = new SessionClient({transport, delivery: 'token'});
  assert.equal((await session.login({username: command.username, password: command.password})).account.displayName, command.displayName);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_machine_grants WHERE account_id=?').get(command.accountId).n, 0);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_data_readers WHERE account_id=?').get(command.accountId).n, 0);
  assert.deepEqual(await f.admin.accounts.get({accountId: command.accountId}), result);
  await assert.rejects(f.admin.accounts.create(command), hasCode('ACCOUNT_EXISTS'));
});

test('concurrent duplicate usernames create one complete account, never a partial credential', async t => {
  const f = await fixture(t), first = newAccount(), second = {...first, accountId: randomUUID()};
  const results = await Promise.allSettled([f.admin.accounts.create(first), f.admin.accounts.create(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'USERNAME_EXISTS');
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_accounts WHERE username=?').get(first.username).n, 1);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_credentials WHERE account_id IN (?,?)').get(first.accountId, second.accountId).n, 1);
});

test('creation denies members before hashing and rechecks administrator after password work', async t => {
  const f = await fixture(t), accounts = new SqliteAccounts({database: f.database});
  const actor = id => ({id, sessionId: f.database.prepare('SELECT id FROM v2_sessions WHERE account_id=?').get(id).id});
  let calls = 0;
  const password = await new Pbkdf2Passwords().hash('new-member-password');
  const create = new CreateAccount({accounts, passwords: {hash: async () => {
    calls++; f.database.exec("UPDATE v2_accounts SET enabled=0 WHERE id='alice'"); return password;
  }}});
  const command = newAccount();
  await assert.rejects(create.execute(actor('bob'), command), hasCode('FORBIDDEN'));
  assert.equal(calls, 0);
  await assert.rejects(create.execute(actor('alice'), command), hasCode('UNAUTHENTICATED'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_accounts WHERE id=?').get(command.accountId).n, 0);
});

test('credential insertion failure rolls back the new account row', async t => {
  const f = await fixture(t), command = newAccount();
  f.database.exec("CREATE TRIGGER reject_credential BEFORE INSERT ON v2_credentials BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(f.admin.accounts.create(command), hasCode('INTERNAL_ERROR'));
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_accounts WHERE id=?').get(command.accountId).n, 0);
  assert.equal(f.database.prepare('SELECT count(*) n FROM v2_credentials WHERE account_id=?').get(command.accountId).n, 0);
});

test('creation contract retains current username/display-name rules and requires a stable new UUID', () => {
  const command = newAccount();
  assert.equal(parseAccountCreate({...command, username: ' 新成员 '}).username, '新成员');
  for (const invalid of [{...command, accountId: 'alice'}, {...command, username: 'admin'}, {...command, username: 'UPPER'},
    {...command, displayName: 'x'.repeat(33)}, {...command, displayName: 'a\u0000b'}, {...command, actor: 'alice'}]) {
    assert.throws(() => parseAccountCreate(invalid), hasCode('INVALID_REQUEST'));
  }
});

test('creation receipt loss keeps the original account identifier available for observation without retry', async t => {
  const f = await fixture(t), command = newAccount();
  const transport = new JsonHttpTransport({baseUrl: f.baseUrl, session: f.admin.transport.session, fetch: async (url, options) => {
    await fetch(url, options); throw new Error('lost creation receipt');
  }});
  await assert.rejects(new AccountClient({transport}).create(command), hasCode('NETWORK_UNAVAILABLE'));
  assert.deepEqual(await f.admin.accounts.get({accountId: command.accountId}),
    {id: command.accountId, role: 'member', enabled: true, revision: 0});
  assert.equal(f.calls.filter(path => path === '/api/v2/accounts/create').length, 1);
});

test('account list returns names and bounded stable-ID pages without writing or exposing credentials', async t => {
  const f = await fixture(t);
  // Seed in one transaction rather than stalling the HTTP event loop with
  // 103 individual disk commits while an authenticated connection sits idle.
  const insert = f.database.prepare('INSERT INTO v2_accounts(id,username,display_name) VALUES(?,?,?)');
  f.database.exec('BEGIN');
  for (let n = 0; n < 103; n++) {
    const id = 'member-' + String(n).padStart(3, '0');
    insert.run(id, id, '成员' + n);
  }
  f.database.exec('COMMIT');
  const writes = f.database.prepare('SELECT total_changes() n').get().n;
  let after = null;
  const all = [];
  do {
    const page = await f.admin.accounts.list({after, limit: 20});
    assert.ok(page.accounts.length <= 20);
    for (const account of page.accounts) assert.deepEqual(Object.keys(account).sort(), ['displayName', 'enabled', 'id', 'revision', 'role', 'username']);
    all.push(...page.accounts); after = page.nextCursor;
  } while (after);
  assert.equal(all.length, 105);
  assert.equal(new Set(all.map(account => account.id)).size, 105);
  assert.equal(all.find(account => account.id === 'member-003').displayName, '成员3');
  assert.equal(f.database.prepare('SELECT total_changes() n').get().n, writes);
  assert.deepEqual(await f.admin.accounts.list({after: 'zzzz', limit: 20}), {accounts: [], nextCursor: null});
});

test('list rejects ordinary members and rechecks administrator revocation between pages', async t => {
  const f = await fixture(t);
  await assert.rejects(f.member.accounts.list(), hasCode('FORBIDDEN'));
  const first = await f.admin.accounts.list({after: null, limit: 1});
  assert.ok(first.nextCursor);
  f.database.exec("UPDATE v2_accounts SET auth_revision=auth_revision+1 WHERE id='alice'");
  await assert.rejects(f.admin.accounts.list({after: first.nextCursor, limit: 1}), hasCode('UNAUTHENTICATED'));
});

test('keyset page stays after the requested ID when earlier rows are inserted', async t => {
  const f = await fixture(t);
  const first = await f.admin.accounts.list({after: null, limit: 1});
  assert.equal(first.accounts[0].id, 'alice');
  f.database.exec("INSERT INTO v2_accounts(id,username,display_name) VALUES('aaa','aaa','Earlier')");
  const next = await f.admin.accounts.list({after: first.nextCursor, limit: 1});
  assert.equal(next.accounts[0].id, 'bob');
  assert.equal(next.nextCursor, null);
});

test('list contracts reject oversized pages, duplicate IDs, secret fields and mismatched cursors', () => {
  assert.throws(() => parseAccountListQuery({after: null, limit: 101}), hasCode('INVALID_REQUEST'));
  const row = {id: 'alice', username: 'alice', displayName: 'Alice', role: 'admin', enabled: true, revision: 0};
  for (const response of [
    {accounts: [row, row], nextCursor: null},
    {accounts: [{...row, hash: 'secret'}], nextCursor: null},
    {accounts: [row], nextCursor: 'other'},
    {accounts: [], nextCursor: 'other'},
  ]) assert.throws(() => parseAccountListResult(response), hasCode('INVALID_API_RESPONSE'));
});

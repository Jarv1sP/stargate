import http from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {loginRequest} from './v2-session-fixture.mjs';
import {createNodeDispatchBindingsSchema, SqliteNodeDispatchBindings} from '../../src/infrastructure/sqlite/node-dispatch-bindings.mjs';
import {assembleNodeTaskRead, assembleSqliteTaskRead} from '../../src/bootstrap/task-read.mjs';
import {assembleSqliteSession} from '../../src/bootstrap/sqlite-session.mjs';
import {HttpJobObserver} from '../../src/infrastructure/http-job-observer.mjs';
import {TaskClient} from '../../src/client/task-client.mjs';
import {SessionClient} from '../../src/client/session-client.mjs';
import {JsonHttpTransport} from '../../src/client/http-transport.mjs';

export const credential = 'c'.repeat(64);
async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  return `http://127.0.0.1:${server.address().port}`;
}

export async function publicServer(t, f, nodes = f.nodes) {
  let tasks, sessions;
  const modules = new Map(['client/task-client.mjs', 'client/task-log-reader.mjs', 'client/task-diagnostic-format.mjs', 'client/session-client.mjs', 'client/http-transport.mjs', 'client/session.mjs', 'client/errors.mjs',
    'contracts/task-read.mjs', 'contracts/task-logs.mjs', 'contracts/task-diagnostics.mjs', 'contracts/dispatch-receipt.mjs', 'contracts/session.mjs', 'contracts/errors.mjs']
    .map(name => ['/modules/' + name, new URL('../../src/' + name, import.meta.url)]));
  const origin = await listen(t, async (req, res) => {
    if (req.url === '/') {res.writeHead(200, {'Content-Type': 'text/html'}); res.end('<!doctype html><title>Task SDK fixture</title>'); return;}
    if (modules.has(req.url)) {res.writeHead(200, {'Content-Type': 'text/javascript'}); res.end(await readFile(modules.get(req.url))); return;}
    return req.url.startsWith('/api/v2/session/') ? sessions(req, res) : tasks(req, res);
  });
  const options = {database: f.database, publicOrigin: origin, clock: () => f.now, reportError() {}};
  tasks = assembleSqliteTaskRead({...options, nodes}); sessions = assembleSqliteSession(options);
  const transport = new JsonHttpTransport({baseUrl: origin});
  await new SessionClient({transport, delivery: 'token'}).login(loginRequest);
  return {origin, transport, client: new TaskClient({transport})};
}

export async function nativeNode(t, f, options = {}) {
  const helper = fileURLToPath(new URL('./v2-job-observation-server.py', import.meta.url));
  const child = spawn(process.env.V2_PYTHON || 'python3', ['-B', helper], {stdio: ['pipe', 'pipe', 'pipe']});
  let stderr = ''; child.stderr.on('data', chunk => stderr += chunk);
  const exited = once(child, 'exit');
  t.after(async () => {child.stdin.end(); await exited;});
  const lines = createInterface({input: child.stdout}), ready = once(lines, 'line');
  child.stdin.write(JSON.stringify({dispatchId: f.prepared.dispatchId, ...options}) + '\n');
  const [line] = await Promise.race([ready, exited.then(() => {throw new Error(stderr || 'native fixture exited before readiness');})]);
  const native = JSON.parse(line), database = new DatabaseSync(':memory:');
  t.after(() => database.close()); createNodeDispatchBindingsSchema(database);
  const binding = {dispatchId: f.prepared.dispatchId, jobId: f.jobId, accountId: 'alice', machineId: 'node-1', gpuCount: 2,
    requestHash: f.database.prepare('SELECT payload_hash FROM v2_training_requests WHERE job_id=?').get(f.jobId).payload_hash,
    nativeDigest: native.nativeDigest, nativeMaxGpus: native.nativeMaxGpus, nativeOwner: native.nativeOwner, nativeName: native.nativeName};
  new SqliteNodeDispatchBindings({database, machineId: 'node-1'}).bind(binding);
  const origin = await listen(t, assembleNodeTaskRead({database, machineId: 'node-1', credential, socketPath: native.socketPath, logRoot: native.logRoot,
    python: process.env.V2_PYTHON || 'python3', reportError() {}}));
  return {native, origin, nodes: new HttpJobObserver({nodes: [{machineId: 'node-1', origin, credential}]})};
}

export async function cli(args, input = '') {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../scripts/v2-client.mjs', import.meta.url)), ...args], {stdio: ['pipe', 'pipe', 'pipe']});
  const chunks = []; let stderr = '';
  child.stdout.on('data', chunk => chunks.push(chunk)); child.stderr.on('data', chunk => stderr += chunk);
  const exited = once(child, 'close'); child.stdin.end(input);
  const [code] = await exited, bytes = Buffer.concat(chunks);
  return {code, stdout: bytes.toString('utf8'), bytes, stderr};
}

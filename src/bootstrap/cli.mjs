import {parseArgs} from 'node:util';
import {openClientCredentials} from '../infrastructure/open-client-credentials.mjs';
import {JsonHttpTransport} from '../client/http-transport.mjs';
import {SessionClient} from '../client/session-client.mjs';
import {DataClient} from '../client/data-client.mjs';
import {AccountClient} from '../client/account-client.mjs';
import {DirectoryClient} from '../client/directory-client.mjs';
import {DataAccessImportClient} from '../client/data-access-import-client.mjs';
import {ProjectClient} from '../client/project-client.mjs';
import {TaskClient} from '../client/task-client.mjs';
import {TaskLogReader} from '../client/task-log-reader.mjs';
import {SESSION_POLICY} from '../domain/session-policy.mjs';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';

const usage = `V2 isolated client (not the installed gpuctl):
  --url ORIGIN --credentials FILE login --username NAME --password-stdin
  --url ORIGIN --credentials FILE current
  --url ORIGIN --credentials FILE logout
  --url ORIGIN --credentials FILE accounts [--after ID] [--limit 50]
  --url ORIGIN --credentials FILE task --job UUID
  --url ORIGIN --credentials FILE task-logs --job UUID [--attempt ID] [--bytes 65536] [--start] [--follow] [--json]
  --url ORIGIN --credentials FILE register-directory --machine ID --source CONFIGURED_ID
  --url ORIGIN --credentials FILE register-project --project-id ID --machine ID --project SLUG --release SHA256
  --url ORIGIN --credentials FILE project-registration --project-id ID --machine ID --project SLUG --release SHA256
  --url ORIGIN --credentials FILE access-import-plan --resource ID
  --url ORIGIN --credentials FILE access-import --resource ID --plan SHA256 --request UUID
  --url ORIGIN --credentials FILE access-import-status --request UUID
  --url ORIGIN --credentials FILE read --machine ID --kind directory --source ID
  --url ORIGIN --credentials FILE read --machine ID --kind warehouse|cache --dataset ID --version SHA256
Credentials parent directory must already exist. Password is read from stdin, never an argument.
`;

async function readPassword(input) {
  const chunks = [];
  let size = 0;
  for await (const chunk of input) {
    size += Buffer.byteLength(chunk);
    if (size > 4096) throw new Error('PASSWORD_INPUT_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

async function printTaskLogs({transport, session, values, stdout}) {
  const reader = new TaskLogReader({client: new TaskClient({transport}), jobId: values.job,
    attemptId: values.attempt ?? null, from: values.start ? 'start' : 'tail',
    ...(values.bytes === undefined ? {} : {maxBytes: Number(values.bytes)})});
  let refreshAt = Date.now() + SESSION_POLICY.touchMs;
  try {
    for (;;) {
      let result;
      try {
        if (Date.now() >= refreshAt) {await session.refresh(); refreshAt = Date.now() + SESSION_POLICY.touchMs;}
        result = await reader.read();
      } catch (error) {
        if (!values.follow || reader.cursor.fileId === null
          || !['TASK_READ_BUSY', 'TASK_READ_TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(error.code)) throw error;
        await delay(1000); continue;
      }
      const chunk = result.log.chunk;
      if (values.json) {
        if (stdout.write(JSON.stringify(result) + '\n') === false) await once(stdout, 'drain');
      } else if (chunk) {
        if (stdout.write(Buffer.from(chunk.dataBase64, 'base64')) === false) await once(stdout, 'drain');
      }
      if (!chunk && (!values.follow || reader.cursor.fileId === null)) {
        if (!values.json) throw new Error('TASK_LOG_' + result.log.kind.toUpperCase().replaceAll('-', '_'));
        return;
      }
      if (!values.follow || result.atEnd) return;
      if (!chunk || chunk.nextOffset === chunk.observedSize) await delay(500);
    }
  } finally {reader.close();}
}

/** Explicit opt-in development entry. Does not start services or select a production default. */
export async function runCli({argv, stdin, stdout}) {
  const {values, positionals} = parseArgs({args: argv, allowPositionals: true, options: {
    url: {type: 'string'}, credentials: {type: 'string'}, username: {type: 'string'},
    'password-stdin': {type: 'boolean'}, help: {type: 'boolean'},
    machine: {type: 'string'}, kind: {type: 'string'}, source: {type: 'string'},
    dataset: {type: 'string'}, version: {type: 'string'},
    after: {type: 'string'}, limit: {type: 'string'},
    resource: {type: 'string'}, plan: {type: 'string'}, request: {type: 'string'},
    'project-id': {type: 'string'}, project: {type: 'string'}, release: {type: 'string'},
    job: {type: 'string'},
    attempt: {type: 'string'}, bytes: {type: 'string'}, start: {type: 'boolean'}, follow: {type: 'boolean'}, json: {type: 'boolean'},
  }});
  if (values.help) {stdout.write(usage); return;}
  const [command] = positionals;
  if (positionals.length !== 1 || !values.url || !values.credentials) throw new Error('Specify command, --url and --credentials; see --help');
  if (command === 'login' && (!values.username || !values['password-stdin'])) {
    throw new Error('Login requires --username and --password-stdin');
  }
  // Validate destination before opening a local credential file.
  const transport = new JsonHttpTransport({baseUrl: values.url});
  const projectReference = () => ({projectId: values['project-id'], machineId: values.machine, project: values.project, release: values.release});
  const actions = {
    current: ({identity, expiry}) => ({...identity, ...expiry}),
    accounts: () => new AccountClient({transport}).list({after: values.after ?? null, limit: values.limit === undefined ? 50 : Number(values.limit)}),
    task: () => new TaskClient({transport}).read({jobId: values.job}),
    'task-logs': ({session}) => printTaskLogs({transport, session, values, stdout}),
    'register-directory': () => new DirectoryClient({transport}).register({machineId: values.machine, sourceId: values.source}),
    'register-project': () => new ProjectClient({transport}).registerRelease(projectReference()),
    'project-registration': () => new ProjectClient({transport}).registration(projectReference()),
    'access-import-plan': () => new DataAccessImportClient({transport}).plan({resourceId: values.resource}),
    'access-import': () => new DataAccessImportClient({transport}).apply({resourceId: values.resource, planId: values.plan, requestId: values.request}),
    'access-import-status': () => new DataAccessImportClient({transport}).receipt({requestId: values.request}),
    read: () => {
      const source = values.kind === 'directory'
        ? {kind: values.kind, sourceId: values.source}
        : {kind: values.kind, datasetId: values.dataset, version: values.version};
      return new DataClient({transport}).resolveReadLocation({machineId: values.machine, source});
    },
  };
  if (!['login', 'logout'].includes(command) && !Object.hasOwn(actions, command)) throw new Error('Unknown command; see --help');
  transport.session.close();
  const store = openClientCredentials(values.credentials);
  try {
    const session = new SessionClient({transport, delivery: 'token', credentials: store.credentials});
    let result;
    if (command === 'login') {
      result = await session.login({username: values.username, password: await readPassword(stdin)});
    } else {
      const identity = await session.restore();
      if (command === 'logout') result = await session.logout();
      else {
        const expiry = await session.refresh();
        result = await actions[command]({identity, expiry, session});
      }
    }
    if (result !== undefined) stdout.write(JSON.stringify(result) + '\n');
  } finally {
    store.close();
  }
}

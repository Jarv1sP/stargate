import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

// No real portal, credentials, jobs or persistent installation is used here.
test('native client works with a loopback mock API and Unicode Windows-style workflows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpuq-native-offline-'));
  const cliFile = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const requests = [];
  const principal = { userId: 'offline-user', username: '测试用户', role: 'member' };
  const state = { demo: false, gpuqConnected: true, machines: [{ id: 'offline-node' }], users: [], jobs: [], datasetUploadAdmission: { protocol: 1, available: true } };
  const specificationFields = ['name', 'manifestBytes', 'manifestSha256', 'totalBytes', 'entries'];
  const specification = args => Object.fromEntries(specificationFields.map(key => [key, args[key]]));
  const codeFiles = new Map();
  const codeUploads = new Map();
  const dataFiles = new Map();
  let manifestBytes = Buffer.alloc(0), manifest, admission, uploadState, badReceipt;
  const uploadReceipt = () => ({
    uploadId: admission.uploadId, name: admission.specification.name, state: uploadState,
    manifestOffset: manifestBytes.length, manifestBytes: admission.specification.manifestBytes,
    totalBytes: admission.specification.totalBytes, entries: admission.specification.entries,
    placementProtocol: 1, requestedMachine: 'offline-node', storageMachine: 'offline-warehouse',
    storageTier: 'hdd', legacyPlacement: false,
    ...(uploadState === 'READY' ? { dataset: 'u-offline-sample', version: 'b'.repeat(64) } : {}),
  });
  const server = createServer(async (req, res) => {
    try {
      let raw = '';
      for await (const part of req) raw += part;
      const body = JSON.parse(raw);
      requests.push({ path: req.url, ...body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/login') {
        assert.equal(body.username, principal.username);
        assert.equal(body.password, 'offline-test-not-a-secret');
        res.end(JSON.stringify({ token: 'a'.repeat(64), principal, state }));
        return;
      }
      assert.equal(req.url, '/api/call');
      assert.equal(req.headers.authorization, 'Bearer ' + 'a'.repeat(64));
      const { operation, args = {} } = body;
      assert.ok(!operation.startsWith('jobs.'), 'Native file and dataset workflows never call jobs');
      if (operation.startsWith('datasets.upload.')) {
        assert.equal(args.machine, 'offline-node', 'Keep the selected machine, never dispatch as the warehouse');
        if (!operation.includes('.admission.') && operation !== 'datasets.upload.begin')
          assert.equal(args.uploadId, admission.uploadId, 'Every control and byte request uses the issued UUID');
      }
      let result;
      if (operation === 'state') { res.end(JSON.stringify({ state })); return; }
      if (operation === 'projects.create') {
        assert.equal(args.environmentMode, 'oci');
        result = { project: args.project, environmentMode: 'oci',...(args.storageMode?{localStorage:{protocol:1,mode:args.storageMode,workspaceMode:args.workspaceMode,roots:[{path:'/data',readOnly:true}],unavailable:[]}}:{}) };
      }
      else if (operation === 'files.upload.status') {
        assert.equal(args.project, 'native-test');
        const record = codeUploads.get(JSON.stringify([args.project,args.path]));
        if (!record) result = { protocol: 2, state: 'ABSENT', path: args.path, complete: false, receivedBytes: 0 };
        else {
          assert.equal(record.totalSize,args.totalSize); assert.equal(record.sha256,args.sha256);
          if (args.uploadId) assert.equal(record.uploadId,args.uploadId);
          result = { protocol: 2, ...record, path: args.path, state: record.complete ? 'COMPLETE' : 'UPLOADING', resumable: true, completionPending: false };
        }
      } else if (operation === 'files.put') {
        const key = JSON.stringify([args.project,args.path]),record = codeUploads.get(key);
        if (args.project && record) {
          assert.equal(record.uploadId,args.uploadId);assert.equal(record.totalSize,args.totalSize);assert.equal(record.sha256,args.sha256);
        }
        const previous = args.offset ? codeFiles.get(args.path) || Buffer.alloc(0) : Buffer.alloc(0);
        assert.equal(previous.length, args.offset);
        const data = Buffer.concat([previous, Buffer.from(args.data, 'base64')]);
        codeFiles.set(args.path, data);
        result = { complete: args.final === true, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), executable: args.executable };
        if (args.project) {
          if (args.final) { assert.equal(data.length,args.totalSize);assert.equal(result.sha256,args.sha256); }
          codeUploads.set(key,{uploadId:args.uploadId,totalSize:args.totalSize,sha256:args.sha256,size:data.length,receivedBytes:data.length,complete:args.final===true});
        }
      } else if (operation === 'files.list') result = { entries: [...codeFiles].map(([name, data]) => ({ name, type: 'file', size: data.length })) };
      else if (operation === 'files.get') {
        const data = codeFiles.get(args.path);
        assert.ok(data, 'Download only the fake uploaded code');
        result = { path:args.path,size:data.length,offset:args.offset,data: data.subarray(args.offset).toString('base64'), eof: true };
      } else if (operation === 'datasets.upload.admission.create') {
        assert.deepEqual(Object.keys(args).sort(), ['machine', 'key', ...specificationFields].sort());
        assert.match(args.key, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
        assert.ok(Number.isSafeInteger(args.manifestBytes) && args.manifestBytes > 0);
        assert.match(args.manifestSha256, /^[a-f0-9]{64}$/);
        const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
        assert.deepEqual(saved.datasetUploadIntents[args.key], {
          protocol: 1, userId: principal.userId, machine: args.machine, key: args.key,
          specification: specification(args),
        }, 'The complete owner-bound intent is durable before allocation');
        assert.equal(saved.datasetUploadKeys?.[args.key], undefined, 'Fresh uploads are not legacy persisted keys');
        admission = { protocol: 'dataset-upload-admission-v1', key: args.key, uploadId: randomUUID(),
          requestedMachine: args.machine, storageMachine: 'offline-warehouse', storageTier: 'hdd',
          specification: specification(args), state: 'ISSUED' };
        assert.notEqual(admission.uploadId, admission.key, 'The server, not the client intent, chooses the upload UUID');
        result = badReceipt === 'admission-spec'
          ? { ...admission, specification: { ...admission.specification, totalBytes: args.totalBytes + 1 } }
          : admission;
      } else if (operation === 'datasets.upload.begin') {
        assert.equal(args.key, admission.uploadId, 'Begin uses only the server-issued UUID');
        assert.deepEqual(specification(args), admission.specification, 'Begin binds the complete admitted specification');
        const saved = JSON.parse(await readFile(sessionFile, 'utf8'));
        assert.deepEqual(saved.datasetUploadIntents[admission.key], {
          protocol: 1, userId: principal.userId, machine: args.machine, key: admission.key,
          specification: admission.specification, uploadId: admission.uploadId,
          storageMachine: admission.storageMachine, storageTier: 'hdd', beginAttempted: true,
        }, 'The issued UUID and begin attempt are durable before dispatch');
        manifestBytes = Buffer.alloc(0); dataFiles.clear(); uploadState = 'RECEIVING_MANIFEST';
        result = uploadReceipt();
        if (badReceipt === 'begin-uuid') result.uploadId = randomUUID();
        if (badReceipt === 'begin-spec') result.entries++;
      }
      else if (operation === 'datasets.upload.manifest') {
        assert.equal(args.offset, manifestBytes.length);
        manifestBytes = Buffer.concat([manifestBytes, Buffer.from(args.data, 'base64')]);
        result = { offset: manifestBytes.length };
      } else if (operation === 'datasets.upload.seal') {
        assert.equal(manifestBytes.length, admission.specification.manifestBytes);
        assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), admission.specification.manifestSha256);
        manifest = JSON.parse(manifestBytes);
        assert.equal(manifest.files.reduce((total, file) => total + file.size, 0), admission.specification.totalBytes);
        assert.equal(manifest.files.length + manifest.directories.length, admission.specification.entries);
        uploadState = 'UPLOADING'; result = uploadReceipt();
      } else if (operation === 'datasets.upload.status' && args.path) {
        const entry = manifest.files.find(file => file.path === args.path);
        assert.ok(entry, 'Only upload files from the manifest');
        result = { state: 'UPLOADING', file: { ...entry, offset: dataFiles.get(args.path)?.length || 0, complete: false } };
      } else if (operation === 'datasets.upload.status') result = uploadReceipt();
      else if (operation === 'datasets.upload.chunk') {
        const entry = manifest.files.find(file => file.path === args.path);
        const previous = dataFiles.get(args.path) || Buffer.alloc(0);
        assert.equal(args.offset, previous.length);
        const data = Buffer.concat([previous, Buffer.from(args.data, 'base64')]);
        dataFiles.set(args.path, data);
        result = { offset: data.length, complete: data.length === entry.size };
      } else if (operation === 'datasets.upload.commit') {
        for (const entry of manifest.files) assert.equal(createHash('sha256').update(dataFiles.get(entry.path)).digest('hex'), entry.sha256);
        uploadState = 'READY'; result = uploadReceipt();
      } else if (operation === 'logout') result = { loggedOut: true };
      else throw new Error(`Unexpected API operation: ${operation}`);
      res.end(JSON.stringify({ result }));
    } catch (error) { res.statusCode = 400; res.end(JSON.stringify({ error: error.message })); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sessionFile = join(dir, '个人 session', 'cache.json');
  const cli = (args, stdin = '') => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args, '--url', origin, '--session-file', sessionFile, '--json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { stderr += part; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr, json: args.includes('--help') || !stdout ? null : JSON.parse(stdout) }); });
    child.stdin.end(stdin);
  });
  const ok = async (args, stdin) => { const result = await cli(args, stdin); assert.equal(result.code, 0, result.stderr); return result; };
  try {
    assert.match((await ok(['--help'])).stdout, /gpuctl login/);
    assert.equal((await ok(['login', principal.username, '--password-stdin'], 'offline-test-not-a-secret\r\n')).json.data.loggedIn, true);
    assert.equal((await ok(['state'])).json.data.machines[0].id, 'offline-node');
    await ok(['use', 'offline-node']);
    const localProject=await ok(['project','create','local-data-test','--storage','local-roots','--workspace-mode','task']);
    assert.equal(localProject.json.data.localStorage.workspaceMode,'task');
    assert.equal(requests.at(-1).args.storageMode,'local-roots');
    const beforeInvalid=requests.length;
    assert.notEqual((await cli(['state','--storage','local-roots'])).code,0);
    assert.equal(requests.length,beforeInvalid);
    assert.equal((await ok(['project', 'create', 'native-test'])).json.data.environmentMode, 'oci');
    const codeDir = join(dir, '代码 space ! &');
    await mkdir(codeDir);
    const content = 'print("hello native client")\n';
    await writeFile(join(codeDir, '训练.py'), content);
    await ok(['push', codeDir]);
    assert.equal(codeFiles.get('训练.py').toString(), content);
    const writes = requests.filter(request=>request.operation==='files.put').length;
    await ok(['push', codeDir]);
    assert.equal(requests.filter(request=>request.operation==='files.put').length,writes,'Verified same-identity receipt is reused without writing');
    assert.equal((await ok(['push-status',join(codeDir,'训练.py'),'训练.py'])).json.data.files[0].state,'COMPLETE');
    assert.equal((await ok(['files'])).json.data.entries[0].name, '训练.py');
    const destination = join(dir, '下载 output.py');
    await ok(['pull', '训练.py', destination]);
    assert.equal(await readFile(destination, 'utf8'), content);
    const datasetDir = join(dir, '数据集 sample');
    await mkdir(datasetDir);
    await writeFile(join(datasetDir, '样本.txt'), 'offline sample\n');
    await writeFile(join(datasetDir, 'empty.txt'), '');
    const uploaded = await ok(['data', 'upload', datasetDir, '--name', 'sample']);
    assert.equal(uploaded.json.data.state, 'READY');
    assert.equal(uploaded.json.data.uploadId, admission.uploadId);
    assert.equal(uploaded.json.data.requestedMachine, 'offline-node');
    assert.equal(uploaded.json.data.storageMachine, 'offline-warehouse');
    assert.equal(uploaded.json.data.storageTier, 'hdd');
    assert.equal(dataFiles.get('样本.txt').toString(), 'offline sample\n');
    const uploadCalls = requests.filter(request => request.operation?.startsWith('datasets.upload.'));
    assert.deepEqual(uploadCalls.map(request => request.operation), [
      'datasets.upload.admission.create', 'datasets.upload.begin', 'datasets.upload.manifest',
      'datasets.upload.seal', 'datasets.upload.status', 'datasets.upload.chunk',
      'datasets.upload.status', 'datasets.upload.chunk', 'datasets.upload.commit',
    ]);
    const completedId = admission.uploadId, beforeResume = requests.length;
    assert.equal((await ok(['data', 'upload', datasetDir, '--name', 'sample'])).json.data.uploadId, completedId);
    assert.deepEqual(requests.slice(beforeResume).filter(request => request.operation?.startsWith('datasets.upload.')),
      [{ path: '/api/call', operation: 'datasets.upload.status', args: { machine: 'offline-node', uploadId: completedId } }],
      'Restart inspects the same durable UUID without allocating or beginning again');
    for (const failure of ['admission-spec', 'begin-uuid', 'begin-spec']) {
      badReceipt = failure;
      const before = requests.length, refused = await cli(['data', 'upload', datasetDir, '--name', failure]);
      assert.equal(refused.code, 1, 'Malformed modern receipts must be refused');
      assert.match(refused.stderr, failure === 'admission-spec' ? /完整清单未确认/ : /saved warehouse admission/);
      assert.deepEqual(requests.slice(before).filter(request => request.operation?.startsWith('datasets.upload.')).map(request => request.operation),
        failure === 'admission-spec' ? ['datasets.upload.admission.create'] : ['datasets.upload.admission.create', 'datasets.upload.begin'],
        'Mismatch sends no upload bytes, status replay, second begin or legacy fallback');
      assert.equal(requests.slice(before).filter(request => request.operation?.startsWith('jobs.')).length, 0);
    }
    await ok(['logout']);
    assert.equal(requests.filter(request => request.operation?.startsWith('jobs.')).length, 0, 'Exactly zero jobs calls');
    assert.ok(requests.every(request => !request.operation?.startsWith('jobs.')), 'No task submission or execution');
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});

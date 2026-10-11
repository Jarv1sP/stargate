import {spawn} from 'node:child_process';

/** Bounded local JSON IPC; callers choose fixed programs/arguments, never a shell. */
export async function jsonProcess({program, args, input, timeoutMs = 5000, maxBytes = 8192, signal}) {
  signal?.throwIfAborted();
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647
    || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError('Invalid native process bounds');
  const body = JSON.stringify(input);
  if (Buffer.byteLength(body) > maxBytes) throw Object.assign(new Error('Native request too large'), {code: 'NATIVE_REQUEST_TOO_LARGE'});
  if (process.platform === 'win32') throw new Error('Native query supervision requires POSIX process groups');
  return new Promise((resolve, reject) => {
    // Only fixed, trusted short-lived helpers belong here. This is not a job runner:
    // descendants must stay in this group and may not outlive the query.
    const child = spawn(program, args, {detached: true, stdio: ['pipe', 'pipe', 'pipe']});
    const output = [];
    let failure, failed = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    function recordFailure(error) {
      if (!failed) {failure = error; failed = true;}
    }
    function terminate() {
      if (!child.pid) return;
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') recordFailure(error); }
    }
    function fail(error) {
      recordFailure(error);
      terminate();
    }
    const abort = () => fail(signal.reason);
    const timer = setTimeout(() => fail(Object.assign(new Error('Native query timed out'),
      {code: 'ETIMEDOUT', killed: true})), timeoutMs);
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxBytes) fail(Object.assign(new Error('Native stdout too large'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));
      else output.push(chunk);
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      if (stderrBytes > maxBytes) fail(Object.assign(new Error('Native stderr too large'), {code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'}));
    });
    child.stdin.on('error', fail);
    child.on('error', fail);
    child.on('exit', terminate);
    child.on('close', (code, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (failed) return reject(failure);
      const stdout = Buffer.concat(output).toString('utf8');
      if (code !== 0) return reject(Object.assign(new Error('Native query failed'), {code, signal: exitSignal, stdout}));
      try { resolve(JSON.parse(stdout)); }
      catch (error) { reject(error); }
    });
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort(); else child.stdin.end(body);
  });
}

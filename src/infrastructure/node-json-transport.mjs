import {ApplicationError, TransientReadError} from '../domain/errors.mjs';

const transientConnections = new Set(['ECONNREFUSED', 'ECONNRESET', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

/** Bounded authenticated node RPC. No redirect, discovery, retry or failover. */
export class NodeJsonTransport {
  #nodes = new Map();
  constructor({nodes, fetch = globalThis.fetch, timeoutMs = 5000, maxResponseBytes = 8192}) {
    for (const {machineId, origin, credential} of nodes) {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && url.hostname === '127.0.0.1'))
        || typeof machineId !== 'string' || !machineId || typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential) || this.#nodes.has(machineId)) {
        throw new TypeError('Invalid node configuration');
      }
      this.#nodes.set(machineId, {origin, credential});
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid node timeout');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || maxResponseBytes > 2 * 1024 * 1024) throw new TypeError('Invalid node response limit');
    this.fetch = fetch; this.timeoutMs = timeoutMs; this.maxResponseBytes = maxResponseBytes;
  }

  async request(machineId, route, input, {timeoutMs = this.timeoutMs, signal: callerSignal} = {}) {
    callerSignal?.throwIfAborted();
    const node = this.#nodes.get(machineId);
    if (!node) throw new ApplicationError('NODE_UNAVAILABLE');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('Invalid node timeout');
    const timeout = AbortSignal.timeout(Math.min(timeoutMs, this.timeoutMs));
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    try {
      const url = new URL(route, node.origin);
      if (url.origin !== node.origin || url.username || url.password || !url.pathname.startsWith('/internal/v2/') || url.search || url.hash) throw new Error('Invalid node route');
      const send = this.fetch;
      const response = await send(url, {method: 'POST', redirect: 'error', signal,
        headers: {'Content-Type': 'application/json', Authorization: `Bearer ${node.credential}`}, body: JSON.stringify(input)});
      if (response.status === 401 || response.status === 403) {
        // Response cleanup cannot turn an explicit denial into a retryable reset.
        try {await response.body?.cancel();}
        finally {throw new ApplicationError(response.status === 403 ? 'FORBIDDEN' : 'NODE_CREDENTIAL_REJECTED');}
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > this.maxResponseBytes) throw new Error('Node response too large');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        if (response.status === 503 && ['SOURCE_BUSY', 'SOURCE_READ_TIMEOUT'].includes(body?.error?.code)) {
          throw new TransientReadError(body.error.code);
        }
        if ((response.status === 429 && body?.error?.code === 'TASK_READ_BUSY')
          || (response.status === 504 && body?.error?.code === 'TASK_READ_TIMEOUT')) throw new TransientReadError(body.error.code);
        throw new Error('Node request rejected');
      }
      return body.result;
    } catch (cause) {
      callerSignal?.throwIfAborted();
      if (cause instanceof TransientReadError) throw cause;
      if (cause instanceof ApplicationError && cause.code === 'FORBIDDEN') throw cause;
      if (cause instanceof ApplicationError && cause.code === 'NODE_CREDENTIAL_REJECTED') throw new ApplicationError('NODE_UNAVAILABLE', {cause});
      if (signal.aborted || transientConnections.has(cause?.cause?.code) || transientConnections.has(cause?.code)) {
        throw new TransientReadError('NODE_UNAVAILABLE', {cause});
      }
      throw new ApplicationError('NODE_UNAVAILABLE', {cause});
    }
  }
}

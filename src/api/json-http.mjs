import {InvalidRequest} from '../contracts/errors.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {readRequestContext} from './read-request-context.mjs';

export function reply(res, status, body, headers = {}) {
  res.writeHead(status, {'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers});
  res.end(JSON.stringify(body));
}

export async function readJson(req, maxBytes = 8192) {
  let size = 0;
  const chunks = [];
  for await (const part of req.iterator({destroyOnReturn: false})) {
    size += part.length;
    if (size > maxBytes) {
      req.resume();
      throw new InvalidRequest('body');
    }
    chunks.push(part);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new InvalidRequest('body'); }
}

export function replyError(res, error, statusByCode, reportError) {
  if (error instanceof InvalidRequest) {
    return reply(res, 400, {error: {code: 'INVALID_REQUEST', field: error.field}});
  }
  const status = error instanceof ApplicationError ? statusByCode[error.code] : undefined;
  if (!status || status >= 500) reportError(error);
  reply(res, status || 500, {error: {code: status ? error.code : 'INTERNAL_ERROR'}});
}

/** Explicit route maps share transport handling, never business decisions. */
export function createJsonRoutes({routes, authenticate, statuses, reportError = console.error}) {
  return async (req, res) => {
    const route = routes.get(req.url);
    if (!route) return reply(res, 404, {error: {code: 'NOT_FOUND'}});
    if (req.method !== 'POST') return reply(res, 405, {error: {code: 'METHOD_NOT_ALLOWED'}});
    if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return reply(res, 415, {error: {code: 'JSON_REQUIRED'}});
    let context;
    try {
      const actor = await authenticate(req);
      const input = route.parse(await readJson(req, route.maxRequestBytes));
      context = route.readOnly ? readRequestContext(req, res) : null;
      context?.signal.throwIfAborted();
      const result = context ? await route.useCase.execute(actor, input, {signal: context.signal}) : await route.useCase.execute(actor, input);
      context?.signal.throwIfAborted();
      reply(res, 200, {result});
    } catch (error) {
      if (!(context?.signal.aborted && res.destroyed)) replyError(res, error, statuses, reportError);
    } finally {context?.dispose();}
  };
}

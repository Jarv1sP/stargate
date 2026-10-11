import {ApplicationError} from '../domain/errors.mjs';

/** Only explicitly read-only routes use disconnect cancellation. */
export function readRequestContext(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort(new ApplicationError('TASK_READ_ABORTED'));
  const closed = () => {if (!res.writableFinished) abort();};
  req.once('aborted', abort);
  res.once('close', closed);
  if (req.aborted || res.destroyed) abort();
  return {signal: controller.signal, dispose() {req.removeListener('aborted', abort); res.removeListener('close', closed);}};
}

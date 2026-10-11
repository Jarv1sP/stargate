import {ApiError} from './errors.mjs';
import {MAX_LOG_BYTES, TERMINAL_LOG_ATTEMPTS, parseTaskLogRequest} from '../contracts/task-logs.mjs';

/** One viewer owns one byte cursor and UTF-8 decoder, pinned after its first chunk. */
export class TaskLogReader {
  #request;
  #identity;
  #controller = new AbortController();
  #decoder = new TextDecoder();
  #pending = false;
  #client;
  constructor({client, jobId, attemptId = null, from = 'tail', maxBytes = MAX_LOG_BYTES}) {
    if (!['tail', 'start'].includes(from)) throw new TypeError('Invalid log origin');
    this.#client = client;
    this.#identity = client.transport.session.snapshot().signal;
    this.#request = parseTaskLogRequest({jobId, attemptId, fileId: null, offset: from === 'tail' ? null : 0, maxBytes});
  }
  #check() {this.#identity.throwIfAborted(); this.#controller.signal.throwIfAborted();}
  close() {this.#controller.abort(new ApiError('LOG_READER_CLOSED')); this.#decoder = new TextDecoder();}
  get cursor() {return {...this.#request};}
  async read({signal} = {}) {
    this.#check();
    if (this.#pending) throw new ApiError('LOG_READ_IN_PROGRESS');
    this.#pending = true;
    try {
      const active = AbortSignal.any([this.#identity, this.#controller.signal, ...(signal ? [signal] : [])]);
      const result = await this.#client.logs({...this.#request}, {signal: active});
      this.#check();
      if (signal?.aborted) throw new ApiError('REQUEST_ABORTED');
      const chunk = result.log.chunk;
      if (!chunk) return {...result, text: '', atEnd: false};
      const bytes = Uint8Array.from(atob(chunk.dataBase64), character => character.charCodeAt(0));
      const atEnd = TERMINAL_LOG_ATTEMPTS.includes(chunk.attemptState) && chunk.nextOffset === chunk.observedSize;
      const text = this.#decoder.decode(bytes, {stream: !atEnd});
      this.#request = {...this.#request, attemptId: chunk.attemptId, fileId: chunk.fileId, offset: chunk.nextOffset};
      return {...result, text, atEnd};
    } catch (error) {this.#check(); throw error;}
    finally {this.#pending = false;}
  }
}

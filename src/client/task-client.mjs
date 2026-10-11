import {TASK_READ_ROUTE, parseTaskReadRequest, parseTaskReadResult} from '../contracts/task-read.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';

/** Browser and CLI share this observation API, never a scheduler-specific command. */
export class TaskClient {
  constructor({transport}) {this.transport = transport;}
  async read(request, options) {
    const input = parseTaskReadRequest(request);
    const response = await this.transport.request(TASK_READ_ROUTE, input, options);
    const result = parseTaskReadResult(response?.result);
    if (result.task.jobId !== input.jobId) throw new InvalidResponse();
    return result;
  }
}

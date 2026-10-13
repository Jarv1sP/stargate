import {TASK_READ_ROUTE, parseTaskReadRequest, parseTaskReadResult} from '../contracts/task-read.mjs';
import {InvalidResponse} from '../contracts/errors.mjs';
import {TASK_LOGS_ROUTE, parseTaskLogRequest, parseTaskLogResult, requireLogCursor} from '../contracts/task-logs.mjs';
import {TASK_DIAGNOSTICS_ROUTE, parseTaskDiagnosticResult} from '../contracts/task-diagnostics.mjs';
import {parseTrainingSubmission} from '../contracts/training-submission.mjs';
import {TASK_SUBMISSION_ROUTES, parseTaskRequestReference, parseTaskSubmissionReceipt} from '../contracts/task-submission.mjs';

/** Browser and CLI share task APIs, never scheduler-specific commands. */
export class TaskClient {
  constructor({transport}) {this.transport = transport;}
  async submit(request, options) {
    const input = parseTrainingSubmission(request);
    const response = await this.transport.request(TASK_SUBMISSION_ROUTES.submit, input, options);
    const result = parseTaskSubmissionReceipt(response?.result);
    if (!result || result.request.requestId !== input.requestId) throw new InvalidResponse();
    return result;
  }
  async request(request, options) {
    const input = parseTaskRequestReference(request);
    const response = await this.transport.request(TASK_SUBMISSION_ROUTES.request, input, options);
    const result = parseTaskSubmissionReceipt(response?.result);
    if (result && result.request.requestId !== input.requestId) throw new InvalidResponse();
    return result;
  }
  async read(request, options) {
    const input = parseTaskReadRequest(request);
    const response = await this.transport.request(TASK_READ_ROUTE, input, options);
    const result = parseTaskReadResult(response?.result);
    if (result.task.jobId !== input.jobId) throw new InvalidResponse();
    return result;
  }
  async logs(request, options) {
    const input = parseTaskLogRequest(request);
    const response = await this.transport.request(TASK_LOGS_ROUTE, input, options);
    const result = parseTaskLogResult(response?.result);
    if (result.task.jobId !== input.jobId) throw new InvalidResponse();
    requireLogCursor(result.log.chunk, input);
    return result;
  }
  async diagnostics(request, options) {
    const input = parseTaskReadRequest(request);
    const response = await this.transport.request(TASK_DIAGNOSTICS_ROUTE, input, options);
    const result = parseTaskDiagnosticResult(response?.result);
    if (result.task.jobId !== input.jobId) throw new InvalidResponse();
    return result;
  }
}

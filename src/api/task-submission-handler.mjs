import {createJsonRoutes} from './json-http.mjs';
import {parseTrainingSubmission} from '../contracts/training-submission.mjs';
import {TASK_SUBMISSION_ROUTES, TASK_SUBMISSION_MAX_BYTES, parseTaskRequestReference} from '../contracts/task-submission.mjs';

export function createTaskSubmissionHandler({authenticate, submit, lookup, reportError}) {
  return createJsonRoutes({authenticate, reportError, routes: new Map([
    [TASK_SUBMISSION_ROUTES.submit, {parse: parseTrainingSubmission, maxRequestBytes: TASK_SUBMISSION_MAX_BYTES, useCase: submit}],
    [TASK_SUBMISSION_ROUTES.request, {readOnly: true, parse: parseTaskRequestReference, useCase: lookup}],
  ]), statuses: {UNAUTHENTICATED: 401, FORBIDDEN: 403, PROJECT_ARCHIVED: 409, PROJECT_RELEASE_NOT_FOUND: 404,
    TRAINING_REQUEST_CONFLICT: 409, TRAINING_NO_ELIGIBLE_MACHINE: 409,
    INVALID_TRAINING_REQUEST: 400, TRAINING_REQUEST_TOO_LARGE: 400, INVALID_SCHEDULING_REQUEST: 400,
    SCHEDULING_POLICY_UNAVAILABLE: 503},
  });
}

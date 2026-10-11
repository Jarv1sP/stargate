import {DATA_ACCESS_IMPORT_ROUTES, parseImportPlanRequest, parseImportApplyRequest, parseImportReceiptRequest} from '../contracts/data-access-import.mjs';
import {createJsonRoutes} from './json-http.mjs';
import {sourceReadStatuses} from './source-read-statuses.mjs';

export function createDataAccessImportHandler({authenticate, imports, reportError}) {
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([
      [DATA_ACCESS_IMPORT_ROUTES.plan, {parse: parseImportPlanRequest, useCase: {execute: (actor, input) => imports.plan(actor, input)}}],
      [DATA_ACCESS_IMPORT_ROUTES.apply, {parse: parseImportApplyRequest, useCase: {execute: (actor, input) => imports.apply(actor, input)}}],
      [DATA_ACCESS_IMPORT_ROUTES.receipt, {parse: parseImportReceiptRequest, useCase: {execute: (actor, input) => imports.receipt(actor, input)}}],
    ]),
    statuses: {...sourceReadStatuses, UNAUTHENTICATED: 401, FORBIDDEN: 403, DATA_RESOURCE_NOT_FOUND: 404, MANAGED_RESOURCE_REQUIRED: 400,
      IMPORT_REQUEST_CONFLICT: 409, IMPORT_PLAN_CHANGED: 409},
  });
}

import {createNodeAuthenticator} from './node-authenticator.mjs';
import {SOURCE_INSPECTION_ROUTE, SOURCE_ACCESS_ROUTE, parseSourceInspection, parseSourceAccessRequest} from '../contracts/source-inspection.mjs';
import {ApplicationError} from '../domain/errors.mjs';
import {readObservation} from '../domain/data-source.mjs';
import {createJsonRoutes} from './json-http.mjs';
import {sourceReadStatuses} from './source-read-statuses.mjs';

/** Dedicated coordinator credential: this endpoint cannot execute or mutate. */
export function createSourceInspectionHandler({machineId, credential, sources, reportError}) {
  const authenticate = createNodeAuthenticator(credential);
  const inspect = {async execute(_actor, {request, accountId}) {
    if (request.machineId !== machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    return readObservation(request, await sources.inspect(request, {actor: {id: accountId}}));
  }};
  const exportAccess = {async execute(_actor, {request, accountId}) {
    if (request.machineId !== machineId) throw new ApplicationError('SOURCE_NODE_MISMATCH');
    const result = await sources.exportAccess(request, {actor: {id: accountId}});
    if (result.machineId !== machineId || JSON.stringify(result.source) !== JSON.stringify(request.source)) {
      throw new ApplicationError('SOURCE_UNAVAILABLE');
    }
    return {machineId, source: {...request.source}, legacyOwners: result.legacyOwners, snapshotId: result.snapshotId};
  }};
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([
      [SOURCE_INSPECTION_ROUTE, {parse: parseSourceInspection, useCase: inspect}],
      [SOURCE_ACCESS_ROUTE, {parse: parseSourceAccessRequest, useCase: exportAccess}],
    ]),
    statuses: {...sourceReadStatuses, UNAUTHENTICATED: 401, FORBIDDEN: 403, SOURCE_NODE_MISMATCH: 409},
  });
}

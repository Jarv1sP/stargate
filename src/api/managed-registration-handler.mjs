import {REGISTER_MANAGED_SOURCE_ROUTE, parseManagedRegistration} from '../contracts/managed-registration.mjs';
import {createJsonRoutes} from './json-http.mjs';
import {sourceReadStatuses} from './source-read-statuses.mjs';

export function createManagedRegistrationHandler({authenticate, registerSource, reportError}) {
  return createJsonRoutes({authenticate, reportError,
    routes: new Map([[REGISTER_MANAGED_SOURCE_ROUTE, {parse: parseManagedRegistration, useCase: registerSource}]]),
    statuses: {...sourceReadStatuses, UNAUTHENTICATED: 401, FORBIDDEN: 403, SOURCE_NOT_CONFIGURED: 404, ACCOUNT_NOT_FOUND: 404, MACHINE_NOT_FOUND: 404,
      SOURCE_REGISTRATION_CONFLICT: 409, SOURCE_NOT_READY: 409},
  });
}

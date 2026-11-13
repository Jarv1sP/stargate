import {DemoService} from '../../dist/service.js';

// Plain unit doubles use the existing in-memory service's lookup contract;
// integration fixtures use PortalService's SQLite implementation.
export function memoryJobAccess(service){
  for(const name of ['job','jobReference','jobByKey','jobByNative'])service[name]=DemoService.prototype[name];
  return service;
}

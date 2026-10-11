import {timingSafeEqual} from 'node:crypto';
import {ApplicationError} from '../domain/errors.mjs';

function credentialBytes(credential) {
  if (typeof credential !== 'string' || !/^[a-f0-9]{64}$/.test(credential)) throw new TypeError('Invalid node credential');
  return Buffer.from(credential, 'hex');
}

function suppliedCredential(req) {
  const supplied = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
  if (!supplied) throw new ApplicationError('UNAUTHENTICATED');
  return Buffer.from(supplied, 'hex');
}

export function createNodeAuthenticator(credential) {
  const expected = credentialBytes(credential);
  return async req => {
    if (!timingSafeEqual(suppliedCredential(req), expected)) throw new ApplicationError('UNAUTHENTICATED');
    return {id: 'coordinator'};
  };
}

/** Reverse direction: each configured node credential identifies exactly one machine. */
export function createMachineAuthenticator(peers) {
  const machines = new Set(), credentials = new Set();
  const entries = peers.map(({machineId, credential}) => {
    if (typeof machineId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(machineId)
      || machines.has(machineId) || credentials.has(credential)) throw new TypeError('Ambiguous node peer configuration');
    machines.add(machineId); credentials.add(credential);
    return {machineId, credential: credentialBytes(credential)};
  });
  return async req => {
    const supplied = suppliedCredential(req);
    const peer = entries.find(entry => timingSafeEqual(supplied, entry.credential));
    if (!peer) throw new ApplicationError('UNAUTHENTICATED');
    return {machineId: peer.machineId};
  };
}

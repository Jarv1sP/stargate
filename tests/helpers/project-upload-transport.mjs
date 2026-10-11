import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPersonalFileTransport} from '../../client-personal-file-campus.mjs';

/** Real grant/route client with in-memory authorization and native frame handler.
 * No portal byte relay, network request or native helper process is used here.
 */
export function projectUploadTransport(write, {onAuthorize = () => {}, onClose = () => {}} = {}) {
  return async (_control, options) => {
    const {machine, context, path, action, identity} = structuredClone(options);
    assert.equal(action, 'put');
    const scope = {machine, ...context, path, ...identity};
    const authorize = async (operation, request) => {
      assert.equal(operation, 'files.direct-ticket');
      assert.deepEqual(request, {...scope, action});
      onAuthorize(structuredClone(request));
      const issuedAt = Math.floor(Date.now() / 1000);
      return {result: {available: true, protocol: 'personal-file-campus-v1', kind: 'campus-direct', routeId: 'primary',
        machine, grantId: randomUUID(), endpoint: 'https://campus.fixture.invalid', certificateSha256: 'a'.repeat(64),
        revision: 'b'.repeat(64), issuedAt, ttl: 300, expiresAt: issuedAt + 300,
        chunkBytes: 1024 * 1024, ticket: 'isolated-fixture-ticket-not-a-secret'}};
    };
    return createPersonalFileTransport(authorize, {...options,
      agentFactory: () => ({destroy: onClose}),
      send: async (_grant, _agent, operation, frame) => {
        assert.equal(operation, 'put');
        assert.ok(Buffer.isBuffer(frame.bytes));
        return write({...scope, offset: frame.offset, final: frame.final, data: frame.bytes.toString('base64')});
      },
    });
  };
}

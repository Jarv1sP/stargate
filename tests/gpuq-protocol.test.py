"""Native RPC identity/error boundaries; local temporary sockets, no GPU."""
from contextlib import contextmanager, redirect_stdout
import io
import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'gpuq'))
from gpuq import cli
from gpuq.protocol import Client, ProtocolError
from gpuq.rpc import _ThreadingUnixServer


DENIAL = {
    'request_id': None, 'ok': False,
    'error': {'code': 'FORBIDDEN', 'message': 'peer uid is not allowed'},
}


@contextmanager
def replying_socket(response):
    """Read one request so tests work on macOS as well as Linux."""
    with tempfile.TemporaryDirectory(prefix='gpuq-rpc-') as directory:
        path = Path(directory) / 'rpc.sock'
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path)); listener.listen(1); listener.settimeout(5)
        requests, errors = [], []

        def serve():
            try:
                with listener.accept()[0] as connection:
                    connection.settimeout(5)
                    wire = bytearray()
                    while not wire.endswith(b'\n'):
                        chunk = connection.recv(4096)
                        if not chunk:
                            raise AssertionError('request was truncated')
                        wire.extend(chunk)
                    request = json.loads(wire)
                    requests.append(request)
                    value = response(request) if callable(response) else response
                    connection.sendall((json.dumps(value) + '\n').encode())
            except BaseException as error:
                errors.append(error)

        thread = threading.Thread(target=serve, daemon=True); thread.start()
        try:
            yield Client(path, timeout=3), requests
        finally:
            thread.join(5); listener.close()
            if thread.is_alive():
                raise AssertionError('fixture thread did not finish')
            if errors:
                raise errors[0]


class NativeProtocolIdentity(unittest.TestCase):
    def test_exact_pre_request_uid_denial_is_explicit_and_not_retried(self):
        with replying_socket(DENIAL) as (client, requests):
            with self.assertRaisesRegex(ProtocolError, '^FORBIDDEN: peer uid is not allowed;.*service user'):
                client.call('show', {'job_id': 'Jfixture'})
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]['op'], 'show')

    def test_cli_json_retains_nonzero_exit_and_permission_error(self):
        with replying_socket(DENIAL) as (client, requests), \
                patch.object(cli, 'get_client', return_value=client), \
                redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(['--json', 'show', 'Jfixture']), 2)
            reply = json.loads(output.getvalue())
            self.assertIs(reply['ok'], False)
            self.assertTrue(reply['error'].startswith('FORBIDDEN: peer uid is not allowed;'))
            self.assertNotIn('result', reply)
            self.assertNotIn('does not match request', reply['error'])
            self.assertEqual(len(requests), 1)

    def test_null_id_is_never_accepted_as_success_or_another_error(self):
        malformed = [
            {'request_id': None, 'ok': True, 'result': {'state': 'RUNNING'}},
            {**DENIAL, 'ok': 0},
            {'ok': False, 'error': DENIAL['error']},
            {**DENIAL, 'error': {'code': 'INTERNAL', 'message': 'peer uid is not allowed'}},
            {**DENIAL, 'error': {'code': 'FORBIDDEN', 'message': 'different failure'}},
        ]
        for reply in malformed:
            with self.subTest(reply=reply), replying_socket(reply) as (client, _):
                with self.assertRaisesRegex(ProtocolError, '^daemon response does not match request$'):
                    client.call('show')

    def test_mismatched_uuid_is_rejected_even_with_the_permission_error(self):
        for reply in (
            {**DENIAL, 'request_id': str(uuid.uuid4())},
            {'request_id': str(uuid.uuid4()), 'ok': True, 'result': {'state': 'RUNNING'}},
        ):
            with self.subTest(reply=reply), replying_socket(reply) as (client, _):
                with self.assertRaisesRegex(ProtocolError, '^daemon response does not match request$'):
                    client.call('show')

    def test_matching_success_and_matching_api_error_are_unchanged(self):
        with replying_socket(lambda request: {
            'request_id': request['request_id'], 'ok': True, 'result': {'state': 'RUNNING'},
        }) as (client, _):
            self.assertEqual(client.call('show'), {'state': 'RUNNING'})
        with replying_socket(lambda request: {**DENIAL, 'request_id': request['request_id']}) as (client, _):
            with self.assertRaisesRegex(ProtocolError, '^FORBIDDEN: peer uid is not allowed$'):
                client.call('show')

    @unittest.skipUnless(hasattr(socket, 'SO_PEERCRED'), 'Linux SO_PEERCRED required')
    def test_real_peer_credentials_deny_before_read_or_dispatch(self):
        with tempfile.TemporaryDirectory(prefix='gpuq-peer-') as directory:
            path = Path(directory) / 'rpc.sock'
            calls = []
            server = _ThreadingUnixServer(path, lambda op, args: calls.append((op, args)), os.getuid() + 1, 262144)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                # The handler must not wait for a request from the wrong uid.
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
                    connection.settimeout(2); connection.connect(str(path))
                    self.assertEqual(json.loads(connection.recv(4096)), DENIAL)
                self.assertEqual(calls, [])
            finally:
                server.shutdown(); server.server_close(); thread.join(3)
            self.assertFalse(thread.is_alive())


if __name__ == '__main__':
    unittest.main()

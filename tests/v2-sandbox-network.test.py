"""Local process startup framing and FD ownership; no network configuration."""
from contextlib import ExitStack
import importlib.util
import json
import os
from pathlib import Path
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('network_startup_test', Path(__file__).resolve().parents[1] / 'src/infrastructure/sandbox-network.py')
N = importlib.util.module_from_spec(spec)
spec.loader.exec_module(N)


class StartupTests(unittest.TestCase):
    def test_fragmented_reply_does_not_treat_first_chunk_as_complete_json(self):
        with ExitStack() as handles:
            reader, writer = N.pipe(handles)
            def send():
                writer.write(b'{"child-'); time.sleep(.02)
                writer.write(b'pid":1234}'); writer.close()
            thread = threading.Thread(target=send)
            thread.start()
            try:
                self.assertEqual(N.sandbox_pid(reader.fileno(), timeout=1), 1234)
                self.assertFalse(reader.closed)
            finally:
                thread.join(1)
            self.assertFalse(thread.is_alive())

    def test_invalid_or_oversized_replies_do_not_supply_a_host_pid(self):
        for raw in [b'', b'{', b'[]', json.dumps({'child-pid': True}).encode(), b'{"child-pid":-1}', b'x' * 4097]:
            with self.subTest(raw=raw[:30]), ExitStack() as handles:
                reader, writer = N.pipe(handles)
                writer.write(raw); writer.close()
                with self.assertRaises(ValueError):
                    N.sandbox_pid(reader.fileno(), timeout=.1)

    def test_startup_deadline_and_pipe_scope_do_not_leak_handles(self):
        with ExitStack() as handles:
            reader, writer = N.pipe(handles)
            descriptors = reader.fileno(), writer.fileno()
            with self.assertRaisesRegex(RuntimeError, 'timed out'):
                N.sandbox_pid(reader.fileno(), timeout=.01)
        for descriptor in descriptors:
            with self.assertRaises(OSError):
                os.fstat(descriptor)


if __name__ == '__main__':
    unittest.main()

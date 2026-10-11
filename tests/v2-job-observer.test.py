"""The private observation bridge classifies typed timeouts, never error text."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('job_observer_bridge',
    Path(__file__).resolve().parents[1] / 'src/infrastructure/gpuq-job-observer.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
from gpuq.protocol import ProtocolError


class JobObserverBridgeTests(unittest.TestCase):
    def run_bridge(self, client, value=None):
        value = value or {'socketPath': '/fixture/gpuq.sock', 'submitKey': 'original-key', 'operation': 'job_observation'}
        output = io.StringIO()
        with (patch.object(M, 'Client', return_value=client) as constructor,
              patch('sys.stdin', SimpleNamespace(buffer=io.BytesIO(json.dumps(value).encode()))), redirect_stdout(output)):
            code = M.main()
        return code, json.loads(output.getvalue()), constructor

    def test_only_original_job_observation_is_called_and_null_is_preserved(self):
        client = SimpleNamespace(call=Mock(return_value=None))
        code, result, constructor = self.run_bridge(client)
        self.assertEqual(code, 0)
        self.assertEqual(result, {'result': None})
        constructor.assert_called_once_with(Path('/fixture/gpuq.sock'), timeout=5)
        client.call.assert_called_once_with('job_observation', {'submit_key': 'original-key'})

    def test_timeout_cause_is_distinct_from_unsupported_protocol_and_never_exposes_diagnostics(self):
        for cause, expected in [(TimeoutError('private socket path'), 'TASK_READ_TIMEOUT'),
                                (PermissionError('private socket path'), 'GPUQ_JOB_UNAVAILABLE'),
                                (None, 'GPUQ_JOB_UNAVAILABLE')]:
            error = ProtocolError('timeout-looking text is not a classifier', code='BAD_REQUEST')
            error.__cause__ = cause
            client = SimpleNamespace(call=Mock(side_effect=error))
            with self.subTest(cause=cause):
                code, result, _ = self.run_bridge(client)
                self.assertEqual(code, 1)
                self.assertEqual(result, {'error': {'code': expected}})
                client.call.assert_called_once_with('job_observation', {'submit_key': 'original-key'})

    def test_callers_cannot_replace_the_read_operation_or_supply_extra_selectors(self):
        client = SimpleNamespace(call=Mock(side_effect=AssertionError('must not call native')))
        for extra in [{'operation': 'cancel'}, {'jobId': 'different'}, {'logPath': '/private'}]:
            code, result, constructor = self.run_bridge(client,
                {'socketPath': '/fixture/gpuq.sock', 'submitKey': 'original-key', 'operation': 'job_observation', **extra})
            self.assertEqual(code, 1)
            self.assertEqual(result, {'error': {'code': 'GPUQ_JOB_UNAVAILABLE'}})
            constructor.assert_not_called()
        client.call.assert_not_called()

    def test_diagnostics_is_a_separate_fixed_read_and_does_not_fall_back_to_show(self):
        client = SimpleNamespace(call=Mock(return_value={'resources': {}}))
        code, result, _ = self.run_bridge(client, {'socketPath': '/fixture/gpuq.sock', 'submitKey': 'original-key', 'operation': 'job_diagnostics'})
        self.assertEqual(code, 0)
        self.assertEqual(result, {'result': {'resources': {}}})
        client.call.assert_called_once_with('job_diagnostics', {'submit_key': 'original-key'})


if __name__ == '__main__':
    unittest.main()

"""The gray PTY must report the CLI exit status, not the PTY close race."""
from pathlib import Path
import subprocess
import sys
import unittest


HELPER = Path(__file__).resolve().parents[1]/'scripts/gray-local/pty-cli.py'


class PtyExitTests(unittest.TestCase):
    def test_closed_pty_waits_for_success_and_preserves_failure(self):
        for code in (0, 7):
            with self.subTest(code=code):
                # A CLI may close its terminal before finishing process cleanup.
                # Keep the process alive briefly after all PTY descriptors close.
                child = '''import os, sys, time
print('fixture# ', end='', flush=True)
assert sys.stdin.readline() == 'probe\\n'
print('DONE', flush=True)
for fd in (0, 1, 2):
    os.close(fd)
time.sleep(0.2)
sys.exit(int(sys.argv[1]))
'''
                result = subprocess.run([sys.executable, str(HELPER), sys.executable,
                                         '-c', child, str(code)], input='probe\n',
                                        text=True, capture_output=True, timeout=5)
                self.assertIn('DONE', result.stdout)
                self.assertEqual(result.returncode, code, result.stderr)


if __name__ == '__main__':
    unittest.main()

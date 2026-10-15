#!/usr/bin/env python3
"""给候选交互 CLI 提供真实 PTY；出现 shell 提示符后只发送一次输入。"""
import errno
import os
import pty
import select
import signal
import subprocess
import sys
import time

payload = sys.stdin.buffer.read()
master, slave = pty.openpty()
child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
deadline, sent, tail = time.monotonic() + 55, False, b''
try:
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.2)[0]:
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
            tail = (tail + data)[-4096:]
            if not sent and (b'$ ' in tail or b'# ' in tail):
                os.write(master, payload)
                sent = True
        if child.poll() is not None:
            break
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=5)
        sys.exit(124)
    sys.exit(child.returncode)
finally:
    os.close(master)
    if child.poll() is None:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()

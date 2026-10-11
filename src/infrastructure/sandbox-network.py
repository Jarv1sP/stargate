"""One unprivileged network helper owned by one container invocation."""
from contextlib import ExitStack, contextmanager
import fcntl
import json
import os
import select
import subprocess
import time


def pipe(handles):
    reader, writer = os.pipe()
    return (handles.enter_context(os.fdopen(reader, 'rb', buffering=0)),
            handles.enter_context(os.fdopen(writer, 'wb', buffering=0)))


def stop_process(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()


def sandbox_pid(descriptor, timeout=12):
    """Read bubblewrap's fragmented, bounded startup reply; caller owns the FD."""
    deadline, raw = time.monotonic() + timeout, bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([descriptor], [], [], remaining)[0]:
            raise RuntimeError('Sandbox startup timed out')
        chunk = os.read(descriptor, 4097 - len(raw))
        if not chunk:
            break
        raw.extend(chunk)
        if len(raw) > 4096:
            raise ValueError('Sandbox startup reply exceeds limit')
    reply = json.loads(raw)
    if not isinstance(reply, dict) or type(reply.get('child-pid')) is not int or reply['child-pid'] <= 0:
        raise ValueError('Invalid sandbox PID')
    return reply['child-pid']


class SlirpNetwork:
    # The fixed default subnet's DNS endpoint; no host resolv.conf is mounted.
    resolv_conf = b'nameserver 10.0.2.3\n'

    def __init__(self, *, binary='/usr/bin/slirp4netns', library_path=None, timeout=12):
        self._binary, self._timeout = binary, timeout
        self._environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}
        if library_path is not None:
            self._environment['LD_LIBRARY_PATH'] = library_path

    @contextmanager
    def open(self, pid):
        with ExitStack() as handles:
            netns = os.open(f'/proc/{pid}/ns/net', os.O_RDONLY | os.O_CLOEXEC)
            handles.callback(os.close, netns)
            # linux/nsfs.h: a network namespace may belong to an ancestor of
            # the payload's final user namespace (bubblewrap's nested setup).
            userns = fcntl.ioctl(netns, 0xb701)  # NS_GET_USERNS
            handles.callback(os.close, userns)
            ready_r, ready_w = pipe(handles)
            exit_r, exit_w = pipe(handles)
            try:
                process = subprocess.Popen([self._binary, '--configure', '--disable-host-loopback', '--enable-seccomp',
                    '--ready-fd', str(ready_w.fileno()), '--exit-fd', str(exit_r.fileno()),
                    '--netns-type=path', '--userns-path=/proc/self/fd/' + str(userns), '/proc/self/fd/' + str(netns), 'tap0'],
                    pass_fds=(ready_w.fileno(), exit_r.fileno(), netns, userns), env=self._environment,
                    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL)
            finally:
                ready_w.close()
                exit_r.close()
            try:
                if not select.select([ready_r], [], [], self._timeout)[0] or ready_r.read(1) != b'1' or process.poll() is not None:
                    raise RuntimeError('Sandbox networking unavailable')
                yield process
            finally:
                stop_process(process)

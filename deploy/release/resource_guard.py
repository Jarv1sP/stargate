"""VPS-only release resource guard; never builds images or stops services."""
import json
import threading
import time
from pathlib import Path

MIB = 1024 * 1024
MAX_CONTAINER = 512 * MIB
ABORT_AVAILABLE = 200 * MIB


class ResourceLimit(RuntimeError):
    pass


def snapshot():
    memory = {key: int(value.split()[0]) * 1024 for key, value in
              (row.split(':', 1) for row in Path('/proc/meminfo').read_text().splitlines())}
    return dict(at=time.time(), available=memory['MemAvailable'],
                swap=memory['SwapTotal'] - memory['SwapFree'],
                load=Path('/proc/loadavg').read_text().split()[:3])


class ResourceGuard:
    def __init__(self, path, read=snapshot):
        self.path, self.read = Path(path), read
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread = None
        self._previous_swap = None
        self._previous_at = None
        self._rising = 0
        self.fault = None

    def observe(self, stage):
        value = self.read()
        with self._lock:
            # Three successive one-second increases are sustained growth.
            if self._previous_at is None or value['at'] - self._previous_at >= 1:
                if self._previous_swap is not None and value['swap'] > self._previous_swap:
                    self._rising += 1
                else:
                    self._rising = 0
                self._previous_at, self._previous_swap = value['at'], value['swap']
            if value['available'] < ABORT_AVAILABLE:
                self.fault = self.fault or 'MemAvailable below 200MiB'
            if self._rising >= 3:
                self.fault = self.fault or 'swap increased in three consecutive one-second observations'
            with self.path.open('a') as output:
                output.write(json.dumps(dict(value, stage=stage, fault=self.fault)) + '\n')
        return value

    def checkpoint(self, stage):
        value = self.observe(stage)
        if self.fault:
            raise ResourceLimit(self.fault)
        return value

    def before_start(self, memory_limit, *, old_stopped, available_before_stop, running_portals=()):
        value = self.checkpoint('before-container-start')
        if not 0 < memory_limit <= MAX_CONTAINER:
            raise ResourceLimit('new container limit must be explicit and at most 512MiB')
        if not old_stopped or running_portals:
            raise ResourceLimit('old Portal must be stopped; no second Portal may be running')
        if value['available'] <= available_before_stop:
            raise ResourceLimit('MemAvailable has not recovered after stopping old Portal')
        return value

    def start(self):
        self.checkpoint('release-begin')
        def watch():
            while not self._stop.wait(1):
                try:
                    self.observe('one-second-watch')
                except Exception as error:
                    self.fault = 'resource monitor unavailable: ' + type(error).__name__
                    return
        self._thread = threading.Thread(target=watch, daemon=True)
        self._thread.start()

    def close(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)

from __future__ import annotations

import fcntl
import logging
import os
import signal
import stat
import threading
from pathlib import Path
from types import FrameType
from typing import Any

from .backends import NvidiaSmiProvider, UserSystemdBackend
from .config import Config
from .coordinator import Coordinator
from .rpc import RpcServer
from .store import Store


LOGGER = logging.getLogger(__name__)


class DaemonAlreadyRunningError(RuntimeError):
    """The process-wide gpuq lock is already owned by another daemon."""


class DaemonLock:
    """Lifetime lock that closes the socket probe/unlink/bind race."""

    def __init__(self, path: Path, uid: int) -> None:
        self.path = path
        self.uid = uid
        self._descriptor: int | None = None

    def acquire(self) -> "DaemonLock":
        if self._descriptor is not None:
            return self
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(self.path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError(f"daemon lock is not a regular file: {self.path}")
            if info.st_uid != self.uid:
                raise RuntimeError(
                    f"daemon lock is not owned by uid {self.uid}: {self.path}"
                )
            os.fchmod(descriptor, 0o600)
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise DaemonAlreadyRunningError(
                    f"another gpuq daemon owns {self.path}"
                ) from exc
        except BaseException:
            os.close(descriptor)
            raise
        self._descriptor = descriptor
        return self

    def close(self) -> None:
        descriptor, self._descriptor = self._descriptor, None
        if descriptor is not None:
            try:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            finally:
                os.close(descriptor)

    def __enter__(self) -> "DaemonLock":
        return self.acquire()

    def __exit__(self, *_exc: object) -> None:
        self.close()


def _scheduler_loop(
    coordinator: Coordinator,
    stop_event: threading.Event,
    interval: float,
) -> None:
    while not stop_event.is_set():
        coordinator.tick()
        stop_event.wait(interval)


def run_daemon(config_path: Path) -> int:
    """Run the fail-closed coordinator until SIGTERM or SIGINT."""

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    old_umask = os.umask(0o077)
    store: Store | None = None
    rpc: RpcServer | None = None
    lock: DaemonLock | None = None
    threads: list[threading.Thread] = []
    stop_event = threading.Event()
    previous_handlers: dict[signal.Signals, Any] = {}
    rpc_started = False

    def request_stop(_signum: int, _frame: FrameType | None) -> None:
        stop_event.set()

    try:
        config = Config.from_json(config_path)
        actual_uid = os.getuid()
        if actual_uid == 0 or actual_uid != config.allowed_uid:
            raise RuntimeError(
                f"gpuq daemon must run as uid {config.allowed_uid}, got {actual_uid}"
            )
        config.ensure_layout()
        lock = DaemonLock(config.root / "daemon.lock", config.allowed_uid).acquire()

        # Daemon startup never initializes or repairs the database implicitly.
        store = Store(config.db_path).open()
        coordinator = Coordinator(
            config,
            store,
            NvidiaSmiProvider(timeout=config.nvidia_timeout_seconds),
            UserSystemdBackend(timeout=config.nvidia_timeout_seconds),
        )
        rpc = RpcServer(
            config.socket_path,
            coordinator.handle_api,
            config.allowed_uid,
            config.max_request_bytes,
        )

        for configured_signal in (signal.SIGINT, signal.SIGTERM):
            previous_handlers[configured_signal] = signal.getsignal(
                configured_signal
            )
            signal.signal(configured_signal, request_stop)

        scheduler_thread = threading.Thread(
            target=_scheduler_loop,
            args=(coordinator, stop_event, config.tick_seconds),
            name="gpuq-scheduler",
            daemon=False,
        )
        rpc_thread = threading.Thread(
            target=rpc.serve_forever,
            name="gpuq-rpc",
            daemon=False,
        )
        scheduler_thread.start()
        threads.append(scheduler_thread)
        rpc_thread.start()
        threads.append(rpc_thread)
        rpc_started = True
        LOGGER.info(
            "gpuq ready: socket=%s pool_size=%d observe_only=%s",
            config.socket_path,
            len(config.managed_gpu_uuids),
            coordinator.observe_only,
        )

        while not stop_event.wait(0.5):
            if not rpc_thread.is_alive():
                raise RuntimeError("RPC server stopped unexpectedly")
            if not scheduler_thread.is_alive():
                raise RuntimeError("scheduler thread stopped unexpectedly")
        return 0
    finally:
        stop_event.set()
        if rpc is not None:
            if rpc_started:
                rpc.shutdown()
            else:
                rpc.close()
        for thread in threads:
            # Never release the Store or flock while any coordinator/RPC
            # thread remains alive.  systemd may still enforce its service
            # stop timeout by killing this daemon cgroup; job units are
            # siblings and are unaffected.
            thread.join()
        for configured_signal, previous in previous_handlers.items():
            signal.signal(configured_signal, previous)
        if store is not None:
            store.close()
        if lock is not None:
            lock.close()
        os.umask(old_umask)

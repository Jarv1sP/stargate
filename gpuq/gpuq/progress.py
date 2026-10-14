"""Strict, best-effort training progress reporting for gpuq jobs.

Rank zero atomically publishes one latest snapshot in the attempt-specific
``$GPUQ_CONTROL_DIR``.  The scheduler may persist that snapshot, but progress
reporting is deliberately observational: a reporter failure never changes the
training process or any scheduler lifecycle state.
"""

from __future__ import annotations

import logging
import math
import os
import re
import stat
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Callable, Mapping

from .constants import ProgressSeverity
from .util import atomic_write_json, json_dumps, reject_duplicate_json


PROGRESS_PROTOCOL_VERSION = 1
PROGRESS_FILE_NAME = "progress.json"
MAX_PROGRESS_FILE_BYTES = 16 * 1024
DEFAULT_REPORT_INTERVAL_SECONDS = 2.0
DEFAULT_STALL_TIMEOUT_SECONDS: None = None
MIN_STALL_TIMEOUT_SECONDS = 30.0
MAX_STALL_TIMEOUT_SECONDS = 86_400.0
MAX_PHASE_CHARS = 64
MAX_MESSAGE_CHARS = 512
MAX_METRICS = 32
MAX_METRIC_NAME_CHARS = 64
MAX_ID_CHARS = 256
MAX_SEQUENCE = 2**63 - 1

_METRIC_NAME_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_.:/-]{0,63}$")
_PAYLOAD_FIELDS = frozenset(
    {
        "version",
        "job_id",
        "attempt_id",
        "sequence",
        "phase",
        "epochs_completed",
        "epochs_total",
        "steps_completed",
        "steps_total",
        "metrics",
        "eta_seconds",
        "stall_timeout_seconds",
        "severity",
        "message",
    }
)

LOGGER = logging.getLogger(__name__)


class ProgressProtocolError(ValueError):
    """A progress snapshot is malformed or violates the v1 contract."""


def _plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _finite_number(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProgressProtocolError(f"{field} must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        raise ProgressProtocolError(f"{field} must be a finite number") from None
    if not math.isfinite(result):
        raise ProgressProtocolError(f"{field} must be a finite number")
    return result




def _single_line_text(value: Any, field: str, maximum: int) -> str:
    if (
        not isinstance(value, str)
        or not 1 <= len(value) <= maximum
        or value != value.strip()
        or not value.isprintable()
    ):
        raise ProgressProtocolError(f"{field} is invalid")
    return value


def _counter_pair(
    completed: Any,
    total: Any,
    *,
    prefix: str,
) -> tuple[int | None, int | None]:
    if completed is None and total is None:
        return None, None
    if not _plain_int(completed) or not _plain_int(total):
        raise ProgressProtocolError(
            f"{prefix}_completed and {prefix}_total must be integers or null"
        )
    if total <= 0 or completed < 0 or completed > total:
        raise ProgressProtocolError(
            f"{prefix}_completed must be between zero and {prefix}_total"
        )
    return int(completed), int(total)


def _metrics(value: Any) -> Mapping[str, float]:
    if not isinstance(value, dict) or len(value) > MAX_METRICS:
        raise ProgressProtocolError(
            f"metrics must be an object with at most {MAX_METRICS} entries"
        )
    result: dict[str, float] = {}
    for key, raw_metric in value.items():
        if (
            not isinstance(key, str)
            or len(key) > MAX_METRIC_NAME_CHARS
            or not _METRIC_NAME_RE.fullmatch(key)
        ):
            raise ProgressProtocolError("metric name is invalid")
        result[key] = _finite_number(raw_metric, f"metric {key}")
    return MappingProxyType(dict(sorted(result.items())))


def _optional_eta(value: Any) -> float | None:
    if value is None:
        return None
    result = _finite_number(value, "eta_seconds")
    if result < 0 or result > 10 * 365 * 24 * 60 * 60:
        raise ProgressProtocolError("eta_seconds is outside the supported range")
    return result


def _stall_timeout(value: Any) -> float | None:
    if value is None:
        return None
    result = _finite_number(value, "stall_timeout_seconds")
    if not MIN_STALL_TIMEOUT_SECONDS <= result <= MAX_STALL_TIMEOUT_SECONDS:
        raise ProgressProtocolError(
            "stall_timeout_seconds must be between "
            f"{MIN_STALL_TIMEOUT_SECONDS:g} and {MAX_STALL_TIMEOUT_SECONDS:g}"
        )
    return result


def _severity(value: Any) -> str:
    try:
        return ProgressSeverity(value).value
    except (TypeError, ValueError):
        raise ProgressProtocolError(
            "severity must be info, warning, or error"
        ) from None


def _message(value: Any, severity: str) -> str | None:
    if value is None:
        return None
    result = _single_line_text(value, "message", MAX_MESSAGE_CHARS)
    if severity == ProgressSeverity.INFO.value:
        raise ProgressProtocolError(
            "message is only allowed for warning or error progress"
        )
    return result


@dataclass(frozen=True, slots=True)
class ProgressSnapshot:
    version: int
    job_id: str
    attempt_id: str
    sequence: int
    phase: str
    epochs_completed: int | None
    epochs_total: int | None
    steps_completed: int | None
    steps_total: int | None
    metrics: Mapping[str, float]
    eta_seconds: float | None
    stall_timeout_seconds: float | None
    severity: str
    message: str | None

    def to_payload(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "job_id": self.job_id,
            "attempt_id": self.attempt_id,
            "sequence": self.sequence,
            "phase": self.phase,
            "epochs_completed": self.epochs_completed,
            "epochs_total": self.epochs_total,
            "steps_completed": self.steps_completed,
            "steps_total": self.steps_total,
            "metrics": dict(self.metrics),
            "eta_seconds": self.eta_seconds,
            "stall_timeout_seconds": self.stall_timeout_seconds,
            "severity": self.severity,
            "message": self.message,
        }

    def canonical_json(self) -> str:
        return json_dumps(self.to_payload())


def validate_progress_payload(value: Any) -> ProgressSnapshot:
    """Validate and normalize one decoded progress-v1 object."""

    if not isinstance(value, dict) or set(value) != _PAYLOAD_FIELDS:
        raise ProgressProtocolError("progress fields do not match protocol v1")
    version = value["version"]
    if not _plain_int(version) or version != PROGRESS_PROTOCOL_VERSION:
        raise ProgressProtocolError("unsupported progress protocol version")
    sequence = value["sequence"]
    if not _plain_int(sequence) or not 1 <= sequence <= MAX_SEQUENCE:
        raise ProgressProtocolError("sequence must be a positive SQLite integer")
    epochs_completed, epochs_total = _counter_pair(
        value["epochs_completed"], value["epochs_total"], prefix="epochs"
    )
    steps_completed, steps_total = _counter_pair(
        value["steps_completed"], value["steps_total"], prefix="steps"
    )
    normalized_severity = _severity(value["severity"])
    snapshot = ProgressSnapshot(
        version=PROGRESS_PROTOCOL_VERSION,
        job_id=_single_line_text(value["job_id"], "job_id", MAX_ID_CHARS),
        attempt_id=_single_line_text(value["attempt_id"], "attempt_id", MAX_ID_CHARS),
        sequence=int(sequence),
        phase=_single_line_text(value["phase"], "phase", MAX_PHASE_CHARS),
        epochs_completed=epochs_completed,
        epochs_total=epochs_total,
        steps_completed=steps_completed,
        steps_total=steps_total,
        metrics=_metrics(value["metrics"]),
        eta_seconds=_optional_eta(value["eta_seconds"]),
        stall_timeout_seconds=_stall_timeout(value["stall_timeout_seconds"]),
        severity=normalized_severity,
        message=_message(value["message"], normalized_severity),
    )
    encoded = (snapshot.canonical_json() + "\n").encode("utf-8")
    if len(encoded) > MAX_PROGRESS_FILE_BYTES:
        raise ProgressProtocolError(
            f"progress snapshot exceeds {MAX_PROGRESS_FILE_BYTES} bytes"
        )
    return snapshot


def parse_progress_bytes(raw: bytes) -> ProgressSnapshot:
    if not isinstance(raw, bytes):
        raise TypeError("raw progress data must be bytes")
    if not raw or len(raw) > MAX_PROGRESS_FILE_BYTES:
        raise ProgressProtocolError("progress file is empty or too large")
    try:
        decoded = raw.decode("utf-8", errors="strict")
        value = reject_duplicate_json(decoded)
    except (UnicodeError, ValueError, RecursionError):
        raise ProgressProtocolError("progress file is not strict JSON") from None
    return validate_progress_payload(value)


def load_progress_file(path: str | os.PathLike[str]) -> ProgressSnapshot | None:
    """Read one secure progress file; return ``None`` only when it is absent."""

    progress_path = Path(path)
    if not progress_path.is_absolute():
        raise ProgressProtocolError("progress path must be absolute")
    # O_NONBLOCK is essential before fstat: opening a FIFO by path would
    # otherwise hang the coordinator before the regular-file check can run.
    # The control tree is a same-UID trusted-team boundary, not a sandbox
    # against an owner replacing parent directories concurrently.
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    try:
        descriptor = os.open(progress_path, flags)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise ProgressProtocolError("cannot securely open progress file") from exc
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise ProgressProtocolError("progress path is not a regular file")
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ProgressProtocolError("progress file ownership or mode is unsafe")
        if not 1 <= info.st_size <= MAX_PROGRESS_FILE_BYTES:
            raise ProgressProtocolError("progress file is empty or too large")
        raw = os.read(descriptor, MAX_PROGRESS_FILE_BYTES + 1)
        if len(raw) != info.st_size or len(raw) > MAX_PROGRESS_FILE_BYTES:
            raise ProgressProtocolError("progress file changed while being read")
    except OSError as exc:
        raise ProgressProtocolError("cannot read progress file") from exc
    finally:
        os.close(descriptor)
    return parse_progress_bytes(raw)


def progress_milestone(snapshot: ProgressSnapshot) -> int | None:
    """Return the completed 10-percent bucket from trusted progress counters."""

    if snapshot.steps_completed is not None and snapshot.steps_total is not None:
        percent = (snapshot.steps_completed * 100) // snapshot.steps_total
    elif snapshot.epochs_completed is not None and snapshot.epochs_total is not None:
        percent = (snapshot.epochs_completed * 100) // snapshot.epochs_total
    else:
        return None
    return min(100, (percent // 10) * 10)


def _environment_rank(environment: Mapping[str, str]) -> int:
    for name in ("RANK", "LOCAL_RANK"):
        raw = environment.get(name)
        if raw is None:
            continue
        if not raw.isascii() or not raw.isdecimal():
            raise ProgressProtocolError(f"{name} must be a non-negative integer")
        return int(raw)
    return 0


class ProgressReporter:
    """Best-effort rank-zero publisher of the latest training snapshot.

    Invalid updates and filesystem errors return ``False`` and are logged at a
    bounded rate.  They are never raised into the training loop.
    """

    def __init__(
        self,
        *,
        rank: int | None = None,
        report_interval_seconds: float = DEFAULT_REPORT_INTERVAL_SECONDS,
        stall_timeout_seconds: float | None = DEFAULT_STALL_TIMEOUT_SECONDS,
        environment: Mapping[str, str] | None = None,
        monotonic: Callable[[], float] = time.monotonic,
        writer: Callable[[Path, Any, int], None] = atomic_write_json,
        logger: logging.Logger = LOGGER,
    ) -> None:
        self._environment = dict(os.environ if environment is None else environment)
        self._monotonic = monotonic
        self._writer = writer
        self._logger = logger
        self._lock = threading.RLock()
        self._last_warning_at: float | None = None
        self._last_write_at: float | None = None
        self._sequence = 0
        self._closed = False
        self._latest: dict[str, Any] | None = None
        self._path: Path | None = None
        self._job_id: str | None = None
        self._attempt_id: str | None = None
        self._enabled = False
        try:
            actual_rank = _environment_rank(self._environment) if rank is None else rank
            if not _plain_int(actual_rank) or actual_rank < 0:
                raise ProgressProtocolError("rank must be a non-negative integer")
            interval = _finite_number(
                report_interval_seconds, "report_interval_seconds"
            )
            if interval < 0 or interval > 3600:
                raise ProgressProtocolError(
                    "report_interval_seconds must be between zero and 3600"
                )
            self._report_interval_seconds = interval
            self._stall_timeout_seconds = _stall_timeout(stall_timeout_seconds)
            if actual_rank != 0:
                return
            control_dir = self._environment.get("GPUQ_CONTROL_DIR")
            job_id = self._environment.get("GPUQ_JOB_ID")
            attempt_id = self._environment.get("GPUQ_ATTEMPT_ID")
            if control_dir is None or job_id is None or attempt_id is None:
                return
            directory = Path(control_dir)
            if not directory.is_absolute():
                raise ProgressProtocolError("GPUQ_CONTROL_DIR must be absolute")
            self._job_id = _single_line_text(job_id, "GPUQ_JOB_ID", MAX_ID_CHARS)
            self._attempt_id = _single_line_text(attempt_id, "GPUQ_ATTEMPT_ID", MAX_ID_CHARS)
            self._path = directory / PROGRESS_FILE_NAME
            existing = load_progress_file(self._path)
            if existing is not None:
                if (
                    existing.job_id != self._job_id
                    or existing.attempt_id != self._attempt_id
                ):
                    raise ProgressProtocolError(
                        "existing progress file belongs to a different attempt"
                    )
                self._sequence = existing.sequence
            self._enabled = True
        except Exception as exc:
            self._warn(exc)
            self._enabled = False

    @property
    def enabled(self) -> bool:
        return self._enabled and not self._closed

    @property
    def sequence(self) -> int:
        return self._sequence

    def _warn(self, exc: Exception) -> None:
        try:
            now = float(self._monotonic())
        except Exception:
            now = 0.0
        if self._last_warning_at is not None and now - self._last_warning_at < 60:
            return
        self._last_warning_at = now
        try:
            self._logger.warning(
                "gpuq progress update was not published (%s)", type(exc).__name__
            )
        except Exception:
            pass

    def _publish(self, payload: dict[str, Any], *, force: bool) -> bool:
        with self._lock:
            if not self.enabled or self._path is None:
                return False
            try:
                now = _finite_number(self._monotonic(), "monotonic clock")
                if (
                    not force
                    and self._last_write_at is not None
                    and now - self._last_write_at < self._report_interval_seconds
                ):
                    return False
                candidate = {**payload, "sequence": self._sequence + 1}
                snapshot = validate_progress_payload(candidate)
                self._writer(self._path, snapshot.to_payload(), 0o600)
                self._sequence = snapshot.sequence
                self._last_write_at = now
                self._latest = snapshot.to_payload()
                return True
            except Exception as exc:
                self._warn(exc)
                return False

    def update(
        self,
        *,
        phase: str,
        epochs_completed: int | None = None,
        epochs_total: int | None = None,
        steps_completed: int | None = None,
        steps_total: int | None = None,
        metrics: Mapping[str, int | float] | None = None,
        eta_seconds: int | float | None = None,
        severity: str | ProgressSeverity = ProgressSeverity.INFO,
        message: str | None = None,
        force: bool = False,
    ) -> bool:
        """Publish, or rate-limit, one full latest snapshot."""

        with self._lock:
            if not self.enabled or self._job_id is None or self._attempt_id is None:
                return False
            severity_value = (
                severity.value if isinstance(severity, ProgressSeverity) else severity
            )
            try:
                if metrics is not None and not isinstance(metrics, Mapping):
                    raise ProgressProtocolError("metrics must be a mapping")
                payload = {
                    "version": PROGRESS_PROTOCOL_VERSION,
                    "job_id": self._job_id,
                    "attempt_id": self._attempt_id,
                    "sequence": self._sequence + 1,
                    "phase": phase,
                    "epochs_completed": epochs_completed,
                    "epochs_total": epochs_total,
                    "steps_completed": steps_completed,
                    "steps_total": steps_total,
                    "metrics": dict(metrics) if metrics is not None else {},
                    "eta_seconds": eta_seconds,
                    "stall_timeout_seconds": self._stall_timeout_seconds,
                    "severity": severity_value,
                    "message": message,
                }
                normalized = validate_progress_payload(payload).to_payload()
                self._latest = normalized
                urgent = severity_value in {
                    ProgressSeverity.WARNING.value,
                    ProgressSeverity.ERROR.value,
                }
                return self._publish(normalized, force=force or urgent)
            except Exception as exc:
                self._warn(exc)
                return False

    def heartbeat(self, *, force: bool = False) -> bool:
        with self._lock:
            if self._latest is None:
                return False
            return self._publish(self._latest, force=force)

    def close(self) -> bool:
        with self._lock:
            if self._closed:
                return False
            flushed = self.heartbeat(force=True)
            self._closed = True
            return flushed

    def __enter__(self) -> "ProgressReporter":
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

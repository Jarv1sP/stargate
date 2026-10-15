"""Cooperative, epoch-boundary checkpoint handling for gpuq jobs.

The scheduler requests a checkpoint by atomically publishing
``$GPUQ_CONTROL_DIR/request.json``.  Training code calls
:func:`checkpoint_at_epoch_end` after an epoch has completed.  Rank zero saves
the checkpoint and atomically publishes ``ack.json`` before every participating
rank exits with :data:`gpuq.constants.CHECKPOINT_EXIT_CODE`.

No signal handler is installed here.  In particular, a training process cannot
be interrupted in the middle of an optimizer step by this module.
"""

from __future__ import annotations

import json

import fcntl
import math
import os
import stat
import time
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from .constants import CHECKPOINT_EXIT_CODE, SCHEMA_VERSION
from .util import atomic_write_json, json_dumps


CONTROL_DIR_ENV = "GPUQ_CONTROL_DIR"
REQUEST_FILE_NAME = "request.json"
ACK_FILE_NAME = "ack.json"
ERROR_FILE_NAME = "error.json"
DECISION_FILE_NAME = "decision.json"
LOCK_FILE_NAME = "checkpoint.lock"
_MAX_CONTROL_FILE_BYTES = 64 * 1024
_ACK_RESERVED_FIELDS = frozenset(
    {
        "version",
        "nonce",
        "attempt_id",
        "requested_by_job_id",
        "acknowledged_at",
        "exit_code",
    }
)

SaveFunction = Callable[[], Optional[Dict[str, Any]]]
BarrierFunction = Callable[[], None]
BroadcastDecisionFunction = Callable[
    [Optional[Dict[str, Any]]], Dict[str, Any]
]
ClockFunction = Callable[[], float]


class CheckpointPeerError(RuntimeError):
    """Rank zero could not produce the requested checkpoint."""


@dataclass(frozen=True)
class CheckpointRequest:
    """A validated checkpoint request."""

    nonce: str
    attempt_id: str
    requested_by_job_id: str
    created_at: float
    expires_at: float | None


def resume_checkpoint_path() -> str | None:
    """Return the prior preemption checkpoint injected on a resumed attempt."""

    value = os.environ.get("GPUQ_RESUME_CHECKPOINT")
    return value if value else None


def _nonempty_string(value: Any, *, max_length: int = 512) -> str | None:
    if not isinstance(value, str) or not value or len(value) > max_length:
        return None
    if value != value.strip() or "\x00" in value:
        return None
    return value


def _timestamp(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        if isinstance(value, (int, float)):
            result = float(value)
        elif isinstance(value, str):
            text = value.strip()
            if not text:
                return None
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                return None
            result = parsed.timestamp()
        else:
            return None
    except (ValueError, OverflowError, OSError):
        return None
    return result if math.isfinite(result) else None


def _read_json_object(path: Path) -> dict[str, Any] | None:
    """Read one small, regular JSON file without following a final symlink."""

    flags = os.O_RDONLY
    if hasattr(os, "O_CLOEXEC"):
        flags |= os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(path, flags)
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > _MAX_CONTROL_FILE_BYTES:
            return None
        chunks: list[bytes] = []
        remaining = _MAX_CONTROL_FILE_BYTES + 1
        while remaining:
            chunk = os.read(descriptor, min(remaining, 16 * 1024))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        if len(raw) > _MAX_CONTROL_FILE_BYTES:
            return None
        decoded = raw.decode("utf-8")
        value = json.loads(decoded)
    except (OSError, UnicodeError, ValueError):
        return None
    finally:
        os.close(descriptor)
    return value if isinstance(value, dict) else None


def _control_directory(control_dir: str | os.PathLike[str] | None) -> Path | None:
    if control_dir is None:
        control_dir = os.environ.get(CONTROL_DIR_ENV)
    if not control_dir:
        return None
    try:
        path = Path(control_dir)
    except TypeError:
        return None
    # The daemon exports an absolute per-attempt directory.  Rejecting relative
    # paths avoids accidentally consuming a request from an unrelated cwd.
    return path if path.is_absolute() else None


def _load_request(
    directory: Path,
    *,
    expected_nonce: str | None,
    current_time: float,
) -> CheckpointRequest | None:
    value = _read_json_object(directory / REQUEST_FILE_NAME)
    if value is None:
        return None
    nonce = _nonempty_string(value.get("nonce"))
    attempt_id = _nonempty_string(value.get("attempt_id"))
    requested_by_job_id = _nonempty_string(value.get("requested_by_job_id"))
    created_at = _timestamp(value.get("created_at"))
    if (
        nonce is None
        or attempt_id is None
        or requested_by_job_id is None
        or created_at is None
        or (expected_nonce is not None and nonce != expected_nonce)
    ):
        return None

    expires_at: float | None = None
    if "expires_at" in value and value["expires_at"] is not None:
        expires_at = _timestamp(value["expires_at"])
        if expires_at is None or expires_at <= current_time:
            return None
    return CheckpointRequest(
        nonce=nonce,
        attempt_id=attempt_id,
        requested_by_job_id=requested_by_job_id,
        created_at=created_at,
        expires_at=expires_at,
    )


def read_checkpoint_request(
    *,
    control_dir: str | os.PathLike[str] | None = None,
    expected_nonce: str | None = None,
    clock: ClockFunction | None = None,
) -> CheckpointRequest | None:
    """Return the current valid request, or ``None`` when none is actionable.

    Missing, malformed, oversized, expired, or nonce-mismatched requests are
    deliberately fail-open: training continues and no acknowledgement is
    created.
    """

    directory = _control_directory(control_dir)
    if directory is None:
        return None
    now = (clock or time.time)()
    if isinstance(now, bool) or not isinstance(now, (int, float)):
        raise TypeError("clock must return a finite number")
    current_time = float(now)
    if not math.isfinite(current_time):
        raise ValueError("clock must return a finite number")
    return _load_request(
        directory,
        expected_nonce=expected_nonce,
        current_time=current_time,
    )


def _matching_ack(directory: Path, request: CheckpointRequest) -> bool:
    value = _read_json_object(directory / ACK_FILE_NAME)
    return checkpoint_acknowledged(
        value,
        nonce=request.nonce,
    )




def checkpoint_acknowledged(value: dict[str, Any] | None, *, nonce: str) -> bool:
    """The save callback completed for this original checkpoint request."""

    return bool(value is not None and value.get("nonce") == nonce
                and value.get("exit_code") == CHECKPOINT_EXIT_CODE)


def _acknowledgement(
    request: CheckpointRequest,
    save_metadata: dict[str, Any] | None,
    *,
    acknowledged_at: float,
) -> dict[str, Any]:
    if save_metadata is None:
        metadata: dict[str, Any] = {}
    elif isinstance(save_metadata, dict):
        metadata = dict(save_metadata)
    else:
        raise TypeError("save_fn must return a dict or None")
    if any(not isinstance(key, str) for key in metadata):
        raise TypeError("save_fn metadata keys must be strings")
    metadata = {key: value for key, value in metadata.items() if key not in _ACK_RESERVED_FIELDS}
    checkpoint_path = metadata.get("checkpoint_path")
    if checkpoint_path is not None and (
        not isinstance(checkpoint_path, str)
        or not checkpoint_path
        or not Path(checkpoint_path).is_absolute()
        or len(checkpoint_path) > 16_384
        or "\x00" in checkpoint_path
        or "\n" in checkpoint_path
        or "\r" in checkpoint_path
    ):
        raise ValueError(
            "checkpoint_path must be a non-empty absolute path without "
            "control characters"
        )
    payload = {
        "version": SCHEMA_VERSION,
        "nonce": request.nonce,
        "attempt_id": request.attempt_id,
        "requested_by_job_id": request.requested_by_job_id,
        "acknowledged_at": acknowledged_at,
        "exit_code": CHECKPOINT_EXIT_CODE,
        **metadata,
    }
    try:
        # atomic_write_json writes exactly this canonical encoding plus one
        # trailing newline, so this is also the on-disk protocol size.
        encoded = (json_dumps(payload) + "\n").encode("utf-8")
    except (TypeError, ValueError) as exc:
        raise ValueError(f"checkpoint acknowledgement is not valid JSON: {exc}") from exc
    if len(encoded) > _MAX_CONTROL_FILE_BYTES:
        raise ValueError(
            f"checkpoint acknowledgement exceeds {_MAX_CONTROL_FILE_BYTES} bytes"
        )
    return payload


def _checkpoint_at_epoch_end_locked(
    save_fn: SaveFunction,
    *,
    rank: int = 0,
    barrier: BarrierFunction | None = None,
    broadcast_decision: BroadcastDecisionFunction | None = None,
    control_dir: str | os.PathLike[str] | None = None,
    expected_nonce: str | None = None,
    clock: ClockFunction | None = None,
) -> bool:
    """Cooperatively checkpoint and terminate when a request is pending.

    Call this function on every participating rank after each completed epoch.
    ``save_fn`` runs on rank zero only and may return a dictionary (for example
    ``{"checkpoint_path": ..., "resume_epoch": ...}``) to merge into the ACK.
    When several ranks call the function, pass a distributed
    ``broadcast_decision`` that broadcasts a Python object from rank zero.
    A barrier may additionally fence the epoch boundary, but a shared file
    alone is intentionally not used for rank consensus: a rank-local I/O error
    must not let some ranks continue while others exit.

    The function returns ``False`` when no valid request remains.  On success it
    does not return: every rank that observes the matching ACK raises
    ``SystemExit(CHECKPOINT_EXIT_CODE)``. Save, ACK-write, collective, and
    barrier errors propagate; a failed save or write is never acknowledged.
    """

    if not callable(save_fn):
        raise TypeError("save_fn must be callable")
    if isinstance(rank, bool) or not isinstance(rank, int) or rank < 0:
        raise ValueError("rank must be a non-negative integer")
    if barrier is not None and not callable(barrier):
        raise TypeError("barrier must be callable or None")
    if broadcast_decision is not None and not callable(broadcast_decision):
        raise TypeError("broadcast_decision must be callable or None")

    directory = _control_directory(control_dir)
    if directory is None:
        return False
    if rank > 0 and broadcast_decision is None:
        raise ValueError(
            "non-zero checkpoint ranks require broadcast_decision"
        )
    if barrier is not None and broadcast_decision is None:
        raise ValueError(
            "distributed barrier use also requires broadcast_decision"
        )
    failure: BaseException | None = None
    request: CheckpointRequest | None = None
    decision: dict[str, Any] = {
        "version": SCHEMA_VERSION,
        "decision_nonce": os.urandom(16).hex() if rank == 0 else "",
        "status": "noop",
    }

    # The optional epoch fence is collective and therefore invoked by every
    # rank before rank zero examines or saves the request.
    if barrier is not None:
        barrier()

    if rank == 0:
        try:
            request = read_checkpoint_request(
                control_dir=directory,
                expected_nonce=expected_nonce,
                clock=clock,
            )
            if request is not None and _matching_ack(directory, request):
                acknowledged = True
            elif request is not None:
                save_metadata = save_fn()
                now = (clock or time.time)()
                if isinstance(now, bool) or not isinstance(now, (int, float)):
                    raise TypeError("clock must return a finite number")
                acknowledged_at = float(now)
                if not math.isfinite(acknowledged_at):
                    raise ValueError("clock must return a finite number")
                # checkpoint.lock is held throughout saving; withdrawal uses the same lock.
                payload = _acknowledgement(request, save_metadata, acknowledged_at=acknowledged_at)
                atomic_write_json(directory / ACK_FILE_NAME, payload, mode=0o600)
                acknowledged = True
            else:
                acknowledged = False
            if acknowledged and request is not None:
                decision = {
                    "version": SCHEMA_VERSION,
                    "decision_nonce": decision["decision_nonce"],
                    "status": "ack",
                    "nonce": request.nonce,
                    "attempt_id": request.attempt_id,
                    "requested_by_job_id": request.requested_by_job_id,
                }
        except BaseException as exc:
            failure = exc
            decision = {
                "version": SCHEMA_VERSION,
                "decision_nonce": decision["decision_nonce"],
                "status": "error",
                "error_type": type(exc).__name__[:128],
                "message": str(exc)[:2048],
            }

    if broadcast_decision is None:
        if failure is not None:
            raise failure
        if rank == 0 and decision["status"] == "ack":
            raise SystemExit(CHECKPOINT_EXIT_CODE)
        return False

    # Framework collective communication carries rank zero's save outcome to peers.
    observed = broadcast_decision(decision if rank == 0 else None)
    observed_error: BaseException | None = None
    if (
        not isinstance(observed, dict)
        or observed.get("status") not in {"noop", "ack", "error"}
    ):
        observed_error = CheckpointPeerError(
            "rank zero did not broadcast a valid checkpoint decision"
        )
    elif observed["status"] == "error" and rank != 0:
        observed_error = CheckpointPeerError(
            "rank zero checkpoint failed: "
            f"{observed.get('error_type', 'Error')}: "
            f"{observed.get('message', 'unknown error')}"
        )

    if barrier is not None:
        barrier()
    if failure is not None:
        raise failure
    if observed_error is not None:
        raise observed_error
    if observed is not None and observed.get("status") == "ack":
        raise SystemExit(CHECKPOINT_EXIT_CODE)
    return False


def checkpoint_at_epoch_end(
    save_fn: SaveFunction,
    *,
    rank: int = 0,
    barrier: BarrierFunction | None = None,
    broadcast_decision: BroadcastDecisionFunction | None = None,
    control_dir: str | os.PathLike[str] | None = None,
    expected_nonce: str | None = None,
    clock: ClockFunction | None = None,
) -> bool:
    """Cooperatively checkpoint at an epoch boundary.

    A shared protocol lock is held for the complete rank-local handshake.  It
    lets the coordinator withdraw an obsolete request only between adapter
    calls, never while a rank is saving or consuming the resulting ACK.
    """

    directory = _control_directory(control_dir)
    if directory is None:
        return False
    flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(directory / LOCK_FILE_NAME, flags, 0o600)
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError("checkpoint protocol lock is not a regular file")
        os.fchmod(descriptor, 0o600)
        fcntl.flock(descriptor, fcntl.LOCK_SH)
        return _checkpoint_at_epoch_end_locked(
            save_fn,
            rank=rank,
            barrier=barrier,
            broadcast_decision=broadcast_decision,
            control_dir=directory,
            expected_nonce=expected_nonce,
            clock=clock,
        )
    finally:
        os.close(descriptor)


__all__ = [
    "ACK_FILE_NAME",
    "CHECKPOINT_EXIT_CODE",
    "CheckpointPeerError",
    "CONTROL_DIR_ENV",
    "DECISION_FILE_NAME",
    "ERROR_FILE_NAME",
    "LOCK_FILE_NAME",
    "CheckpointRequest",
    "REQUEST_FILE_NAME",
    "checkpoint_at_epoch_end",
    "read_checkpoint_request",
    "resume_checkpoint_path",
]

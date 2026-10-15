from __future__ import annotations

import argparse
from collections import deque
from collections.abc import Callable, Mapping
import json
import math
import os
import shutil
import sys
import time
import unicodedata
import uuid
from pathlib import Path
from typing import Any, Sequence, TextIO

from .config import Config
from .constants import (
    CheckpointCapability,
    DispatchMode,
    MAX_PRIORITY,
    MIN_PRIORITY,
    RestartPolicy,
)
from .elastic import compatible_world_sizes
from .protocol import Client, ProtocolError
from .submission import validate_submission
from .util import ENV_NAME_RE, json_dumps, validate_label
from .job_display import labels as display_labels


DEFAULT_CONFIG = Path(os.environ.get("GPUQ_CONFIG", "/data1/gpu-scheduler/config.json"))
WATCH_POLL_SECONDS = 1.0
WATCH_EXIT_CODES = {
    "SUCCEEDED": 0,
    "FAILED": 1,
    "LOST": 3,
    "CANCELED": 4,
}
CAPTURE_ENV_EXACT = {
    "PATH",
    "CONDA_PREFIX",
    "CONDA_DEFAULT_ENV",
    "VIRTUAL_ENV",
    "LD_LIBRARY_PATH",
    "PYTHONPATH",
    "CUDA_HOME",
    "CUDA_PATH",
    "HF_HOME",
    "TORCH_HOME",
    "XDG_CACHE_HOME",
    "OMP_NUM_THREADS",
    "MKL_NUM_THREADS",
}
CAPTURE_ENV_PREFIXES = ("NCCL_", "TORCH_", "PYTORCH_")
RESERVED_ENV = {
    "CUDA_VISIBLE_DEVICES",
    "NVIDIA_VISIBLE_DEVICES",
    "GPUQ_JOB_ID",
    "GPUQ_ATTEMPT_ID",
    "GPUQ_CONTROL_DIR",
    "GPUQ_ASSIGNED_GPU_UUIDS",
    "GPUQ_ASSIGNED_GPU_INDICES",
    "GPUQ_ASSIGNED_GPU_COUNT",
    "GPUQ_ACTUAL_GPU_COUNT",
    "GPUQ_MIN_GPU_COUNT",
    "GPUQ_MAX_GPU_COUNT",
    "GPUQ_PREVIOUS_GPU_COUNT",
    "GPUQ_WORLD_SIZE",
    "GPUQ_MIN_WORLD_SIZE",
    "GPUQ_MAX_WORLD_SIZE",
    "GPUQ_PREVIOUS_WORLD_SIZE",
    "GPUQ_TARGET_GLOBAL_BATCH_SIZE",
    "GPUQ_PER_DEVICE_MICRO_BATCH_SIZE",
    "GPUQ_ALLOWED_GPU_COUNTS",
    "GPUQ_RESUME_CHECKPOINT",
}
UNSUPPORTED_LAUNCHERS = {
    "docker",
    "podman",
    "systemd-run",
    "tmux",
    "screen",
    "sudo",
    "su",
}


def parse_priority(raw: str) -> int:
    value = raw.upper()
    if value.startswith("P"):
        value = value[1:]
    try:
        number = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("priority must be P0..P4") from exc
    if not MIN_PRIORITY <= number <= MAX_PRIORITY:
        raise argparse.ArgumentTypeError("priority must be P0..P4")
    return number


def parse_gpu_indices(raw: str) -> list[int]:
    parts = [item.strip() for item in raw.split(",")]
    if not parts or any(not item for item in parts):
        raise argparse.ArgumentTypeError(
            "fixed GPUs must be comma-separated indices, for example 4,6"
        )
    try:
        indices = [int(item) for item in parts]
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "fixed GPU indices must be non-negative integers"
        ) from exc
    if any(index < 0 for index in indices):
        raise argparse.ArgumentTypeError(
            "fixed GPU indices must be non-negative integers"
        )
    if len(set(indices)) != len(indices):
        raise argparse.ArgumentTypeError(
            "fixed GPU indices must not contain duplicates"
        )
    return indices


def resolve_pinned_gpu_uuids(
    indices: Sequence[int],
    managed_gpu_uuids: Sequence[str],
) -> list[str]:
    """Resolve user-facing indices once and persist physical UUID identity."""

    from .backends import NvidiaSmiProvider

    if not indices:
        raise ValueError("at least one fixed GPU index is required")
    if len(set(indices)) != len(indices):
        raise ValueError("fixed GPU indices must not contain duplicates")
    devices = NvidiaSmiProvider().snapshot()
    by_index = {device.index: device.uuid for device in devices}
    missing = [index for index in indices if index not in by_index]
    if missing:
        raise ValueError(
            "GPU index is not present: " + ", ".join(str(index) for index in missing)
        )
    managed = set(managed_gpu_uuids)
    requested = [by_index[index] for index in indices]
    outside = [
        index
        for index, uuid_value in zip(indices, requested)
        if uuid_value not in managed
    ]
    if outside:
        raise ValueError(
            "fixed GPU indices are outside the managed pool: "
            + ", ".join(str(index) for index in outside)
        )
    return requested


def parse_env(items: Sequence[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for item in items:
        if "=" not in item:
            raise ValueError(f"--env requires KEY=VALUE, got: {item!r}")
        key, value = item.split("=", 1)
        if not ENV_NAME_RE.fullmatch(key):
            raise ValueError(f"invalid environment variable name: {key!r}")
        console_oci = key == "GPUQ_CONSOLE_OCI" and value == "1"
        if key in RESERVED_ENV or (key.startswith("GPUQ_") and not console_oci):
            raise ValueError(f"environment variable is managed by gpuq: {key}")
        if "\x00" in value or "\n" in value or "\r" in value:
            raise ValueError(f"environment value contains a forbidden control: {key}")
        result[key] = value
    return result


def captured_environment() -> dict[str, str]:
    result: dict[str, str] = {}
    for key, value in os.environ.items():
        if key in RESERVED_ENV or key.startswith("GPUQ_"):
            continue
        if key in CAPTURE_ENV_EXACT or key.startswith(CAPTURE_ENV_PREFIXES):
            if "\x00" not in value and "\n" not in value and "\r" not in value:
                result[key] = value
    if "PATH" not in result:
        result["PATH"] = os.defpath
    return result


def default_owner() -> str:
    # GPUQ_OWNER remains supported for existing shell profiles.
    configured = os.environ.get("GPUQ_SUBMITTER") or os.environ.get("GPUQ_OWNER")
    if configured:
        return validate_label(configured, "owner")
    connection = os.environ.get("SSH_CONNECTION", "").split()
    if connection:
        candidate = f"{os.environ.get('USER', 'user')}@{connection[0]}"
        if len(candidate) <= 64:
            return validate_label(candidate, "owner")
    return validate_label(os.environ.get("USER", "unknown"), "owner")


def _script_argument(arguments: Sequence[str]) -> str | None:
    """Return the most likely user entry point from launcher arguments."""

    after_separator = False
    for argument in arguments:
        if argument == "--":
            after_separator = True
            continue
        if not after_separator and argument.startswith("-"):
            continue
        suffix = Path(argument).suffix.lower()
        if suffix in {".py", ".pyw", ".sh", ".bash"}:
            return Path(argument).name
    return None


def default_job_name(command: Sequence[str]) -> str:
    """Infer a useful task name instead of usually returning ``python``.

    Explicit ``--name`` always wins.  This inference only recognizes common
    Python and distributed launch forms and safely falls back to the executable
    name for unfamiliar commands.
    """

    if not command:
        return "job"
    executable = Path(command[0]).name
    lowered = executable.lower()
    arguments = list(command[1:])
    is_python = lowered == "python" or lowered.startswith(("python3", "pypy"))
    candidate: str | None = None
    if is_python:
        index = 0
        while index < len(arguments):
            argument = arguments[index]
            if argument == "-m" and index + 1 < len(arguments):
                module = arguments[index + 1]
                if module in {"torch.distributed.run", "torch.distributed.launch"}:
                    candidate = _script_argument(arguments[index + 2 :]) or module
                else:
                    candidate = module
                break
            if argument in {"-c", "-"}:
                break
            if argument in {"-W", "-X"} and index + 1 < len(arguments):
                index += 2
                continue
            if not argument.startswith("-"):
                candidate = Path(argument).name
                break
            index += 1
    elif lowered in {"torchrun", "deepspeed", "accelerate"}:
        candidate = _script_argument(arguments)
    elif lowered in {"bash", "sh"}:
        candidate = _script_argument(arguments)
    if candidate is None:
        candidate = executable or "job"
    # Preserve the daemon's existing safe-label protocol: inferred filenames
    # may contain spaces or shell punctuation even though display labels may
    # not.  Replacing those characters keeps automatic naming fail-safe.
    safe = "".join(
        (
            character
            if character.isascii() and (character.isalnum() or character in "_.@:+-")
            else "-"
        )
        for character in candidate
    )
    if not safe or not safe[0].isalnum():
        safe = "job-" + safe.lstrip("_.@:+-")
    return safe[:64].rstrip("_.@:+-") or "job"


def resolve_job_identity(
    command: Sequence[str],
    *,
    requested_name: str | None,
    requested_owner: str | None,
) -> tuple[str, str]:
    """Resolve validated display identity, with explicit values taking priority."""

    owner_value = requested_owner if requested_owner is not None else default_owner()
    name_value = (
        requested_name if requested_name is not None else default_job_name(command)
    )
    return (
        validate_label(name_value, "name"),
        validate_label(owner_value, "owner"),
    )


def resolve_workdir(raw: str | None) -> Path:
    path = Path(raw) if raw else Path.cwd()
    try:
        resolved = path.expanduser().resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise ValueError(f"working directory is not accessible: {path}: {exc}") from exc
    if not resolved.is_dir():
        raise ValueError(f"working directory is not a directory: {resolved}")
    return resolved


def resolve_command(
    command: Sequence[str], cwd: Path, env: dict[str, str]
) -> list[str]:
    if not command:
        raise ValueError("missing command after --")
    if command[0] == "--":
        command = command[1:]
    if not command:
        raise ValueError("missing command after --")
    clean: list[str] = []
    for argument in command:
        if "\x00" in argument:
            raise ValueError("command arguments may not contain NUL")
        clean.append(argument)
    executable = clean[0]
    if "/" in executable:
        candidate = Path(executable)
        if not candidate.is_absolute():
            candidate = cwd / candidate
        try:
            resolved = candidate.resolve(strict=True)
        except (OSError, RuntimeError) as exc:
            raise ValueError(f"executable does not exist: {candidate}") from exc
        if not resolved.is_file() or not os.access(resolved, os.X_OK):
            raise ValueError(f"executable is not executable: {resolved}")
        clean[0] = str(resolved)
    else:
        resolved_name = shutil.which(executable, path=env.get("PATH"))
        if resolved_name is None:
            raise ValueError(f"executable not found in PATH: {executable}")
        clean[0] = str(Path(resolved_name).resolve())
    if Path(clean[0]).name in UNSUPPORTED_LAUNCHERS:
        raise ValueError(
            f"{Path(clean[0]).name} is not supported in gpuq v1 because it can "
            "escape the managed systemd cgroup"
        )
    return clean


def get_client(args: argparse.Namespace) -> Client:
    config = Config.from_json(args.config)
    return Client(
        config.socket_path,
        max_request_bytes=config.max_request_bytes,
    )


def print_result(result: Any, as_json: bool) -> None:
    if as_json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
        return
    if isinstance(result, str):
        print(result)
        return
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))


def _safe_display_text(value: Any, fallback: str = "-") -> str:
    if value is None:
        return fallback
    text = str(value)
    if not text:
        return fallback
    # Old database rows predate the current display-text validator.  Never let
    # an unexpected control byte in a legacy row alter the caller's terminal.
    return "".join(character if character.isprintable() else "?" for character in text)


def _display_width(value: str) -> int:
    width = 0
    for character in value:
        if unicodedata.combining(character):
            continue
        width += 2 if unicodedata.east_asian_width(character) in {"F", "W"} else 1
    return width


def _fit_display_cell(value: str, width: int, *, pad: bool = True) -> str:
    if width < 1:
        return ""
    if _display_width(value) > width:
        budget = width - 1
        consumed = 0
        kept: list[str] = []
        for character in value:
            character_width = (
                0
                if unicodedata.combining(character)
                else 2 if unicodedata.east_asian_width(character) in {"F", "W"} else 1
            )
            if consumed + character_width > budget:
                break
            kept.append(character)
            consumed += character_width
        value = "".join(kept) + "…"
    if not pad:
        return value
    return value + " " * max(0, width - _display_width(value))


class _WatchPayloadError(ProtocolError):
    """The daemon returned a syntactically valid but unusable watch payload."""


def _watch_text(value: Any, *, maximum: int = 160, fallback: str = "-") -> str:
    text = _safe_display_text(value, fallback=fallback)
    if len(text) <= maximum:
        return text
    return text[: max(0, maximum - 1)] + "…"


def _finite_number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    return number if math.isfinite(number) else None


def _format_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else f"{value:.6g}"


def _format_duration(value: Any) -> str | None:
    number = _finite_number(value)
    if number is None or number < 0:
        return None
    seconds = int(number)
    days, remainder = divmod(seconds, 86_400)
    hours, remainder = divmod(remainder, 3_600)
    minutes, seconds = divmod(remainder, 60)
    if days:
        return f"{days}d{hours:02d}h"
    if hours:
        return f"{hours}h{minutes:02d}m"
    if minutes:
        return f"{minutes}m{seconds:02d}s"
    return f"{seconds}s"


def _progress_counter(
    snapshot: Mapping[str, Any],
) -> tuple[str, float | None, float | None] | None:
    # Steps are the most precise signal.  Epochs remain useful for jobs that
    # intentionally report only at checkpoint boundaries.
    for label, completed_key, total_key in (
        ("steps", "steps_completed", "steps_total"),
        ("epochs", "epochs_completed", "epochs_total"),
    ):
        completed = _finite_number(snapshot.get(completed_key))
        total = _finite_number(snapshot.get(total_key))
        if completed is not None or total is not None:
            return label, completed, total
    return None


def _format_progress(progress: Any) -> list[str]:
    if progress is None:
        return ["progress=-"]
    if not isinstance(progress, Mapping):
        return ["progress=invalid"]
    reported = progress.get("reported") is True
    snapshot = progress.get("snapshot")
    if not reported or not isinstance(snapshot, Mapping):
        progress_error = progress.get("error")
        if progress_error is not None and progress_error != "":
            return ["progress=invalid-report"]
        return ["progress=not-reported"]

    parts: list[str] = []
    counter = _progress_counter(snapshot)
    if counter is None:
        parts.append("progress=reported")
    else:
        label, completed, total = counter
        if completed is not None and total is not None:
            value = f"{label}={_format_number(completed)}/{_format_number(total)}"
            if total > 0:
                value += f"({100.0 * completed / total:.1f}%)"
        elif completed is not None:
            value = f"{label}={_format_number(completed)}"
        else:
            assert total is not None
            value = f"{label}=?/{_format_number(total)}"
        parts.append(value)

    phase = snapshot.get("phase")
    if phase is not None and phase != "":
        parts.append(f"phase={_watch_text(phase, maximum=48)}")
    severity = snapshot.get("severity")
    if severity is not None and severity not in ("", "info", "normal"):
        parts.append(f"severity={_watch_text(severity, maximum=24)}")

    metrics = snapshot.get("metrics")
    if isinstance(metrics, Mapping):
        rendered_metrics: list[str] = []
        for raw_key in sorted(metrics, key=lambda item: str(item)):
            number = _finite_number(metrics[raw_key])
            if number is None:
                continue
            key = _watch_text(raw_key, maximum=32)
            rendered_metrics.append(f"{key}={_format_number(number)}")
            if len(rendered_metrics) == 4:
                break
        if rendered_metrics:
            parts.append("metrics=" + ",".join(rendered_metrics))

    eta = _format_duration(snapshot.get("eta_seconds"))
    if eta is not None:
        parts.append(f"eta={eta}")
    progress_age_value = progress.get(
        "progress_age_seconds",
        progress.get("heartbeat_age_seconds"),
    )
    heartbeat_age = _format_duration(progress_age_value)
    if progress.get("stale") is True:
        parts.append(
            "progress_age=stale" + (f"({heartbeat_age})" if heartbeat_age else "")
        )
    elif heartbeat_age is not None:
        parts.append(f"progress_age={heartbeat_age}")
    message = snapshot.get("message")
    if message is not None and message != "":
        parts.append(f"message={_watch_text(message, maximum=96)}")
    return parts


def _attempt_gpu_indices(attempt: Mapping[str, Any]) -> list[int]:
    raw = attempt.get("gpu_indices", attempt.get("assigned_gpu_indices"))
    if not isinstance(raw, (list, tuple)):
        return []
    return [
        value
        for value in raw
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0
    ]


def format_watch_line(
    result: Mapping[str, Any],
    *,
    now: float | None = None,
) -> str:
    job = result["job"]
    assert isinstance(job, Mapping)
    current_time = time.time() if now is None else now
    job_id = _watch_text(job.get("id"), maximum=32)
    submitter, task_name = display_labels(job)
    owner = _watch_text(submitter, maximum=96)
    name = _watch_text(task_name, maximum=64)
    state = _watch_text(job.get("state"), maximum=32)
    parts = [job_id, f"{owner}/{name}", f"state={state}"]
    started_at = _finite_number(job.get("started_at"))
    finished_at = _finite_number(job.get("finished_at"))
    created_at = _finite_number(job.get("created_at"))
    if started_at is not None:
        end = finished_at if finished_at is not None else current_time
        if end >= started_at:
            runtime = _format_duration(end - started_at)
            if runtime is not None:
                parts.append(f"runtime={runtime}")
    elif state == "PENDING" and created_at is not None and current_time >= created_at:
        queued = _format_duration(current_time - created_at)
        if queued is not None:
            parts.append(f"queued={queued}")
    reason = job.get("state_reason")
    if reason is not None and reason != "":
        parts.append(f"reason={_watch_text(reason, maximum=128)}")

    attempt = result.get("latest_attempt")
    if isinstance(attempt, Mapping):
        attempt_id = _watch_text(attempt.get("id"), maximum=32)
        ordinal = attempt.get("ordinal")
        ordinal_text = (
            str(ordinal)
            if isinstance(ordinal, int)
            and not isinstance(ordinal, bool)
            and ordinal > 0
            else "?"
        )
        attempt_state = _watch_text(attempt.get("state"), maximum=32)
        parts.append(f"attempt={ordinal_text}:{attempt_id}/{attempt_state}")
        indices = _attempt_gpu_indices(attempt)
        if indices:
            parts.append("gpu=" + ",".join(str(value) for value in indices))
        exit_code = attempt.get("exit_code")
        if isinstance(exit_code, int) and not isinstance(exit_code, bool):
            parts.append(f"exit={exit_code}")
        failure_reason = attempt.get("failure_reason")
        if failure_reason is not None and failure_reason != "":
            parts.append(f"attempt_error={_watch_text(failure_reason, maximum=128)}")

    parts.extend(_format_progress(result.get("progress")))
    latest_event_id = result.get("latest_event_id")
    if (
        isinstance(latest_event_id, int)
        and not isinstance(latest_event_id, bool)
        and latest_event_id >= 0
    ):
        parts.append(f"event=#{latest_event_id}")
    return "  ".join(parts)


def _freeze_watch_value(value: Any) -> Any:
    if isinstance(value, Mapping):
        return tuple(
            sorted((str(key), _freeze_watch_value(item)) for key, item in value.items())
        )
    if isinstance(value, (list, tuple)):
        return tuple(_freeze_watch_value(item) for item in value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    return _watch_text(value)


def _watch_signature(result: Mapping[str, Any]) -> tuple[Any, ...]:
    job = result["job"]
    assert isinstance(job, Mapping)
    attempt = result.get("latest_attempt")
    attempt_fields: Mapping[str, Any] = attempt if isinstance(attempt, Mapping) else {}
    progress = result.get("progress")
    if isinstance(progress, Mapping):
        snapshot = progress.get("snapshot")
        snapshot_fields = (
            {
                key: value
                for key, value in snapshot.items()
                if key not in {"sequence", "updated_at"}
            }
            if isinstance(snapshot, Mapping)
            else None
        )
        progress_signature = (
            progress.get("reported"),
            progress.get("stale"),
            progress.get("error") is not None and progress.get("error") != "",
            _freeze_watch_value(snapshot_fields),
        )
    else:
        progress_signature = None
    return (
        job.get("id"),
        job.get("owner"),
        job.get("name"),
        _freeze_watch_value(job.get("display_metadata")),
        job.get("state"),
        job.get("state_reason"),
        tuple(
            attempt_fields.get(key)
            for key in (
                "id",
                "ordinal",
                "state",
                "exit_code",
                "failure_reason",
                "finished_at",
            )
        ),
        tuple(_attempt_gpu_indices(attempt_fields)),
        progress_signature,
        result.get("latest_event_id"),
    )


def _normalize_watch_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, Mapping):
        raise _WatchPayloadError("daemon returned an invalid job_watch result")
    job = result.get("job")
    if not isinstance(job, Mapping):
        raise _WatchPayloadError("job_watch result omitted a valid job")
    state = job.get("state")
    if not isinstance(state, str) or not state:
        raise _WatchPayloadError("job_watch result omitted a valid job state")
    attempt = result.get("latest_attempt")
    if attempt is not None and not isinstance(attempt, Mapping):
        raise _WatchPayloadError("job_watch result contains an invalid attempt")
    progress = result.get("progress")
    if progress is not None and not isinstance(progress, Mapping):
        raise _WatchPayloadError("job_watch result contains invalid progress")
    latest_event_id = result.get("latest_event_id")
    if latest_event_id is not None and (
        isinstance(latest_event_id, bool)
        or not isinstance(latest_event_id, int)
        or latest_event_id < 0
    ):
        raise _WatchPayloadError("job_watch result contains an invalid event id")
    return {
        "job": dict(job),
        "latest_attempt": dict(attempt) if isinstance(attempt, Mapping) else None,
        "progress": dict(progress) if isinstance(progress, Mapping) else None,
        "latest_event_id": latest_event_id,
    }


def _watch_error_is_permanent(error: ProtocolError) -> bool:
    message = str(error).lstrip().upper()
    return message.startswith(("NOT_FOUND:", "BAD_REQUEST:", "CONFLICT:"))


def _stream_isatty(stream: TextIO) -> bool:
    try:
        return bool(stream.isatty())
    except (AttributeError, OSError):
        return False


def _stream_width(stream: TextIO) -> int:
    try:
        return max(1, os.get_terminal_size(stream.fileno()).columns - 1)
    except (AttributeError, OSError, ValueError):
        return 119


def watch_job(
    client: Client,
    job_id: str,
    *,
    output: TextIO | None = None,
    error_output: TextIO | None = None,
    sleeper: Callable[[float], None] | None = None,
    clock: Callable[[], float] | None = None,
    poll_interval: float = WATCH_POLL_SECONDS,
    is_tty: bool | None = None,
) -> int:
    """Watch one job without attaching the training process to this terminal."""

    if not isinstance(job_id, str) or not job_id:
        raise ValueError("job_id must be a non-empty string")
    if isinstance(poll_interval, bool) or poll_interval < 0:
        raise ValueError("watch poll interval must be non-negative")
    # Keep non-optional locals for the nested render helpers.  Some analyzers
    # intentionally do not preserve narrowing for captured parameters.
    output_stream: TextIO = sys.stdout if output is None else output
    error_stream: TextIO = sys.stderr if error_output is None else error_output
    sleeper = sleeper or time.sleep
    clock = clock or time.time
    tty = _stream_isatty(output_stream) if is_tty is None else is_tty
    consecutive_errors = 0
    last_signature: tuple[Any, ...] | None = None
    tty_line_active = False
    tty_line_width = 0

    def finish_tty_line() -> None:
        nonlocal tty_line_active, tty_line_width
        if tty and tty_line_active:
            output_stream.write("\n")
            output_stream.flush()
            tty_line_active = False
            tty_line_width = 0

    def refresh_tty_line(line: str) -> None:
        nonlocal tty_line_active, tty_line_width
        fitted = _fit_display_cell(line, _stream_width(output_stream), pad=False)
        width = _display_width(fitted)
        output_stream.write("\r" + fitted + " " * max(0, tty_line_width - width))
        output_stream.flush()
        tty_line_active = True
        tty_line_width = width

    try:
        while True:
            try:
                raw = client.call("job_watch", {"job_id": job_id})
                result = _normalize_watch_result(raw)
            except _WatchPayloadError as exc:
                print(f"gpu watch: node status is unknown ({exc}); query again with the same job number", file=error_stream, flush=True)
                sleeper(poll_interval)
                continue
            except ProtocolError as exc:
                if _watch_error_is_permanent(exc):
                    raise
                consecutive_errors += 1
                retry_line = (
                    f"{_watch_text(job_id, maximum=32)}  daemon temporarily "
                    f"unavailable; waiting to retry ({consecutive_errors})"
                )
                if tty:
                    refresh_tty_line(retry_line)
                else:
                    print(f"gpu watch: {retry_line}", file=error_stream, flush=True)
                sleeper(poll_interval)
                continue

            recovered = consecutive_errors > 0
            consecutive_errors = 0
            if recovered and not tty:
                print("gpu watch: daemon connection recovered", file=error_stream)

            line = format_watch_line(result, now=clock())
            signature = _watch_signature(result)
            if tty:
                refresh_tty_line(line)
            elif signature != last_signature:
                print(line, file=output_stream, flush=True)
            last_signature = signature

            state = result["job"]["state"]
            if state in WATCH_EXIT_CODES:
                finish_tty_line()
                return WATCH_EXIT_CODES[state]
            sleeper(poll_interval)
    except KeyboardInterrupt:
        finish_tty_line()
        print(
            f"gpu watch: detached from {_watch_text(job_id, maximum=32)}; "
            "the job continues under gpuq",
            file=error_stream,
            flush=True,
        )
        return 130
    except BaseException:
        finish_tty_line()
        raise


def _job_placement(job: dict[str, Any], current_indices: dict[str, str]) -> str:
    if job.get("share_gpu"):
        indices = ",".join(
            current_indices.get(str(u), str(u))
            for u in job.get("requested_gpu_uuids", [])
        )
        label = f"@{indices}/shared:{job.get('vram_mb', 0) / 1024:g}GiB"
        return label + (f"/HAMi:SM{job['sm_percent']}%" if job.get("hami_core") else "")
    if job.get("placement") == "pinned":
        return "@" + ",".join(
            current_indices.get(str(uuid_value), str(uuid_value))
            for uuid_value in job.get("requested_gpu_uuids", [])
        )
    gpu_count = job.get("gpu_count", "-")
    if not job.get("elastic_gpu_count"):
        return str(gpu_count)
    minimum = job.get("min_gpu_count", gpu_count)
    assigned = job.get("assigned_gpu_count")
    scale_target = job.get("scale_target_gpu_count")
    scaling = (
        isinstance(assigned, int)
        and not isinstance(assigned, bool)
        and isinstance(scale_target, int)
        and not isinstance(scale_target, bool)
        and scale_target > assigned
    )
    target = job.get("target_global_batch_size")
    micro_batch = job.get("per_device_micro_batch_size")
    if (
        target is not None
        and micro_batch is not None
        and isinstance(minimum, int)
        and isinstance(gpu_count, int)
    ):
        allowed = compatible_world_sizes(target, micro_batch, minimum, gpu_count)
        requested_range = "{" + ",".join(map(str, allowed)) + "}"
        if scaling:
            return f"{assigned}→{scale_target}{requested_range}"
        return requested_range if assigned is None else f"{assigned}{requested_range}"
    requested_range = f"{minimum}-{gpu_count}"
    if scaling:
        return f"{assigned}→{scale_target}[{requested_range}]"
    return requested_range if assigned is None else f"{assigned}[{requested_range}]"


def format_status_table(
    jobs: Sequence[dict[str, Any]],
    current_indices: dict[str, str],
) -> list[str]:
    """Format the human queue while keeping JSON/API fields unchanged.

    Submitter and task name are intentionally never truncated.  TASK NAME is
    last so a long descriptive name cannot hide the short ID and operational
    state needed to inspect or cancel the job.
    """

    headers = (
        "JOB ID",
        "PRI",
        "MODE",
        "GPU/PLACE",
        "STATE",
        "SUBMITTER",
        "TASK NAME",
    )
    rows: list[tuple[str, ...]] = []
    for job in jobs:
        priority = job.get("priority_name")
        if not priority:
            raw_priority = job.get("priority")
            priority = f"P{raw_priority}" if raw_priority is not None else "-"
        rows.append(
            (
                _safe_display_text(job.get("id")),
                _safe_display_text(priority),
                _safe_display_text(job.get("dispatch_mode")),
                _safe_display_text(_job_placement(job, current_indices)),
                _safe_display_text(job.get("state")),
                _safe_display_text(display_labels(job)[0]),
                _safe_display_text(display_labels(job)[1]),
            )
        )
    natural_widths = [
        max(
            (
                _display_width(header),
                *(_display_width(row[index]) for row in rows),
            )
        )
        for index, header in enumerate(headers)
    ]
    widths = natural_widths

    def render(values: Sequence[str]) -> str:
        cells = [
            _fit_display_cell(value, widths[index], pad=index < len(values) - 1)
            for index, value in enumerate(values)
        ]
        return "  ".join(cells)

    return [render(headers), *(render(row) for row in rows)]


def prepare_submission(args: argparse.Namespace) -> tuple[Config, dict[str, Any]]:
    watch_after_submit = bool(getattr(args, "watch", False))
    if watch_after_submit and getattr(args, "json", False):
        raise ValueError(
            "--watch cannot be combined with --json; submit first, then use "
            "'gpu watch JOB_ID' for an interactive view"
        )
    config = Config.from_json(args.config)
    workdir = resolve_workdir(args.cwd)
    environment = captured_environment()
    environment.update(parse_env(args.env))
    command = resolve_command(args.command, workdir, environment)
    name, owner = resolve_job_identity(
        command,
        requested_name=args.name,
        requested_owner=args.owner,
    )
    fixed_indices = getattr(args, "gpu_indices", None)
    share_gpu = bool(getattr(args, "share", False))
    vram_gb = getattr(args, "vram_gb", None)
    if vram_gb is not None and (
        not math.isfinite(vram_gb) or not 0 < vram_gb <= (2**31 - 1) / 1024
    ):
        raise ValueError("--vram-gb must be positive and finite")
    vram_mb = None if vram_gb is None else math.ceil(vram_gb * 1024)
    requested_min_gpus = getattr(args, "min_gpus", None)
    elastic_start = bool(getattr(args, "elastic_start", False))
    auto_scale_up = getattr(args, "auto_scale_up", False)
    if not isinstance(auto_scale_up, bool):
        raise ValueError("--auto-expand must be a boolean flag")
    target_global_batch_size = getattr(args, "global_batch", None)
    per_device_micro_batch_size = getattr(args, "micro_batch", None)
    if (target_global_batch_size is None) != (per_device_micro_batch_size is None):
        raise ValueError("--global-batch and --micro-batch must be provided together")
    if target_global_batch_size is not None and (
        not elastic_start or fixed_indices is not None
    ):
        raise ValueError(
            "--global-batch and --micro-batch require arbitrary placement "
            "with --elastic-start"
        )
    if auto_scale_up:
        if not elastic_start or fixed_indices is not None:
            raise ValueError(
                "--auto-expand requires arbitrary placement with --elastic-start"
            )
        if not args.checkpointable:
            raise ValueError("--auto-expand requires --checkpointable")
        if args.restart_policy != RestartPolicy.ON_PREEMPT.value:
            raise ValueError("--auto-expand requires --restart-policy on-preempt")
        if target_global_batch_size is None:
            raise ValueError("--auto-expand requires --global-batch and --micro-batch")
    if fixed_indices is None:
        if args.gpus is None:
            raise ValueError("provide --gpus or --gpu")
        placement = "any"
        gpu_count = args.gpus
        if elastic_start:
            if requested_min_gpus is None:
                raise ValueError("--elastic-start requires --min-gpus")
            min_gpu_count = requested_min_gpus
        else:
            if requested_min_gpus is not None:
                raise ValueError("--min-gpus requires --elastic-start")
            min_gpu_count = gpu_count
        requested_gpu_uuids: list[str] = []
    else:
        if elastic_start or requested_min_gpus is not None:
            raise ValueError(
                "--elastic-start and --min-gpus require arbitrary placement "
                "with --gpus"
            )
        placement = "pinned"
        gpu_count = len(fixed_indices)
        min_gpu_count = gpu_count
        requested_gpu_uuids = resolve_pinned_gpu_uuids(
            fixed_indices, config.managed_gpu_uuids
        )
    submission = {
        "hami_core": bool(
            getattr(args, "hami", False)
            or getattr(args, "sm_percent", None) is not None
        ),
        "sm_percent": getattr(args, "sm_percent", None),
        "share_gpu": share_gpu,
        "vram_mb": vram_mb,
        "submit_key": args.submit_key or str(uuid.uuid4()),
        "name": name,
        "owner": owner,
        "priority": args.priority,
        "dispatch_mode": args.mode,
        "yield_policy": getattr(args, "yield_policy", "legacy"),
        "preempt_idle_only": bool(getattr(args, "preempt_idle_only", False)),
        "preempt_opt_in_only": bool(getattr(args, "preempt_opt_in_only", False)),
        "checkpoint_capability": (
            CheckpointCapability.EPOCH_V1.value
            if args.checkpointable
            else CheckpointCapability.NONE.value
        ),
        "restart_policy": args.restart_policy,
        "gpu_count": gpu_count,
        "min_gpu_count": min_gpu_count,
        "elastic_gpu_count": elastic_start,
        "auto_scale_up": auto_scale_up,
        "target_global_batch_size": target_global_batch_size,
        "per_device_micro_batch_size": per_device_micro_batch_size,
        "placement": placement,
        "requested_gpu_uuids": requested_gpu_uuids,
        "argv": command,
        "cwd": str(workdir),
        "env": environment,
    }
    submission = validate_submission(
        submission,
        len(config.managed_gpu_uuids),
        max_request_bytes=config.max_request_bytes,
        managed_gpu_uuids=tuple(config.managed_gpu_uuids),
    )
    return config, submission


def cmd_submit(args: argparse.Namespace) -> int:
    config, submission = prepare_submission(args)
    watch_after_submit = bool(getattr(args, "watch", False))
    client = Client(
        config.socket_path,
        max_request_bytes=config.max_request_bytes,
    )
    try:
        result = client.call("submit", submission, request_id=submission["submit_key"])
    except ProtocolError as exc:
        raise ProtocolError(
            f"{exc}; submission key={submission['submit_key']} "
            "(reuse with --submit-key to query/retry idempotently)"
        ) from exc
    print_result(result, args.json)
    if watch_after_submit:
        if not isinstance(result, Mapping) or not isinstance(result.get("job_id"), str):
            raise ProtocolError("submit result omitted a valid job_id for --watch")
        return watch_job(client, result["job_id"])
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    result = get_client(args).call(
        "status",
        {
            "all": args.all,
            "limit": args.limit,
        },
    )
    if args.json:
        print_result(result, True)
        return 0
    daemon = result["daemon"]
    capacity_fields: list[str] = []
    capacity_health = daemon.get("capacity_health")
    if isinstance(capacity_health, str) and capacity_health in {
        "ok",
        "partial",
        "blocked",
    }:
        capacity_fields.append(f"capacity={capacity_health}")
    quarantined = daemon.get("quarantined_gpus")
    if isinstance(quarantined, list):
        quarantine_indices = sorted(
            {
                item["index"]
                for item in quarantined
                if isinstance(item, Mapping)
                and isinstance(item.get("index"), int)
                and not isinstance(item.get("index"), bool)
                and item["index"] >= 0
            }
        )
        if quarantine_indices:
            capacity_fields.append(
                "quarantine=" + ",".join(str(item) for item in quarantine_indices)
            )
    schedulable = daemon.get("schedulable_gpu_indices")
    if isinstance(schedulable, list) and all(
        isinstance(item, int) and not isinstance(item, bool) and item >= 0
        for item in schedulable
    ):
        capacity_fields.append(
            "schedulable="
            + (",".join(str(item) for item in sorted(set(schedulable))) or "-")
        )
    capacity_suffix = "" if not capacity_fields else "; " + "; ".join(capacity_fields)
    print(
        f"gpuq: {'observe-only' if daemon['observe_only'] else 'active'}; "
        f"health={daemon['health']}{capacity_suffix}; "
        f"pool={','.join(daemon['managed_indices'])}"
    )
    current_indices = {
        item["uuid"]: str(item["index"]) for item in daemon.get("managed_gpus", [])
    }
    for line in format_status_table(result["jobs"], current_indices):
        print(line)
    usage = result.get("gpu_usage", [])
    if usage:
        print("GPU  VRAM USED/TOTAL MiB  SHARED JOBS  SHARE BUDGET/HEADROOM MiB")
        for item in usage:
            print(
                f"{item['index']:>3}  {item['memory_used_mb']:>7}/{item['memory_total_mb']:<7}  {item['shared_jobs']:>11}  {item['shared_reserved_mb']}/{item['sharing_headroom_mb']}"
            )
    external = result.get("external", [])
    if external:
        print("protected external GPU processes:")
        for item in external:
            print(
                f"  GPU {item['index']} {item['uuid']} "
                f"pid={','.join(str(pid) for pid in item['pids'])}"
            )
    return 0


def cmd_show(args: argparse.Namespace) -> int:
    arguments = {"job_id": args.job_id}
    for name in ("history_before_id", "history_limit"):
        if getattr(args, name, None) is not None:
            arguments[name] = getattr(args, name)
    result = get_client(args).call("show", arguments)
    print_result(result, args.json)
    return 0


def cmd_cancel(args: argparse.Namespace) -> int:
    result = get_client(args).call("cancel", {"job_id": args.job_id})
    print_result(result, args.json)
    return 0


def cmd_retry(args: argparse.Namespace) -> int:
    result = get_client(args).call("retry", {"job_id": args.job_id})
    print_result(result, args.json)
    return 0


def cmd_set_display(args: argparse.Namespace) -> int:
    result = get_client(args).call("set_job_display", {
        "job_id": args.job_id,
        "metadata": {"name": args.name, "description": args.description,
                     "submitter": {"name": args.submitter_name, "username": args.username}},
    })
    print_result(result, args.json)
    return 0


def cmd_set_priority(args: argparse.Namespace) -> int:
    rank_only = getattr(args, "rank_only", False)
    arguments: dict[str, Any] = {"job_id": args.job_id, "priority" if rank_only else "priority_class": args.priority_class}
    result = get_client(args).call("set_priority_rank" if rank_only else "set_priority", arguments)
    print_result(result, args.json)
    return 0


def cmd_logs(args: argparse.Namespace) -> int:
    result = get_client(args).call("log_path", {"job_id": args.job_id})
    path = Path(result["path"])
    if not path.exists():
        raise ProtocolError(f"log does not exist yet: {path}")
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        if args.lines > 0:
            for line in deque(handle, maxlen=args.lines):
                sys.stdout.write(line)
        else:
            for line in handle:
                sys.stdout.write(line)
        sys.stdout.flush()
        if not args.follow:
            return 0
        while True:
            line = handle.readline()
            if line:
                sys.stdout.write(line)
                sys.stdout.flush()
            else:
                time.sleep(0.5)


def cmd_events(args: argparse.Namespace) -> int:
    result = get_client(args).call(
        "events", {"job_id": args.job_id, "limit": args.limit}
    )
    print_result(result, args.json)
    return 0


def cmd_watch(args: argparse.Namespace) -> int:
    if getattr(args, "json", False):
        raise ValueError(
            "gpu watch is an interactive stream and cannot be combined with --json"
        )
    return watch_job(get_client(args), args.job_id)


def cmd_health(args: argparse.Namespace) -> int:
    result = get_client(args).call("health")
    print_result(result, args.json)
    return 0 if result.get("health") == "ok" else 2


def cmd_set_mode(args: argparse.Namespace) -> int:
    result = get_client(args).call(
        "set_observe_only", {"observe_only": args.observe_only}
    )
    print_result(result, args.json)
    return 0


def cmd_init(args: argparse.Namespace) -> int:
    from .daemon import DaemonAlreadyRunningError, DaemonLock
    from .store import Store

    config = Config.from_json(args.config)
    if os.getuid() != config.allowed_uid:
        raise ValueError(f"gpuq initialization must run as uid {config.allowed_uid}")
    config.ensure_layout()
    try:
        with DaemonLock(
            config.root / "daemon.lock",
            config.allowed_uid,
        ):
            store = Store(config.db_path).initialize()
            store.close()
    except DaemonAlreadyRunningError as exc:
        raise ValueError(
            "refusing to initialize or migrate while the gpuq daemon is running"
        ) from exc
    print(f"initialized gpuq database: {config.db_path}")
    return 0


def cmd_daemon(args: argparse.Namespace) -> int:
    from .daemon import run_daemon

    return run_daemon(Path(args.config))


def cmd_exec(args: argparse.Namespace) -> int:
    from .exec_job import main as exec_main

    return exec_main([args.launch_spec])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gpu",
        description="Conservative single-host GPU queue (P4 highest, P0 lowest).",
    )
    parser.add_argument("--config", default=str(DEFAULT_CONFIG), help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help="emit JSON")
    parser.add_argument("--host", help="target host in the fleet inventory")
    parser.add_argument("--fleet-config", default=os.environ.get("GPUQ_FLEET_CONFIG", "/data1/gpu-scheduler/fleet.json"))
    subparsers = parser.add_subparsers(dest="command_name", required=True)

    submit = subparsers.add_parser(
        "submit",
        aliases=["run"],
        help="submit a job",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "elastic training example: gpu submit -g 8 --min-gpus 2 "
            "--elastic-start --auto-expand --checkpointable "
            "--global-batch 256 --micro-batch 16 -- command"
        ),
    )
    placement = submit.add_mutually_exclusive_group(required=True)
    placement.add_argument(
        "-g",
        "--gpus",
        type=int,
        help=("maximum (or exact, by default) number of arbitrary managed GPUs"),
    )
    placement.add_argument(
        "--gpu",
        "--gpu-indices",
        dest="gpu_indices",
        type=parse_gpu_indices,
        metavar="4,6",
        help="fixed physical GPU indices, persisted internally by UUID",
    )
    submit.add_argument(
        "--min-gpus",
        type=int,
        help=(
            "minimum GPU count for elastic arbitrary placement; requires "
            "--elastic-start"
        ),
    )
    submit.add_argument(
        "--elastic-start",
        action="store_true",
        help=(
            "start an arbitrary-placement job on the largest currently "
            "available count between --min-gpus and --gpus"
        ),
    )
    submit.add_argument(
        "--auto-expand",
        "--auto-scale-up",
        dest="auto_scale_up",
        action="store_true",
        help=(
            "when more GPUs become idle, checkpoint at an epoch boundary and "
            "restart on the largest larger legal count; requires "
            "--elastic-start, --checkpointable, and restart policy on-preempt"
        ),
    )
    submit.add_argument(
        "--global-batch",
        type=int,
        help=(
            "target global batch size for exact batch-compatible elastic "
            "GPU counts; requires --micro-batch and --elastic-start"
        ),
    )
    submit.add_argument(
        "--micro-batch",
        type=int,
        help=(
            "per-device micro-batch size used to select exact-compatible "
            "elastic GPU counts; requires --global-batch"
        ),
    )
    submit.add_argument("-p", "--priority", type=parse_priority, default=2)
    submit.add_argument(
        "-m",
        "--mode",
        choices=[item.value for item in DispatchMode],
        default=DispatchMode.QUEUE.value,
        help="how this job may obtain GPUs from lower-priority managed jobs",
    )
    submit.add_argument("--checkpointable", action="store_true")
    submit.add_argument("--yield", dest="yield_policy", choices=["legacy", "never", "now", "save"], default="legacy",
                        help="victim policy: legacy behavior, protected, immediate yield, or checkpoint-only yield")
    submit.add_argument("--preempt-idle-only", action="store_true",
                        help="only displace explicit P0 / yield-now / restart-never jobs; protect existing checkpoint-yield jobs")
    submit.add_argument("--preempt-opt-in-only", action="store_true",
                        help="only preempt lower-ranked jobs that explicitly permit now/save yielding")
    submit.add_argument(
        "--hami",
        action="store_true",
        help="enforce the shared VRAM budget using the validated HAMi runtime",
    )
    submit.add_argument(
        "--sm-percent",
        type=int,
        help="experimental CUDA kernel utilization cap (1-100); implies --hami; not a guaranteed performance share",
    )
    submit.add_argument(
        "--share",
        action="store_true",
        help="opt in to sharing one explicit --gpu, including external workloads; queue only",
    )
    submit.add_argument(
        "--vram-gb",
        type=float,
        help="expected GPU memory in GiB; required with --share (admission budget, not a hard limit)",
    )
    submit.add_argument(
        "--restart-policy",
        choices=[item.value for item in RestartPolicy],
        default=RestartPolicy.ON_PREEMPT.value,
    )
    submit.add_argument(
        "-n",
        "--name",
        "--task-name",
        dest="name",
        metavar="NAME",
        help="task name shown by 'gpu q' (default: inferred script or module)",
    )
    submit.add_argument(
        "-u",
        "--owner",
        "--submitter",
        dest="owner",
        metavar="NAME",
        help=(
            "submitter shown by 'gpu q' (default: GPUQ_SUBMITTER, "
            "GPUQ_OWNER, or SSH identity)"
        ),
    )
    submit.add_argument("--cwd")
    submit.add_argument("--hosts", help="cluster candidates: all or comma-separated host names")
    submit.add_argument("--require-path", action="append", default=[], help="path that must already exist on each candidate (repeatable)")
    submit.add_argument("--require-module", action="append", default=[], help="Python module required in the target interpreter (repeatable)")
    submit.add_argument("--gpu-model", help="required GPU model substring, e.g. 4090")
    submit.add_argument("--min-vram-gb", type=float, help="minimum physical VRAM per GPU on the selected host")
    submit.add_argument("--env", action="append", default=[])
    submit.add_argument(
        "--submit-key",
        help="UUID idempotency key; reuse the same value after an uncertain timeout",
    )
    submit.add_argument(
        "--watch",
        action="store_true",
        help=(
            "after submission, watch scheduler state and structured progress "
            "until the job finishes; Ctrl-C only detaches"
        ),
    )
    submit.add_argument("command", nargs=argparse.REMAINDER)
    submit.set_defaults(func=cmd_submit)

    status = subparsers.add_parser(
        "status",
        aliases=["list", "queue", "q"],
        help="show the active queue and server GPU state (short alias: q)",
    )
    status.add_argument("--all", action="store_true")
    status.add_argument("--all-hosts", action="store_true", help="query every configured host")
    status.add_argument("--cluster", action="store_true", help="show the unified cross-host queue")
    status.add_argument("--limit", type=int, default=100)
    status.set_defaults(func=cmd_status)

    show = subparsers.add_parser("show")
    show.add_argument("--history-before-id", type=int)
    show.add_argument("--history-limit", type=int)
    show.add_argument("job_id")
    show.set_defaults(func=cmd_show)

    cancel = subparsers.add_parser("cancel")
    cancel.add_argument("job_id")
    cancel.set_defaults(func=cmd_cancel)

    retry = subparsers.add_parser("retry")
    retry.add_argument("job_id")
    retry.set_defaults(func=cmd_retry)

    display = subparsers.add_parser("set-display", help="update human task labels")
    display.add_argument("job_id")
    for option in ("name", "submitter-name", "username"):
        display.add_argument("--"+option, required=True)
    display.add_argument("--description", default="")
    display.set_defaults(func=cmd_set_display)

    priority = subparsers.add_parser("set-priority", help="change a pending job's complete priority/yield contract")
    priority.add_argument("job_id")
    priority.add_argument("priority_class", choices=["idle", "normal", "high"])
    priority.set_defaults(func=cmd_set_priority)
    rank = subparsers.add_parser("set-rank", help="change only a pending job's P0..P4 rank, preserving its other policies")
    rank.add_argument("job_id")
    rank.add_argument("priority_class", type=parse_priority, metavar="P0..P4")
    rank.set_defaults(func=cmd_set_priority, rank_only=True)

    logs = subparsers.add_parser("logs")
    logs.add_argument("job_id")
    logs.add_argument("-f", "--follow", action="store_true")
    logs.add_argument("-n", "--lines", type=int, default=100)
    logs.set_defaults(func=cmd_logs)

    events = subparsers.add_parser("events")
    events.add_argument("job_id", nargs="?")
    events.add_argument("--limit", type=int, default=100)
    events.set_defaults(func=cmd_events)

    watch = subparsers.add_parser(
        "watch",
        aliases=["attach"],
        help=(
            "watch scheduler state and structured progress until one job "
            "finishes; Ctrl-C only detaches"
        ),
    )
    watch.add_argument("job_id")
    watch.set_defaults(func=cmd_watch)

    health = subparsers.add_parser("health")
    health.set_defaults(func=cmd_health)

    mode = subparsers.add_parser("set-mode", help="administrator rollout switch")
    group = mode.add_mutually_exclusive_group(required=True)
    group.add_argument("--observe-only", dest="observe_only", action="store_true")
    group.add_argument("--active", dest="observe_only", action="store_false")
    mode.set_defaults(func=cmd_set_mode)

    initialize = subparsers.add_parser("_init", help=argparse.SUPPRESS)
    initialize.set_defaults(func=cmd_init)

    daemon = subparsers.add_parser("daemon", help=argparse.SUPPRESS)
    daemon.set_defaults(func=cmd_daemon)

    execute = subparsers.add_parser("_exec", help=argparse.SUPPRESS)
    execute.add_argument("launch_spec")
    execute.set_defaults(func=cmd_exec)
    remote = subparsers.add_parser("_remote", help=argparse.SUPPRESS)
    remote.set_defaults(func=lambda args: __import__("gpuq.fleet", fromlist=["remote_entry"]).remote_entry(args.config))
    cluster_rpc = subparsers.add_parser("_cluster", help=argparse.SUPPRESS)
    cluster_rpc.add_argument("scope", choices=["hub", "node"])
    cluster_rpc.add_argument("operation")
    cluster_rpc.add_argument("payload")
    cluster_rpc.set_defaults(func=lambda args: __import__("gpuq.cluster", fromlist=["rpc_entry"]).rpc_entry(args))
    cluster_daemon = subparsers.add_parser("fleet-daemon", help=argparse.SUPPRESS)
    cluster_daemon.set_defaults(func=lambda args: __import__("gpuq.cluster", fromlist=["run_daemon"]).run_daemon(args.fleet_config))
    board = subparsers.add_parser("board", help="shared team message board")
    board.add_argument("--limit", type=int, default=20)
    board.set_defaults(func=lambda args: 0, board_action="list")
    board_commands = board.add_subparsers(dest="board_action")
    post = board_commands.add_parser("post", help="post a message to all three hosts")
    post.add_argument("text")
    post.add_argument("-u", "--submitter", dest="owner")
    post.add_argument("--message-key", help="UUID for idempotent retry after connection loss")
    message_kind = post.add_mutually_exclusive_group(required=True)
    message_kind.add_argument("--job", help="task message; deleted automatically when this F/J job ends")
    message_kind.add_argument("--general", action="store_true", help="non-task message; retained until manually deleted")
    post.add_argument("--on-host", help="host of a local J job (default: this host)")
    delete = board_commands.add_parser("delete", help="hide the specified message")
    delete.add_argument("message_id")
    sync = subparsers.add_parser("sync", help="manual additive file transfer over LAN; never delete/overwrite")
    sync.add_argument("source")
    sync.add_argument("--to", required=True, help="one target fleet host")
    sync.add_argument("--dest", required=True, help="absolute target directory; its parent must exist")
    sync.add_argument("--exclude", action="append", default=[], help="exact relative path to omit in files mode")
    sync.add_argument("--dry-run", action="store_true", help="preview without writing the destination")
    sync.set_defaults(func=lambda args: __import__("gpuq.sync", fromlist=["cmd_sync"]).cmd_sync(args))
    receiver = subparsers.add_parser("_sync-rsync", help=argparse.SUPPRESS)
    receiver.add_argument("header")
    receiver.add_argument("server_args", nargs=argparse.REMAINDER)
    receiver.set_defaults(func=lambda args: __import__("gpuq.sync", fromlist=["receiver"]).receiver(args.header, args.server_args, args.config))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    parser = build_parser()
    args = parser.parse_args(argv)
    requested_count = getattr(args, "gpus", None)
    if requested_count is not None and requested_count < 1:
        parser.error("--gpus must be at least 1")
    requested_min_count = getattr(args, "min_gpus", None)
    if requested_min_count is not None and requested_min_count < 1:
        parser.error("--min-gpus must be at least 1")
    target_global_batch_size = getattr(args, "global_batch", None)
    if target_global_batch_size is not None and target_global_batch_size < 1:
        parser.error("--global-batch must be at least 1")
    per_device_micro_batch_size = getattr(args, "micro_batch", None)
    if per_device_micro_batch_size is not None and per_device_micro_batch_size < 1:
        parser.error("--micro-batch must be at least 1")
    try:
        from .cluster import route_cli
        routed = route_cli(args, argv)
        if routed is not None:
            return routed
        if args.host or getattr(args, "all_hosts", False):
            from .fleet import forward, load_inventory, query_all, routing_argv
            if args.host and getattr(args, "all_hosts", False):
                raise ValueError("--host and --all-hosts are mutually exclusive")
            inventory = load_inventory(args.fleet_config)
            if args.host:
                return forward(inventory, args.host, routing_argv(argv))
            return query_all(inventory, all_jobs=args.all, limit=args.limit, as_json=args.json)
        return int(args.func(args))
    except (ValueError, ProtocolError, OSError) as exc:
        if getattr(args, "json", False):
            print(json_dumps({"ok": False, "error": str(exc)}))
        else:
            print(f"gpu: error: {exc}", file=sys.stderr)
        return 2


def zipapp_main() -> None:
    """Propagate the CLI status when invoked by ``python -m zipapp -m``."""
    raise SystemExit(main())


if __name__ == "__main__":
    raise SystemExit(main())

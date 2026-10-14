"""Durable SQLite state for the gpuq daemon.

The database is intentionally not created by :class:`Store` construction or by
the first CRUD operation.  ``initialize_database`` (or ``Store.initialize``)
is the only creation path; normal daemon startup uses ``Store.open`` and fails
closed when the file, schema, or integrity checks are not valid.

All values interpolated into SQL identifiers come from private, fixed
whitelists.  Application values are always bound parameters.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import math
import os
import sqlite3
import stat
import threading
import time
import uuid
from collections.abc import Iterable, Iterator, Mapping, Sequence
from enum import Enum
from pathlib import Path
from typing import Any

from .constants import (
    ACTIVE_ATTEMPT_STATES,
    ACTIVE_SCALE_UP_STATES,
    MAX_PRIORITY,
    MIN_PRIORITY,
    ActionState,
    ActionType,
    AttemptState,
    CheckpointCapability,
    DispatchMode,
    JobState,
    RestartPolicy,
    ScaleUpState,
    STORE_SCHEMA_VERSION,
    TERMINAL_JOB_STATES,
    TERMINAL_SCALE_UP_STATES,
)
from .progress import (
    ProgressProtocolError,
    ProgressSnapshot,
    progress_milestone,
    validate_progress_payload,
)
from .util import reject_duplicate_json
from .sharing import validate_sharing
from .hami import validate_hami_request
from .policy import priority_class_contract, validate_yield_policy


APPLICATION_ID = 0x47505131  # ASCII-ish "GPQ1"; protects against a wrong DB.
DEFAULT_BUSY_TIMEOUT_MS = 5_000
_SCHEMA_VERSION_V2 = 2
_SCHEMA_VERSION_V3 = 3
_SCHEMA_VERSION_V4 = 4
_SCHEMA_VERSION_V5 = 5
_SCHEMA_VERSION_V6 = 6
_SCHEMA_VERSION_V7 = 7
_SCHEMA_VERSION_V8 = 8
_SCHEMA_VERSION_V9 = 9
_SCHEMA_VERSION_V10 = 10
_SQLITE_SIGNED_INT_MAX = 2**63 - 1
_MAX_CLAIM_ACTION_EXCLUSIONS = 1000
_UNSET = object()

_JOB_STATES = frozenset(item.value for item in JobState)
_ATTEMPT_STATES = frozenset(item.value for item in AttemptState)
_ACTION_TYPES = frozenset(item.value for item in ActionType)
_ACTION_STATES = frozenset(item.value for item in ActionState)
_DISPATCH_MODES = frozenset(item.value for item in DispatchMode)
_CHECKPOINT_CAPABILITIES = frozenset(item.value for item in CheckpointCapability)
_RESTART_POLICIES = frozenset(item.value for item in RestartPolicy)
_SCALE_UP_STATES = frozenset(item.value for item in ScaleUpState)
_PLACEMENTS = frozenset({"any", "pinned"})

_REQUIRED_TABLES_V2_TO_V4 = frozenset(
    {"schema_meta", "settings", "jobs", "attempts", "leases", "actions", "events"}
)
_REQUIRED_TABLES_V5 = frozenset(
    {
        "schema_meta",
        "settings",
        "jobs",
        "attempts",
        "leases",
        "actions",
        "events",
        "scale_up_plans",
        "scale_up_reservations",
    }
)
_REQUIRED_TABLES_V6_TO_V10 = frozenset({*_REQUIRED_TABLES_V5, "attempt_progress"})
_REQUIRED_TABLES = frozenset({*_REQUIRED_TABLES_V6_TO_V10, "gpu_allocation_history"})


class StoreError(RuntimeError):
    """Base class for durable-store failures."""


class StoreNotInitializedError(StoreError):
    """The daemon was pointed at a database which was never initialized."""


class StoreCorruptError(StoreError):
    """SQLite could not read the database or its integrity check failed."""


class StoreSchemaError(StoreError):
    """The database belongs to gpuq but has an unsupported schema."""


class StoreConflictError(StoreError):
    """An idempotency key, lease, or optimistic update conflicted."""


class StoreNotFoundError(StoreError):
    """A requested durable object does not exist."""


# Short aliases are convenient for callers and retain descriptive public names.
NotInitializedError = StoreNotInitializedError
CorruptDatabaseError = StoreCorruptError
SchemaVersionError = StoreSchemaError
ConflictError = StoreConflictError
NotFoundError = StoreNotFoundError


def _enum_value(value: str | Enum) -> str:
    return str(value.value) if isinstance(value, Enum) else str(value)


def _json_dump(value: Any) -> str:
    try:
        return json.dumps(
            value,
            ensure_ascii=False,
            allow_nan=False,
            separators=(",", ":"),
            sort_keys=True,
        )
    except (TypeError, ValueError) as exc:
        raise ValueError(f"value is not JSON serializable: {exc}") from exc


def _json_load(raw: str) -> Any:
    try:
        return json.loads(raw)
    except (TypeError, ValueError) as exc:  # A persisted bad value is fail-closed.
        raise StoreCorruptError("database contains invalid JSON") from exc


def _digest(*parts: str) -> str:
    # A separator is ambiguous when user-controlled strings may contain it.
    # Length-prefixing makes the encoding injective for every UTF-8 string.
    digest = hashlib.sha256()
    for part in parts:
        encoded = part.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
    return digest.hexdigest()


def _submission_digest(
    *,
    name: str,
    owner: str,
    priority: int,
    dispatch_mode: str,
    checkpoint_capability: str,
    restart_policy: str,
    gpu_count: int,
    min_gpu_count: int,
    elastic_gpu_count: bool | int,
    auto_scale_up: bool | int,
    target_global_batch_size: int | None,
    per_device_micro_batch_size: int | None,
    placement: str,
    requested_gpu_uuids_json: str,
    argv_json: str,
    cwd: str,
    env_json: str,
    include_batch_fields: bool = True,
    share_gpu: bool = False,
    vram_mb: int | None = None,
    hami_core: bool = False,
    sm_percent: int | None = None,
    yield_policy: str = "legacy",
    preempt_idle_only: bool = False,
    preempt_opt_in_only: bool = False,
) -> str:
    """Build the versioned canonical submission idempotency digest."""

    parts = [
        name,
        owner,
        str(priority),
        dispatch_mode,
        checkpoint_capability,
        restart_policy,
        str(gpu_count),
        str(min_gpu_count),
        str(int(elastic_gpu_count)),
        str(int(auto_scale_up)),
    ]
    if include_batch_fields:
        parts.extend(
            (
                (
                    ""
                    if target_global_batch_size is None
                    else str(target_global_batch_size)
                ),
                (
                    ""
                    if per_device_micro_batch_size is None
                    else str(per_device_micro_batch_size)
                ),
            )
        )
    parts.extend(
        (
            placement,
            requested_gpu_uuids_json,
            argv_json,
            cwd,
            env_json,
        )
    )
    if share_gpu:
        parts.extend(("shared-v1", str(vram_mb)))
    if hami_core:
        parts.extend(("hami-core-v1", str(sm_percent)))
    if yield_policy != "legacy":
        parts.extend(("yield-v1", yield_policy))
    if preempt_idle_only:
        parts.append("preempt-idle-only-v1")
    if preempt_opt_in_only:
        parts.append("preempt-opt-in-only-v1")
    return _digest(*parts)


def _nonempty(value: Any, field: str, *, maximum: int = 4096) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        raise ValueError(f"{field} must be a non-empty string")
    if "\x00" in value:
        raise ValueError(f"{field} must not contain NUL")
    return value


def _optional_text(value: Any, field: str, *, maximum: int = 4096) -> str | None:
    if value is None:
        return None
    return _nonempty(value, field, maximum=maximum)


def _optional_absolute_path(value: Any, field: str) -> str | None:
    result = _optional_text(value, field, maximum=16_384)
    if result is None:
        return None
    if not os.path.isabs(result) or "\n" in result or "\r" in result:
        raise ValueError(f"{field} must be a safe absolute path")
    return result


def _claim_action_exclusions(value: Iterable[str] | None) -> list[str]:
    """Validate and materialize one bounded set of action claim exclusions."""

    if value is None:
        return []
    if isinstance(value, (str, bytes, bytearray, bool)):
        raise ValueError("exclude_action_ids must be an iterable of action IDs")
    try:
        iterator = iter(value)
    except TypeError as exc:
        raise ValueError(
            "exclude_action_ids must be an iterable of action IDs"
        ) from exc

    normalized: list[str] = []
    seen: set[str] = set()
    for item in iterator:
        if len(normalized) >= _MAX_CLAIM_ACTION_EXCLUSIONS:
            raise ValueError(
                "exclude_action_ids must contain at most "
                f"{_MAX_CLAIM_ACTION_EXCLUSIONS} action IDs"
            )
        action_id = _nonempty(item, "excluded action ID", maximum=256)
        if action_id in seen:
            raise ValueError("exclude_action_ids must contain unique action IDs")
        seen.add(action_id)
        normalized.append(action_id)
    return normalized


def _finite_timestamp(value: Any, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field} must be a finite timestamp")
    result = float(value)
    if not math.isfinite(result):
        raise ValueError(f"{field} must be a finite timestamp")
    return result


def _plain_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _priority(value: Any) -> int:
    if isinstance(value, str) and len(value) == 2 and value[0].upper() == "P":
        try:
            value = int(value[1])
        except ValueError as exc:
            raise ValueError("priority must be P0..P4") from exc
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("priority must be P0..P4")
    if not MIN_PRIORITY <= value <= MAX_PRIORITY:
        raise ValueError("priority must be P0..P4")
    return int(value)


def _optional_positive_sqlite_int(value: Any, field: str) -> int | None:
    if value is None:
        return None
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or value <= 0
        or value > _SQLITE_SIGNED_INT_MAX
    ):
        raise ValueError(
            f"{field} must be a positive integer no greater than "
            f"{_SQLITE_SIGNED_INT_MAX}"
        )
    return int(value)


def _choice(value: str | Enum, allowed: frozenset[str], field: str) -> str:
    result = _enum_value(value)
    if result not in allowed:
        raise ValueError(f"invalid {field}: {result}")
    return result


def _new_id() -> str:
    return str(uuid.uuid4())


# Schema v3 deliberately starts from the exact v2 DDL and applies the same
# additive migration used for an existing production database.  This keeps a
# freshly initialized database and a migrated database byte-for-byte
# equivalent at the sqlite_schema level, so the strict schema signature check
# remains useful after migration.
_SCHEMA_V2_STATEMENTS = (
    """
    CREATE TABLE schema_meta (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        schema_version INTEGER NOT NULL,
        initialized_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at REAL NOT NULL
    )
    """,
    """
    CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        sequence INTEGER NOT NULL UNIQUE CHECK (sequence > 0),
        submit_key TEXT NOT NULL UNIQUE,
        submit_digest TEXT NOT NULL,
        name TEXT NOT NULL,
        owner TEXT NOT NULL,
        priority INTEGER NOT NULL CHECK (priority BETWEEN 0 AND 4),
        dispatch_mode TEXT NOT NULL
            CHECK (dispatch_mode IN ('queue','preempt-save','preempt-now')),
        checkpoint_capability TEXT NOT NULL
            CHECK (checkpoint_capability IN ('none','epoch-v1')),
        restart_policy TEXT NOT NULL
            CHECK (restart_policy IN ('on-preempt','never')),
        gpu_count INTEGER NOT NULL CHECK (gpu_count > 0),
        placement TEXT NOT NULL DEFAULT 'any'
            CHECK (placement IN ('any','pinned')),
        requested_gpu_uuids_json TEXT NOT NULL DEFAULT '[]'
            CHECK (
                CASE
                    WHEN json_valid(requested_gpu_uuids_json) THEN
                        json_type(requested_gpu_uuids_json) = 'array'
                        AND (
                            (
                                placement = 'any'
                                AND json_array_length(
                                    requested_gpu_uuids_json
                                ) = 0
                            )
                            OR (
                                placement = 'pinned'
                                AND json_array_length(
                                    requested_gpu_uuids_json
                                ) = gpu_count
                            )
                        )
                    ELSE 0
                END
            ),
        argv_json TEXT NOT NULL,
        cwd TEXT NOT NULL,
        env_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (
            state IN (
                'PENDING','STARTING','RUNNING','PREEMPTING',
                'SUCCEEDED','FAILED','CANCELED','LOST'
            )
        ),
        state_reason TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        started_at REAL,
        finished_at REAL
    )
    """,
    """
    CREATE TRIGGER jobs_requested_gpus_insert_validate
    BEFORE INSERT ON jobs
    BEGIN
        SELECT RAISE(ABORT, 'invalid requested GPU UUID')
        WHERE EXISTS (
            SELECT 1
            FROM json_each(NEW.requested_gpu_uuids_json)
            WHERE type <> 'text'
               OR length(value) = 0
               OR length(value) > 256
               OR instr(value, char(0)) > 0
        );
        SELECT RAISE(ABORT, 'duplicate requested GPU UUID')
        WHERE EXISTS (
            SELECT value
            FROM json_each(NEW.requested_gpu_uuids_json)
            GROUP BY value
            HAVING count(*) > 1
        );
    END
    """,
    """
    CREATE TRIGGER jobs_requested_gpus_update_validate
    BEFORE UPDATE OF placement, requested_gpu_uuids_json, gpu_count ON jobs
    BEGIN
        SELECT RAISE(ABORT, 'invalid requested GPU UUID')
        WHERE EXISTS (
            SELECT 1
            FROM json_each(NEW.requested_gpu_uuids_json)
            WHERE type <> 'text'
               OR length(value) = 0
               OR length(value) > 256
               OR instr(value, char(0)) > 0
        );
        SELECT RAISE(ABORT, 'duplicate requested GPU UUID')
        WHERE EXISTS (
            SELECT value
            FROM json_each(NEW.requested_gpu_uuids_json)
            GROUP BY value
            HAVING count(*) > 1
        );
    END
    """,
    """
    CREATE INDEX jobs_schedule_idx
    ON jobs(state, priority DESC, sequence)
    """,
    """
    CREATE INDEX jobs_owner_idx
    ON jobs(owner, created_at DESC)
    """,
    """
    CREATE TABLE attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL CHECK (ordinal > 0),
        state TEXT NOT NULL CHECK (
            state IN (
                'PLANNED','STARTING','RUNNING','SAVE_REQUESTED','SAVE_WITHDRAWING',
                'CHECKPOINT_ACKED','TERM_REQUESTED','KILL_REQUESTED',
                'DRAINING','PREEMPTED','EXITED_SUCCESS','EXITED_FAILURE',
                'CANCELED','LOST','STUCK'
            )
        ),
        unit_name TEXT,
        unit_token TEXT,
        boot_id TEXT,
        invocation_id TEXT,
        main_pid INTEGER CHECK (main_pid IS NULL OR main_pid > 0),
        start_ticks INTEGER CHECK (start_ticks IS NULL OR start_ticks >= 0),
        gpu_uuids_json TEXT NOT NULL DEFAULT '[]',
        gpu_indices_json TEXT NOT NULL DEFAULT '[]',
        control_dir TEXT,
        log_path TEXT,
        preempt_nonce TEXT,
        preempt_requested_by_job_id TEXT REFERENCES jobs(id),
        preempt_requested_at REAL,
        preempt_deadline_at REAL,
        checkpoint_deadline_at REAL,
        term_deadline_at REAL,
        kill_deadline_at REAL,
        checkpoint_path TEXT,
        exit_code INTEGER,
        failure_reason TEXT,
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        started_at REAL,
        finished_at REAL,
        UNIQUE(job_id, ordinal),
        UNIQUE(id, job_id),
        UNIQUE(unit_token)
    )
    """,
    """
    CREATE UNIQUE INDEX attempts_one_active_per_job_idx
    ON attempts(job_id)
    WHERE state IN (
        'PLANNED','STARTING','RUNNING','SAVE_REQUESTED','SAVE_WITHDRAWING',
        'CHECKPOINT_ACKED','TERM_REQUESTED','KILL_REQUESTED','DRAINING'
    )
    """,
    """
    CREATE INDEX attempts_job_idx
    ON attempts(job_id, ordinal DESC)
    """,
    """
    CREATE TABLE leases (
        gpu_uuid TEXT PRIMARY KEY,
        gpu_index INTEGER NOT NULL UNIQUE CHECK (gpu_index >= 0),
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        acquired_at REAL NOT NULL,
        heartbeat_at REAL NOT NULL,
        lease_token TEXT NOT NULL,
        FOREIGN KEY(attempt_id, job_id)
            REFERENCES attempts(id, job_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE INDEX leases_job_idx ON leases(job_id)
    """,
    """
    CREATE INDEX leases_attempt_idx ON leases(attempt_id)
    """,
    """
    CREATE TABLE actions (
        id TEXT PRIMARY KEY,
        dedupe_key TEXT NOT NULL UNIQUE,
        action_digest TEXT NOT NULL,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_id TEXT,
        action_type TEXT NOT NULL CHECK (
            action_type IN (
                'START_UNIT','REQUEST_SAVE','TERM_UNIT',
                'KILL_UNIT','CLEANUP_UNIT'
            )
        ),
        state TEXT NOT NULL DEFAULT 'PENDING'
            CHECK (state IN ('PENDING','DONE','FAILED')),
        payload_json TEXT NOT NULL,
        result_json TEXT,
        available_at REAL NOT NULL,
        claimed_by TEXT,
        claim_token TEXT,
        claim_until REAL,
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error TEXT,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        finished_at REAL,
        FOREIGN KEY(attempt_id, job_id)
            REFERENCES attempts(id, job_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE INDEX actions_outbox_idx
    ON actions(state, available_at, claim_until, created_at, id)
    """,
    """
    CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT REFERENCES jobs(id) ON DELETE CASCADE,
        attempt_id TEXT,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at REAL NOT NULL,
        FOREIGN KEY(attempt_id, job_id)
            REFERENCES attempts(id, job_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE INDEX events_job_idx ON events(job_id, id)
    """,
)

_SCHEMA_V2_TO_V3_DDL = (
    """
    ALTER TABLE jobs
    ADD COLUMN min_gpu_count INTEGER NOT NULL DEFAULT 1
        CHECK (min_gpu_count > 0 AND min_gpu_count <= gpu_count)
    """,
    """
    ALTER TABLE jobs
    ADD COLUMN elastic_gpu_count INTEGER NOT NULL DEFAULT 0
        CHECK (
            elastic_gpu_count IN (0, 1)
            AND (
                elastic_gpu_count = 1
                OR min_gpu_count = gpu_count
            )
            AND (
                elastic_gpu_count = 0
                OR placement = 'any'
            )
        )
    """,
)

_SCHEMA_V3_TO_V4_DDL = (
    """
    ALTER TABLE jobs
    ADD COLUMN target_global_batch_size INTEGER DEFAULT NULL
        CHECK (
            target_global_batch_size IS NULL
            OR (
                typeof(target_global_batch_size) = 'integer'
                AND target_global_batch_size > 0
            )
        )
    """,
    """
    ALTER TABLE jobs
    ADD COLUMN per_device_micro_batch_size INTEGER DEFAULT NULL
        CHECK (
            (
                target_global_batch_size IS NULL
                AND per_device_micro_batch_size IS NULL
            )
            OR (
                typeof(target_global_batch_size) = 'integer'
                AND target_global_batch_size > 0
                AND typeof(per_device_micro_batch_size) = 'integer'
                AND per_device_micro_batch_size > 0
                AND placement = 'any'
                AND elastic_gpu_count = 1
            )
        )
    """,
    """
    CREATE TRIGGER jobs_batch_contract_insert_validate
    BEFORE INSERT ON jobs
    BEGIN
        SELECT RAISE(ABORT, 'batch contract has no compatible GPU count')
        WHERE NEW.target_global_batch_size IS NOT NULL
          AND NOT EXISTS (
              WITH RECURSIVE gpu_counts(value) AS (
                  SELECT NEW.min_gpu_count
                  UNION ALL
                  SELECT value + 1
                  FROM gpu_counts
                  WHERE value < NEW.gpu_count
              )
              SELECT 1
              FROM gpu_counts
              WHERE NEW.target_global_batch_size
                        % NEW.per_device_micro_batch_size = 0
                AND (
                    NEW.target_global_batch_size
                    / NEW.per_device_micro_batch_size
                ) % value = 0
          );
    END
    """,
    """
    CREATE TRIGGER jobs_batch_contract_update_validate
    BEFORE UPDATE OF
        target_global_batch_size, per_device_micro_batch_size,
        min_gpu_count, gpu_count, elastic_gpu_count, placement
    ON jobs
    BEGIN
        SELECT RAISE(ABORT, 'batch contract has no compatible GPU count')
        WHERE NEW.target_global_batch_size IS NOT NULL
          AND NOT EXISTS (
              WITH RECURSIVE gpu_counts(value) AS (
                  SELECT NEW.min_gpu_count
                  UNION ALL
                  SELECT value + 1
                  FROM gpu_counts
                  WHERE value < NEW.gpu_count
              )
              SELECT 1
              FROM gpu_counts
              WHERE NEW.target_global_batch_size
                        % NEW.per_device_micro_batch_size = 0
                AND (
                    NEW.target_global_batch_size
                    / NEW.per_device_micro_batch_size
                ) % value = 0
          );
    END
    """,
)


_SCHEMA_V4_TO_V5_DDL = (
    """
    ALTER TABLE jobs
    ADD COLUMN auto_scale_up INTEGER NOT NULL DEFAULT 0
        CHECK (
            auto_scale_up IN (0, 1)
            AND (
                auto_scale_up = 0
                OR (
                    elastic_gpu_count = 1
                    AND placement = 'any'
                    AND checkpoint_capability = 'epoch-v1'
                    AND restart_policy = 'on-preempt'
                    AND target_global_batch_size IS NOT NULL
                    AND per_device_micro_batch_size IS NOT NULL
                    AND min_gpu_count < gpu_count
                )
            )
        )
    """,
    """
    CREATE TRIGGER jobs_auto_scale_up_insert_validate
    BEFORE INSERT ON jobs
    BEGIN
        SELECT RAISE(ABORT, 'auto scale-up requires two compatible GPU counts')
        WHERE NEW.auto_scale_up = 1
          AND (
              WITH RECURSIVE gpu_counts(value) AS (
                  SELECT NEW.min_gpu_count
                  UNION ALL
                  SELECT value + 1
                  FROM gpu_counts
                  WHERE value < NEW.gpu_count
              )
              SELECT count(*)
              FROM gpu_counts
              WHERE NEW.target_global_batch_size
                        % NEW.per_device_micro_batch_size = 0
                AND (
                    NEW.target_global_batch_size
                    / NEW.per_device_micro_batch_size
                ) % value = 0
          ) < 2;
    END
    """,
    """
    CREATE TRIGGER jobs_auto_scale_up_update_validate
    BEFORE UPDATE OF
        auto_scale_up, checkpoint_capability, restart_policy,
        target_global_batch_size, per_device_micro_batch_size,
        min_gpu_count, gpu_count, elastic_gpu_count, placement
    ON jobs
    BEGIN
        SELECT RAISE(ABORT, 'auto scale-up requires two compatible GPU counts')
        WHERE NEW.auto_scale_up = 1
          AND (
              WITH RECURSIVE gpu_counts(value) AS (
                  SELECT NEW.min_gpu_count
                  UNION ALL
                  SELECT value + 1
                  FROM gpu_counts
                  WHERE value < NEW.gpu_count
              )
              SELECT count(*)
              FROM gpu_counts
              WHERE NEW.target_global_batch_size
                        % NEW.per_device_micro_batch_size = 0
                AND (
                    NEW.target_global_batch_size
                    / NEW.per_device_micro_batch_size
                ) % value = 0
          ) < 2;
    END
    """,
    """
    ALTER TABLE attempts
    ADD COLUMN launch_resume_checkpoint_path TEXT DEFAULT NULL
        CHECK (
            launch_resume_checkpoint_path IS NULL
            OR (
                length(launch_resume_checkpoint_path) BETWEEN 1 AND 16384
                AND substr(launch_resume_checkpoint_path, 1, 1) = '/'
                AND instr(launch_resume_checkpoint_path, char(0)) = 0
                AND instr(launch_resume_checkpoint_path, char(10)) = 0
                AND instr(launch_resume_checkpoint_path, char(13)) = 0
            )
        )
    """,
    """
    ALTER TABLE attempts
    ADD COLUMN resume_from_attempt_id TEXT DEFAULT NULL
        REFERENCES attempts(id)
        CHECK (
            (resume_from_attempt_id IS NULL)
            = (launch_resume_checkpoint_path IS NULL)
        )
    """,
    """
    CREATE TABLE scale_up_plans (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
        source_attempt_id TEXT NOT NULL,
        nonce TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL CHECK (
            state IN (
                'SAVE_REQUESTED','CHECKPOINT_ACKED','TERM_REQUESTED',
                'RESTART_PENDING','RESTART_PLANNED','COMPLETED',
                'WITHDRAWN','FAILED','CANCELED'
            )
        ),
        from_gpu_count INTEGER NOT NULL CHECK (from_gpu_count > 0),
        target_gpu_count INTEGER NOT NULL
            CHECK (target_gpu_count > from_gpu_count),
        target_gpu_uuids_json TEXT NOT NULL CHECK (
            CASE
                WHEN json_valid(target_gpu_uuids_json) THEN
                    json_type(target_gpu_uuids_json) = 'array'
                    AND json_array_length(target_gpu_uuids_json)
                            = target_gpu_count
                ELSE 0
            END
        ),
        target_gpu_indices_json TEXT NOT NULL CHECK (
            CASE
                WHEN json_valid(target_gpu_indices_json) THEN
                    json_type(target_gpu_indices_json) = 'array'
                    AND json_array_length(target_gpu_indices_json)
                            = target_gpu_count
                ELSE 0
            END
        ),
        reservation_token TEXT NOT NULL,
        checkpoint_path TEXT CHECK (
            checkpoint_path IS NULL
            OR (
                length(checkpoint_path) BETWEEN 1 AND 16384
                AND substr(checkpoint_path, 1, 1) = '/'
                AND instr(checkpoint_path, char(0)) = 0
                AND instr(checkpoint_path, char(10)) = 0
                AND instr(checkpoint_path, char(13)) = 0
            )
        ),
        successor_attempt_id TEXT REFERENCES attempts(id),
        version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        checkpointed_at REAL,
        finished_at REAL,
        UNIQUE(id, job_id),
        FOREIGN KEY(source_attempt_id, job_id)
            REFERENCES attempts(id, job_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE UNIQUE INDEX scale_up_plans_one_active_per_job_idx
    ON scale_up_plans(job_id)
    WHERE state IN (
        'SAVE_REQUESTED','CHECKPOINT_ACKED','TERM_REQUESTED',
        'RESTART_PENDING','RESTART_PLANNED'
    )
    """,
    """
    CREATE UNIQUE INDEX scale_up_plans_one_active_per_source_idx
    ON scale_up_plans(source_attempt_id)
    WHERE state IN (
        'SAVE_REQUESTED','CHECKPOINT_ACKED','TERM_REQUESTED',
        'RESTART_PENDING','RESTART_PLANNED'
    )
    """,
    """
    CREATE INDEX scale_up_plans_job_idx
    ON scale_up_plans(job_id, created_at DESC)
    """,
    """
    CREATE TRIGGER scale_up_plans_target_insert_validate
    BEFORE INSERT ON scale_up_plans
    BEGIN
        SELECT RAISE(ABORT, 'invalid scale-up target GPU UUID')
        WHERE EXISTS (
            SELECT 1 FROM json_each(NEW.target_gpu_uuids_json)
            WHERE type <> 'text'
               OR length(value) = 0
               OR length(value) > 256
               OR instr(value, char(0)) > 0
        );
        SELECT RAISE(ABORT, 'duplicate scale-up target GPU UUID')
        WHERE EXISTS (
            SELECT value FROM json_each(NEW.target_gpu_uuids_json)
            GROUP BY value HAVING count(*) > 1
        );
        SELECT RAISE(ABORT, 'invalid scale-up target GPU index')
        WHERE EXISTS (
            SELECT 1 FROM json_each(NEW.target_gpu_indices_json)
            WHERE type <> 'integer' OR value < 0
        );
        SELECT RAISE(ABORT, 'duplicate scale-up target GPU index')
        WHERE EXISTS (
            SELECT value FROM json_each(NEW.target_gpu_indices_json)
            GROUP BY value HAVING count(*) > 1
        );
    END
    """,
    """
    CREATE TRIGGER scale_up_plans_identity_immutable
    BEFORE UPDATE OF
        job_id, source_attempt_id, nonce, from_gpu_count, target_gpu_count,
        target_gpu_uuids_json, target_gpu_indices_json, reservation_token
    ON scale_up_plans
    BEGIN
        SELECT RAISE(ABORT, 'scale-up plan identity is immutable');
    END
    """,
    """
    CREATE TRIGGER scale_up_plans_successor_validate
    BEFORE UPDATE OF successor_attempt_id ON scale_up_plans
    WHEN NEW.successor_attempt_id IS NOT NULL
    BEGIN
        SELECT RAISE(ABORT, 'scale-up successor belongs to a different job')
        WHERE NOT EXISTS (
            SELECT 1 FROM attempts
            WHERE id = NEW.successor_attempt_id
              AND job_id = NEW.job_id
        );
    END
    """,
    """
    CREATE TABLE scale_up_reservations (
        gpu_uuid TEXT PRIMARY KEY
            CHECK (length(gpu_uuid) BETWEEN 1 AND 256),
        gpu_index INTEGER NOT NULL UNIQUE CHECK (gpu_index >= 0),
        plan_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        reservation_token TEXT NOT NULL,
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY(plan_id, job_id)
            REFERENCES scale_up_plans(id, job_id) ON DELETE CASCADE
    )
    """,
    """
    CREATE INDEX scale_up_reservations_plan_idx
    ON scale_up_reservations(plan_id, gpu_index)
    """,
    """
    CREATE INDEX scale_up_reservations_job_idx
    ON scale_up_reservations(job_id, gpu_index)
    """,
    """
    CREATE TRIGGER scale_up_reservations_insert_validate
    BEFORE INSERT ON scale_up_reservations
    BEGIN
        SELECT RAISE(ABORT, 'scale-up reservation does not match plan')
        WHERE NOT EXISTS (
            SELECT 1
            FROM scale_up_plans AS p,
                 json_each(p.target_gpu_uuids_json) AS u,
                 json_each(p.target_gpu_indices_json) AS i
            WHERE p.id = NEW.plan_id
              AND p.job_id = NEW.job_id
              AND p.reservation_token = NEW.reservation_token
              AND u.key = i.key
              AND u.value = NEW.gpu_uuid
              AND i.value = NEW.gpu_index
              AND p.state IN (
                  'SAVE_REQUESTED','CHECKPOINT_ACKED','TERM_REQUESTED',
                  'RESTART_PENDING','RESTART_PLANNED'
              )
        );
    END
    """,
    """
    CREATE TRIGGER scale_up_reservations_identity_immutable
    BEFORE UPDATE OF
        gpu_uuid, gpu_index, plan_id, job_id, reservation_token
    ON scale_up_reservations
    BEGIN
        SELECT RAISE(ABORT, 'scale-up reservation identity is immutable');
    END
    """,
)


_SCHEMA_V5_TO_V6_DDL = (
    """
    CREATE TABLE attempt_progress (
        attempt_id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        snapshot_json TEXT NOT NULL CHECK (
            json_valid(snapshot_json)
            AND json_type(snapshot_json) = 'object'
        ),
        heartbeat_at REAL NOT NULL,
        advanced_at REAL NOT NULL,
        stall_timeout_seconds REAL CHECK (
            stall_timeout_seconds IS NULL
            OR stall_timeout_seconds BETWEEN 30.0 AND 86400.0
        ),
        stalled_at REAL,
        stalled_sequence INTEGER CHECK (
            stalled_sequence IS NULL
            OR (stalled_sequence > 0 AND stalled_sequence <= sequence)
        ),
        last_notified_milestone INTEGER CHECK (
            last_notified_milestone IS NULL
            OR (
                last_notified_milestone BETWEEN 0 AND 100
                AND last_notified_milestone % 10 = 0
            )
        ),
        last_notified_problem_sequence INTEGER CHECK (
            last_notified_problem_sequence IS NULL
            OR (
                last_notified_problem_sequence > 0
                AND last_notified_problem_sequence <= sequence
            )
        ),
        last_problem_notified_at REAL,
        last_problem_severity TEXT CHECK (
            last_problem_severity IS NULL
            OR last_problem_severity IN ('warning','error')
        ),
        created_at REAL NOT NULL,
        updated_at REAL NOT NULL,
        FOREIGN KEY(attempt_id, job_id)
            REFERENCES attempts(id, job_id) ON DELETE CASCADE,
        CHECK (advanced_at <= heartbeat_at),
        CHECK (created_at <= updated_at),
        CHECK ((stalled_at IS NULL) = (stalled_sequence IS NULL)),
        CHECK (
            (last_notified_problem_sequence IS NULL
             AND last_problem_notified_at IS NULL
             AND last_problem_severity IS NULL)
            OR
            (last_notified_problem_sequence IS NOT NULL
             AND last_problem_notified_at IS NOT NULL
             AND last_problem_severity IS NOT NULL)
        )
    )
    """,
    """
    CREATE INDEX attempt_progress_job_idx
    ON attempt_progress(job_id, updated_at DESC)
    """,
    """
    CREATE TRIGGER attempt_progress_identity_immutable
    BEFORE UPDATE OF attempt_id, job_id, protocol_version, created_at
    ON attempt_progress
    BEGIN
        SELECT RAISE(ABORT, 'attempt progress identity is immutable');
    END
    """,
    """
    CREATE TRIGGER attempt_progress_snapshot_monotonic
    BEFORE UPDATE OF
        sequence, snapshot_json, heartbeat_at, advanced_at,
        stall_timeout_seconds
    ON attempt_progress
    BEGIN
        SELECT RAISE(ABORT, 'attempt progress sequence must increase')
        WHERE NEW.sequence <= OLD.sequence;
        SELECT RAISE(ABORT, 'attempt progress timestamps moved backward')
        WHERE NEW.heartbeat_at < OLD.heartbeat_at
           OR NEW.advanced_at < OLD.advanced_at
           OR NEW.updated_at < OLD.updated_at;
    END
    """,
)


def _schema_signature(
    connection: sqlite3.Connection,
) -> tuple[tuple[str, str, str, str], ...]:
    """Return a normalized signature for every application schema object."""

    rows = connection.execute(
        """
        SELECT type, name, tbl_name, sql
        FROM sqlite_master
        WHERE name NOT LIKE 'sqlite_%'
        ORDER BY type, name
        """
    ).fetchall()
    return tuple(
        (
            str(row[0]),
            str(row[1]),
            str(row[2]),
            " ".join(str(row[3]).split()),
        )
        for row in rows
    )


def _build_expected_schema_signature(
    migration_ddl: Sequence[str] = (),
) -> tuple[tuple[str, str, str, str], ...]:
    connection = sqlite3.connect(":memory:", isolation_level=None)
    try:
        for statement in _SCHEMA_V2_STATEMENTS:
            connection.execute(statement)
        for statement in migration_ddl:
            connection.execute(statement)
        return _schema_signature(connection)
    finally:
        connection.close()


_EXPECTED_SCHEMA_SIGNATURE_V2 = _build_expected_schema_signature()
_EXPECTED_SCHEMA_SIGNATURE_V3 = _build_expected_schema_signature(_SCHEMA_V2_TO_V3_DDL)
_EXPECTED_SCHEMA_SIGNATURE_V4 = _build_expected_schema_signature(
    (*_SCHEMA_V2_TO_V3_DDL, *_SCHEMA_V3_TO_V4_DDL)
)
_EXPECTED_SCHEMA_SIGNATURE_V5 = _build_expected_schema_signature(
    (
        *_SCHEMA_V2_TO_V3_DDL,
        *_SCHEMA_V3_TO_V4_DDL,
        *_SCHEMA_V4_TO_V5_DDL,
    )
)
_EXPECTED_SCHEMA_SIGNATURE_V6 = _build_expected_schema_signature(
    (
        *_SCHEMA_V2_TO_V3_DDL,
        *_SCHEMA_V3_TO_V4_DDL,
        *_SCHEMA_V4_TO_V5_DDL,
        *_SCHEMA_V5_TO_V6_DDL,
    )
)


_SCHEMA_V6_TO_V7_DDL = (
    "ALTER TABLE jobs ADD COLUMN share_gpu INTEGER NOT NULL DEFAULT 0 CHECK (share_gpu IN (0,1))",
    """ALTER TABLE jobs ADD COLUMN vram_mb INTEGER CHECK (
        (share_gpu=0 AND vram_mb IS NULL) OR
        (share_gpu=1 AND vram_mb IS NOT NULL AND vram_mb BETWEEN 1 AND 2147483647
         AND placement='pinned' AND gpu_count=1 AND min_gpu_count=1
         AND elastic_gpu_count=0 AND auto_scale_up=0 AND dispatch_mode='queue'))""",
    "ALTER TABLE leases RENAME TO leases_v6",
    "DROP INDEX leases_job_idx",
    "DROP INDEX leases_attempt_idx",
    """CREATE TABLE leases (
        gpu_uuid TEXT NOT NULL,
        gpu_index INTEGER NOT NULL CHECK (gpu_index >= 0),
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        acquired_at REAL NOT NULL,
        heartbeat_at REAL NOT NULL,
        lease_token TEXT NOT NULL,
        PRIMARY KEY(gpu_uuid, attempt_id),
        UNIQUE(gpu_index, attempt_id),
        FOREIGN KEY(attempt_id, job_id) REFERENCES attempts(id, job_id) ON DELETE CASCADE
    )""",
    "INSERT INTO leases SELECT * FROM leases_v6",
    "DROP TABLE leases_v6",
    "CREATE INDEX leases_job_idx ON leases(job_id)",
    "CREATE INDEX leases_attempt_idx ON leases(attempt_id)",
    """CREATE TRIGGER leases_sharing_insert_validate BEFORE INSERT ON leases BEGIN
        SELECT RAISE(ABORT, 'incompatible GPU sharing') WHERE EXISTS (
            SELECT 1 FROM leases AS l JOIN jobs AS j ON j.id=l.job_id
            WHERE (l.gpu_uuid=NEW.gpu_uuid OR l.gpu_index=NEW.gpu_index)
              AND (l.gpu_uuid<>NEW.gpu_uuid OR l.gpu_index<>NEW.gpu_index
                   OR (SELECT share_gpu FROM jobs WHERE id=NEW.job_id)=0)
        );
    END""",
)

_EXPECTED_SCHEMA_SIGNATURE_V7 = _build_expected_schema_signature(
    (
        *_SCHEMA_V2_TO_V3_DDL,
        *_SCHEMA_V3_TO_V4_DDL,
        *_SCHEMA_V4_TO_V5_DDL,
        *_SCHEMA_V5_TO_V6_DDL,
        *_SCHEMA_V6_TO_V7_DDL,
    )
)


_SCHEMA_V7_TO_V8_DDL = (
    "ALTER TABLE jobs ADD COLUMN hami_core INTEGER NOT NULL DEFAULT 0 CHECK (hami_core IN (0,1))",
    """ALTER TABLE jobs ADD COLUMN sm_percent INTEGER CHECK (
        (hami_core=0 AND sm_percent IS NULL) OR
        (hami_core=1 AND share_gpu=1 AND sm_percent IS NOT NULL AND sm_percent BETWEEN 1 AND 100))""",
)
_EXPECTED_SCHEMA_SIGNATURE_V8 = _build_expected_schema_signature(
    (
        *_SCHEMA_V2_TO_V3_DDL,
        *_SCHEMA_V3_TO_V4_DDL,
        *_SCHEMA_V4_TO_V5_DDL,
        *_SCHEMA_V5_TO_V6_DDL,
        *_SCHEMA_V6_TO_V7_DDL,
        *_SCHEMA_V7_TO_V8_DDL,
    )
)


_SCHEMA_V8_TO_V9_DDL = (
    """ALTER TABLE jobs ADD COLUMN yield_policy TEXT NOT NULL DEFAULT 'legacy'
    CHECK (yield_policy IN ('legacy','never','now','save')
       AND (yield_policy<>'save' OR checkpoint_capability='epoch-v1')
       AND (yield_policy NOT IN ('now','save') OR share_gpu=0))""",
)
_EXPECTED_SCHEMA_SIGNATURE_V9 = _build_expected_schema_signature((
    *_SCHEMA_V2_TO_V3_DDL, *_SCHEMA_V3_TO_V4_DDL, *_SCHEMA_V4_TO_V5_DDL,
    *_SCHEMA_V5_TO_V6_DDL, *_SCHEMA_V6_TO_V7_DDL, *_SCHEMA_V7_TO_V8_DDL,
    *_SCHEMA_V8_TO_V9_DDL,
))

_SCHEMA_V9_TO_V10_DDL = (
    """ALTER TABLE jobs ADD COLUMN preempt_idle_only INTEGER NOT NULL DEFAULT 0
    CHECK (preempt_idle_only IN (0,1))""",
)
_EXPECTED_SCHEMA_SIGNATURE_V10 = _build_expected_schema_signature((
    *_SCHEMA_V2_TO_V3_DDL, *_SCHEMA_V3_TO_V4_DDL, *_SCHEMA_V4_TO_V5_DDL,
    *_SCHEMA_V5_TO_V6_DDL, *_SCHEMA_V6_TO_V7_DDL, *_SCHEMA_V7_TO_V8_DDL,
    *_SCHEMA_V8_TO_V9_DDL, *_SCHEMA_V9_TO_V10_DDL,
))

_SCHEMA_V10_TO_V11_DDL = (
    """CREATE TABLE gpu_allocation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        gpu_uuid TEXT NOT NULL,
        gpu_index INTEGER NOT NULL CHECK (gpu_index>=0),
        acquired_at REAL NOT NULL,
        released_at REAL,
        release_reason TEXT,
        source TEXT NOT NULL CHECK (source IN ('observed','migrated_active')),
        FOREIGN KEY(attempt_id, job_id) REFERENCES attempts(id, job_id)
    )""",
    """CREATE UNIQUE INDEX allocation_history_active_idx
        ON gpu_allocation_history(attempt_id,gpu_uuid) WHERE released_at IS NULL""",
    "CREATE INDEX allocation_history_job_idx ON gpu_allocation_history(job_id,id DESC)",
    """INSERT INTO gpu_allocation_history(
        job_id,attempt_id,gpu_uuid,gpu_index,acquired_at,source)
        SELECT job_id,attempt_id,gpu_uuid,gpu_index,acquired_at,'migrated_active'
        FROM leases ORDER BY acquired_at,attempt_id,gpu_index""",
)
_EXPECTED_SCHEMA_SIGNATURE_V11 = _build_expected_schema_signature((
    *_SCHEMA_V2_TO_V3_DDL, *_SCHEMA_V3_TO_V4_DDL, *_SCHEMA_V4_TO_V5_DDL,
    *_SCHEMA_V5_TO_V6_DDL, *_SCHEMA_V6_TO_V7_DDL, *_SCHEMA_V7_TO_V8_DDL,
    *_SCHEMA_V8_TO_V9_DDL, *_SCHEMA_V9_TO_V10_DDL, *_SCHEMA_V10_TO_V11_DDL,
))

_SCHEMA_V11_TO_V12_DDL = (
    """ALTER TABLE jobs ADD COLUMN preempt_opt_in_only INTEGER NOT NULL DEFAULT 0
    CHECK (preempt_opt_in_only IN (0,1))""",
)
_EXPECTED_SCHEMA_SIGNATURE_V12 = _build_expected_schema_signature((
    *_SCHEMA_V2_TO_V3_DDL, *_SCHEMA_V3_TO_V4_DDL, *_SCHEMA_V4_TO_V5_DDL,
    *_SCHEMA_V5_TO_V6_DDL, *_SCHEMA_V6_TO_V7_DDL, *_SCHEMA_V7_TO_V8_DDL,
    *_SCHEMA_V8_TO_V9_DDL, *_SCHEMA_V9_TO_V10_DDL, *_SCHEMA_V10_TO_V11_DDL,
    *_SCHEMA_V11_TO_V12_DDL,
))

_SCHEMA_V12_TO_V13_DDL = (
    """ALTER TABLE jobs ADD COLUMN display_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(display_json) AND json_type(display_json)='object')""",
)
_EXPECTED_SCHEMA_SIGNATURE = _build_expected_schema_signature((
    *_SCHEMA_V2_TO_V3_DDL, *_SCHEMA_V3_TO_V4_DDL, *_SCHEMA_V4_TO_V5_DDL,
    *_SCHEMA_V5_TO_V6_DDL, *_SCHEMA_V6_TO_V7_DDL, *_SCHEMA_V7_TO_V8_DDL,
    *_SCHEMA_V8_TO_V9_DDL, *_SCHEMA_V9_TO_V10_DDL, *_SCHEMA_V10_TO_V11_DDL,
    *_SCHEMA_V11_TO_V12_DDL, *_SCHEMA_V12_TO_V13_DDL,
))


class Store:
    """Thread-safe owner of one SQLite connection.

    A ``Store`` must not be shared across ``fork()``.  It may be shared by
    threads: an ``RLock`` serializes the connection and every write uses an
    explicit ``BEGIN IMMEDIATE`` transaction.
    """

    def __init__(
        self,
        path: str | os.PathLike[str],
        *,
        busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
        clock: Any = None,
    ) -> None:
        self.path = Path(path)
        if busy_timeout_ms < 0:
            raise ValueError("busy_timeout_ms must be non-negative")
        self.busy_timeout_ms = int(busy_timeout_ms)
        self._clock = clock or time.time
        self._lock = threading.RLock()
        self._connection: sqlite3.Connection | None = None
        self._pid: int | None = None
        self._transaction_depth = 0

    @property
    def is_open(self) -> bool:
        return self._connection is not None

    def _now(self) -> float:
        return _finite_timestamp(self._clock(), "clock result")

    def _require_regular_file(self) -> None:
        try:
            info = self.path.lstat()
        except FileNotFoundError as exc:
            raise StoreNotInitializedError(
                f"gpuq database is not initialized: {self.path}"
            ) from exc
        if not stat.S_ISREG(info.st_mode):
            raise StoreNotInitializedError(
                f"gpuq database is not a regular file: {self.path}"
            )

    def _uri(self, mode: str) -> str:
        if mode not in {"rw", "rwc"}:  # private fixed modes only.
            raise AssertionError("invalid SQLite open mode")
        return f"{self.path.resolve().as_uri()}?mode={mode}"

    def _connect(self, mode: str) -> sqlite3.Connection:
        connection: sqlite3.Connection | None = None
        try:
            connection = sqlite3.connect(
                self._uri(mode),
                uri=True,
                timeout=self.busy_timeout_ms / 1000,
                isolation_level=None,
                check_same_thread=False,
            )
            connection.row_factory = sqlite3.Row
            connection.execute(f"PRAGMA busy_timeout={self.busy_timeout_ms}")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=FULL")
            if connection.execute("PRAGMA foreign_keys").fetchone()[0] != 1:
                raise StoreError("SQLite foreign-key enforcement is disabled")
            if connection.execute("PRAGMA synchronous").fetchone()[0] != 2:
                raise StoreError("SQLite synchronous mode is not FULL")
            return connection
        except sqlite3.DatabaseError as exc:
            if connection is not None:
                connection.close()
            raise self._database_exception(exc) from exc
        except BaseException:
            if connection is not None:
                connection.close()
            raise

    def _configure_wal(self, connection: sqlite3.Connection) -> None:
        """Switch a validated gpuq DB to WAL, retrying SQLite's PRAGMA race."""

        deadline = time.monotonic() + self.busy_timeout_ms / 1000
        while True:
            try:
                journal_mode = connection.execute("PRAGMA journal_mode=WAL").fetchone()[
                    0
                ]
                if str(journal_mode).lower() != "wal":
                    raise StoreError("SQLite refused WAL journal mode")
                return
            except sqlite3.OperationalError as exc:
                message = str(exc).lower()
                if (
                    "locked" not in message and "busy" not in message
                ) or time.monotonic() >= deadline:
                    raise self._database_exception(exc) from exc
                time.sleep(0.01)
            except sqlite3.DatabaseError as exc:
                raise self._database_exception(exc) from exc

    @staticmethod
    def _database_exception(exc: sqlite3.DatabaseError) -> StoreError:
        corrupt_codes = {
            getattr(sqlite3, "SQLITE_CORRUPT", 11),
            getattr(sqlite3, "SQLITE_NOTADB", 26),
        }
        code = getattr(exc, "sqlite_errorcode", None)
        message = str(exc).lower()
        corrupt_markers = (
            "not a database",
            "malformed",
            "corrupt",
            "file is encrypted",
            "unsupported file format",
        )
        if code in corrupt_codes or any(
            marker in message for marker in corrupt_markers
        ):
            return StoreCorruptError(f"invalid gpuq database: {exc}")
        return StoreError(f"SQLite failure: {exc}")

    def initialize(self) -> "Store":
        """Explicitly initialize a new DB, or validate an existing gpuq DB."""

        with self._lock:
            if self._connection is not None:
                self.check_integrity()
                return self
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            try:
                self._require_regular_file()
            except StoreNotInitializedError:
                flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
                if hasattr(os, "O_NOFOLLOW"):
                    flags |= os.O_NOFOLLOW
                try:
                    descriptor = os.open(self.path, flags, 0o600)
                except FileExistsError:
                    self._require_regular_file()
                else:
                    os.close(descriptor)

            connection = self._connect("rw")
            try:
                # Inspect and create only after taking SQLite's writer lock.
                # Otherwise two explicit init processes can both observe an
                # empty DB and race their CREATE statements.
                connection.execute("BEGIN EXCLUSIVE")
                try:
                    objects = connection.execute(
                        """
                        SELECT name FROM sqlite_master
                        WHERE type IN ('table','view')
                          AND name NOT LIKE 'sqlite_%'
                        """
                    ).fetchall()
                    version = int(
                        connection.execute("PRAGMA user_version").fetchone()[0]
                    )
                    app_id = int(
                        connection.execute("PRAGMA application_id").fetchone()[0]
                    )
                    if not objects and version == 0 and app_id == 0:
                        now = self._now()
                        for statement in _SCHEMA_V2_STATEMENTS:
                            connection.execute(statement)
                        connection.execute(
                            """
                            INSERT INTO schema_meta(
                                singleton, schema_version, initialized_at
                            ) VALUES (1, ?, ?)
                            """,
                            (_SCHEMA_VERSION_V2, now),
                        )
                        connection.execute(f"PRAGMA application_id={APPLICATION_ID}")
                        connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION_V2}")
                        version = _SCHEMA_VERSION_V2
                    if version == _SCHEMA_VERSION_V2:
                        self._migrate_v2_to_v3(connection)
                        version = _SCHEMA_VERSION_V3
                    if version == _SCHEMA_VERSION_V3:
                        self._migrate_v3_to_v4(connection)
                        version = _SCHEMA_VERSION_V4
                    if version == _SCHEMA_VERSION_V4:
                        self._migrate_v4_to_v5(connection)
                        version = _SCHEMA_VERSION_V5
                    if version == _SCHEMA_VERSION_V5:
                        self._migrate_v5_to_v6(connection)
                        version = _SCHEMA_VERSION_V6
                    if version == _SCHEMA_VERSION_V6:
                        self._migrate_v6_to_v7(connection)
                        version = _SCHEMA_VERSION_V7
                    if version == _SCHEMA_VERSION_V7:
                        self._migrate_v7_to_v8(connection)
                        version = _SCHEMA_VERSION_V8
                    if version == _SCHEMA_VERSION_V8:
                        self._migrate_v8_to_v9(connection)
                        version = _SCHEMA_VERSION_V9
                    if version == _SCHEMA_VERSION_V9:
                        self._migrate_v9_to_v10(connection)
                        version = _SCHEMA_VERSION_V10
                    if version == _SCHEMA_VERSION_V10:
                        self._migrate_v10_to_v11(connection)
                        version = 11
                    if version == 11:
                        self._migrate_v11_to_v12(connection)
                        version = 12
                    if version == 12:
                        self._migrate_v12_to_v13(connection)
                    self._validate_schema(connection)
                    connection.commit()
                except BaseException:
                    connection.rollback()
                    raise
                # Explicit initialization also repairs an accidentally
                # pre-created world/group-readable empty file.
                os.chmod(self.path, 0o600)
                self._validate_integrity(connection)
                self._configure_wal(connection)
            except sqlite3.DatabaseError as exc:
                connection.close()
                raise self._database_exception(exc) from exc
            except BaseException:
                connection.close()
                raise
            self._connection = connection
            self._pid = os.getpid()
            return self

    def open(self, *, integrity_check: bool = True) -> "Store":
        """Open an existing initialized DB; never creates a missing file."""

        with self._lock:
            if self._connection is not None:
                if integrity_check:
                    self.check_integrity()
                return self
            self._require_regular_file()
            connection = self._connect("rw")
            try:
                self._validate_schema(connection)
                if integrity_check:
                    self._validate_integrity(connection)
                self._configure_wal(connection)
            except sqlite3.DatabaseError as exc:
                connection.close()
                raise self._database_exception(exc) from exc
            except BaseException:
                connection.close()
                raise
            self._connection = connection
            self._pid = os.getpid()
            return self

    # A daemon entry point with a name that makes the fail-closed intent clear.
    open_daemon = open

    def _validate_schema_version(
        self,
        connection: sqlite3.Connection,
        *,
        version: int,
        expected_signature: tuple[tuple[str, str, str, str], ...],
    ) -> None:
        app_id = int(connection.execute("PRAGMA application_id").fetchone()[0])
        actual_version = int(connection.execute("PRAGMA user_version").fetchone()[0])
        if app_id != APPLICATION_ID:
            raise StoreSchemaError(
                f"wrong SQLite application_id {app_id}; expected {APPLICATION_ID}"
            )
        if actual_version != version:
            raise StoreSchemaError(
                "unsupported schema version " f"{actual_version}; expected {version}"
            )
        tables = {
            str(row[0])
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if version in {11, 12, STORE_SCHEMA_VERSION}:
            required_tables = _REQUIRED_TABLES
        elif version in {_SCHEMA_VERSION_V6, _SCHEMA_VERSION_V7, _SCHEMA_VERSION_V8, _SCHEMA_VERSION_V9, _SCHEMA_VERSION_V10}:
            required_tables = _REQUIRED_TABLES_V6_TO_V10
        elif version == _SCHEMA_VERSION_V5:
            required_tables = _REQUIRED_TABLES_V5
        else:
            required_tables = _REQUIRED_TABLES_V2_TO_V4
        missing = sorted(required_tables - tables)
        if missing:
            raise StoreSchemaError(
                "gpuq database is missing tables: " + ", ".join(missing)
            )
        row = connection.execute(
            "SELECT schema_version FROM schema_meta WHERE singleton=1"
        ).fetchone()
        if row is None or int(row[0]) != version:
            raise StoreSchemaError("schema_meta version does not match user_version")
        if _schema_signature(connection) != expected_signature:
            raise StoreSchemaError(
                f"gpuq schema objects do not match expected schema version {version}"
            )

    def _validate_schema(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(
            connection,
            version=STORE_SCHEMA_VERSION,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE,
        )

    def _migrate_v2_to_v3(self, connection: sqlite3.Connection) -> None:
        """Transactionally migrate the exact production v2 schema to v3.

        The caller owns an exclusive transaction.  Validation happens before
        any DDL, and SQLite's transactional DDL ensures that a bad legacy row
        rolls the complete migration back to v2.
        """

        if STORE_SCHEMA_VERSION < _SCHEMA_VERSION_V3:
            raise StoreSchemaError("v2 migration requires STORE_SCHEMA_VERSION>=3")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V2,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V2,
        )
        connection.execute(_SCHEMA_V2_TO_V3_DDL[0])
        connection.execute("UPDATE jobs SET min_gpu_count=gpu_count")
        connection.execute(_SCHEMA_V2_TO_V3_DDL[1])

        # Submission idempotency must survive migration.  V3 includes the new
        # scheduling contract in the digest, so re-key every legacy row to the
        # equivalent strict min=max, elastic=false request.
        rows = connection.execute(
            """
            SELECT id, name, owner, priority, dispatch_mode,
                   checkpoint_capability, restart_policy, gpu_count,
                   placement, requested_gpu_uuids_json, argv_json, cwd,
                   env_json
            FROM jobs
            """
        ).fetchall()
        for row in rows:
            requested_gpu_uuids_json = _json_dump(
                _json_load(row["requested_gpu_uuids_json"])
            )
            argv_json = _json_dump(_json_load(row["argv_json"]))
            env_json = _json_dump(_json_load(row["env_json"]))
            digest = _submission_digest(
                name=str(row["name"]),
                owner=str(row["owner"]),
                priority=int(row["priority"]),
                dispatch_mode=str(row["dispatch_mode"]),
                checkpoint_capability=str(row["checkpoint_capability"]),
                restart_policy=str(row["restart_policy"]),
                gpu_count=int(row["gpu_count"]),
                min_gpu_count=int(row["gpu_count"]),
                elastic_gpu_count=False,
                auto_scale_up=False,
                target_global_batch_size=None,
                per_device_micro_batch_size=None,
                placement=str(row["placement"]),
                requested_gpu_uuids_json=requested_gpu_uuids_json,
                argv_json=argv_json,
                cwd=str(row["cwd"]),
                env_json=env_json,
                include_batch_fields=False,
            )
            connection.execute(
                "UPDATE jobs SET submit_digest=? WHERE id=?",
                (digest, row["id"]),
            )

        connection.execute(
            "UPDATE schema_meta SET schema_version=? WHERE singleton=1",
            (_SCHEMA_VERSION_V3,),
        )
        connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION_V3}")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V3,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V3,
        )

    def _migrate_v3_to_v4(self, connection: sqlite3.Connection) -> None:
        """Transactionally add the optional batch/world-size contract."""

        if STORE_SCHEMA_VERSION < _SCHEMA_VERSION_V4:
            raise StoreSchemaError("v3 migration requires STORE_SCHEMA_VERSION>=4")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V3,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V3,
        )
        for statement in _SCHEMA_V3_TO_V4_DDL:
            connection.execute(statement)

        # V3 jobs have no batch metadata.  Include the two canonical nulls in
        # their v4 digest so old-protocol retries remain exactly idempotent.
        rows = connection.execute(
            """
            SELECT id, name, owner, priority, dispatch_mode,
                   checkpoint_capability, restart_policy, gpu_count,
                   min_gpu_count, elastic_gpu_count, placement,
                   requested_gpu_uuids_json, argv_json, cwd, env_json
            FROM jobs
            """
        ).fetchall()
        for row in rows:
            requested_gpu_uuids_json = _json_dump(
                _json_load(row["requested_gpu_uuids_json"])
            )
            argv_json = _json_dump(_json_load(row["argv_json"]))
            env_json = _json_dump(_json_load(row["env_json"]))
            digest = _submission_digest(
                name=str(row["name"]),
                owner=str(row["owner"]),
                priority=int(row["priority"]),
                dispatch_mode=str(row["dispatch_mode"]),
                checkpoint_capability=str(row["checkpoint_capability"]),
                restart_policy=str(row["restart_policy"]),
                gpu_count=int(row["gpu_count"]),
                min_gpu_count=int(row["min_gpu_count"]),
                elastic_gpu_count=int(row["elastic_gpu_count"]),
                auto_scale_up=False,
                target_global_batch_size=None,
                per_device_micro_batch_size=None,
                placement=str(row["placement"]),
                requested_gpu_uuids_json=requested_gpu_uuids_json,
                argv_json=argv_json,
                cwd=str(row["cwd"]),
                env_json=env_json,
            )
            connection.execute(
                "UPDATE jobs SET submit_digest=? WHERE id=?",
                (digest, row["id"]),
            )

        connection.execute(
            "UPDATE schema_meta SET schema_version=? WHERE singleton=1",
            (_SCHEMA_VERSION_V4,),
        )
        connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION_V4}")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V4,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V4,
        )

    def _migrate_v4_to_v5(self, connection: sqlite3.Connection) -> None:
        """Add durable, opt-in checkpoint/restart scale-up state."""

        if STORE_SCHEMA_VERSION < _SCHEMA_VERSION_V5:
            raise StoreSchemaError("v4 migration requires STORE_SCHEMA_VERSION>=5")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V4,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V4,
        )
        for statement in _SCHEMA_V4_TO_V5_DDL:
            connection.execute(statement)

        # Every historical job remains opt-out.  Re-key the digest so an old
        # protocol retry (which omits auto_scale_up) is still idempotent while
        # an explicit opt-in with the same submit_key is rejected.
        rows = connection.execute(
            """
            SELECT id, name, owner, priority, dispatch_mode,
                   checkpoint_capability, restart_policy, gpu_count,
                   min_gpu_count, elastic_gpu_count,
                   target_global_batch_size, per_device_micro_batch_size,
                   placement, requested_gpu_uuids_json, argv_json, cwd,
                   env_json
            FROM jobs
            """
        ).fetchall()
        for row in rows:
            digest = _submission_digest(
                name=str(row["name"]),
                owner=str(row["owner"]),
                priority=int(row["priority"]),
                dispatch_mode=str(row["dispatch_mode"]),
                checkpoint_capability=str(row["checkpoint_capability"]),
                restart_policy=str(row["restart_policy"]),
                gpu_count=int(row["gpu_count"]),
                min_gpu_count=int(row["min_gpu_count"]),
                elastic_gpu_count=int(row["elastic_gpu_count"]),
                auto_scale_up=False,
                target_global_batch_size=row["target_global_batch_size"],
                per_device_micro_batch_size=row["per_device_micro_batch_size"],
                placement=str(row["placement"]),
                requested_gpu_uuids_json=_json_dump(
                    _json_load(row["requested_gpu_uuids_json"])
                ),
                argv_json=_json_dump(_json_load(row["argv_json"])),
                cwd=str(row["cwd"]),
                env_json=_json_dump(_json_load(row["env_json"])),
            )
            connection.execute(
                "UPDATE jobs SET submit_digest=? WHERE id=?",
                (digest, row["id"]),
            )

        connection.execute(
            "UPDATE schema_meta SET schema_version=? WHERE singleton=1",
            (_SCHEMA_VERSION_V5,),
        )
        connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION_V5}")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V5,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V5,
        )

    def _migrate_v5_to_v6(self, connection: sqlite3.Connection) -> None:
        """Add one bounded latest-snapshot row for each reporting attempt."""

        if STORE_SCHEMA_VERSION < 6:
            raise StoreSchemaError("v5 migration requires STORE_SCHEMA_VERSION>=6")
        self._validate_schema_version(
            connection,
            version=_SCHEMA_VERSION_V5,
            expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V5,
        )
        for statement in _SCHEMA_V5_TO_V6_DDL:
            connection.execute(statement)
        connection.execute(
            "UPDATE schema_meta SET schema_version=? WHERE singleton=1",
            (_SCHEMA_VERSION_V6,),
        )
        connection.execute(f"PRAGMA user_version={_SCHEMA_VERSION_V6}")
        self._validate_schema_version(
            connection, version=6, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V6
        )

    def _migrate_v6_to_v7(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(
            connection, version=6, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V6
        )
        for statement in _SCHEMA_V6_TO_V7_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=7 WHERE singleton=1")
        connection.execute("PRAGMA user_version=7")
        self._validate_schema_version(
            connection, version=7, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V7
        )

    def _migrate_v7_to_v8(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(
            connection, version=7, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V7
        )
        for statement in _SCHEMA_V7_TO_V8_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=8 WHERE singleton=1")
        connection.execute("PRAGMA user_version=8")
        self._validate_schema_version(connection, version=8, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V8)

    def _migrate_v8_to_v9(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(connection, version=8, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V8)
        for statement in _SCHEMA_V8_TO_V9_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=9 WHERE singleton=1")
        connection.execute("PRAGMA user_version=9")
        self._validate_schema_version(connection, version=9, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V9)

    def _migrate_v9_to_v10(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(connection, version=9, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V9)
        for statement in _SCHEMA_V9_TO_V10_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=10 WHERE singleton=1")
        connection.execute("PRAGMA user_version=10")
        self._validate_schema_version(connection, version=10, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V10)

    def _migrate_v10_to_v11(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(connection, version=10, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V10)
        for statement in _SCHEMA_V10_TO_V11_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=11 WHERE singleton=1")
        connection.execute("PRAGMA user_version=11")
        self._validate_schema_version(connection, version=11, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V11)

    def _migrate_v11_to_v12(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(connection, version=11, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V11)
        for statement in _SCHEMA_V11_TO_V12_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=12 WHERE singleton=1")
        connection.execute("PRAGMA user_version=12")
        self._validate_schema_version(connection, version=12, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V12)

    def _migrate_v12_to_v13(self, connection: sqlite3.Connection) -> None:
        self._validate_schema_version(connection, version=12, expected_signature=_EXPECTED_SCHEMA_SIGNATURE_V12)
        for statement in _SCHEMA_V12_TO_V13_DDL:
            connection.execute(statement)
        connection.execute("UPDATE schema_meta SET schema_version=13 WHERE singleton=1")
        connection.execute("PRAGMA user_version=13")
        self._validate_schema(connection)

    @staticmethod
    def _validate_integrity(connection: sqlite3.Connection) -> None:
        rows = connection.execute("PRAGMA integrity_check").fetchall()
        if len(rows) != 1 or str(rows[0][0]).lower() != "ok":
            details = "; ".join(str(row[0]) for row in rows[:8])
            raise StoreCorruptError(f"SQLite integrity_check failed: {details}")
        foreign_key_errors = connection.execute("PRAGMA foreign_key_check").fetchall()
        if foreign_key_errors:
            raise StoreCorruptError(
                f"SQLite foreign_key_check found {len(foreign_key_errors)} error(s)"
            )

    def check_integrity(self) -> dict[str, Any]:
        with self._read_connection() as connection:
            self._validate_schema(connection)
            self._validate_integrity(connection)
            return {
                "ok": True,
                "schema_version": STORE_SCHEMA_VERSION,
                "application_id": APPLICATION_ID,
                "journal_mode": str(
                    connection.execute("PRAGMA journal_mode").fetchone()[0]
                ).lower(),
                "synchronous": int(
                    connection.execute("PRAGMA synchronous").fetchone()[0]
                ),
                "foreign_keys": bool(
                    connection.execute("PRAGMA foreign_keys").fetchone()[0]
                ),
            }

    health = check_integrity

    def close(self) -> None:
        with self._lock:
            connection, self._connection = self._connection, None
            self._pid = None
            self._transaction_depth = 0
            if connection is not None:
                connection.close()

    def __enter__(self) -> "Store":
        return self.open()

    def __exit__(self, *_exc: object) -> None:
        self.close()

    def _get_connection(self) -> sqlite3.Connection:
        if self._connection is None:
            self.open()
        if self._pid != os.getpid():
            raise StoreError("Store connection cannot be used after fork")
        assert self._connection is not None
        return self._connection

    @contextlib.contextmanager
    def _read_connection(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            connection = self._get_connection()
            try:
                yield connection
            except sqlite3.DatabaseError as exc:
                raise self._database_exception(exc) from exc

    @contextlib.contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock:
            connection = self._get_connection()
            depth = self._transaction_depth
            savepoint = f"gpuq_nested_{depth}"
            try:
                if depth == 0:
                    connection.execute("BEGIN IMMEDIATE")
                else:
                    connection.execute(f"SAVEPOINT {savepoint}")
                self._transaction_depth += 1
                yield connection
                if depth == 0:
                    connection.commit()
                else:
                    connection.execute(f"RELEASE SAVEPOINT {savepoint}")
            except sqlite3.IntegrityError:
                if depth == 0:
                    connection.rollback()
                else:
                    connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    connection.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise
            except sqlite3.DatabaseError as exc:
                if depth == 0:
                    connection.rollback()
                else:
                    with contextlib.suppress(sqlite3.DatabaseError):
                        connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                        connection.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise self._database_exception(exc) from exc
            except BaseException:
                if depth == 0:
                    connection.rollback()
                else:
                    connection.execute(f"ROLLBACK TO SAVEPOINT {savepoint}")
                    connection.execute(f"RELEASE SAVEPOINT {savepoint}")
                raise
            finally:
                self._transaction_depth = depth

    @contextlib.contextmanager
    def transaction(self) -> Iterator["Store"]:
        """Atomically compose multiple public mutation methods.

        The yielded object is this store rather than a raw SQLite connection,
        so callers retain the parameterized, validated CRUD boundary::

            with store.transaction() as tx:
                attempt = tx.create_attempt(job_id)
                tx.acquire_leases(job_id, attempt["id"], assignments)
                tx.enqueue_action(...)

        Nested CRUD transactions use savepoints.  Any exception escaping this
        context rolls the entire unit of work back.
        """

        with self._transaction():
            yield self

    # -------------------------------------------------------------- settings

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Return one JSON setting, or ``default`` when it has not been set."""

        key = _nonempty(key, "setting key", maximum=256)
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT value_json FROM settings WHERE key=?", (key,)
            ).fetchone()
        return default if row is None else _json_load(row["value_json"])

    def set_setting(self, key: str, value: Any) -> Any:
        """Atomically insert or replace a JSON setting and return ``value``."""

        key = _nonempty(key, "setting key", maximum=256)
        value_json = _json_dump(value)
        now = self._now()
        with self._transaction() as connection:
            connection.execute(
                """
                INSERT INTO settings(key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE
                SET value_json=excluded.value_json,
                    updated_at=excluded.updated_at
                """,
                (key, value_json, now),
            )
        # Decode the canonical representation so tuples, for example, have the
        # same representation on the setting call and after a process restart.
        return _json_load(value_json)

    def list_settings(self) -> dict[str, Any]:
        with self._read_connection() as connection:
            rows = connection.execute(
                "SELECT key, value_json FROM settings ORDER BY key"
            ).fetchall()
        return {str(row["key"]): _json_load(row["value_json"]) for row in rows}

    def delete_setting(self, key: str) -> bool:
        key = _nonempty(key, "setting key", maximum=256)
        with self._transaction() as connection:
            cursor = connection.execute("DELETE FROM settings WHERE key=?", (key,))
            return cursor.rowcount == 1

    # ------------------------------------------------------------------ jobs

    @staticmethod
    def _job(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["display_metadata"] = _json_load(result.pop("display_json"))
        result["argv"] = _json_load(result.pop("argv_json"))
        result["env"] = _json_load(result.pop("env_json"))
        result["requested_gpu_uuids"] = _json_load(
            result.pop("requested_gpu_uuids_json")
        )
        result["elastic_gpu_count"] = bool(result["elastic_gpu_count"])
        result["auto_scale_up"] = bool(result["auto_scale_up"])
        result["share_gpu"] = bool(result["share_gpu"])
        result["hami_core"] = bool(result["hami_core"])
        result["preempt_idle_only"] = bool(result["preempt_idle_only"])
        result["preempt_opt_in_only"] = bool(result["preempt_opt_in_only"])
        result["priority_name"] = f"P{result['priority']}"
        result.pop("submit_digest", None)
        return result

    def submit_job(
        self,
        submission: Mapping[str, Any] | None = None,
        **fields: Any,
    ) -> dict[str, Any]:
        """Insert an idempotent submission and return its durable job row.

        Repeating an identical request with the same ``submit_key`` returns the
        original row.  Reusing that key for different content is rejected.
        """

        values = dict(submission or {})
        overlap = set(values).intersection(fields)
        if overlap:
            raise ValueError(
                f"duplicate submission fields: {', '.join(sorted(overlap))}"
            )
        values.update(fields)
        allowed = {
            "preempt_idle_only",
            "preempt_opt_in_only",
            "yield_policy",
            "hami_core",
            "sm_percent",
            "share_gpu",
            "vram_mb",
            "id",
            "job_id",
            "submit_key",
            "name",
            "owner",
            "priority",
            "dispatch_mode",
            "checkpoint_capability",
            "restart_policy",
            "gpu_count",
            "min_gpu_count",
            "elastic_gpu_count",
            "auto_scale_up",
            "target_global_batch_size",
            "per_device_micro_batch_size",
            "placement",
            "requested_gpu_uuids",
            "argv",
            "cwd",
            "env",
        }
        unknown = sorted(set(values) - allowed)
        if unknown:
            raise ValueError(f"unknown job fields: {', '.join(unknown)}")
        if "id" in values and "job_id" in values:
            raise ValueError("id and job_id are aliases; provide only one")
        submit_key = _nonempty(values.get("submit_key"), "submit_key", maximum=256)
        name = _nonempty(values.get("name"), "name", maximum=256)
        owner = _nonempty(values.get("owner"), "owner", maximum=256)
        priority = _priority(values.get("priority"))
        dispatch_mode = _choice(
            values.get("dispatch_mode", DispatchMode.QUEUE),
            _DISPATCH_MODES,
            "dispatch_mode",
        )
        checkpoint_capability = _choice(
            values.get("checkpoint_capability", CheckpointCapability.NONE),
            _CHECKPOINT_CAPABILITIES,
            "checkpoint_capability",
        )
        restart_policy = _choice(
            values.get("restart_policy", RestartPolicy.ON_PREEMPT),
            _RESTART_POLICIES,
            "restart_policy",
        )
        gpu_count = values.get("gpu_count")
        if isinstance(gpu_count, bool) or not isinstance(gpu_count, int):
            raise ValueError("gpu_count must be a positive integer")
        if gpu_count <= 0:
            raise ValueError("gpu_count must be a positive integer")
        min_gpu_count = values.get("min_gpu_count", gpu_count)
        if (
            isinstance(min_gpu_count, bool)
            or not isinstance(min_gpu_count, int)
            or min_gpu_count <= 0
        ):
            raise ValueError("min_gpu_count must be a positive integer")
        if min_gpu_count > gpu_count:
            raise ValueError("min_gpu_count must not exceed gpu_count")
        elastic_gpu_count = values.get("elastic_gpu_count", False)
        if not isinstance(elastic_gpu_count, bool):
            raise ValueError("elastic_gpu_count must be a boolean")
        placement = _choice(
            values.get("placement", "any"),
            _PLACEMENTS,
            "placement",
        )
        if elastic_gpu_count and placement != "any":
            raise ValueError("elastic GPU count requires any placement")
        if not elastic_gpu_count and min_gpu_count != gpu_count:
            raise ValueError(
                "min_gpu_count must equal gpu_count when elastic_gpu_count is false"
            )
        auto_scale_up = values.get("auto_scale_up", False)
        if not isinstance(auto_scale_up, bool):
            raise ValueError("auto_scale_up must be a boolean")
        target_global_batch_size = _optional_positive_sqlite_int(
            values.get("target_global_batch_size"),
            "target_global_batch_size",
        )
        per_device_micro_batch_size = _optional_positive_sqlite_int(
            values.get("per_device_micro_batch_size"),
            "per_device_micro_batch_size",
        )
        if (target_global_batch_size is None) != (per_device_micro_batch_size is None):
            raise ValueError(
                "target_global_batch_size and per_device_micro_batch_size "
                "must be provided together"
            )
        if target_global_batch_size is not None:
            assert per_device_micro_batch_size is not None
            if placement != "any" or not elastic_gpu_count:
                raise ValueError("batch-size metadata requires elastic any placement")
            if not any(
                target_global_batch_size % (world_size * per_device_micro_batch_size)
                == 0
                for world_size in range(min_gpu_count, gpu_count + 1)
            ):
                raise ValueError(
                    "batch-size metadata has no compatible GPU count "
                    "between min_gpu_count and gpu_count"
                )
        if auto_scale_up:
            if not elastic_gpu_count or placement != "any":
                raise ValueError("automatic scale-up requires elastic any placement")
            if checkpoint_capability != CheckpointCapability.EPOCH_V1.value:
                raise ValueError(
                    "automatic scale-up requires epoch-v1 checkpoint capability"
                )
            if restart_policy != RestartPolicy.ON_PREEMPT.value:
                raise ValueError(
                    "automatic scale-up requires on-preempt restart policy"
                )
            if target_global_batch_size is None or per_device_micro_batch_size is None:
                raise ValueError("automatic scale-up requires batch-size metadata")
            legal_gpu_counts = [
                world_size
                for world_size in range(min_gpu_count, gpu_count + 1)
                if target_global_batch_size % (world_size * per_device_micro_batch_size)
                == 0
            ]
            if len(legal_gpu_counts) < 2:
                raise ValueError(
                    "automatic scale-up requires at least two compatible GPU counts"
                )
        requested_gpu_uuids = values.get("requested_gpu_uuids", ())
        if not isinstance(requested_gpu_uuids, Sequence) or isinstance(
            requested_gpu_uuids, (str, bytes)
        ):
            raise ValueError("requested_gpu_uuids must be a sequence of GPU UUIDs")
        normalized_gpu_uuids = [
            _nonempty(item, "requested GPU UUID", maximum=256)
            for item in requested_gpu_uuids
        ]
        if len(set(normalized_gpu_uuids)) != len(normalized_gpu_uuids):
            raise ValueError("requested_gpu_uuids must contain unique GPU UUIDs")
        if placement == "any" and normalized_gpu_uuids:
            raise ValueError("any placement must not request specific GPU UUIDs")
        if placement == "pinned" and (
            not normalized_gpu_uuids or len(normalized_gpu_uuids) != gpu_count
        ):
            raise ValueError(
                "pinned placement requires exactly gpu_count requested GPU UUIDs"
            )
        requested_gpu_uuids_json = _json_dump(normalized_gpu_uuids)
        share_gpu, vram_mb = validate_sharing(
            values.get("share_gpu", False),
            values.get("vram_mb"),
            placement=placement,
            gpu_count=gpu_count,
            elastic=elastic_gpu_count,
            mode=dispatch_mode,
        )
        argv = values.get("argv")
        if (
            not isinstance(argv, Sequence)
            or isinstance(argv, (str, bytes))
            or not argv
            or any(not isinstance(item, str) or "\x00" in item for item in argv)
        ):
            raise ValueError("argv must be a non-empty sequence of strings")
        argv_json = _json_dump(list(argv))
        cwd = _nonempty(values.get("cwd"), "cwd", maximum=16_384)
        env = values.get("env", {})
        if not isinstance(env, Mapping) or any(
            not isinstance(key, str) or not isinstance(value, str)
            for key, value in env.items()
        ):
            raise ValueError("env must map strings to strings")
        env_json = _json_dump(dict(env))
        hami_core, sm_percent = validate_hami_request(
            values.get("hami_core", False), values.get("sm_percent"), share_gpu, env
        )
        yield_policy = validate_yield_policy(values.get("yield_policy", "legacy"), checkpoint_capability, share_gpu)
        preempt_idle_only = values.get("preempt_idle_only", False)
        if not isinstance(preempt_idle_only, bool):
            raise ValueError("preempt_idle_only must be a boolean")
        preempt_opt_in_only = values.get("preempt_opt_in_only", False)
        if not isinstance(preempt_opt_in_only, bool):
            raise ValueError("preempt_opt_in_only must be a boolean")
        job_id = values.get("id", values.get("job_id", _new_id()))
        job_id = _nonempty(job_id, "job_id", maximum=256)
        digest = _submission_digest(
            preempt_idle_only=preempt_idle_only,
            preempt_opt_in_only=preempt_opt_in_only,
            yield_policy=yield_policy,
            hami_core=hami_core,
            sm_percent=sm_percent,
            share_gpu=share_gpu,
            vram_mb=vram_mb,
            name=name,
            owner=owner,
            priority=priority,
            dispatch_mode=dispatch_mode,
            checkpoint_capability=checkpoint_capability,
            restart_policy=restart_policy,
            gpu_count=gpu_count,
            min_gpu_count=min_gpu_count,
            elastic_gpu_count=elastic_gpu_count,
            auto_scale_up=auto_scale_up,
            target_global_batch_size=target_global_batch_size,
            per_device_micro_batch_size=per_device_micro_batch_size,
            placement=placement,
            requested_gpu_uuids_json=requested_gpu_uuids_json,
            argv_json=argv_json,
            cwd=cwd,
            env_json=env_json,
        )
        now = self._now()
        try:
            with self._transaction() as connection:
                sequence = int(
                    connection.execute(
                        "SELECT COALESCE(MAX(sequence), 0) + 1 FROM jobs"
                    ).fetchone()[0]
                )
                connection.execute(
                    """
                    INSERT INTO jobs(
                        id, sequence, submit_key, submit_digest,
                        name, owner, priority,
                        dispatch_mode, checkpoint_capability, restart_policy,
                        gpu_count, placement, requested_gpu_uuids_json,
                        argv_json, cwd, env_json, state,
                        created_at, updated_at,
                        min_gpu_count, elastic_gpu_count,
                        target_global_batch_size, per_device_micro_batch_size,
                        auto_scale_up, share_gpu, vram_mb, hami_core, sm_percent, yield_policy, preempt_idle_only, preempt_opt_in_only
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    (
                        job_id,
                        sequence,
                        submit_key,
                        digest,
                        name,
                        owner,
                        priority,
                        dispatch_mode,
                        checkpoint_capability,
                        restart_policy,
                        gpu_count,
                        placement,
                        requested_gpu_uuids_json,
                        argv_json,
                        cwd,
                        env_json,
                        JobState.PENDING.value,
                        now,
                        now,
                        min_gpu_count,
                        int(elastic_gpu_count),
                        target_global_batch_size,
                        per_device_micro_batch_size,
                        int(auto_scale_up),
                        int(share_gpu),
                        vram_mb,
                        int(hami_core),
                        sm_percent,
                        yield_policy,
                        int(preempt_idle_only),
                        int(preempt_opt_in_only),
                    ),
                )
                row = connection.execute(
                    "SELECT * FROM jobs WHERE id=?", (job_id,)
                ).fetchone()
                assert row is not None
                return self._job(row)
        except sqlite3.IntegrityError as exc:
            with self._read_connection() as connection:
                row = connection.execute(
                    "SELECT * FROM jobs WHERE submit_key=?", (submit_key,)
                ).fetchone()
                if row is not None:
                    if row["submit_digest"] == digest:
                        return self._job(row)
                    raise StoreConflictError(
                        "submit_key was already used for a different submission"
                    ) from exc
                if connection.execute(
                    "SELECT 1 FROM jobs WHERE id=?", (job_id,)
                ).fetchone():
                    raise StoreConflictError(
                        f"job id already exists: {job_id}"
                    ) from exc
            raise StoreConflictError(f"cannot insert job: {exc}") from exc

    create_job = submit_job

    def set_job_display(self, job_id: str, metadata: Any, *, expected_submit_key: str,
                        expected_owner: str, expected_name: str) -> dict[str, Any]:
        from .job_display import normalize_display
        normalized = normalize_display(metadata)
        with self.transaction() as tx:
            connection = tx._get_connection()
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise StoreNotFoundError(f"job not found: {job_id}")
            if (row["submit_key"], row["owner"], row["name"]) != (expected_submit_key, expected_owner, expected_name):
                raise StoreConflictError("job display binding does not match original submission")
            encoded = _json_dump(normalized)
            if row["display_json"] != encoded:
                # No updated_at, digest, state, scheduling, argv, env or lease changes.
                connection.execute("UPDATE jobs SET display_json=? WHERE id=?", (encoded, job_id))
                tx.append_event("JOB_DISPLAY_UPDATED", job_id=job_id)
            return tx.get_job(job_id)

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
        if row is None:
            raise StoreNotFoundError(f"job not found: {job_id}")
        return self._job(row)

    def get_job_by_submit_key(self, submit_key: str) -> dict[str, Any] | None:
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE submit_key=?", (submit_key,)
            ).fetchone()
        return None if row is None else self._job(row)

    def list_jobs(
        self,
        *,
        states: Iterable[str | JobState] | None = None,
        owner: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not 1 <= limit <= 100_000:
            raise ValueError("limit must be between 1 and 100000")
        clauses: list[str] = []
        parameters: list[Any] = []
        if states is not None:
            normalized = [_choice(state, _JOB_STATES, "job state") for state in states]
            if not normalized:
                return []
            clauses.append("state IN (" + ",".join("?" for _ in normalized) + ")")
            parameters.extend(normalized)
        if owner is not None:
            clauses.append("owner=?")
            parameters.append(owner)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        parameters.append(limit)
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM jobs{where}
                ORDER BY priority DESC, sequence
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._job(row) for row in rows]

    def update_job(
        self,
        job_id: str,
        *,
        state: str | JobState | None = None,
        state_reason: str | None | object = _UNSET,
        priority: int | str | None = None,
        expected_version: int | None = None,
        expected_states: Iterable[str | JobState] | None = None,
    ) -> dict[str, Any]:
        updates: list[str] = []
        parameters: list[Any] = []
        now = self._now()
        normalized_state: str | None = None
        if state is not None:
            normalized_state = _choice(state, _JOB_STATES, "job state")
            updates.append("state=?")
            parameters.append(normalized_state)
            if normalized_state == JobState.RUNNING.value:
                updates.append("started_at=COALESCE(started_at, ?)")
                parameters.append(now)
            if normalized_state in TERMINAL_JOB_STATES:
                updates.append("finished_at=COALESCE(finished_at, ?)")
                parameters.append(now)
        if state_reason is not _UNSET:
            updates.append("state_reason=?")
            parameters.append(
                _optional_text(state_reason, "state_reason", maximum=16_384)
            )
        if priority is not None:
            updates.append("priority=?")
            parameters.append(_priority(priority))
        if not updates:
            return self.get_job(job_id)
        updates.extend(("updated_at=?", "version=version+1"))
        parameters.append(now)
        clauses = ["id=?"]
        parameters.append(job_id)
        if expected_version is not None:
            if isinstance(expected_version, bool) or expected_version < 0:
                raise ValueError("expected_version must be non-negative")
            clauses.append("version=?")
            parameters.append(expected_version)
        if expected_states is not None:
            normalized_expected = [
                _choice(item, _JOB_STATES, "job state") for item in expected_states
            ]
            if not normalized_expected:
                raise ValueError("expected_states must not be empty")
            clauses.append(
                "state IN (" + ",".join("?" for _ in normalized_expected) + ")"
            )
            parameters.extend(normalized_expected)
        with self._transaction() as connection:
            cursor = connection.execute(
                f"UPDATE jobs SET {', '.join(updates)} "
                f"WHERE {' AND '.join(clauses)}",
                parameters,
            )
            if cursor.rowcount != 1:
                exists = connection.execute(
                    "SELECT 1 FROM jobs WHERE id=?", (job_id,)
                ).fetchone()
                if exists is None:
                    raise StoreNotFoundError(f"job not found: {job_id}")
                raise StoreConflictError("job state/version changed concurrently")
            row = connection.execute(
                "SELECT * FROM jobs WHERE id=?", (job_id,)
            ).fetchone()
            assert row is not None
            return self._job(row)

    def transition_job(
        self,
        job_id: str,
        to_state: str | JobState,
        *,
        from_states: Iterable[str | JobState] | None = None,
        reason: str | None = None,
        expected_version: int | None = None,
    ) -> dict[str, Any]:
        return self.update_job(
            job_id,
            state=to_state,
            state_reason=reason,
            expected_states=from_states,
            expected_version=expected_version,
        )

    def set_job_priority(
        self, job_id: str, priority: int | str, *, expected_version: int | None = None
    ) -> dict[str, Any]:
        return self.update_job(
            job_id, priority=priority, expected_version=expected_version
        )

    def set_pending_priority_class(
        self,
        job_id: str,
        priority_class: str,
        *,
        expected: Mapping[str, Any] | None = None,
        _rank_only: bool = False,
    ) -> dict[str, Any]:
        """Atomically replace a waiting job's complete scheduling contract.

        This deliberately excludes attempts/reservations/preemption already in
        flight. A stale reader can supply all four old contract fields, so a
        priority change never silently overrides another operator's decision.
        """
        contract = ({"priority": _priority(priority_class), "yield_policy": None,
                     "restart_policy": None, "dispatch_mode": None}
                    if _rank_only else priority_class_contract(priority_class))
        if expected is not None:
            if not isinstance(expected, Mapping) or set(expected) != set(contract):
                raise ValueError("expected must contain priority, yield_policy, restart_policy and dispatch_mode")
            if isinstance(expected["priority"], bool) or not isinstance(expected["priority"], int):
                raise ValueError("expected priority must be an integer P0..P4")
            _priority(expected["priority"])
            _choice(expected["yield_policy"], frozenset({"legacy", "never", "now", "save"}), "expected yield_policy")
            _choice(expected["restart_policy"], _RESTART_POLICIES, "expected restart_policy")
            _choice(expected["dispatch_mode"], _DISPATCH_MODES, "expected dispatch_mode")
        with self._transaction() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise StoreNotFoundError(f"job not found: {job_id}")
            current = self._job(row)
            if current["state"] != JobState.PENDING.value:
                raise StoreConflictError("priority can only be changed while the job is PENDING")
            before = {key: current[key] for key in contract}
            if _rank_only:
                contract = {**before, "priority": contract["priority"]}
            if expected is not None and before != dict(expected):
                raise StoreConflictError("job scheduling policy changed; refresh before retrying")
            if current.get("auto_scale_up") and not _rank_only:
                raise StoreConflictError("automatic scale-up jobs cannot use the Console priority contract")
            validate_yield_policy(contract["yield_policy"], current["checkpoint_capability"], current["share_gpu"])
            active_states = sorted(ACTIVE_ATTEMPT_STATES)
            active = connection.execute(
                "SELECT 1 FROM attempts WHERE state IN (" + ",".join("?" for _ in active_states)
                + ") AND (job_id=? OR preempt_requested_by_job_id=?) LIMIT 1",
                (*active_states, job_id, job_id),
            ).fetchone()
            leases = connection.execute("SELECT 1 FROM leases WHERE job_id=? LIMIT 1", (job_id,)).fetchone()
            scale_states = sorted(ACTIVE_SCALE_UP_STATES)
            scale = connection.execute(
                "SELECT 1 FROM scale_up_plans WHERE job_id=? AND state IN ("
                + ",".join("?" for _ in scale_states) + ") LIMIT 1",
                (job_id, *scale_states),
            ).fetchone()
            if active or leases or scale:
                raise StoreConflictError("job attempt, reservation or preemption cleanup is still in progress")
            if before == contract:
                return current
            cursor = connection.execute(
                "UPDATE jobs SET priority=?, yield_policy=?, restart_policy=?, dispatch_mode=?, "
                "updated_at=?, version=version+1 WHERE id=? AND state='PENDING' AND version=?",
                (contract["priority"], contract["yield_policy"], contract["restart_policy"],
                 contract["dispatch_mode"], self._now(), job_id, current["version"]),
            )
            if cursor.rowcount != 1:
                raise StoreConflictError("job state/version changed concurrently")
            self.append_event("PRIORITY_CHANGED", job_id=job_id,
                              payload={"priority_class": priority_class, "previous": before, "current": contract})
            return self.get_job(job_id)

    def set_pending_priority_rank(
        self, job_id: str, priority: int | str, *, expected: Mapping[str, Any] | None = None
    ) -> dict[str, Any]:
        """Change only queue rank; retain yielding/restart/dispatch and FIFO.

        The historical class API is retained for callers explicitly choosing a
        preset. Reuse its transaction, CAS and in-flight activity protections.
        """
        return self.set_pending_priority_class(
            job_id, f"P{_priority(priority)}", expected=expected, _rank_only=True
        )

    # --------------------------------------------------------------- attempts

    @staticmethod
    def _attempt(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["gpu_uuids"] = _json_load(result.pop("gpu_uuids_json"))
        result["gpu_indices"] = _json_load(result.pop("gpu_indices_json"))
        return result

    @staticmethod
    def _require_pinned_assignment(job: sqlite3.Row, gpu_uuids: Sequence[str]) -> None:
        if job["placement"] != "pinned":
            return
        requested = _json_load(job["requested_gpu_uuids_json"])
        if (
            not isinstance(requested, list)
            or any(not isinstance(item, str) or not item for item in requested)
            or len(set(requested)) != len(requested)
        ):
            raise StoreCorruptError("pinned job requested GPU UUIDs are invalid")
        if set(gpu_uuids) != set(requested):
            raise StoreConflictError(
                "attempt GPU assignment does not match pinned job GPUs"
            )

    @staticmethod
    def _require_gpu_assignment_count(
        job: sqlite3.Row,
        gpu_count: int,
        *,
        subject: str,
    ) -> None:
        """Validate one attempt/lease bundle against its durable job contract."""

        maximum = int(job["gpu_count"])
        minimum = int(job["min_gpu_count"])
        elastic = int(job["elastic_gpu_count"])
        if elastic not in (0, 1) or minimum <= 0 or minimum > maximum:
            raise StoreCorruptError("job GPU count contract is invalid")
        if (
            elastic == 1
            and job["placement"] == "any"
            and minimum <= gpu_count <= maximum
        ):
            return
        if elastic == 0 and gpu_count == maximum:
            return
        if elastic == 1 and job["placement"] == "any":
            raise StoreConflictError(
                f"{subject} must contain between {minimum} and {maximum} GPUs"
            )
        raise StoreConflictError(f"{subject} does not match the job gpu_count")

    def create_attempt(
        self,
        job_id: str,
        *,
        attempt_id: str | None = None,
        state: str | AttemptState = AttemptState.PLANNED,
        gpu_uuids: Sequence[str] = (),
        gpu_indices: Sequence[int] = (),
        unit_name: str | None = None,
        unit_token: str | None = None,
        boot_id: str | None = None,
        invocation_id: str | None = None,
        main_pid: int | None = None,
        start_ticks: int | None = None,
        control_dir: str | None = None,
        log_path: str | None = None,
        launch_resume_checkpoint_path: str | None = None,
        resume_from_attempt_id: str | None = None,
    ) -> dict[str, Any]:
        attempt_id = _nonempty(attempt_id or _new_id(), "attempt_id", maximum=256)
        normalized_state = _choice(state, _ATTEMPT_STATES, "attempt state")
        uuids = list(gpu_uuids)
        indices = list(gpu_indices)
        if len(uuids) != len(indices):
            raise ValueError("gpu_uuids and gpu_indices must have equal lengths")
        if any(not isinstance(item, str) or not item for item in uuids):
            raise ValueError("gpu_uuids must contain non-empty strings")
        if any(
            isinstance(item, bool) or not isinstance(item, int) or item < 0
            for item in indices
        ):
            raise ValueError("gpu_indices must contain non-negative integers")
        if len(set(uuids)) != len(uuids) or len(set(indices)) != len(indices):
            raise ValueError("GPU assignment contains duplicates")
        ordered_assignment = sorted(zip(uuids, indices), key=lambda item: item[1])
        uuids = [item[0] for item in ordered_assignment]
        indices = [item[1] for item in ordered_assignment]
        if main_pid is not None and (
            isinstance(main_pid, bool) or not isinstance(main_pid, int) or main_pid <= 0
        ):
            raise ValueError("main_pid must be a positive integer")
        if start_ticks is not None and (
            isinstance(start_ticks, bool)
            or not isinstance(start_ticks, int)
            or start_ticks < 0
        ):
            raise ValueError("start_ticks must be non-negative")
        launch_resume_checkpoint_path = _optional_absolute_path(
            launch_resume_checkpoint_path,
            "launch_resume_checkpoint_path",
        )
        resume_from_attempt_id = _optional_text(
            resume_from_attempt_id,
            "resume_from_attempt_id",
            maximum=256,
        )
        if (launch_resume_checkpoint_path is None) != (resume_from_attempt_id is None):
            raise ValueError(
                "launch_resume_checkpoint_path and resume_from_attempt_id "
                "must be provided together"
            )
        now = self._now()
        with self._transaction() as connection:
            job = connection.execute(
                """
                SELECT state, gpu_count, min_gpu_count, elastic_gpu_count,
                       placement,
                       requested_gpu_uuids_json
                FROM jobs WHERE id=?
                """,
                (job_id,),
            ).fetchone()
            if job is None:
                raise StoreNotFoundError(f"job not found: {job_id}")
            if job["state"] in TERMINAL_JOB_STATES:
                raise StoreConflictError("cannot create an attempt for a terminal job")
            if resume_from_attempt_id is not None:
                resume_source = connection.execute(
                    """
                    SELECT job_id, checkpoint_path
                    FROM attempts WHERE id=?
                    """,
                    (resume_from_attempt_id,),
                ).fetchone()
                if resume_source is None:
                    raise StoreNotFoundError(
                        "resume source attempt not found: " f"{resume_from_attempt_id}"
                    )
                if resume_source["job_id"] != job_id:
                    raise StoreConflictError(
                        "resume source attempt belongs to a different job"
                    )
                if resume_source["checkpoint_path"] != launch_resume_checkpoint_path:
                    raise StoreConflictError(
                        "launch resume checkpoint does not match source attempt"
                    )
            if uuids:
                self._require_gpu_assignment_count(
                    job,
                    len(uuids),
                    subject="attempt GPU assignment",
                )
            self._require_pinned_assignment(job, uuids)
            ordinal = int(
                connection.execute(
                    "SELECT COALESCE(MAX(ordinal), 0) + 1 FROM attempts WHERE job_id=?",
                    (job_id,),
                ).fetchone()[0]
            )
            try:
                connection.execute(
                    """
                    INSERT INTO attempts(
                        id, job_id, ordinal, state, unit_name, unit_token,
                        boot_id, invocation_id, main_pid, start_ticks,
                        gpu_uuids_json, gpu_indices_json, control_dir, log_path,
                        launch_resume_checkpoint_path, resume_from_attempt_id,
                        created_at, updated_at
                    ) VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                    """,
                    (
                        attempt_id,
                        job_id,
                        ordinal,
                        normalized_state,
                        _optional_text(unit_name, "unit_name"),
                        _optional_text(unit_token, "unit_token"),
                        _optional_text(boot_id, "boot_id"),
                        _optional_text(invocation_id, "invocation_id"),
                        main_pid,
                        start_ticks,
                        _json_dump(uuids),
                        _json_dump(indices),
                        _optional_text(control_dir, "control_dir", maximum=16_384),
                        _optional_text(log_path, "log_path", maximum=16_384),
                        launch_resume_checkpoint_path,
                        resume_from_attempt_id,
                        now,
                        now,
                    ),
                )
            except sqlite3.IntegrityError as exc:
                raise StoreConflictError(
                    "job already has an active attempt or attempt identity conflicts"
                ) from exc
            row = connection.execute(
                "SELECT * FROM attempts WHERE id=?", (attempt_id,)
            ).fetchone()
            assert row is not None
            return self._attempt(row)

    def get_attempt(self, attempt_id: str) -> dict[str, Any]:
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT * FROM attempts WHERE id=?", (attempt_id,)
            ).fetchone()
        if row is None:
            raise StoreNotFoundError(f"attempt not found: {attempt_id}")
        return self._attempt(row)

    def list_attempts(
        self,
        *,
        job_id: str | None = None,
        states: Iterable[str | AttemptState] | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not 1 <= limit <= 100_000:
            raise ValueError("limit must be between 1 and 100000")
        clauses: list[str] = []
        parameters: list[Any] = []
        if job_id is not None:
            clauses.append("job_id=?")
            parameters.append(job_id)
        if states is not None:
            normalized = [
                _choice(state, _ATTEMPT_STATES, "attempt state") for state in states
            ]
            if not normalized:
                return []
            clauses.append("state IN (" + ",".join("?" for _ in normalized) + ")")
            parameters.extend(normalized)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        order_by = (
            "ordinal DESC, id"
            if job_id is not None
            else "created_at DESC, ordinal DESC, id"
        )
        parameters.append(limit)
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM attempts{where}
                ORDER BY {order_by}
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._attempt(row) for row in rows]

    def update_attempt(
        self,
        attempt_id: str,
        *,
        state: str | AttemptState | None = None,
        expected_version: int | None = None,
        expected_states: Iterable[str | AttemptState] | None = None,
        **changes: Any,
    ) -> dict[str, Any]:
        column_validators: dict[str, Any] = {
            "unit_name": lambda value: _optional_text(value, "unit_name"),
            "unit_token": lambda value: _optional_text(value, "unit_token"),
            "boot_id": lambda value: _optional_text(value, "boot_id"),
            "invocation_id": lambda value: _optional_text(value, "invocation_id"),
            "control_dir": lambda value: _optional_text(
                value, "control_dir", maximum=16_384
            ),
            "log_path": lambda value: _optional_text(value, "log_path", maximum=16_384),
            "preempt_nonce": lambda value: _optional_text(value, "preempt_nonce"),
            "preempt_requested_by_job_id": lambda value: _optional_text(
                value, "preempt_requested_by_job_id", maximum=256
            ),
            "checkpoint_path": lambda value: _optional_text(
                value, "checkpoint_path", maximum=16_384
            ),
            "failure_reason": lambda value: (
                None
                if value is None
                else _nonempty(value, "failure_reason", maximum=16_384)
            ),
        }
        integer_columns = {"main_pid", "start_ticks", "exit_code"}
        timestamp_columns = {
            "preempt_requested_at",
            "preempt_deadline_at",
            "checkpoint_deadline_at",
            "term_deadline_at",
            "kill_deadline_at",
        }
        allowed_changes = (
            set(column_validators)
            | integer_columns
            | timestamp_columns
            | {"gpu_uuids", "gpu_indices"}
        )
        unknown = sorted(set(changes) - allowed_changes)
        if unknown:
            raise ValueError(f"unknown attempt fields: {', '.join(unknown)}")
        updates: list[str] = []
        parameters: list[Any] = []
        now = self._now()
        normalized_state: str | None = None
        if state is not None:
            normalized_state = _choice(state, _ATTEMPT_STATES, "attempt state")
            updates.append("state=?")
            parameters.append(normalized_state)
            if normalized_state == AttemptState.RUNNING.value:
                updates.append("started_at=COALESCE(started_at, ?)")
                parameters.append(now)
            if normalized_state not in ACTIVE_ATTEMPT_STATES:
                updates.append("finished_at=COALESCE(finished_at, ?)")
                parameters.append(now)
        for column, validator in column_validators.items():
            if column in changes:
                updates.append(f"{column}=?")
                parameters.append(validator(changes[column]))
        for column in integer_columns:
            if column not in changes:
                continue
            value = changes[column]
            if value is not None and (
                isinstance(value, bool) or not isinstance(value, int)
            ):
                raise ValueError(f"{column} must be an integer or null")
            if column == "main_pid" and value is not None and value <= 0:
                raise ValueError("main_pid must be positive")
            if column == "start_ticks" and value is not None and value < 0:
                raise ValueError("start_ticks must be non-negative")
            updates.append(f"{column}=?")
            parameters.append(value)
        for column in timestamp_columns:
            if column not in changes:
                continue
            value = changes[column]
            updates.append(f"{column}=?")
            parameters.append(
                None if value is None else _finite_timestamp(value, column)
            )
        gpu_change_requested = "gpu_uuids" in changes or "gpu_indices" in changes
        if not updates and not gpu_change_requested:
            return self.get_attempt(attempt_id)
        if expected_version is not None:
            if isinstance(expected_version, bool) or expected_version < 0:
                raise ValueError("expected_version must be non-negative")
        normalized_expected: list[str] | None = None
        if expected_states is not None:
            normalized_expected = [
                _choice(item, _ATTEMPT_STATES, "attempt state")
                for item in expected_states
            ]
            if not normalized_expected:
                raise ValueError("expected_states must not be empty")
        try:
            with self._transaction() as connection:
                if gpu_change_requested:
                    current = connection.execute(
                        """
                        SELECT a.gpu_uuids_json, a.gpu_indices_json,
                               j.gpu_count, j.min_gpu_count,
                               j.elastic_gpu_count, j.placement,
                               j.requested_gpu_uuids_json
                        FROM attempts AS a
                        JOIN jobs AS j ON j.id=a.job_id
                        WHERE a.id=?
                        """,
                        (attempt_id,),
                    ).fetchone()
                    if current is None:
                        raise StoreNotFoundError(f"attempt not found: {attempt_id}")
                    current_uuids = _json_load(current["gpu_uuids_json"])
                    current_indices = _json_load(current["gpu_indices_json"])
                    if not isinstance(current_uuids, list) or not isinstance(
                        current_indices, list
                    ):
                        raise StoreCorruptError(
                            "attempt GPU assignment is not a JSON array"
                        )
                    uuids = list(changes.get("gpu_uuids", current_uuids))
                    indices = list(changes.get("gpu_indices", current_indices))
                    if len(uuids) != len(indices):
                        raise ValueError(
                            "gpu_uuids and gpu_indices must have equal lengths"
                        )
                    if any(not isinstance(value, str) or not value for value in uuids):
                        raise ValueError("invalid GPU UUID")
                    if any(
                        isinstance(value, bool)
                        or not isinstance(value, int)
                        or value < 0
                        for value in indices
                    ):
                        raise ValueError("invalid GPU index")
                    if len(set(uuids)) != len(uuids) or len(set(indices)) != len(
                        indices
                    ):
                        raise ValueError("GPU assignment contains duplicates")
                    if uuids:
                        self._require_gpu_assignment_count(
                            current,
                            len(uuids),
                            subject="attempt GPU assignment",
                        )
                    ordered = sorted(zip(uuids, indices), key=lambda item: item[1])
                    uuids = [item[0] for item in ordered]
                    indices = [item[1] for item in ordered]
                    self._require_pinned_assignment(current, uuids)
                    lease_rows = connection.execute(
                        """
                        SELECT gpu_uuid, gpu_index FROM leases
                        WHERE attempt_id=?
                        """,
                        (attempt_id,),
                    ).fetchall()
                    leased = {(row["gpu_uuid"], row["gpu_index"]) for row in lease_rows}
                    if leased and leased != set(zip(uuids, indices)):
                        raise StoreConflictError(
                            "attempt GPU assignment differs from active leases"
                        )
                    updates.extend(("gpu_uuids_json=?", "gpu_indices_json=?"))
                    parameters.extend((_json_dump(uuids), _json_dump(indices)))

                updates.extend(("updated_at=?", "version=version+1"))
                parameters.append(now)
                clauses = ["id=?"]
                parameters.append(attempt_id)
                if expected_version is not None:
                    clauses.append("version=?")
                    parameters.append(expected_version)
                if normalized_expected is not None:
                    clauses.append(
                        "state IN (" + ",".join("?" for _ in normalized_expected) + ")"
                    )
                    parameters.extend(normalized_expected)
                cursor = connection.execute(
                    f"UPDATE attempts SET {', '.join(updates)} "
                    f"WHERE {' AND '.join(clauses)}",
                    parameters,
                )
                if cursor.rowcount != 1:
                    exists = connection.execute(
                        "SELECT 1 FROM attempts WHERE id=?", (attempt_id,)
                    ).fetchone()
                    if exists is None:
                        raise StoreNotFoundError(f"attempt not found: {attempt_id}")
                    raise StoreConflictError(
                        "attempt state/version changed concurrently"
                    )
                row = connection.execute(
                    "SELECT * FROM attempts WHERE id=?", (attempt_id,)
                ).fetchone()
                assert row is not None
                return self._attempt(row)
        except sqlite3.IntegrityError as exc:
            raise StoreConflictError(
                "attempt update violates an identity or active-attempt constraint"
            ) from exc

    def transition_attempt(
        self,
        attempt_id: str,
        to_state: str | AttemptState,
        *,
        from_states: Iterable[str | AttemptState] | None = None,
        expected_version: int | None = None,
        **changes: Any,
    ) -> dict[str, Any]:
        return self.update_attempt(
            attempt_id,
            state=to_state,
            expected_states=from_states,
            expected_version=expected_version,
            **changes,
        )

    # ------------------------------------------------------------- progress

    @staticmethod
    def _attempt_progress(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        raw_snapshot = result.pop("snapshot_json")
        try:
            decoded = reject_duplicate_json(raw_snapshot)
            snapshot = validate_progress_payload(decoded)
        except (TypeError, ValueError, ProgressProtocolError) as exc:
            raise StoreCorruptError(
                "database contains invalid attempt progress"
            ) from exc
        if (
            result["protocol_version"] != snapshot.version
            or result["sequence"] != snapshot.sequence
            or result["job_id"] != snapshot.job_id
            or result["attempt_id"] != snapshot.attempt_id
            or result["stall_timeout_seconds"] != snapshot.stall_timeout_seconds
        ):
            raise StoreCorruptError(
                "attempt progress columns do not match its snapshot"
            )
        for field in (
            "heartbeat_at",
            "advanced_at",
            "stalled_at",
            "last_problem_notified_at",
            "created_at",
            "updated_at",
        ):
            value = result[field]
            if value is not None:
                result[field] = _finite_timestamp(value, field)
        result["snapshot"] = snapshot.to_payload()
        return result

    @staticmethod
    def _progress_continuity(
        previous: ProgressSnapshot,
        candidate: ProgressSnapshot,
    ) -> bool:
        """Validate one attempt-local counter stream and report advancement."""

        advanced = candidate.phase != previous.phase
        for prefix in ("epochs", "steps"):
            old_completed = getattr(previous, f"{prefix}_completed")
            old_total = getattr(previous, f"{prefix}_total")
            new_completed = getattr(candidate, f"{prefix}_completed")
            new_total = getattr(candidate, f"{prefix}_total")
            if old_completed is None:
                if new_completed is not None and new_completed > 0:
                    advanced = True
                continue
            if new_completed is None or new_total is None:
                raise StoreConflictError(
                    f"{prefix} counters cannot disappear within an attempt"
                )
            if new_total != old_total:
                raise StoreConflictError(
                    f"{prefix}_total cannot change within an attempt"
                )
            if new_completed < old_completed:
                raise StoreConflictError(f"{prefix}_completed cannot move backward")
            if new_completed > old_completed:
                advanced = True
        return advanced

    def accept_attempt_progress(
        self,
        snapshot: ProgressSnapshot | Mapping[str, Any],
        observed_at: float | None = None,
    ) -> dict[str, Any]:
        """Atomically accept one latest snapshot for an active exact attempt.

        A repeated sequence with byte-equivalent canonical content is
        idempotent and does not refresh server timestamps.  No job, attempt,
        lease, action, or event row is ever modified by this method.
        """

        candidate = validate_progress_payload(
            snapshot.to_payload()
            if isinstance(snapshot, ProgressSnapshot)
            else dict(snapshot)
        )
        snapshot_json = candidate.canonical_json()
        now = (
            self._now()
            if observed_at is None
            else _finite_timestamp(observed_at, "observed_at")
        )
        with self._transaction() as connection:
            attempt = connection.execute(
                "SELECT job_id, state FROM attempts WHERE id=?",
                (candidate.attempt_id,),
            ).fetchone()
            if attempt is None:
                raise StoreNotFoundError(f"attempt not found: {candidate.attempt_id}")
            if attempt["job_id"] != candidate.job_id:
                raise StoreConflictError("progress job_id does not match the attempt")
            if attempt["state"] not in ACTIVE_ATTEMPT_STATES:
                raise StoreConflictError(
                    "progress can only be reported for an active attempt"
                )
            existing_row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (candidate.attempt_id,),
            ).fetchone()
            if existing_row is None:
                connection.execute(
                    """
                    INSERT INTO attempt_progress(
                        attempt_id, job_id, protocol_version, sequence,
                        snapshot_json, heartbeat_at, advanced_at,
                        stall_timeout_seconds, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        candidate.attempt_id,
                        candidate.job_id,
                        candidate.version,
                        candidate.sequence,
                        snapshot_json,
                        now,
                        now,
                        candidate.stall_timeout_seconds,
                        now,
                        now,
                    ),
                )
                row = connection.execute(
                    "SELECT * FROM attempt_progress WHERE attempt_id=?",
                    (candidate.attempt_id,),
                ).fetchone()
                assert row is not None
                return {
                    "progress": self._attempt_progress(row),
                    "accepted": True,
                    "idempotent": False,
                    "advanced": True,
                    "was_stalled": False,
                }

            existing = self._attempt_progress(existing_row)
            previous = validate_progress_payload(existing["snapshot"])
            if candidate.sequence < previous.sequence:
                raise StoreConflictError("progress sequence moved backward")
            if candidate.sequence == previous.sequence:
                if snapshot_json != previous.canonical_json():
                    raise StoreConflictError(
                        "progress sequence was reused with different content"
                    )
                return {
                    "progress": existing,
                    "accepted": False,
                    "idempotent": True,
                    "advanced": False,
                    "was_stalled": existing["stalled_at"] is not None,
                }
            advanced = self._progress_continuity(previous, candidate)
            observed_at = max(
                now,
                float(existing["heartbeat_at"]),
                float(existing["updated_at"]),
                (
                    float(existing["stalled_at"])
                    if existing["stalled_at"] is not None
                    else now
                ),
            )
            advanced_at = observed_at if advanced else float(existing["advanced_at"])
            cursor = connection.execute(
                """
                UPDATE attempt_progress
                SET sequence=?, snapshot_json=?, heartbeat_at=?, advanced_at=?,
                    stall_timeout_seconds=?, updated_at=?
                WHERE attempt_id=? AND sequence=?
                """,
                (
                    candidate.sequence,
                    snapshot_json,
                    observed_at,
                    advanced_at,
                    candidate.stall_timeout_seconds,
                    observed_at,
                    candidate.attempt_id,
                    previous.sequence,
                ),
            )
            if cursor.rowcount != 1:
                raise StoreConflictError("progress sequence changed concurrently")
            row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (candidate.attempt_id,),
            ).fetchone()
            assert row is not None
            return {
                "progress": self._attempt_progress(row),
                "accepted": True,
                "idempotent": False,
                "advanced": advanced,
                "was_stalled": existing["stalled_at"] is not None,
            }

    def get_attempt_progress(self, attempt_id: str) -> dict[str, Any] | None:
        attempt_id = _nonempty(attempt_id, "attempt_id", maximum=256)
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
        return None if row is None else self._attempt_progress(row)

    def list_attempt_progress(
        self,
        *,
        job_id: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not 1 <= limit <= 100_000:
            raise ValueError("limit must be between 1 and 100000")
        parameters: list[Any] = []
        where = ""
        if job_id is not None:
            parameters.append(_nonempty(job_id, "job_id", maximum=256))
            where = "WHERE p.job_id=?"
        parameters.append(limit)
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT p.*
                FROM attempt_progress AS p
                JOIN attempts AS a ON a.id=p.attempt_id
                {where}
                ORDER BY a.ordinal DESC, p.attempt_id
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._attempt_progress(row) for row in rows]

    def mark_progress_stalled(
        self,
        attempt_id: str,
        expected_sequence: int,
        stalled_at: float | None = None,
    ) -> bool:
        """Mark one due progress stream stalled exactly once."""

        attempt_id = _nonempty(attempt_id, "attempt_id", maximum=256)
        if not _plain_int(expected_sequence) or expected_sequence < 1:
            raise ValueError("expected_sequence must be a positive integer")
        now = (
            self._now()
            if stalled_at is None
            else _finite_timestamp(stalled_at, "stalled_at")
        )
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
            if row is None:
                raise StoreNotFoundError(f"attempt progress not found: {attempt_id}")
            progress = self._attempt_progress(row)
            timeout = progress["stall_timeout_seconds"]
            if (
                timeout is None
                or progress["stalled_at"] is not None
                or progress["sequence"] != expected_sequence
                or now - float(progress["advanced_at"]) < float(timeout)
            ):
                return False
            stalled_at = max(now, float(progress["heartbeat_at"]))
            cursor = connection.execute(
                """
                UPDATE attempt_progress
                SET stalled_at=?, stalled_sequence=?
                WHERE attempt_id=? AND sequence=? AND stalled_at IS NULL
                """,
                (stalled_at, progress["sequence"], attempt_id, progress["sequence"]),
            )
            return cursor.rowcount == 1

    def mark_progress_recovered(
        self,
        attempt_id: str,
        expected_sequence: int,
    ) -> bool:
        """Clear a stall only after a later snapshot truly advanced."""

        attempt_id = _nonempty(attempt_id, "attempt_id", maximum=256)
        if not _plain_int(expected_sequence) or expected_sequence < 1:
            raise ValueError("expected_sequence must be a positive integer")
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
            if row is None:
                raise StoreNotFoundError(f"attempt progress not found: {attempt_id}")
            progress = self._attempt_progress(row)
            stalled_sequence = progress["stalled_sequence"]
            if (
                progress["stalled_at"] is None
                or stalled_sequence is None
                or progress["sequence"] <= stalled_sequence
                or float(progress["advanced_at"]) < float(progress["stalled_at"])
                or progress["sequence"] != expected_sequence
            ):
                return False
            cursor = connection.execute(
                """
                UPDATE attempt_progress
                SET stalled_at=NULL, stalled_sequence=NULL
                WHERE attempt_id=? AND sequence=? AND stalled_sequence=?
                """,
                (
                    attempt_id,
                    progress["sequence"],
                    stalled_sequence,
                ),
            )
            return cursor.rowcount == 1

    def mark_progress_milestone(
        self,
        attempt_id: str,
        milestone: int,
        expected_sequence: int,
    ) -> bool:
        """CAS a coordinator-derived completed 10-percent bucket."""

        attempt_id = _nonempty(attempt_id, "attempt_id", maximum=256)
        if (
            not _plain_int(milestone)
            or not 0 <= milestone <= 100
            or milestone % 10 != 0
        ):
            raise ValueError("milestone must be a 10-percent bucket from 0 to 100")
        if not _plain_int(expected_sequence) or expected_sequence < 1:
            raise ValueError("expected_sequence must be a positive integer")
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
            if row is None:
                raise StoreNotFoundError(f"attempt progress not found: {attempt_id}")
            progress = self._attempt_progress(row)
            snapshot = validate_progress_payload(progress["snapshot"])
            eligible = progress_milestone(snapshot)
            previous = progress["last_notified_milestone"]
            if (
                eligible is None
                or milestone > eligible
                or (previous is not None and milestone <= previous)
                or progress["sequence"] != expected_sequence
            ):
                return False
            cursor = connection.execute(
                """
                UPDATE attempt_progress
                SET last_notified_milestone=?
                WHERE attempt_id=? AND sequence=?
                  AND (last_notified_milestone IS NULL
                       OR last_notified_milestone < ?)
                """,
                (milestone, attempt_id, progress["sequence"], milestone),
            )
            return cursor.rowcount == 1

    def mark_progress_problem_notified(
        self,
        attempt_id: str,
        severity: str,
        expected_sequence: int,
        notified_at: float | None = None,
        min_interval_seconds: float = 300.0,
    ) -> bool:
        """CAS a bounded warning/error notification claim."""

        attempt_id = _nonempty(attempt_id, "attempt_id", maximum=256)
        if severity not in {"warning", "error"}:
            raise ValueError("severity must be warning or error")
        if not _plain_int(expected_sequence) or expected_sequence < 1:
            raise ValueError("expected_sequence must be a positive integer")
        cooldown = _finite_timestamp(min_interval_seconds, "min_interval_seconds")
        if cooldown < 0 or cooldown > 86_400:
            raise ValueError("min_interval_seconds must be between zero and 86400")
        now = (
            self._now()
            if notified_at is None
            else _finite_timestamp(notified_at, "notified_at")
        )
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM attempt_progress WHERE attempt_id=?",
                (attempt_id,),
            ).fetchone()
            if row is None:
                raise StoreNotFoundError(f"attempt progress not found: {attempt_id}")
            progress = self._attempt_progress(row)
            snapshot = validate_progress_payload(progress["snapshot"])
            previous_at = progress["last_problem_notified_at"]
            escalated = (
                progress["last_problem_severity"] == "warning" and severity == "error"
            )
            if (
                progress["sequence"] != expected_sequence
                or snapshot.severity != severity
                or (
                    previous_at is not None
                    and not escalated
                    and now - float(previous_at) < cooldown
                )
            ):
                return False
            notified_at = max(
                now,
                float(previous_at) if previous_at is not None else now,
            )
            cursor = connection.execute(
                """
                UPDATE attempt_progress
                SET last_notified_problem_sequence=?,
                    last_problem_notified_at=?, last_problem_severity=?
                WHERE attempt_id=? AND sequence=?
                """,
                (
                    progress["sequence"],
                    notified_at,
                    severity,
                    attempt_id,
                    progress["sequence"],
                ),
            )
            return cursor.rowcount == 1

    # ----------------------------------------------------------- scale-up plans

    @staticmethod
    def _scale_up_plan(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["target_gpu_uuids"] = _json_load(result.pop("target_gpu_uuids_json"))
        result["target_gpu_indices"] = _json_load(result.pop("target_gpu_indices_json"))
        return result

    @staticmethod
    def _scale_up_reservation(row: sqlite3.Row) -> dict[str, Any]:
        return dict(row)

    def create_scale_up_plan(
        self,
        job_id: str,
        source_attempt_id: str,
        target_assignments: Mapping[str, int] | Iterable[tuple[str, int]],
        *,
        plan_id: str | None = None,
        nonce: str | None = None,
        reservation_token: str | None = None,
    ) -> dict[str, Any]:
        """Atomically create one scale-up plan and reserve its extra GPUs.

        ``target_assignments`` is the complete successor assignment.  It must
        be a strict, legal superset of the source attempt's current leases.
        Source GPUs remain fenced by their leases; only newly added GPUs are
        inserted into ``scale_up_reservations`` at this phase.
        """

        job_id = _nonempty(job_id, "job_id", maximum=256)
        source_attempt_id = _nonempty(
            source_attempt_id, "source_attempt_id", maximum=256
        )
        plan_id = _nonempty(plan_id or ("S" + uuid.uuid4().hex), "plan_id", maximum=256)
        nonce = _nonempty(nonce or ("scale-" + uuid.uuid4().hex), "nonce", maximum=256)
        reservation_token = _nonempty(
            reservation_token or _new_id(),
            "reservation_token",
            maximum=256,
        )
        normalized = sorted(
            self._assignments(target_assignments), key=lambda item: item[1]
        )
        target_set = set(normalized)
        now = self._now()
        try:
            with self._transaction() as connection:
                source = connection.execute(
                    """
                    SELECT a.job_id, a.state AS attempt_state,
                           a.started_at, a.gpu_uuids_json,
                           a.gpu_indices_json,
                           j.state AS job_state, j.auto_scale_up,
                           j.elastic_gpu_count, j.placement,
                           j.checkpoint_capability, j.restart_policy,
                           j.min_gpu_count, j.gpu_count,
                           j.target_global_batch_size,
                           j.per_device_micro_batch_size
                    FROM attempts AS a
                    JOIN jobs AS j ON j.id=a.job_id
                    WHERE a.id=?
                    """,
                    (source_attempt_id,),
                ).fetchone()
                if source is None:
                    raise StoreNotFoundError(
                        f"source attempt not found: {source_attempt_id}"
                    )
                if source["job_id"] != job_id:
                    raise StoreConflictError(
                        "source attempt does not belong to scale-up job"
                    )
                if (
                    source["job_state"] != JobState.RUNNING.value
                    or source["attempt_state"] != AttemptState.RUNNING.value
                    or source["started_at"] is None
                ):
                    raise StoreConflictError(
                        "scale-up source job and attempt must be running"
                    )
                if (
                    int(source["auto_scale_up"]) != 1
                    or int(source["elastic_gpu_count"]) != 1
                    or source["placement"] != "any"
                    or source["checkpoint_capability"]
                    != CheckpointCapability.EPOCH_V1.value
                    or source["restart_policy"] != RestartPolicy.ON_PREEMPT.value
                    or source["target_global_batch_size"] is None
                    or source["per_device_micro_batch_size"] is None
                ):
                    raise StoreConflictError(
                        "job is not eligible for automatic scale-up"
                    )
                source_uuids = _json_load(source["gpu_uuids_json"])
                source_indices = _json_load(source["gpu_indices_json"])
                if (
                    not isinstance(source_uuids, list)
                    or not isinstance(source_indices, list)
                    or len(source_uuids) != len(source_indices)
                ):
                    raise StoreCorruptError("source attempt GPU assignment is invalid")
                source_set = set(zip(source_uuids, source_indices))
                if len(source_set) != len(source_uuids) or not source_set:
                    raise StoreCorruptError("source attempt GPU assignment is invalid")
                lease_rows = connection.execute(
                    """
                    SELECT gpu_uuid, gpu_index FROM leases
                    WHERE attempt_id=?
                    """,
                    (source_attempt_id,),
                ).fetchall()
                leased_set = {
                    (str(row["gpu_uuid"]), int(row["gpu_index"])) for row in lease_rows
                }
                if leased_set != source_set:
                    raise StoreConflictError(
                        "source attempt assignment does not match its leases"
                    )
                from_count = len(source_set)
                target_count = len(normalized)
                if not source_set < target_set:
                    raise StoreConflictError(
                        "scale-up target must strictly add to source GPUs"
                    )
                if not (
                    int(source["min_gpu_count"])
                    <= target_count
                    <= int(source["gpu_count"])
                ):
                    raise StoreConflictError(
                        "scale-up target GPU count is outside the job range"
                    )
                target_batch = int(source["target_global_batch_size"])
                micro_batch = int(source["per_device_micro_batch_size"])
                if target_batch % (target_count * micro_batch) != 0:
                    raise StoreConflictError(
                        "scale-up target GPU count violates the batch contract"
                    )

                extras = sorted(target_set - source_set, key=lambda item: item[1])
                for gpu_uuid, gpu_index in extras:
                    lease = connection.execute(
                        """
                        SELECT job_id FROM leases
                        WHERE gpu_uuid=? OR gpu_index=?
                        LIMIT 1
                        """,
                        (gpu_uuid, gpu_index),
                    ).fetchone()
                    if lease is not None:
                        raise StoreConflictError(
                            f"GPU {gpu_uuid}/{gpu_index} is leased by "
                            f"job {lease['job_id']}"
                        )
                    reservation = connection.execute(
                        """
                        SELECT job_id FROM scale_up_reservations
                        WHERE gpu_uuid=? OR gpu_index=?
                        LIMIT 1
                        """,
                        (gpu_uuid, gpu_index),
                    ).fetchone()
                    if reservation is not None:
                        raise StoreConflictError(
                            f"GPU {gpu_uuid}/{gpu_index} is reserved by "
                            f"job {reservation['job_id']}"
                        )

                connection.execute(
                    """
                    INSERT INTO scale_up_plans(
                        id, job_id, source_attempt_id, nonce, state,
                        from_gpu_count, target_gpu_count,
                        target_gpu_uuids_json, target_gpu_indices_json,
                        reservation_token, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        plan_id,
                        job_id,
                        source_attempt_id,
                        nonce,
                        ScaleUpState.SAVE_REQUESTED.value,
                        from_count,
                        target_count,
                        _json_dump([item[0] for item in normalized]),
                        _json_dump([item[1] for item in normalized]),
                        reservation_token,
                        now,
                        now,
                    ),
                )
                for gpu_uuid, gpu_index in extras:
                    connection.execute(
                        """
                        INSERT INTO scale_up_reservations(
                            gpu_uuid, gpu_index, plan_id, job_id,
                            reservation_token, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            gpu_uuid,
                            gpu_index,
                            plan_id,
                            job_id,
                            reservation_token,
                            now,
                            now,
                        ),
                    )
                row = connection.execute(
                    "SELECT * FROM scale_up_plans WHERE id=?", (plan_id,)
                ).fetchone()
                assert row is not None
                return self._scale_up_plan(row)
        except sqlite3.IntegrityError as exc:
            raise StoreConflictError(
                "scale-up plan identity or GPU reservation conflicts"
            ) from exc

    def get_scale_up_plan(self, plan_id: str) -> dict[str, Any]:
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT * FROM scale_up_plans WHERE id=?", (plan_id,)
            ).fetchone()
        if row is None:
            raise StoreNotFoundError(f"scale-up plan not found: {plan_id}")
        return self._scale_up_plan(row)

    def get_active_scale_up_plan(self, job_id: str) -> dict[str, Any] | None:
        placeholders = ",".join("?" for _ in ACTIVE_SCALE_UP_STATES)
        parameters: list[Any] = [job_id, *sorted(ACTIVE_SCALE_UP_STATES)]
        with self._read_connection() as connection:
            row = connection.execute(
                f"""
                SELECT * FROM scale_up_plans
                WHERE job_id=? AND state IN ({placeholders})
                ORDER BY created_at DESC, id
                LIMIT 1
                """,
                parameters,
            ).fetchone()
        return None if row is None else self._scale_up_plan(row)

    def list_scale_up_plans(
        self,
        *,
        job_id: str | None = None,
        source_attempt_id: str | None = None,
        states: Iterable[str | ScaleUpState] | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not 1 <= limit <= 100_000:
            raise ValueError("limit must be between 1 and 100000")
        clauses: list[str] = []
        parameters: list[Any] = []
        if job_id is not None:
            clauses.append("job_id=?")
            parameters.append(job_id)
        if source_attempt_id is not None:
            clauses.append("source_attempt_id=?")
            parameters.append(source_attempt_id)
        if states is not None:
            normalized_states = [
                _choice(item, _SCALE_UP_STATES, "scale-up state") for item in states
            ]
            if not normalized_states:
                return []
            clauses.append(
                "state IN (" + ",".join("?" for _ in normalized_states) + ")"
            )
            parameters.extend(normalized_states)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        parameters.append(limit)
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM scale_up_plans{where}
                ORDER BY created_at DESC, id
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._scale_up_plan(row) for row in rows]

    def update_scale_up_plan(
        self,
        plan_id: str,
        *,
        state: str | ScaleUpState | None = None,
        checkpoint_path: str | None | object = _UNSET,
        successor_attempt_id: str | None | object = _UNSET,
        expected_version: int | None = None,
        expected_states: Iterable[str | ScaleUpState] | None = None,
    ) -> dict[str, Any]:
        normalized_state = (
            None
            if state is None
            else _choice(state, _SCALE_UP_STATES, "scale-up state")
        )
        normalized_checkpoint: str | None | object = _UNSET
        if checkpoint_path is not _UNSET:
            normalized_checkpoint = _optional_absolute_path(
                checkpoint_path, "checkpoint_path"
            )
        normalized_successor: str | None | object = _UNSET
        if successor_attempt_id is not _UNSET:
            normalized_successor = _optional_text(
                successor_attempt_id,
                "successor_attempt_id",
                maximum=256,
            )
        if expected_version is not None and (
            isinstance(expected_version, bool) or expected_version < 0
        ):
            raise ValueError("expected_version must be non-negative")
        normalized_expected: list[str] | None = None
        if expected_states is not None:
            normalized_expected = [
                _choice(item, _SCALE_UP_STATES, "scale-up state")
                for item in expected_states
            ]
            if not normalized_expected:
                raise ValueError("expected_states must not be empty")
        if (
            normalized_state is None
            and normalized_checkpoint is _UNSET
            and normalized_successor is _UNSET
        ):
            return self.get_scale_up_plan(plan_id)

        now = self._now()
        try:
            with self._transaction() as connection:
                current = connection.execute(
                    "SELECT * FROM scale_up_plans WHERE id=?", (plan_id,)
                ).fetchone()
                if current is None:
                    raise StoreNotFoundError(f"scale-up plan not found: {plan_id}")
                if (
                    expected_version is not None
                    and int(current["version"]) != expected_version
                ):
                    raise StoreConflictError(
                        "scale-up plan state/version changed concurrently"
                    )
                if (
                    normalized_expected is not None
                    and current["state"] not in normalized_expected
                ):
                    raise StoreConflictError(
                        "scale-up plan state/version changed concurrently"
                    )

                effective_checkpoint = current["checkpoint_path"]
                if normalized_checkpoint is not _UNSET:
                    if (
                        effective_checkpoint is not None
                        and normalized_checkpoint != effective_checkpoint
                    ):
                        raise StoreConflictError(
                            "scale-up checkpoint_path is immutable once recorded"
                        )
                    effective_checkpoint = normalized_checkpoint
                effective_successor = current["successor_attempt_id"]
                if normalized_successor is not _UNSET:
                    effective_successor = normalized_successor
                final_state = normalized_state or str(current["state"])
                if (
                    final_state
                    in {
                        ScaleUpState.CHECKPOINT_ACKED.value,
                        ScaleUpState.TERM_REQUESTED.value,
                        ScaleUpState.RESTART_PENDING.value,
                        ScaleUpState.RESTART_PLANNED.value,
                        ScaleUpState.COMPLETED.value,
                    }
                    and effective_checkpoint is None
                ):
                    raise StoreConflictError(
                        "scale-up plan cannot advance without checkpoint_path"
                    )
                if (
                    final_state
                    in {
                        ScaleUpState.RESTART_PLANNED.value,
                        ScaleUpState.COMPLETED.value,
                    }
                    and effective_successor is None
                ):
                    raise StoreConflictError(
                        f"{final_state} requires a successor attempt"
                    )
                if effective_successor is not None:
                    successor = connection.execute(
                        """
                        SELECT job_id, launch_resume_checkpoint_path,
                               resume_from_attempt_id
                        FROM attempts WHERE id=?
                        """,
                        (effective_successor,),
                    ).fetchone()
                    if successor is None:
                        raise StoreNotFoundError(
                            "successor attempt not found: " f"{effective_successor}"
                        )
                    if successor["job_id"] != current["job_id"]:
                        raise StoreConflictError(
                            "successor attempt belongs to a different job"
                        )
                    if effective_checkpoint is not None and (
                        successor["launch_resume_checkpoint_path"]
                        != effective_checkpoint
                        or successor["resume_from_attempt_id"]
                        != current["source_attempt_id"]
                    ):
                        raise StoreConflictError(
                            "successor attempt resume identity does not match plan"
                        )

                updates = ["updated_at=?", "version=version+1"]
                parameters: list[Any] = [now]
                if normalized_state is not None:
                    updates.insert(0, "state=?")
                    parameters.insert(0, normalized_state)
                    if normalized_state in {
                        ScaleUpState.CHECKPOINT_ACKED.value,
                        ScaleUpState.TERM_REQUESTED.value,
                        ScaleUpState.RESTART_PENDING.value,
                        ScaleUpState.RESTART_PLANNED.value,
                        ScaleUpState.COMPLETED.value,
                    }:
                        updates.append("checkpointed_at=COALESCE(checkpointed_at, ?)")
                        parameters.append(now)
                    if normalized_state in TERMINAL_SCALE_UP_STATES:
                        updates.append("finished_at=COALESCE(finished_at, ?)")
                        parameters.append(now)
                if normalized_checkpoint is not _UNSET:
                    updates.append("checkpoint_path=?")
                    parameters.append(normalized_checkpoint)
                if normalized_successor is not _UNSET:
                    updates.append("successor_attempt_id=?")
                    parameters.append(normalized_successor)
                parameters.append(plan_id)
                connection.execute(
                    f"UPDATE scale_up_plans SET {', '.join(updates)} " "WHERE id=?",
                    parameters,
                )
                if final_state in TERMINAL_SCALE_UP_STATES:
                    connection.execute(
                        "DELETE FROM scale_up_reservations WHERE plan_id=?",
                        (plan_id,),
                    )
                row = connection.execute(
                    "SELECT * FROM scale_up_plans WHERE id=?", (plan_id,)
                ).fetchone()
                assert row is not None
                return self._scale_up_plan(row)
        except sqlite3.IntegrityError as exc:
            raise StoreConflictError(
                "scale-up plan update violates a durable invariant"
            ) from exc

    def transition_scale_up_plan(
        self,
        plan_id: str,
        to_state: str | ScaleUpState,
        *,
        from_states: Iterable[str | ScaleUpState] | None = None,
        expected_version: int | None = None,
        checkpoint_path: str | None | object = _UNSET,
        successor_attempt_id: str | None | object = _UNSET,
    ) -> dict[str, Any]:
        return self.update_scale_up_plan(
            plan_id,
            state=to_state,
            checkpoint_path=checkpoint_path,
            successor_attempt_id=successor_attempt_id,
            expected_version=expected_version,
            expected_states=from_states,
        )

    def list_scale_up_reservations(
        self,
        *,
        plan_id: str | None = None,
        job_id: str | None = None,
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[Any] = []
        if plan_id is not None:
            clauses.append("plan_id=?")
            parameters.append(plan_id)
        if job_id is not None:
            clauses.append("job_id=?")
            parameters.append(job_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM scale_up_reservations{where}
                ORDER BY gpu_index
                """,
                parameters,
            ).fetchall()
        return [self._scale_up_reservation(row) for row in rows]

    def release_scale_up_reservations(
        self,
        plan_id: str,
        *,
        reservation_token: str | None = None,
    ) -> int:
        clauses = ["plan_id=?"]
        parameters: list[Any] = [plan_id]
        if reservation_token is not None:
            clauses.append("reservation_token=?")
            parameters.append(reservation_token)
        with self._transaction() as connection:
            cursor = connection.execute(
                "DELETE FROM scale_up_reservations WHERE " + " AND ".join(clauses),
                parameters,
            )
            return int(cursor.rowcount)

    def reserve_full_scale_up_target(
        self,
        plan_id: str,
        *,
        reservation_token: str | None = None,
    ) -> list[dict[str, Any]]:
        """Fence every target GPU after the source leases are released."""

        now = self._now()
        try:
            with self._transaction() as connection:
                plan = connection.execute(
                    "SELECT * FROM scale_up_plans WHERE id=?", (plan_id,)
                ).fetchone()
                if plan is None:
                    raise StoreNotFoundError(f"scale-up plan not found: {plan_id}")
                if plan["state"] != ScaleUpState.RESTART_PENDING.value:
                    raise StoreConflictError(
                        "full target can only be reserved while restart is pending"
                    )
                token = str(plan["reservation_token"])
                if reservation_token is not None and reservation_token != token:
                    raise StoreConflictError("scale-up reservation token changed")
                targets = list(
                    zip(
                        _json_load(plan["target_gpu_uuids_json"]),
                        _json_load(plan["target_gpu_indices_json"]),
                    )
                )
                for gpu_uuid, gpu_index in targets:
                    lease = connection.execute(
                        """
                        SELECT job_id FROM leases
                        WHERE gpu_uuid=? OR gpu_index=? LIMIT 1
                        """,
                        (gpu_uuid, gpu_index),
                    ).fetchone()
                    if lease is not None:
                        raise StoreConflictError(
                            f"GPU {gpu_uuid}/{gpu_index} is still leased by "
                            f"job {lease['job_id']}"
                        )
                    existing = connection.execute(
                        """
                        SELECT * FROM scale_up_reservations
                        WHERE gpu_uuid=? OR gpu_index=?
                        """,
                        (gpu_uuid, gpu_index),
                    ).fetchall()
                    if existing:
                        if (
                            len(existing) != 1
                            or existing[0]["gpu_uuid"] != gpu_uuid
                            or int(existing[0]["gpu_index"]) != gpu_index
                            or existing[0]["plan_id"] != plan_id
                            or existing[0]["reservation_token"] != token
                        ):
                            raise StoreConflictError(
                                f"GPU {gpu_uuid}/{gpu_index} has a conflicting "
                                "scale-up reservation"
                            )
                        connection.execute(
                            """
                            UPDATE scale_up_reservations
                            SET updated_at=? WHERE gpu_uuid=?
                            """,
                            (now, gpu_uuid),
                        )
                        continue
                    connection.execute(
                        """
                        INSERT INTO scale_up_reservations(
                            gpu_uuid, gpu_index, plan_id, job_id,
                            reservation_token, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            gpu_uuid,
                            gpu_index,
                            plan_id,
                            plan["job_id"],
                            token,
                            now,
                            now,
                        ),
                    )
                rows = connection.execute(
                    """
                    SELECT * FROM scale_up_reservations
                    WHERE plan_id=? ORDER BY gpu_index
                    """,
                    (plan_id,),
                ).fetchall()
                if len(rows) != int(plan["target_gpu_count"]):
                    raise StoreCorruptError(
                        "scale-up plan does not hold its full target reservation"
                    )
                return [self._scale_up_reservation(row) for row in rows]
        except sqlite3.IntegrityError as exc:
            raise StoreConflictError(
                "cannot reserve the complete scale-up target"
            ) from exc

    def consume_scale_up_reservations(
        self,
        plan_id: str,
        successor_attempt_id: str,
        *,
        lease_token: str | None = None,
        reservation_token: str | None = None,
        expected_version: int | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Atomically convert a full target reservation into successor leases."""

        with self._transaction() as connection:
            plan = connection.execute(
                "SELECT * FROM scale_up_plans WHERE id=?", (plan_id,)
            ).fetchone()
            if plan is None:
                raise StoreNotFoundError(f"scale-up plan not found: {plan_id}")
            if plan["state"] != ScaleUpState.RESTART_PENDING.value:
                raise StoreConflictError(
                    "scale-up plan is not ready to create a successor"
                )
            if (
                expected_version is not None
                and int(plan["version"]) != expected_version
            ):
                raise StoreConflictError(
                    "scale-up plan state/version changed concurrently"
                )
            token = str(plan["reservation_token"])
            if reservation_token is not None and reservation_token != token:
                raise StoreConflictError("scale-up reservation token changed")
            if plan["checkpoint_path"] is None:
                raise StoreConflictError(
                    "scale-up successor requires a durable checkpoint_path"
                )
            targets = list(
                zip(
                    _json_load(plan["target_gpu_uuids_json"]),
                    _json_load(plan["target_gpu_indices_json"]),
                )
            )
            reservations = connection.execute(
                """
                SELECT gpu_uuid, gpu_index, reservation_token
                FROM scale_up_reservations
                WHERE plan_id=? ORDER BY gpu_index
                """,
                (plan_id,),
            ).fetchall()
            reserved = {
                (str(row["gpu_uuid"]), int(row["gpu_index"]))
                for row in reservations
                if row["reservation_token"] == token
            }
            if reserved != set(targets) or len(reservations) != len(targets):
                raise StoreConflictError(
                    "scale-up plan does not hold its complete target reservation"
                )
            successor = connection.execute(
                """
                SELECT job_id, state, gpu_uuids_json, gpu_indices_json,
                       launch_resume_checkpoint_path, resume_from_attempt_id
                FROM attempts WHERE id=?
                """,
                (successor_attempt_id,),
            ).fetchone()
            if successor is None:
                raise StoreNotFoundError(
                    f"successor attempt not found: {successor_attempt_id}"
                )
            successor_assignment = set(
                zip(
                    _json_load(successor["gpu_uuids_json"]),
                    _json_load(successor["gpu_indices_json"]),
                )
            )
            if (
                successor["job_id"] != plan["job_id"]
                or successor["state"] != AttemptState.PLANNED.value
                or successor_assignment != set(targets)
                or successor["launch_resume_checkpoint_path"] != plan["checkpoint_path"]
                or successor["resume_from_attempt_id"] != plan["source_attempt_id"]
            ):
                raise StoreConflictError(
                    "successor attempt does not match scale-up plan"
                )
            connection.execute(
                "DELETE FROM scale_up_reservations WHERE plan_id=?",
                (plan_id,),
            )
            leases = self.acquire_leases(
                str(plan["job_id"]),
                successor_attempt_id,
                targets,
                lease_token=lease_token or successor_attempt_id,
            )
            updated = self.update_scale_up_plan(
                plan_id,
                state=ScaleUpState.RESTART_PLANNED,
                successor_attempt_id=successor_attempt_id,
                expected_version=int(plan["version"]),
                expected_states=[ScaleUpState.RESTART_PENDING],
            )
            return updated, leases

    # ---------------------------------------------------------------- leases

    @staticmethod
    def _lease(row: sqlite3.Row) -> dict[str, Any]:
        return dict(row)

    @staticmethod
    def _assignments(
        assignments: Mapping[str, int] | Iterable[tuple[str, int]],
    ) -> list[tuple[str, int]]:
        items = list(
            assignments.items() if isinstance(assignments, Mapping) else assignments
        )
        normalized: list[tuple[str, int]] = []
        for item in items:
            if not isinstance(item, (tuple, list)) or len(item) != 2:
                raise ValueError("each GPU assignment must be (uuid, index)")
            gpu_uuid, gpu_index = item
            if not isinstance(gpu_uuid, str) or not gpu_uuid:
                raise ValueError("GPU UUID must be a non-empty string")
            if (
                isinstance(gpu_index, bool)
                or not isinstance(gpu_index, int)
                or gpu_index < 0
            ):
                raise ValueError("GPU index must be a non-negative integer")
            normalized.append((gpu_uuid, gpu_index))
        if not normalized:
            raise ValueError("at least one GPU assignment is required")
        if len({item[0] for item in normalized}) != len(normalized):
            raise ValueError("duplicate GPU UUID in assignment")
        if len({item[1] for item in normalized}) != len(normalized):
            raise ValueError("duplicate GPU index in assignment")
        return normalized

    def acquire_leases(
        self,
        job_id: str,
        attempt_id: str,
        assignments: Mapping[str, int] | Iterable[tuple[str, int]],
        *,
        lease_token: str | None = None,
        memory_capacity_mb: int | None = None,
    ) -> list[dict[str, Any]]:
        normalized = sorted(self._assignments(assignments), key=lambda item: item[1])
        lease_token = _nonempty(lease_token or _new_id(), "lease_token", maximum=256)
        now = self._now()
        with self._transaction() as connection:
            attempt = connection.execute(
                """
                SELECT a.job_id, a.state, a.gpu_uuids_json,
                       a.gpu_indices_json, j.gpu_count, j.min_gpu_count,
                       j.elastic_gpu_count, j.placement,
                       j.requested_gpu_uuids_json, j.share_gpu, j.vram_mb
                FROM attempts AS a
                JOIN jobs AS j ON j.id=a.job_id
                WHERE a.id=?
                """,
                (attempt_id,),
            ).fetchone()
            if attempt is None:
                raise StoreNotFoundError(f"attempt not found: {attempt_id}")
            if attempt["job_id"] != job_id:
                raise StoreConflictError("attempt does not belong to job")
            if attempt["state"] not in ACTIVE_ATTEMPT_STATES:
                raise StoreConflictError("cannot lease GPUs to an inactive attempt")
            if attempt["share_gpu"] and (
                isinstance(memory_capacity_mb, bool)
                or not isinstance(memory_capacity_mb, int)
                or memory_capacity_mb <= 0
            ):
                raise ValueError("shared lease requires positive memory_capacity_mb")
            self._require_gpu_assignment_count(
                attempt,
                len(normalized),
                subject="lease assignment",
            )
            self._require_pinned_assignment(attempt, [item[0] for item in normalized])
            recorded_uuids = _json_load(attempt["gpu_uuids_json"])
            recorded_indices = _json_load(attempt["gpu_indices_json"])
            if not isinstance(recorded_uuids, list) or not isinstance(
                recorded_indices, list
            ):
                raise StoreCorruptError("attempt GPU assignment is not a JSON array")
            if len(recorded_uuids) != len(recorded_indices):
                raise StoreCorruptError("attempt GPU assignment lengths differ")
            if any(
                not isinstance(value, str) or not value for value in recorded_uuids
            ) or any(
                isinstance(value, bool) or not isinstance(value, int) or value < 0
                for value in recorded_indices
            ):
                raise StoreCorruptError("attempt GPU assignment has invalid values")
            recorded = set(zip(recorded_uuids, recorded_indices))
            requested = set(normalized)
            if recorded and recorded != requested:
                raise StoreConflictError(
                    "lease assignment differs from the attempt GPU assignment"
                )
            if not recorded:
                connection.execute(
                    """
                    UPDATE attempts
                    SET gpu_uuids_json=?, gpu_indices_json=?,
                        updated_at=?, version=version+1
                    WHERE id=?
                    """,
                    (
                        _json_dump([item[0] for item in normalized]),
                        _json_dump([item[1] for item in normalized]),
                        now,
                        attempt_id,
                    ),
                )
            existing_for_attempt = connection.execute(
                """
                SELECT gpu_uuid, gpu_index
                FROM leases
                WHERE attempt_id=?
                """,
                (attempt_id,),
            ).fetchall()
            if any(
                (row["gpu_uuid"], row["gpu_index"]) not in requested
                for row in existing_for_attempt
            ):
                raise StoreConflictError(
                    "attempt already holds a different GPU lease assignment"
                )
            matching_rows: list[sqlite3.Row] = []
            missing: list[tuple[str, int]] = []
            for gpu_uuid, gpu_index in normalized:
                reservation = connection.execute(
                    """
                    SELECT job_id, plan_id FROM scale_up_reservations
                    WHERE gpu_uuid=? OR gpu_index=?
                    LIMIT 1
                    """,
                    (gpu_uuid, gpu_index),
                ).fetchone()
                if reservation is not None:
                    raise StoreConflictError(
                        f"GPU {gpu_uuid}/{gpu_index} is reserved by "
                        f"scale-up plan {reservation['plan_id']} for "
                        f"job {reservation['job_id']}"
                    )
                current = connection.execute(
                    """
                    SELECT l.*, j.share_gpu, j.vram_mb FROM leases AS l
                    JOIN jobs AS j ON j.id=l.job_id
                    WHERE gpu_uuid=? OR gpu_index=?
                    """,
                    (gpu_uuid, gpu_index),
                ).fetchall()
                own = None
                for holder in current:
                    if (
                        holder["gpu_uuid"] != gpu_uuid
                        or holder["gpu_index"] != gpu_index
                    ):
                        raise StoreConflictError("GPU UUID/index conflict")
                    if (
                        holder["attempt_id"] == attempt_id
                        and holder["job_id"] == job_id
                    ):
                        own = holder
                    elif not attempt["share_gpu"] and not any(
                        row["attempt_id"] == attempt_id and row["job_id"] == job_id
                        for row in current
                    ):
                        raise StoreConflictError(
                            f"GPU {gpu_uuid}/{gpu_index} is leased by job {holder['job_id']}"
                        )
                if own is not None:
                    matching_rows.append(own)
                    continue
                if attempt["share_gpu"]:
                    assert isinstance(memory_capacity_mb, int)
                    reserved_mb = sum(
                        int(row["vram_mb"]) for row in current if row["share_gpu"]
                    )
                    if reserved_mb + int(attempt["vram_mb"]) > memory_capacity_mb:
                        raise StoreConflictError("shared GPU memory budget exhausted")
                missing.append((gpu_uuid, gpu_index))

            current_tokens = {str(row["lease_token"]) for row in matching_rows}
            if not missing and len(current_tokens) == 1:
                # A retry of a complete bundle preserves its fencing token.
                effective_token = next(iter(current_tokens))
            else:
                # Rebuilding a partially released (or legacy mixed-token)
                # bundle rotates every surviving row to one new token.
                effective_token = lease_token
                if matching_rows:
                    connection.execute(
                        """
                        UPDATE leases
                        SET lease_token=?, heartbeat_at=?
                        WHERE attempt_id=?
                        """,
                        (effective_token, now, attempt_id),
                    )
            for gpu_uuid, gpu_index in missing:
                connection.execute(
                    """
                    INSERT INTO leases(
                        gpu_uuid, gpu_index, job_id, attempt_id,
                        acquired_at, heartbeat_at, lease_token
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        gpu_uuid,
                        gpu_index,
                        job_id,
                        attempt_id,
                        now,
                        now,
                        effective_token,
                    ),
                )
                connection.execute(
                    """INSERT INTO gpu_allocation_history(
                        job_id,attempt_id,gpu_uuid,gpu_index,acquired_at,source)
                        VALUES(?,?,?,?,?,'observed')""",
                    (job_id, attempt_id, gpu_uuid, gpu_index, now),
                )
            placeholders = ",".join("?" for _ in normalized)
            rows = connection.execute(
                f"""
                SELECT * FROM leases
                WHERE gpu_uuid IN ({placeholders}) AND attempt_id=?
                ORDER BY gpu_index
                """,
                [*[item[0] for item in normalized], attempt_id],
            ).fetchall()
            return [self._lease(row) for row in rows]

    def list_leases(
        self, *, job_id: str | None = None, attempt_id: str | None = None
    ) -> list[dict[str, Any]]:
        clauses: list[str] = []
        parameters: list[Any] = []
        if job_id is not None:
            clauses.append("job_id=?")
            parameters.append(job_id)
        if attempt_id is not None:
            clauses.append("attempt_id=?")
            parameters.append(attempt_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with self._read_connection() as connection:
            rows = connection.execute(
                f"SELECT * FROM leases{where} ORDER BY gpu_index", parameters
            ).fetchall()
        return [self._lease(row) for row in rows]

    def heartbeat_leases(self, attempt_id: str) -> int:
        now = self._now()
        with self._transaction() as connection:
            cursor = connection.execute(
                "UPDATE leases SET heartbeat_at=? WHERE attempt_id=?",
                (now, attempt_id),
            )
            return int(cursor.rowcount)

    def list_allocation_history(
        self, *, job_id: str, before_id: int | None = None, limit: int = 256
    ) -> list[dict[str, Any]]:
        job_id = _nonempty(job_id, "job_id", maximum=256)
        if type(limit) is not int or not 1 <= limit <= 257:
            raise ValueError("allocation history limit must be an integer from 1 to 257")
        if before_id is not None and (type(before_id) is not int or not 1 <= before_id <= _SQLITE_SIGNED_INT_MAX):
            raise ValueError("allocation history cursor must be a positive SQLite integer")
        parameters: list[Any] = [job_id]
        clause = "job_id=?"
        if before_id is not None:
            clause += " AND id<?"
            parameters.append(before_id)
        parameters.append(limit)
        with self._read_connection() as connection:
            return [dict(row) for row in connection.execute(
                "SELECT id,job_id,attempt_id,gpu_uuid,gpu_index,acquired_at,released_at,release_reason,source "
                + "FROM gpu_allocation_history WHERE " + clause + " ORDER BY id DESC LIMIT ?", parameters
            ).fetchall()]

    def release_leases(
        self,
        *,
        attempt_id: str,
        gpu_uuids: Iterable[str] | None = None,
        lease_token: str | None = None,
        reason: str | None = None,
    ) -> int:
        if reason is not None:
            reason = _nonempty(reason, "release reason", maximum=400)
        clauses = ["attempt_id=?"]
        parameters: list[Any] = [attempt_id]
        if gpu_uuids is not None:
            values = list(gpu_uuids)
            if not values:
                return 0
            clauses.append("gpu_uuid IN (" + ",".join("?" for _ in values) + ")")
            parameters.extend(values)
        if lease_token is not None:
            clauses.append("lease_token=?")
            parameters.append(lease_token)
        with self._transaction() as connection:
            leases = connection.execute(
                f"SELECT * FROM leases WHERE {' AND '.join(clauses)}", parameters
            ).fetchall()
            released_at = self._now()
            for lease in leases:
                updated = connection.execute(
                    """UPDATE gpu_allocation_history SET released_at=?,release_reason=?
                        WHERE job_id=? AND attempt_id=? AND gpu_uuid=? AND gpu_index=?
                        AND acquired_at=? AND released_at IS NULL""",
                    (released_at, reason, lease['job_id'], lease['attempt_id'],
                     lease['gpu_uuid'], lease['gpu_index'], lease['acquired_at']),
                )
                if updated.rowcount != 1:
                    raise StoreCorruptError("active lease lacks exactly one allocation history record")
            cursor = connection.execute(
                f"DELETE FROM leases WHERE {' AND '.join(clauses)}", parameters
            )
            return int(cursor.rowcount)

    # --------------------------------------------------------- actions/outbox

    @staticmethod
    def _action(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["payload"] = _json_load(result.pop("payload_json"))
        raw_result = result.pop("result_json")
        result["result"] = None if raw_result is None else _json_load(raw_result)
        result.pop("action_digest", None)
        return result

    def enqueue_action(
        self,
        *,
        job_id: str,
        action_type: str | ActionType,
        attempt_id: str | None = None,
        payload: Any = None,
        dedupe_key: str | None = None,
        available_at: float | None = None,
        action_id: str | None = None,
    ) -> dict[str, Any]:
        normalized_type = _choice(action_type, _ACTION_TYPES, "action_type")
        action_id = _nonempty(action_id or _new_id(), "action_id", maximum=256)
        dedupe_key = _nonempty(dedupe_key or action_id, "dedupe_key", maximum=512)
        payload_json = _json_dump({} if payload is None else payload)
        available = (
            self._now()
            if available_at is None
            else _finite_timestamp(available_at, "available_at")
        )
        now = self._now()
        # Scheduling time is mutable outbox metadata, not action identity.  In
        # particular, two retries of the same request without an explicit
        # ``available_at`` must still resolve to the same durable action.
        digest = _digest(job_id, attempt_id or "", normalized_type, payload_json)
        try:
            with self._transaction() as connection:
                job = connection.execute(
                    "SELECT 1 FROM jobs WHERE id=?", (job_id,)
                ).fetchone()
                if job is None:
                    raise StoreNotFoundError(f"job not found: {job_id}")
                if attempt_id is not None:
                    attempt = connection.execute(
                        "SELECT job_id FROM attempts WHERE id=?", (attempt_id,)
                    ).fetchone()
                    if attempt is None:
                        raise StoreNotFoundError(f"attempt not found: {attempt_id}")
                    if attempt["job_id"] != job_id:
                        raise StoreConflictError("attempt does not belong to job")
                connection.execute(
                    """
                    INSERT INTO actions(
                        id, dedupe_key, action_digest, job_id, attempt_id,
                        action_type, state, payload_json, available_at,
                        created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        action_id,
                        dedupe_key,
                        digest,
                        job_id,
                        attempt_id,
                        normalized_type,
                        ActionState.PENDING.value,
                        payload_json,
                        available,
                        now,
                        now,
                    ),
                )
                row = connection.execute(
                    "SELECT * FROM actions WHERE id=?", (action_id,)
                ).fetchone()
                assert row is not None
                return self._action(row)
        except sqlite3.IntegrityError as exc:
            with self._read_connection() as connection:
                row = connection.execute(
                    "SELECT * FROM actions WHERE dedupe_key=?", (dedupe_key,)
                ).fetchone()
                if row is not None and row["action_digest"] == digest:
                    return self._action(row)
                if row is not None:
                    raise StoreConflictError(
                        "dedupe_key was already used for a different action"
                    ) from exc
            raise StoreConflictError(f"cannot enqueue action: {exc}") from exc

    enqueue_outbox = enqueue_action

    def get_action(self, action_id: str) -> dict[str, Any]:
        with self._read_connection() as connection:
            row = connection.execute(
                "SELECT * FROM actions WHERE id=?", (action_id,)
            ).fetchone()
        if row is None:
            raise StoreNotFoundError(f"action not found: {action_id}")
        return self._action(row)

    def list_actions(
        self,
        *,
        states: Iterable[str | ActionState] | None = None,
        job_id: str | None = None,
        attempt_id: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if isinstance(limit, bool) or not 1 <= limit <= 100_000:
            raise ValueError("limit must be between 1 and 100000")
        clauses: list[str] = []
        parameters: list[Any] = []
        if states is not None:
            normalized = [
                _choice(state, _ACTION_STATES, "action state") for state in states
            ]
            if not normalized:
                return []
            clauses.append("state IN (" + ",".join("?" for _ in normalized) + ")")
            parameters.extend(normalized)
        if job_id is not None:
            clauses.append("job_id=?")
            parameters.append(job_id)
        if attempt_id is not None:
            clauses.append("attempt_id=?")
            parameters.append(attempt_id)
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        parameters.append(limit)
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM actions{where}
                ORDER BY available_at, created_at, id
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._action(row) for row in rows]

    def claim_actions(
        self,
        worker_id: str,
        *,
        limit: int = 1,
        lease_seconds: float = 30.0,
        now: float | None = None,
        exclude_action_ids: Iterable[str] | None = None,
    ) -> list[dict[str, Any]]:
        worker_id = _nonempty(worker_id, "worker_id", maximum=256)
        if isinstance(limit, bool) or not 1 <= limit <= 1000:
            raise ValueError("limit must be between 1 and 1000")
        if (
            isinstance(lease_seconds, bool)
            or not isinstance(lease_seconds, (int, float))
            or not math.isfinite(float(lease_seconds))
            or lease_seconds <= 0
        ):
            raise ValueError("lease_seconds must be positive and finite")
        current = self._now() if now is None else _finite_timestamp(now, "now")
        claim_until = current + float(lease_seconds)
        if not math.isfinite(claim_until):
            raise ValueError("claim deadline must be finite")
        excluded_ids = _claim_action_exclusions(exclude_action_ids)
        exclusion_sql = ""
        candidate_parameters: list[Any] = [
            ActionState.PENDING.value,
            current,
            current,
        ]
        if excluded_ids:
            exclusion_placeholders = ",".join("?" for _ in excluded_ids)
            exclusion_sql = f" AND id NOT IN ({exclusion_placeholders})"
            candidate_parameters.extend(excluded_ids)
        candidate_parameters.append(limit)
        claim_token = _new_id()
        with self._transaction() as connection:
            candidates = connection.execute(
                f"""
                SELECT id FROM actions
                WHERE state=?
                  AND available_at<=?
                  AND (claim_until IS NULL OR claim_until<=?)
                  {exclusion_sql}
                ORDER BY available_at, created_at, id
                LIMIT ?
                """,
                candidate_parameters,
            ).fetchall()
            ids = [str(row["id"]) for row in candidates]
            if not ids:
                return []
            placeholders = ",".join("?" for _ in ids)
            connection.execute(
                f"""
                UPDATE actions
                SET claimed_by=?, claim_token=?, claim_until=?,
                    attempt_count=attempt_count+1, updated_at=?
                WHERE id IN ({placeholders})
                """,
                [worker_id, claim_token, claim_until, current, *ids],
            )
            rows = connection.execute(
                f"""
                SELECT * FROM actions WHERE id IN ({placeholders})
                ORDER BY available_at, created_at, id
                """,
                ids,
            ).fetchall()
            return [self._action(row) for row in rows]

    claim_outbox = claim_actions

    def complete_action(
        self,
        action_id: str,
        *,
        claim_token: str | None = None,
        result: Any = None,
    ) -> dict[str, Any]:
        if claim_token is not None:
            claim_token = _nonempty(claim_token, "claim_token", maximum=256)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM actions WHERE id=?", (action_id,)
            ).fetchone()
            if row is None:
                raise StoreNotFoundError(f"action not found: {action_id}")
            if row["state"] == ActionState.DONE.value:
                if claim_token is not None and row["claim_token"] != claim_token:
                    raise StoreConflictError("action claim token does not match")
                return self._action(row)
            if row["state"] != ActionState.PENDING.value:
                raise StoreConflictError(f"action is already {row['state']}")
            if claim_token is None:
                raise StoreConflictError(
                    "a claim token is required to complete an action"
                )
            if row["claim_token"] != claim_token:
                raise StoreConflictError("action claim token does not match")
            now = self._now()
            result_json = _json_dump({} if result is None else result)
            connection.execute(
                """
                UPDATE actions
                SET state=?, result_json=?, claim_until=NULL,
                    updated_at=?, finished_at=?
                WHERE id=?
                """,
                (ActionState.DONE.value, result_json, now, now, action_id),
            )
            updated = connection.execute(
                "SELECT * FROM actions WHERE id=?", (action_id,)
            ).fetchone()
            assert updated is not None
            return self._action(updated)

    ack_action = complete_action

    def fail_action(
        self,
        action_id: str,
        error: str,
        *,
        claim_token: str | None = None,
        retry: bool = False,
        available_at: float | None = None,
    ) -> dict[str, Any]:
        if claim_token is not None:
            claim_token = _nonempty(claim_token, "claim_token", maximum=256)
        with self._transaction() as connection:
            row = connection.execute(
                "SELECT * FROM actions WHERE id=?", (action_id,)
            ).fetchone()
            if row is None:
                raise StoreNotFoundError(f"action not found: {action_id}")
            if row["state"] != ActionState.PENDING.value:
                if not retry and row["state"] == ActionState.FAILED.value:
                    if claim_token is not None and row["claim_token"] != claim_token:
                        raise StoreConflictError("action claim token does not match")
                    return self._action(row)
                raise StoreConflictError(f"action is already {row['state']}")
            if claim_token is None:
                # Coordinator cancellation may retire an action which has
                # never left the outbox.  Once a worker has claimed it, token
                # fencing is mandatory so cancellation cannot acknowledge a
                # stale or concurrently executing delivery.
                if row["claim_token"] is not None:
                    raise StoreConflictError(
                        "a claim token is required to fail a claimed action"
                    )
                if retry:
                    raise StoreConflictError(
                        "a claim token is required to retry an action"
                    )
            elif row["claim_token"] != claim_token:
                raise StoreConflictError("action claim token does not match")
            error = _nonempty(error, "error", maximum=16_384)
            now = self._now()
            available = now
            if retry:
                available = (
                    now
                    if available_at is None
                    else _finite_timestamp(available_at, "available_at")
                )
            elif available_at is not None:
                raise ValueError("available_at is only valid when retry=True")
            if retry:
                connection.execute(
                    """
                    UPDATE actions
                    SET last_error=?, available_at=?, claimed_by=NULL,
                        claim_token=NULL, claim_until=NULL, updated_at=?
                    WHERE id=?
                    """,
                    (error, available, now, action_id),
                )
            else:
                connection.execute(
                    """
                    UPDATE actions
                    SET state=?, last_error=?, claim_until=NULL,
                        updated_at=?, finished_at=?
                    WHERE id=?
                    """,
                    (ActionState.FAILED.value, error, now, now, action_id),
                )
            updated = connection.execute(
                "SELECT * FROM actions WHERE id=?", (action_id,)
            ).fetchone()
            assert updated is not None
            return self._action(updated)

    nack_action = fail_action

    # ---------------------------------------------------------------- events

    @staticmethod
    def _event(row: sqlite3.Row) -> dict[str, Any]:
        result = dict(row)
        result["payload"] = _json_load(result.pop("payload_json"))
        return result

    def append_event(
        self,
        event_type: str,
        *,
        job_id: str | None = None,
        attempt_id: str | None = None,
        payload: Any = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        event_type = _nonempty(event_type, "event_type", maximum=256)
        payload_json = _json_dump({} if payload is None else payload)
        timestamp = (
            self._now()
            if created_at is None
            else _finite_timestamp(created_at, "created_at")
        )
        if attempt_id is not None and job_id is None:
            raise ValueError("job_id is required when attempt_id is supplied")
        try:
            with self._transaction() as connection:
                cursor = connection.execute(
                    """
                    INSERT INTO events(
                        job_id, attempt_id, event_type, payload_json, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (job_id, attempt_id, event_type, payload_json, timestamp),
                )
                row = connection.execute(
                    "SELECT * FROM events WHERE id=?", (cursor.lastrowid,)
                ).fetchone()
                assert row is not None
                return self._event(row)
        except sqlite3.IntegrityError as exc:
            raise StoreConflictError("event references an unknown job/attempt") from exc

    record_event = append_event

    def latest_event_id(self, job_id: str | None = None) -> int:
        """Return the current event cursor globally or for one job."""

        parameters: tuple[str, ...] = ()
        where = ""
        if job_id is not None:
            parameters = (_nonempty(job_id, "job_id", maximum=256),)
            where = " WHERE job_id=?"
        with self._read_connection() as connection:
            row = connection.execute(
                f"SELECT COALESCE(MAX(id), 0) FROM events{where}",
                parameters,
            ).fetchone()
        assert row is not None
        return int(row[0])

    def list_events(
        self,
        *,
        after_id: int = 0,
        job_id: str | None = None,
        attempt_id: str | None = None,
        limit: int = 1000,
    ) -> list[dict[str, Any]]:
        if isinstance(after_id, bool) or not isinstance(after_id, int) or after_id < 0:
            raise ValueError("after_id must be a non-negative integer")
        if isinstance(limit, bool) or not 1 <= limit <= 100_000:
            raise ValueError("limit must be between 1 and 100000")
        clauses = ["id>?"]
        parameters: list[Any] = [after_id]
        if job_id is not None:
            clauses.append("job_id=?")
            parameters.append(job_id)
        if attempt_id is not None:
            clauses.append("attempt_id=?")
            parameters.append(attempt_id)
        parameters.append(limit)
        with self._read_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT * FROM events
                WHERE {' AND '.join(clauses)}
                ORDER BY id
                LIMIT ?
                """,
                parameters,
            ).fetchall()
        return [self._event(row) for row in rows]


SQLiteStore = Store
JobStore = Store


def initialize_database(
    path: str | os.PathLike[str],
    *,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
) -> Store:
    """Create/validate and return an open store for an explicit ``gpuq init``."""

    return Store(path, busy_timeout_ms=busy_timeout_ms).initialize()


def open_database(
    path: str | os.PathLike[str],
    *,
    busy_timeout_ms: int = DEFAULT_BUSY_TIMEOUT_MS,
    integrity_check: bool = True,
) -> Store:
    """Open an existing store using the daemon's fail-closed semantics."""

    return Store(path, busy_timeout_ms=busy_timeout_ms).open(
        integrity_check=integrity_check
    )

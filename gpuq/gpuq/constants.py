from __future__ import annotations

from enum import Enum


# On-disk control/launch protocol version shared with training adapters.
SCHEMA_VERSION = 1
# SQLite schema version.  Kept separate so DB migrations do not invalidate
# checkpoint adapters or launch specifications.
STORE_SCHEMA_VERSION = 16
CHECKPOINT_EXIT_CODE = 75
MAX_PRIORITY = 4
MIN_PRIORITY = 0


class DispatchMode(str, Enum):
    QUEUE = "queue"
    PREEMPT_SAVE = "preempt-save"
    PREEMPT_NOW = "preempt-now"


class CheckpointCapability(str, Enum):
    NONE = "none"
    EPOCH_V1 = "epoch-v1"


class RestartPolicy(str, Enum):
    ON_PREEMPT = "on-preempt"
    NEVER = "never"


class ProgressSeverity(str, Enum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class JobState(str, Enum):
    PENDING = "PENDING"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    PREEMPTING = "PREEMPTING"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELED = "CANCELED"
    LOST = "LOST"


TERMINAL_JOB_STATES = {
    JobState.SUCCEEDED.value,
    JobState.FAILED.value,
    JobState.CANCELED.value,
    JobState.LOST.value,
}


class AttemptState(str, Enum):
    PLANNED = "PLANNED"
    STARTING = "STARTING"
    RUNNING = "RUNNING"
    SAVE_REQUESTED = "SAVE_REQUESTED"
    SAVE_WITHDRAWING = "SAVE_WITHDRAWING"
    CHECKPOINT_ACKED = "CHECKPOINT_ACKED"
    TERM_REQUESTED = "TERM_REQUESTED"
    KILL_REQUESTED = "KILL_REQUESTED"
    DRAINING = "DRAINING"
    PREEMPTED = "PREEMPTED"
    EXITED_SUCCESS = "EXITED_SUCCESS"
    EXITED_FAILURE = "EXITED_FAILURE"
    CANCELED = "CANCELED"
    LOST = "LOST"
    STUCK = "STUCK"


class ScaleUpState(str, Enum):
    """Durable phases of one checkpoint/restart scale-up operation."""

    SAVE_REQUESTED = "SAVE_REQUESTED"
    CHECKPOINT_ACKED = "CHECKPOINT_ACKED"
    TERM_REQUESTED = "TERM_REQUESTED"
    RESTART_PENDING = "RESTART_PENDING"
    RESTART_PLANNED = "RESTART_PLANNED"
    COMPLETED = "COMPLETED"
    WITHDRAWN = "WITHDRAWN"
    FAILED = "FAILED"
    CANCELED = "CANCELED"


ACTIVE_SCALE_UP_STATES = {
    ScaleUpState.SAVE_REQUESTED.value,
    ScaleUpState.CHECKPOINT_ACKED.value,
    ScaleUpState.TERM_REQUESTED.value,
    ScaleUpState.RESTART_PENDING.value,
    ScaleUpState.RESTART_PLANNED.value,
}


TERMINAL_SCALE_UP_STATES = {
    ScaleUpState.COMPLETED.value,
    ScaleUpState.WITHDRAWN.value,
    ScaleUpState.FAILED.value,
    ScaleUpState.CANCELED.value,
}


ACTIVE_ATTEMPT_STATES = {
    AttemptState.PLANNED.value,
    AttemptState.STARTING.value,
    AttemptState.RUNNING.value,
    AttemptState.SAVE_REQUESTED.value,
    AttemptState.SAVE_WITHDRAWING.value,
    AttemptState.CHECKPOINT_ACKED.value,
    AttemptState.TERM_REQUESTED.value,
    AttemptState.KILL_REQUESTED.value,
    AttemptState.DRAINING.value,
}


class ActionType(str, Enum):
    START_UNIT = "START_UNIT"
    REQUEST_SAVE = "REQUEST_SAVE"
    TERM_UNIT = "TERM_UNIT"
    KILL_UNIT = "KILL_UNIT"
    CLEANUP_UNIT = "CLEANUP_UNIT"


class ActionState(str, Enum):
    PENDING = "PENDING"
    DONE = "DONE"
    FAILED = "FAILED"

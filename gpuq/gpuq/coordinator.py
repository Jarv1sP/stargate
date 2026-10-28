from __future__ import annotations

import fcntl
import itertools
import json
import logging
import os
import pwd
import secrets
import stat
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any, Callable, Iterable

from .backends import (
    BackendError,
    GpuDevice,
    NvidiaSmiError,
    UnitNotFoundError,
    UserSystemdBackend,
)
from .checkpoint import (
    ACK_FILE_NAME,
    LOCK_FILE_NAME,
    REQUEST_FILE_NAME,
    checkpoint_acknowledged,
)
from .config import Config
from .constants import (
    ACTIVE_ATTEMPT_STATES,
    ACTIVE_SCALE_UP_STATES,
    ActionState,
    ActionType,
    AttemptState,
    CheckpointCapability,
    DispatchMode,
    JobState,
    ProgressSeverity,
    RestartPolicy,
    SCHEMA_VERSION,
    ScaleUpState,
    TERMINAL_JOB_STATES,
)
from .elastic import compatible_world_sizes
from .hami import runtime_library, runtime_environment
from .gpu_metrics import observe as observe_gpu_metrics, read_metrics as gpu_metrics
from .policy import VictimCandidate, victim_in_scope, preemption_mode, select_scale_target, select_victims
from .progress import (
    PROGRESS_FILE_NAME,
    ProgressProtocolError,
    ProgressSnapshot,
    load_progress_file,
)
from .rpc import ApiError
from .store import Store, StoreConflictError, StoreNotFoundError
from .submission import validate_submission
from .util import (
    atomic_write_json,
    pid_control_group,
    process_start_ticks,
    read_cgroup_tree_processes,
    read_boot_id,
    secure_create_empty,
)


LOGGER = logging.getLogger(__name__)
_MAX_CONTROL_FILE_BYTES = 64 * 1024
_MAX_LAUNCH_SPEC_BYTES = 512 * 1024
_LAUNCH_FILE_NAME = "launch.json"
_ACTIVE_JOB_STATES = {
    JobState.PENDING.value,
    JobState.STARTING.value,
    JobState.RUNNING.value,
    JobState.PREEMPTING.value,
}


class GpuIndexDriftError(RuntimeError):
    """A UUID no longer maps to the index captured by the start plan."""


class GpuFenceAuditError(RuntimeError):
    """Durable GPU ownership cannot be safely partitioned per device."""


def _canonical_control_group(group: Any) -> bool:
    return (
        isinstance(group, str)
        and group.startswith("/")
        and "\x00" not in group
        and all(part not in ("", ".", "..") for part in group[1:].split("/"))
    )

def _control_group_owners(statuses: dict[str, Any]) -> dict[str, str]:
    """Index verified unit roots without permitting ambiguous descendants."""
    owners: dict[str, str] = {}
    for attempt_id, status in statuses.items():
        group = status.control_group
        if not group:
            continue
        if not _canonical_control_group(group):
            raise GpuFenceAuditError("invalid systemd control group")
        if group in owners:
            raise GpuFenceAuditError("systemd control group is shared by attempts")
        owners[group] = attempt_id
    for group in owners:
        parent = group.rpartition("/")[0]
        while parent:
            if parent in owners:
                raise GpuFenceAuditError("systemd control groups overlap between attempts")
            parent = parent.rpartition("/")[0]
    return owners


class StartCapacityBlocked(RuntimeError):
    """A reserved start target is locally unavailable but remains fenced."""

    def __init__(
        self,
        gpu_uuid: str,
        gpu_index: int,
        pids: Iterable[int],
    ) -> None:
        self.gpu_uuid = gpu_uuid
        self.gpu_index = gpu_index
        self.pids = tuple(sorted(pids))
        super().__init__(
            f"reserved GPU became externally busy before launch: {gpu_uuid}"
        )


@dataclass(frozen=True, slots=True)
class CollisionFinding:
    """One GPU-local mismatch between observed processes and durable leases."""

    gpu_uuid: str
    gpu_index: int
    kind: str
    pids: tuple[int, ...]
    lease_attempt_id: str | None = None
    process_attempt_id: str | None = None
    reservation_plan_id: str | None = None
    reservation_source_attempt_id: str | None = None

    @property
    def affected_attempt_ids(self) -> frozenset[str]:
        return frozenset(
            value
            for value in (
                self.lease_attempt_id,
                self.process_attempt_id,
                self.reservation_source_attempt_id,
            )
            if value is not None
        )

    def message(self) -> str:
        pid_text = ",".join(str(pid) for pid in self.pids)
        if self.kind == "leased-external-process":
            return (
                f"{self.gpu_uuid} leased to {self.lease_attempt_id} has external "
                f"PID(s) {pid_text}"
            )
        if self.kind == "managed-process-without-lease":
            return (
                f"{self.gpu_uuid} has managed PID(s) {pid_text} from "
                f"{self.process_attempt_id} but no GPU lease"
            )
        if self.kind == "reserved-external-process":
            return (
                f"{self.gpu_uuid} reserved by scale-up plan "
                f"{self.reservation_plan_id} has external PID(s) {pid_text}"
            )
        if self.kind == "start-target-busy":
            return (
                f"{self.gpu_uuid} reserved for start by {self.lease_attempt_id} "
                f"became busy" + (f" with PID(s) {pid_text}" if pid_text else "")
            )
        return (
            f"{self.gpu_uuid} leased to {self.lease_attempt_id} has managed "
            f"PID(s) {pid_text} from {self.process_attempt_id}"
        )


@dataclass(frozen=True, slots=True)
class GpuQuarantine:
    """Effective quarantine, including the clean-confirmation interval."""

    gpu_uuid: str
    gpu_index: int
    findings: tuple[CollisionFinding, ...]
    affected_attempt_ids: tuple[str, ...]
    collision_active: bool
    clean_scans: int


def _request_fields(
    arguments: dict[str, Any],
    *,
    allowed: set[str],
    required: set[str] | None = None,
) -> None:
    required = required or set()
    for key in list(arguments):
        if key not in allowed:
            del arguments[key]
    missing = sorted(required - set(arguments))
    if missing:
        raise ApiError("BAD_REQUEST", f"missing fields: {', '.join(missing)}")


def _small_json_file(
    path: Path, max_bytes: int = _MAX_CONTROL_FILE_BYTES
) -> dict[str, Any] | None:
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except FileNotFoundError:
        return None
    except OSError:
        return None
    try:
        info = os.fstat(descriptor)
        if not stat.S_ISREG(info.st_mode) or info.st_size > max_bytes:
            return None
        raw = os.read(descriptor, max_bytes + 1)
        if len(raw) > max_bytes:
            return None
        value = json.loads(raw.decode("utf-8", errors="strict"))
    except (OSError, UnicodeError, ValueError):
        return None
    finally:
        os.close(descriptor)
    return value if isinstance(value, dict) else None


class Coordinator:
    """Durable scheduler state machine.

    All externally destructive work is represented by a committed outbox
    action before it is executed.  Unknown GPU PIDs and ambiguous systemd
    identity are never acted upon.
    """

    def __init__(
        self,
        config: Config,
        store: Store,
        gpu_provider: Any,
        systemd: UserSystemdBackend,
        *,
        clock: Callable[[], float] = time.time,
        monotonic: Callable[[], float] = time.monotonic,
        cgroup_for_pid: Callable[[int], str | None] = pid_control_group,
        boot_id: str | None = None,
    ) -> None:
        self.config = config
        self.store = store
        self.gpu_provider = gpu_provider
        self.systemd = systemd
        self.clock = clock
        self.monotonic = monotonic
        self.cgroup_for_pid = cgroup_for_pid
        self.boot_id = boot_id or read_boot_id()
        self.worker_id = f"daemon-{uuid.uuid4()}"
        self._lock = threading.RLock()
        self._health = "recovering"
        self._last_error: str | None = None
        self._snapshot: tuple[GpuDevice, ...] = ()
        self._dependency_waiting: set[str] = set()
        self._gpu_samples_available = False
        self._statuses: dict[str, Any] = {}
        self._process_owners: dict[int, str | None] = {}
        self._external: dict[str, set[int]] = {}
        self._idle_counts: dict[str, int] = {}
        self._release_counts: dict[str, int] = {}
        # Quarantine is derived from a complete live observation and is never
        # persisted.  Durable leases remain the ownership fence; quarantine
        # only removes ambiguous capacity and affected gangs from scheduling
        # decisions.  A cleared GPU remains here for two clean observations.
        self._quarantines: dict[str, GpuQuarantine] = {}
        self._quarantine_affected_attempt_ids: set[str] = set()
        # Progress is observational only.  Parse failures are exposed to the
        # submitting user's watcher, but never alter scheduling health or any
        # job/attempt/lease state.
        self._progress_errors: dict[str, str] = {}
        self._recovery_scans = 0
        persisted_mode = store.get_setting("observe_only", config.observe_only)
        if not isinstance(persisted_mode, bool):
            raise RuntimeError("observe_only database setting must be boolean")
        self._observe_only = persisted_mode
        if store.get_setting("observe_only", None) is None:
            store.set_setting("observe_only", self._observe_only)

    def _invalidate_observation_history(self) -> None:
        """Reset resource observations when the current sample is unavailable."""

        self._recovery_scans = 0
        self._idle_counts.clear()
        self._release_counts.clear()
        self._quarantines.clear()
        self._quarantine_affected_attempt_ids.clear()

    # -------------------------------------------------------------- snapshots

    @property
    def health_name(self) -> str:
        with self._lock:
            return self._health

    @property
    def observe_only(self) -> bool:
        with self._lock:
            return self._observe_only

    def _set_health(self, health: str, error: str | None = None) -> None:
        self._health = health
        self._last_error = error

    def _verified_status(self, attempt: dict[str, Any]) -> Any | None:
        unit_name = attempt.get("unit_name")
        unit_token = attempt.get("unit_token")
        if not unit_name or not unit_token:
            return None
        return self.systemd.status(
            unit_name=unit_name,
        )

    def _collect_statuses(
        self, attempts: Iterable[dict[str, Any]]
    ) -> tuple[dict[str, Any], list[str]]:
        statuses: dict[str, Any] = {}
        problems: list[str] = []
        for attempt in attempts:
            if not attempt.get("unit_name") or not attempt.get("unit_token"):
                continue
            try:
                status = self._verified_status(attempt)
            except UnitNotFoundError:
                continue
            except BackendError as exc:
                problems.append(f"{attempt['id']}: {exc}")
                continue
            if status is not None:
                statuses[attempt["id"]] = status
        return statuses, problems

    def _classify_processes(
        self,
        devices: tuple[GpuDevice, ...],
        statuses: dict[str, Any],
        leases: list[dict[str, Any]],
        reservations: list[dict[str, Any]],
        *,
        process_owners: dict[int, str | None] | None = None,
    ) -> tuple[
        dict[str, set[int]],
        dict[str, set[int]],
        list[CollisionFinding],
    ]:
        group_to_attempt = _control_group_owners(statuses)
        managed: dict[str, set[int]] = {}
        external: dict[str, set[int]] = {}
        pid_attempt: dict[int, str | None] = {}
        if process_owners is not None:
            process_owners.clear()
        for device in devices:
            for pid in device.compute_pids:
                if pid not in pid_attempt:
                    group = self.cgroup_for_pid(pid)
                    attempt_id = None
                    if _canonical_control_group(group):
                        # Delegated OCI/Ray payloads can live below the unit.
                        # Walk path components, never a raw string prefix.
                        while group:
                            attempt_id = group_to_attempt.get(group)
                            if attempt_id is not None:
                                break
                            group = group.rpartition("/")[0]
                        if process_owners is not None:
                            process_owners[pid] = attempt_id
                    pid_attempt[pid] = attempt_id
                attempt_id = pid_attempt[pid]
                if attempt_id is None:
                    external.setdefault(device.uuid, set()).add(pid)
                else:
                    managed.setdefault(device.uuid, set()).add(pid)
        leases_by_uuid: dict[str, list[dict[str, Any]]] = {}
        for lease in leases:
            leases_by_uuid.setdefault(lease["gpu_uuid"], []).append(lease)
        jobs = {
            lease["job_id"]: self.store.get_job(lease["job_id"]) for lease in leases
        }
        reservation_by_uuid = {
            reservation["gpu_uuid"]: reservation for reservation in reservations
        }
        index_by_uuid = {device.uuid: device.index for device in devices}
        collisions: list[CollisionFinding] = []
        for uuid_value, pids in external.items():
            holders = leases_by_uuid.get(uuid_value, [])
            for lease in holders:
                if jobs[lease["job_id"]].get("share_gpu"):
                    continue
                collisions.append(
                    CollisionFinding(
                        gpu_uuid=uuid_value,
                        gpu_index=index_by_uuid[uuid_value],
                        kind="leased-external-process",
                        pids=tuple(sorted(pids)),
                        lease_attempt_id=str(lease["attempt_id"]),
                    )
                )
            if holders:
                continue
            reservation = reservation_by_uuid.get(uuid_value)
            if reservation is not None and pids:
                plan = self.store.get_scale_up_plan(str(reservation["plan_id"]))
                collisions.append(
                    CollisionFinding(
                        gpu_uuid=uuid_value,
                        gpu_index=index_by_uuid[uuid_value],
                        kind="reserved-external-process",
                        pids=tuple(sorted(pids)),
                        reservation_plan_id=str(reservation["plan_id"]),
                        reservation_source_attempt_id=str(plan["source_attempt_id"]),
                    )
                )
        for uuid_value, pids in managed.items():
            holders = leases_by_uuid.get(uuid_value, [])
            pids_by_attempt: dict[str, list[int]] = {}
            for pid in pids:
                pids_by_attempt.setdefault(pid_attempt[pid], []).append(pid)
            for actual_attempt, actual_pids in sorted(pids_by_attempt.items()):
                if any(holder["attempt_id"] == actual_attempt for holder in holders):
                    continue
                if not holders:
                    collisions.append(
                        CollisionFinding(
                            gpu_uuid=uuid_value,
                            gpu_index=index_by_uuid[uuid_value],
                            kind="managed-process-without-lease",
                            pids=tuple(sorted(actual_pids)),
                            process_attempt_id=actual_attempt,
                        )
                    )
                else:
                    for lease in holders:
                        collisions.append(
                            CollisionFinding(
                                gpu_uuid=uuid_value,
                                gpu_index=index_by_uuid[uuid_value],
                                kind="managed-process-wrong-lease",
                                pids=tuple(sorted(actual_pids)),
                                lease_attempt_id=str(lease["attempt_id"]),
                                process_attempt_id=actual_attempt,
                            )
                        )
        collisions.sort(
            key=lambda item: (
                item.gpu_index,
                item.kind,
                item.lease_attempt_id or "",
                item.process_attempt_id or "",
                item.pids,
            )
        )
        return managed, external, collisions

    def _audit_gpu_fences(
        self,
        attempts: Iterable[dict[str, Any]],
        leases: list[dict[str, Any]],
        reservations: list[dict[str, Any]],
        devices: tuple[GpuDevice, ...],
        statuses: dict[str, Any],
    ) -> None:
        """Check actual GPU allocations before isolating a local collision.

        Per-GPU continuation is safe only when every durable assignment can be
        partitioned unambiguously.  A malformed gang, stale UUID/index map, or
        duplicated runtime cgroup remains a controller-wide failure.
        """

        _control_group_owners(statuses)

        by_uuid = {device.uuid: device for device in devices}
        managed = set(self.config.managed_gpu_uuids)
        attempts_by_id = {str(attempt["id"]): attempt for attempt in attempts}
        leases_by_attempt: dict[str, list[dict[str, Any]]] = {}
        for lease in leases:
            attempt_id = str(lease["attempt_id"])
            leases_by_attempt.setdefault(attempt_id, []).append(lease)
            if attempt_id not in attempts_by_id:
                attempts_by_id[attempt_id] = self.store.get_attempt(attempt_id)
            uuid_value = str(lease["gpu_uuid"])
            device = by_uuid.get(uuid_value)
            if uuid_value not in managed or device is None:
                raise GpuFenceAuditError(
                    f"lease for {attempt_id} names unmanaged or missing GPU "
                    f"{uuid_value}"
                )
            if device.index != int(lease["gpu_index"]):
                raise GpuFenceAuditError(
                    f"lease GPU index changed for {uuid_value}: "
                    f"stored {lease['gpu_index']}, current {device.index}"
                )

        plans: dict[str, dict[str, Any]] = {}
        # Several leases are legal only when all but at most one are explicit
        # single-card sharing opt-ins. An ordinary lease remains exclusive
        # against later ordinary starts; sharing never changes its contract.
        for gpu_uuid in {lease["gpu_uuid"] for lease in leases}:
            holders = [lease for lease in leases if lease["gpu_uuid"] == gpu_uuid]
            exclusive_count = 0
            for lease in holders:
                job = self.store.get_job(lease["job_id"])
                if job.get("share_gpu"):
                    if (
                        job["placement"] != "pinned"
                        or job["gpu_count"] != 1
                        or not job.get("vram_mb")
                    ):
                        raise GpuFenceAuditError("invalid shared lease contract")
                else:
                    exclusive_count += 1
            if exclusive_count > 1:
                raise GpuFenceAuditError("multiple ordinary leases on one GPU")
        for reservation in reservations:
            plan_id = str(reservation["plan_id"])
            plan = plans.get(plan_id)
            if plan is None:
                plan = self.store.get_scale_up_plan(plan_id)
                plans[plan_id] = plan
            uuid_value = str(reservation["gpu_uuid"])
            device = by_uuid.get(uuid_value)
            if uuid_value not in managed or device is None:
                raise GpuFenceAuditError(
                    f"scale-up reservation {plan_id} names unmanaged or missing "
                    f"GPU {uuid_value}"
                )
            if device.index != int(reservation["gpu_index"]):
                raise GpuFenceAuditError(
                    f"scale-up reservation GPU index changed for {uuid_value}: "
                    f"stored {reservation['gpu_index']}, current {device.index}"
                )

        active_ids = {str(attempt["id"]) for attempt in attempts}
        for attempt_id, attempt in attempts_by_id.items():
            uuids = attempt.get("gpu_uuids")
            indices = attempt.get("gpu_indices")
            if (
                not isinstance(uuids, list)
                or not isinstance(indices, list)
                or not uuids
                or len(uuids) != len(indices)
                or any(not isinstance(value, str) or not value for value in uuids)
                or any(
                    isinstance(value, bool) or not isinstance(value, int) or value < 0
                    for value in indices
                )
                or len(set(uuids)) != len(uuids)
                or len(set(indices)) != len(indices)
            ):
                raise GpuFenceAuditError(
                    f"attempt {attempt_id} has an invalid GPU assignment"
                )
            expected = set(zip(uuids, indices))
            if any(
                uuid_value not in managed
                or (device := by_uuid.get(uuid_value)) is None
                or device.index != index_value
                for uuid_value, index_value in expected
            ):
                raise GpuFenceAuditError(
                    f"attempt {attempt_id} GPU assignment no longer matches "
                    "the managed UUID/index map"
                )
            attempt_leases = leases_by_attempt.get(attempt_id, [])
            actual = {
                (str(lease["gpu_uuid"]), int(lease["gpu_index"]))
                for lease in attempt_leases
            }
            if expected != actual:
                raise GpuFenceAuditError(
                    f"attempt {attempt_id} has an incomplete or different "
                    "gang lease bundle"
                )

        # Every active attempt must be represented above, even if a corrupt
        # database lost its complete lease bundle.
        missing_active = active_ids - set(leases_by_attempt)
        if missing_active:
            raise GpuFenceAuditError(
                "active attempt(s) have no GPU lease bundle: "
                + ",".join(sorted(missing_active))
            )

    def _update_quarantines(
        self,
        collisions: Iterable[CollisionFinding],
        devices: Iterable[GpuDevice],
    ) -> None:
        grouped: dict[str, list[CollisionFinding]] = {}
        for finding in collisions:
            grouped.setdefault(finding.gpu_uuid, []).append(finding)

        previous = self._quarantines
        updated: dict[str, GpuQuarantine] = {}
        for uuid_value, findings in grouped.items():
            ordered = tuple(findings)
            affected = sorted(
                set().union(*(finding.affected_attempt_ids for finding in ordered))
            )
            updated[uuid_value] = GpuQuarantine(
                gpu_uuid=uuid_value,
                gpu_index=ordered[0].gpu_index,
                findings=ordered,
                affected_attempt_ids=tuple(affected),
                collision_active=True,
                clean_scans=0,
            )

        by_uuid = {device.uuid: device for device in devices}
        required_clean = max(2, int(self.config.idle_confirmations))
        for uuid_value, old in previous.items():
            if uuid_value in updated:
                continue
            holds_busy_start = any(
                finding.kind == "start-target-busy" for finding in old.findings
            )
            device = by_uuid.get(uuid_value)
            if holds_busy_start and (
                device is None
                or bool(device.compute_pids)
                or device.memory_used_mib > self.config.max_idle_memory_mb
            ):
                updated[uuid_value] = GpuQuarantine(
                    gpu_uuid=old.gpu_uuid,
                    gpu_index=old.gpu_index,
                    findings=old.findings,
                    affected_attempt_ids=old.affected_attempt_ids,
                    collision_active=True,
                    clean_scans=0,
                )
                continue
            clean_scans = old.clean_scans + 1
            if clean_scans >= required_clean:
                continue
            updated[uuid_value] = GpuQuarantine(
                gpu_uuid=old.gpu_uuid,
                gpu_index=old.gpu_index,
                findings=old.findings,
                affected_attempt_ids=old.affected_attempt_ids,
                collision_active=False,
                clean_scans=clean_scans,
            )

        self._quarantines = updated
        self._quarantine_affected_attempt_ids = (
            set().union(*(set(item.affected_attempt_ids) for item in updated.values()))
            if updated
            else set()
        )
        for uuid_value in updated:
            self._idle_counts[uuid_value] = 0
        for attempt_id in self._quarantine_affected_attempt_ids:
            self._release_counts[attempt_id] = 0

    def _attempt_is_quarantine_affected(self, attempt: dict[str, Any]) -> bool:
        return str(attempt["id"]) in self._quarantine_affected_attempt_ids or bool(
            set(attempt.get("gpu_uuids", ())).intersection(self._quarantines)
        )

    def _recover_cleanup_ready_external_collisions(
        self,
        attempts: Iterable[dict[str, Any]],
        statuses: dict[str, Any],
        leases: list[dict[str, Any]],
        devices: tuple[GpuDevice, ...],
        managed: dict[str, set[int]],
        external: dict[str, set[int]],
    ) -> list[str]:
        """Retire verified dead units whose stale leases cause a collision.

        A live or unverifiable managed unit must keep every lease while any
        process overlaps its assignment.  A systemd unit that is already in a
        terminal state with no MainPID or remaining cgroup process cannot own
        those GPU processes, however: they are external work and must remain
        protected as such.  Finalizing only that exact, invocation-bound unit
        releases its other stale leases without signalling either workload.
        """

        collided_attempt_ids = {
            lease["attempt_id"] for lease in leases if lease["gpu_uuid"] in external
        }
        attempts_by_id = {attempt["id"]: attempt for attempt in attempts}
        recovered: list[str] = []
        for attempt_id in sorted(collided_attempt_ids):
            attempt = attempts_by_id.get(attempt_id)
            status = statuses.get(attempt_id)
            if attempt is None or status is None or not status.is_cleanup_ready:
                continue
            if any(managed.get(str(uuid_value)) for uuid_value in attempt.get("gpu_uuids", [])):
                continue
            # Query the actual unit and cgroup before releasing its leases.
            fresh_status = self._verified_status(attempt)
            if (
                fresh_status is None
                or not fresh_status.is_cleanup_ready
                or fresh_status.main_pid != 0
            ):
                continue
            if fresh_status.control_group:
                try:
                    remaining = read_cgroup_tree_processes(fresh_status.control_group)
                except RuntimeError:
                    continue
                if remaining:
                    continue

            self._statuses[attempt_id] = fresh_status
            current = self.store.get_attempt(attempt_id)
            if current["state"] not in {
                AttemptState.RUNNING.value,
                AttemptState.SAVE_REQUESTED.value,
                AttemptState.SAVE_WITHDRAWING.value,
                AttemptState.CHECKPOINT_ACKED.value,
                AttemptState.TERM_REQUESTED.value,
                AttemptState.KILL_REQUESTED.value,
                AttemptState.DRAINING.value,
            }:
                continue
            if current["state"] != AttemptState.DRAINING.value:
                self._on_unit_exited(current, fresh_status)
                current = self.store.get_attempt(attempt_id)
            else:
                if current.get("exit_code") is None:
                    self.store.update_attempt(
                        attempt_id,
                        exit_code=fresh_status.exec_main_status,
                        expected_states=[AttemptState.DRAINING],
                    )
                    current = self.store.get_attempt(attempt_id)
                self.store.enqueue_action(
                    job_id=current["job_id"],
                    attempt_id=attempt_id,
                    action_type=ActionType.CLEANUP_UNIT,
                    payload={
                        "unit_name": current["unit_name"],
                        "unit_token": current["unit_token"],
                        "invocation_id": fresh_status.invocation_id,
                    },
                    dedupe_key=(f"cleanup:{attempt_id}:{fresh_status.invocation_id}"),
                    available_at=current["created_at"],
                )

            # The current unit and cgroup are empty. Any observed GPU process is already
            # classified as external and remains unavailable after the leases
            # are released.
            self._finalize_attempt(current)
            recovered.append(attempt_id)
        return recovered

    # --------------------------------------------------------------- progress

    def _progress_path_for_attempt(self, attempt: dict[str, Any]) -> Path | None:
        """Return the exact daemon-created progress path, or fail closed.

        The shared team uid can write its own control files, so this is an
        accidental-misrouting guard rather than a user-authentication claim.
        It prevents one attempt from pointing the scanner at another path.
        """

        attempt_id = str(attempt["id"])
        expected_directory = self.config.control_dir / attempt_id
        if attempt.get("control_dir") != str(expected_directory):
            return None
        try:
            info = expected_directory.lstat()
        except OSError:
            return None
        if (
            not stat.S_ISDIR(info.st_mode)
            or info.st_uid != self.config.allowed_uid
            or info.st_mode & 0o077
        ):
            return None
        return expected_directory / PROGRESS_FILE_NAME

    @staticmethod
    def _progress_percent(snapshot: ProgressSnapshot) -> int | None:
        for completed, total in (
            (snapshot.steps_completed, snapshot.steps_total),
            (snapshot.epochs_completed, snapshot.epochs_total),
        ):
            if completed is not None and total is not None and total > 0:
                return min(100, (completed * 100) // total)
        return None

    @staticmethod
    def _progress_event_phase(snapshot: ProgressSnapshot) -> str:
        # ProgressSnapshot already enforces a short, printable single line.
        return snapshot.phase

    def _record_progress_snapshot(
        self,
        attempt: dict[str, Any],
        snapshot: ProgressSnapshot,
        *,
        observed_at: float,
    ) -> None:
        """Persist one snapshot and its sparse notifications atomically."""

        with self.store.transaction() as tx:
            previous = tx.get_attempt_progress(attempt["id"])
            outcome = tx.accept_attempt_progress(
                snapshot,
                observed_at=observed_at,
            )
            current = outcome["progress"]
            if not outcome["accepted"]:
                return

            if (
                outcome["advanced"]
                and previous is not None
                and previous.get("stalled_at") is not None
                and tx.mark_progress_recovered(
                    attempt["id"],
                    expected_sequence=current["sequence"],
                )
            ):
                stale_seconds = max(
                    0,
                    int(observed_at - float(previous["stalled_at"])),
                )
                tx.append_event(
                    "PROGRESS_RECOVERED",
                    job_id=attempt["job_id"],
                    attempt_id=attempt["id"],
                    payload={
                        "stale_seconds": stale_seconds,
                        "phase": self._progress_event_phase(snapshot),
                    },
                    created_at=observed_at,
                )

            percent = self._progress_percent(snapshot)
            milestone = None if percent is None else (percent // 10) * 10
            if (
                milestone is not None
                and milestone >= 10
                and tx.mark_progress_milestone(
                    attempt["id"],
                    milestone,
                    expected_sequence=current["sequence"],
                )
            ):
                tx.append_event(
                    "PROGRESS_MILESTONE",
                    job_id=attempt["job_id"],
                    attempt_id=attempt["id"],
                    payload={
                        "percent": milestone,
                        "phase": self._progress_event_phase(snapshot),
                    },
                    created_at=observed_at,
                )

            if snapshot.severity in {
                ProgressSeverity.WARNING.value,
                ProgressSeverity.ERROR.value,
            } and tx.mark_progress_problem_notified(
                attempt["id"],
                severity=snapshot.severity,
                expected_sequence=current["sequence"],
                notified_at=observed_at,
                min_interval_seconds=300.0,
            ):
                tx.append_event(
                    "PROGRESS_REPORTED_PROBLEM",
                    job_id=attempt["job_id"],
                    attempt_id=attempt["id"],
                    payload={
                        "severity": snapshot.severity,
                        "phase": self._progress_event_phase(snapshot),
                    },
                    created_at=observed_at,
                )

    def _scan_progress(self, attempts: Iterable[dict[str, Any]]) -> None:
        """Ingest bounded rank-zero snapshots without trusting them as state."""

        current_attempts = {
            str(attempt["id"]): attempt
            for attempt in attempts
        }
        self._progress_errors = {
            attempt_id: message
            for attempt_id, message in self._progress_errors.items()
            if attempt_id in current_attempts
        }
        observed_at = float(self.clock())
        for attempt_id, attempt in current_attempts.items():
            path = self._progress_path_for_attempt(attempt)
            if path is None:
                continue
            try:
                snapshot = load_progress_file(path)
                if snapshot is None:
                    continue
                snapshot = replace(snapshot, job_id=attempt["job_id"], attempt_id=attempt_id)
                self._record_progress_snapshot(
                    attempt,
                    snapshot,
                    observed_at=observed_at,
                )
                self._progress_errors.pop(attempt_id, None)
            except (ProgressProtocolError, StoreConflictError):
                # Keep the last valid durable snapshot.  The watcher receives
                # a fixed diagnostic; arbitrary file contents never reach a
                # terminal or Telegram message.
                self._progress_errors[attempt_id] = "invalid progress snapshot"

        # Stalling is an opt-in warning based on actual counter/phase advance,
        # not merely on a reporter heartbeat.  It never changes lifecycle
        # state or sends a signal to the training process.
        for attempt_id, attempt in current_attempts.items():
            progress = self.store.get_attempt_progress(attempt_id)
            if progress is None or progress.get("stall_timeout_seconds") is None:
                continue
            timeout = float(progress["stall_timeout_seconds"])
            stale_seconds = max(0.0, observed_at - float(progress["advanced_at"]))
            if stale_seconds < timeout or progress.get("stalled_at") is not None:
                continue
            with self.store.transaction() as tx:
                current = tx.get_attempt_progress(attempt_id)
                if (
                    current is None
                    or current.get("stalled_at") is not None
                    or current["sequence"] != progress["sequence"]
                    or observed_at - float(current["advanced_at"]) < timeout
                    or not tx.mark_progress_stalled(
                        attempt_id,
                        expected_sequence=current["sequence"],
                        stalled_at=observed_at,
                    )
                ):
                    continue
                stored_snapshot = current["snapshot"]
                tx.append_event(
                    "PROGRESS_STALLED",
                    job_id=attempt["job_id"],
                    attempt_id=attempt_id,
                    payload={
                        "stale_seconds": int(stale_seconds),
                        "phase": str(stored_snapshot["phase"]),
                    },
                    created_at=observed_at,
                )

    def tick(self) -> None:
        with self._lock:
            try:
                # Progress remains observable even while GPU discovery makes
                # the scheduling half of this tick fail closed.
                attempts = self.store.list_attempts(
                    states=ACTIVE_ATTEMPT_STATES, limit=10_000
                )
                self._scan_progress(attempts)
                self._gpu_samples_available = False
                devices = tuple(self.gpu_provider.snapshot())
                self._gpu_samples_available = True
                for attempt in attempts:
                    observe_gpu_metrics(attempt, devices, self.clock())
                by_uuid = {device.uuid: device for device in devices}
                missing = [
                    item
                    for item in self.config.managed_gpu_uuids
                    if item not in by_uuid
                ]
                if missing:
                    raise NvidiaSmiError(
                        "managed GPU UUIDs are missing: " + ", ".join(missing)
                    )
                attempts = self.store.list_attempts(
                    states=ACTIVE_ATTEMPT_STATES, limit=10_000
                )
                leases = self.store.list_leases()
                reservations = self.store.list_scale_up_reservations()
                statuses, status_problems = self._collect_statuses(attempts)
                self._snapshot = devices
                self._statuses = statuses
                self._process_owners.clear()
                if status_problems:
                    self._invalidate_observation_history()
                    self._set_health("degraded", "; ".join(status_problems))
                    return
                self._audit_gpu_fences(
                    attempts, leases, reservations, devices, statuses
                )
                managed, external, collisions = self._classify_processes(
                    devices, statuses, leases, reservations,
                    process_owners=self._process_owners,
                )
                if collisions:
                    recovered = self._recover_cleanup_ready_external_collisions(
                        attempts, statuses, leases, devices, managed, external
                    )
                    if recovered:
                        attempts = self.store.list_attempts(
                            states=ACTIVE_ATTEMPT_STATES, limit=10_000
                        )
                        leases = self.store.list_leases()
                        reservations = self.store.list_scale_up_reservations()
                        self._audit_gpu_fences(
                            attempts, leases, reservations, devices, statuses
                        )
                        managed, external, collisions = self._classify_processes(
                            devices, statuses, leases, reservations,
                            process_owners=self._process_owners,
                        )
                self._external = external
                self._update_quarantines(collisions, devices)
                self._update_idle_counts(by_uuid, leases)
                self._recovery_scans += 1
                if self._recovery_scans < 2:
                    self._set_health("recovering")
                    return
                self._set_health("ok")
                self._repair_incomplete_plans()
                self._reconcile_attempts()
                self._reconcile_scale_up_plans()
                self._process_actions()
                self._dependency_waiting = self._reconcile_dependencies()
                if not self._observe_only and self._health == "ok":
                    self._schedule_scale_up_restarts()
                    self._schedule()
                    self._schedule_shared()
                    self._schedule_scale_ups()
            except Exception as exc:
                LOGGER.exception("scheduler tick failed")
                self._invalidate_observation_history()
                self._set_health("degraded", f"{type(exc).__name__}: {exc}")

    def _update_idle_counts(
        self, by_uuid: dict[str, GpuDevice], leases: list[dict[str, Any]]
    ) -> None:
        leased = {item["gpu_uuid"] for item in leases}
        for uuid_value in self.config.managed_gpu_uuids:
            device = by_uuid[uuid_value]
            idle = (
                uuid_value not in leased
                and uuid_value not in self._quarantines
                and not device.compute_pids
                and device.memory_used_mib <= self.config.max_idle_memory_mb
            )
            self._idle_counts[uuid_value] = (
                self._idle_counts.get(uuid_value, 0) + 1 if idle else 0
            )

    # ------------------------------------------------------------- start plan

    def _job_environment(
        self,
        job: dict[str, Any],
        attempt: dict[str, Any],
    ) -> dict[str, str]:
        account = pwd.getpwuid(self.config.allowed_uid)
        environment = {
            "HOME": account.pw_dir,
            "USER": account.pw_name,
            "LOGNAME": account.pw_name,
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            **dict(job["env"]),
        }
        indices = ",".join(str(item) for item in attempt["gpu_indices"])
        uuids = ",".join(attempt["gpu_uuids"])
        actual_gpu_count = len(attempt["gpu_uuids"])
        maximum_gpu_count = int(job["gpu_count"])
        minimum_gpu_count = self._minimum_gpu_count(job)
        allowed_gpu_counts = self._allowed_gpu_counts(job)
        # The immediately preceding attempt is the only meaningful previous
        # world size.  It is useful even without a resumable checkpoint:
        # training launchers can make an explicit policy decision instead of
        # silently assuming that every attempt has the same rank count.
        previous = None
        resume_from_attempt_id = attempt.get("resume_from_attempt_id")
        if resume_from_attempt_id:
            candidate = self.store.get_attempt(str(resume_from_attempt_id))
            previous = candidate
        else:
            previous = next(
                (
                    item
                    for item in self.store.list_attempts(job_id=job["id"], limit=2)
                    if item["id"] != attempt["id"]
                ),
                None,
            )
        previous_gpu_count = (
            len(previous["gpu_uuids"])
            if previous is not None and previous.get("started_at") is not None
            else 0
        )
        environment.update(
            {
                "CUDA_VISIBLE_DEVICES": indices,
                "NVIDIA_VISIBLE_DEVICES": uuids,
                "GPUQ_JOB_ID": job["id"],
                "GPUQ_ATTEMPT_ID": attempt["id"],
                "GPUQ_CONTROL_DIR": attempt["control_dir"],
                "GPUQ_ASSIGNED_GPU_UUIDS": uuids,
                "GPUQ_ASSIGNED_GPU_INDICES": indices,
                "GPUQ_ASSIGNED_GPU_COUNT": str(actual_gpu_count),
                "GPUQ_ACTUAL_GPU_COUNT": str(actual_gpu_count),
                "GPUQ_MIN_GPU_COUNT": str(minimum_gpu_count),
                "GPUQ_MAX_GPU_COUNT": str(maximum_gpu_count),
                "GPUQ_PREVIOUS_GPU_COUNT": str(previous_gpu_count),
                "GPUQ_WORLD_SIZE": str(actual_gpu_count),
                "GPUQ_MIN_WORLD_SIZE": str(minimum_gpu_count),
                "GPUQ_MAX_WORLD_SIZE": str(maximum_gpu_count),
                "GPUQ_PREVIOUS_WORLD_SIZE": str(previous_gpu_count),
            }
        )
        target_global_batch_size = job.get("target_global_batch_size")
        per_device_micro_batch_size = job.get("per_device_micro_batch_size")
        if (
            target_global_batch_size is not None
            and per_device_micro_batch_size is not None
        ):
            environment.update(
                {
                    "GPUQ_TARGET_GLOBAL_BATCH_SIZE": str(target_global_batch_size),
                    "GPUQ_PER_DEVICE_MICRO_BATCH_SIZE": str(
                        per_device_micro_batch_size
                    ),
                    "GPUQ_ALLOWED_GPU_COUNTS": ",".join(
                        str(item) for item in allowed_gpu_counts
                    ),
                }
            )
        # A start plan pins its exact resume source.  This survives a failed
        # pre-launch replan without falling back across an intervening attempt
        # or silently restarting from scratch.
        resume_checkpoint = attempt.get("launch_resume_checkpoint_path")
        if resume_checkpoint:
            environment["GPUQ_RESUME_CHECKPOINT"] = str(resume_checkpoint)
        archive = str(self.config.archive_path)
        existing_python_path = environment.get("PYTHONPATH")
        environment["PYTHONPATH"] = (
            archive
            if not existing_python_path
            else f"{archive}{os.pathsep}{existing_python_path}"
        )
        environment.update(runtime_environment(self.config.archive_path, attempt, job))
        return environment

    def _start_payload(
        self, job: dict[str, Any], attempt: dict[str, Any]
    ) -> dict[str, Any]:
        return {
            "unit_name": attempt["unit_name"],
            "unit_token": attempt["unit_token"],
            "argv": job["argv"],
            "cwd": job["cwd"],
            "env": self._job_environment(job, attempt),
            "log_path": attempt["log_path"],
            "gpu_uuids": attempt["gpu_uuids"],
            "gpu_indices": attempt["gpu_indices"],
        }

    def _create_attempt_paths(self, job_id: str, attempt_id: str) -> tuple[Path, Path]:
        control_path = self.config.control_dir / attempt_id
        log_path = self.config.log_dir / f"{job_id}-{attempt_id}.log"
        control_path.mkdir(mode=0o700)
        secure_create_empty(log_path, 0o600)
        return control_path, log_path

    def _resume_source_for_new_attempt(
        self, job_id: str
    ) -> tuple[str | None, str | None]:
        """Return the one safe checkpoint lineage a new plan may inherit."""

        attempts = self.store.list_attempts(job_id=job_id, limit=1)
        if not attempts:
            return None, None
        latest = attempts[0]
        checkpoint_path = latest.get("checkpoint_path")
        if checkpoint_path:
            return str(checkpoint_path), str(latest["id"])
        if latest.get("started_at") is None and latest.get(
            "launch_resume_checkpoint_path"
        ):
            return (
                str(latest["launch_resume_checkpoint_path"]),
                str(latest["resume_from_attempt_id"]),
            )
        return None, None

    def _pending_scale_fallback_plan(
        self,
        job: dict[str, Any],
    ) -> dict[str, Any] | None:
        """Return an unconsumed terminal scale plan requiring a safe fallback.

        A failed or withdrawn expansion must first resume at its original
        world size.  Otherwise generic elastic placement could immediately
        reacquire the just-released extra GPUs and bypass queue priority.  The
        terminal plan's successor identity durably records consumption across
        daemon restarts.  An unstarted failed fallback remains unconsumed and
        is retried at the same bounded size.
        """

        plans = self.store.list_scale_up_plans(job_id=job["id"], limit=1)
        if not plans:
            return None
        plan = plans[0]
        if plan["state"] not in {
            ScaleUpState.FAILED.value,
            ScaleUpState.WITHDRAWN.value,
        } or not plan.get("checkpoint_path"):
            return None
        successor_id = plan.get("successor_attempt_id")
        if not successor_id:
            return plan
        successor = self.store.get_attempt(str(successor_id))
        if (
            len(successor["gpu_uuids"]) == int(plan["from_gpu_count"])
            and successor.get("started_at") is not None
        ):
            return None
        return plan

    def _plan_start(
        self,
        job: dict[str, Any],
        devices: list[GpuDevice],
        *,
        scale_fallback_plan: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        attempt_id = "A" + uuid.uuid4().hex
        unit_name = f"gpuq-{attempt_id.lower()}"
        unit_token = f"attempt:{attempt_id}"
        control_path, log_path = self._create_attempt_paths(job["id"], attempt_id)
        uuids = [device.uuid for device in devices]
        indices = [device.index for device in devices]
        resume_checkpoint: str | None
        resume_from_attempt_id: str | None
        if scale_fallback_plan is not None:
            if len(devices) != int(scale_fallback_plan["from_gpu_count"]):
                raise RuntimeError("scale-up fallback must use its original GPU count")
            checkpoint_path = scale_fallback_plan.get("checkpoint_path")
            if not checkpoint_path:
                raise RuntimeError("scale-up fallback has no durable checkpoint")
            # The terminal plan is the durable lineage authority.  A prior
            # expanded successor may have reached RUNNING and then become LOST
            # before the coordinator committed plan completion; generic latest
            # attempt inference would select that started, checkpoint-less
            # successor and permanently strand the retry.
            resume_checkpoint = str(checkpoint_path)
            resume_from_attempt_id = str(scale_fallback_plan["source_attempt_id"])
        else:
            resume_checkpoint, resume_from_attempt_id = (
                self._resume_source_for_new_attempt(job["id"])
            )
        fulfilled_promises = [
            item
            for item in self.store.list_attempts(limit=10_000)
            if item.get("preempt_requested_by_job_id") == job["id"]
            and item["state"] not in ACTIVE_ATTEMPT_STATES
        ]
        with self.store.transaction() as tx:
            for promised in fulfilled_promises:
                tx.update_attempt(
                    promised["id"],
                    expected_states=[promised["state"]],
                    preempt_requested_by_job_id=None,
                )
            attempt = tx.create_attempt(
                job["id"],
                attempt_id=attempt_id,
                state=AttemptState.PLANNED,
                gpu_uuids=uuids,
                gpu_indices=indices,
                unit_name=unit_name,
                unit_token=unit_token,
                boot_id=self.boot_id,
                control_dir=str(control_path),
                log_path=str(log_path),
                launch_resume_checkpoint_path=resume_checkpoint,
                resume_from_attempt_id=resume_from_attempt_id,
            )
            if scale_fallback_plan is not None:
                tx.update_scale_up_plan(
                    scale_fallback_plan["id"],
                    successor_attempt_id=attempt["id"],
                    expected_states=[scale_fallback_plan["state"]],
                    expected_version=scale_fallback_plan["version"],
                )
            tx.acquire_leases(
                job["id"],
                attempt_id,
                dict(zip(uuids, indices)),
                lease_token=attempt_id,
                memory_capacity_mb=(
                    devices[0].memory_total_mib - self.config.max_idle_memory_mb
                    if job.get("share_gpu")
                    else None
                ),
            )
            tx.update_job(
                job["id"],
                state=JobState.STARTING,
                state_reason="resources reserved",
                expected_states=[JobState.PENDING],
            )
            tx.enqueue_action(
                job_id=job["id"],
                attempt_id=attempt_id,
                action_type=ActionType.START_UNIT,
                payload=self._start_payload(job, attempt),
                dedupe_key=f"start:{attempt_id}",
                available_at=attempt["created_at"],
            )
            tx.append_event(
                "START_PLANNED",
                job_id=job["id"],
                attempt_id=attempt_id,
                payload={
                    "gpu_uuids": uuids,
                    "gpu_indices": indices,
                    "assigned_gpu_count": len(uuids),
                    "min_gpu_count": self._minimum_gpu_count(job),
                    "max_gpu_count": int(job["gpu_count"]),
                    "elastic_gpu_count": bool(job.get("elastic_gpu_count", False)),
                    "target_global_batch_size": job.get("target_global_batch_size"),
                    "per_device_micro_batch_size": job.get(
                        "per_device_micro_batch_size"
                    ),
                    "allowed_gpu_counts": list(self._allowed_gpu_counts(job)),
                    "scale_fallback_plan_id": (
                        scale_fallback_plan["id"]
                        if scale_fallback_plan is not None
                        else None
                    ),
                },
            )
        return attempt

    def _repair_incomplete_plans(self) -> None:
        attempts = self.store.list_attempts(
            states=[AttemptState.PLANNED, AttemptState.STARTING], limit=10_000
        )
        for attempt in attempts:
            job = self.store.get_job(attempt["job_id"])
            start_dedupe_key = f"start:{attempt['id']}"
            existing_start = next(
                (
                    action
                    for action in self.store.list_actions(
                        attempt_id=attempt["id"],
                        limit=100,
                    )
                    if action["dedupe_key"] == start_dedupe_key
                ),
                None,
            )
            if (
                existing_start is not None
                and existing_start["action_type"] != ActionType.START_UNIT.value
            ):
                raise RuntimeError(
                    "start action dedupe key belongs to a different action"
                )
            if job["state"] == JobState.CANCELED.value:
                # A previous daemon may have crashed after systemd created the
                # unit but before InvocationID was committed.  Keep the lease
                # and recover the START action so it can probe the exact token;
                # it will never launch a canceled job.
                if existing_start is None:
                    self.store.enqueue_action(
                        job_id=job["id"],
                        attempt_id=attempt["id"],
                        action_type=ActionType.START_UNIT,
                        payload=self._start_payload(job, attempt),
                        dedupe_key=start_dedupe_key,
                        available_at=attempt["created_at"],
                    )
                continue
            if not attempt["gpu_uuids"] or not attempt["unit_name"]:
                self._abort_unstarted_attempt(attempt, "incomplete start identity")
                continue
            assignments = dict(zip(attempt["gpu_uuids"], attempt["gpu_indices"]))
            try:
                with self.store.transaction() as tx:
                    tx.acquire_leases(
                        job["id"],
                        attempt["id"],
                        assignments,
                        lease_token=attempt["id"],
                        memory_capacity_mb=(
                            next(
                                d.memory_total_mib
                                for d in self._snapshot
                                if d.uuid == attempt["gpu_uuids"][0]
                            )
                            - self.config.max_idle_memory_mb
                            if job.get("share_gpu")
                            else None
                        ),
                    )
                    tx.update_job(
                        job["id"],
                        state=JobState.STARTING,
                        state_reason="recovering start plan",
                        expected_states=[
                            JobState.PENDING,
                            JobState.STARTING,
                        ],
                    )
                    if existing_start is None:
                        tx.enqueue_action(
                            job_id=job["id"],
                            attempt_id=attempt["id"],
                            action_type=ActionType.START_UNIT,
                            payload=self._start_payload(job, attempt),
                            dedupe_key=start_dedupe_key,
                            available_at=attempt["created_at"],
                        )
            except StoreConflictError as exc:
                self._abort_unstarted_attempt(
                    attempt, f"start recovery conflict: {exc}"
                )

    def _abort_unstarted_attempt(self, attempt: dict[str, Any], reason: str) -> None:
        job = self.store.get_job(attempt["job_id"])
        scale_plan = self.store.get_active_scale_up_plan(job["id"])
        with self.store.transaction() as tx:
            for action in tx.list_actions(
                states=[ActionState.PENDING],
                attempt_id=attempt["id"],
                limit=100,
            ):
                if not action.get("claim_token"):
                    tx.fail_action(action["id"], reason)
            tx.transition_attempt(
                attempt["id"],
                AttemptState.LOST,
                from_states=[
                    AttemptState.PLANNED,
                    AttemptState.STARTING,
                ],
                failure_reason=reason,
            )
            tx.release_leases(attempt_id=attempt["id"], reason="unstarted attempt aborted")
            if (
                scale_plan is not None
                and scale_plan["state"] == ScaleUpState.RESTART_PLANNED.value
                and scale_plan.get("successor_attempt_id") == attempt["id"]
            ):
                failed = tx.transition_scale_up_plan(
                    scale_plan["id"],
                    ScaleUpState.FAILED,
                    from_states=[ScaleUpState.RESTART_PLANNED],
                    expected_version=scale_plan["version"],
                )
                tx.append_event(
                    "SCALE_UP_FAILED",
                    job_id=job["id"],
                    attempt_id=attempt["id"],
                    payload={
                        **self._scale_plan_event_payload(failed),
                        "reason": reason,
                    },
                )
            if job["state"] != JobState.CANCELED.value:
                tx.update_job(
                    job["id"],
                    state=JobState.PENDING,
                    state_reason=reason,
                    expected_states=[
                        JobState.STARTING,
                        JobState.PENDING,
                    ],
                )
            tx.append_event(
                "START_ABORTED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload={"reason": reason},
            )

    def _cancel_unstarted_attempt(
        self,
        attempt: dict[str, Any],
        reason: str,
        *,
        exclude_action_id: str | None = None,
    ) -> None:
        current = self.store.get_attempt(attempt["id"])
        if current["state"] not in {
            AttemptState.PLANNED.value,
            AttemptState.STARTING.value,
        }:
            return
        with self.store.transaction() as tx:
            for pending in tx.list_actions(
                states=[ActionState.PENDING],
                attempt_id=current["id"],
                limit=100,
            ):
                if pending["id"] != exclude_action_id and not pending.get(
                    "claim_token"
                ):
                    tx.fail_action(pending["id"], reason)
            tx.update_attempt(
                current["id"],
                state=AttemptState.CANCELED,
                expected_states=[
                    AttemptState.PLANNED,
                    AttemptState.STARTING,
                ],
            )
            tx.release_leases(attempt_id=current["id"], reason="unstarted attempt canceled")
            tx.append_event(
                "START_CANCELED",
                job_id=current["job_id"],
                attempt_id=current["id"],
                payload={"reason": reason},
            )

    # ------------------------------------------------------------- preemption

    @staticmethod
    def _is_scale_request(attempt: dict[str, Any]) -> bool:
        return str(attempt.get("preempt_nonce") or "").startswith(
            "scale-"
        ) and attempt.get("preempt_requested_by_job_id") == attempt.get("job_id")

    def _scale_plan_for_attempt(self, attempt: dict[str, Any]) -> dict[str, Any] | None:
        """Return the exact durable plan named by a self scale request."""

        if not self._is_scale_request(attempt):
            return None
        matches = [
            plan
            for plan in self.store.list_scale_up_plans(
                source_attempt_id=str(attempt["id"]),
                limit=100,
            )
            if plan["nonce"] == attempt.get("preempt_nonce")
            and plan["job_id"] == attempt["job_id"]
        ]
        if len(matches) != 1:
            raise RuntimeError(
                f"{attempt['id']}: scale request has no unique durable plan"
            )
        return matches[0]

    @staticmethod
    def _scale_plan_event_payload(plan: dict[str, Any]) -> dict[str, Any]:
        return {
            "scale_up_plan_id": plan["id"],
            "source_attempt_id": plan["source_attempt_id"],
            "successor_attempt_id": plan.get("successor_attempt_id"),
            "from_gpu_count": plan["from_gpu_count"],
            "target_gpu_count": plan["target_gpu_count"],
            "target_gpu_indices": list(plan["target_gpu_indices"]),
        }

    @staticmethod
    def _scale_plan_status(plan: dict[str, Any] | None) -> dict[str, Any] | None:
        if plan is None:
            return None
        return {
            "id": plan["id"],
            "state": plan["state"],
            "source_attempt_id": plan["source_attempt_id"],
            "successor_attempt_id": plan.get("successor_attempt_id"),
            "from_gpu_count": plan["from_gpu_count"],
            "target_gpu_count": plan["target_gpu_count"],
            "target_gpu_indices": list(plan["target_gpu_indices"]),
            "created_at": plan["created_at"],
            "updated_at": plan["updated_at"],
            "finished_at": plan.get("finished_at"),
        }

    def _scale_target_is_stable(
        self,
        plan: dict[str, Any],
        *,
        extras_only: bool,
    ) -> bool:
        """Prove that a plan's reserved target is still physically idle."""

        source = self.store.get_attempt(str(plan["source_attempt_id"]))
        source_uuids = set(source["gpu_uuids"])
        reservations = self.store.list_scale_up_reservations(plan_id=plan["id"])
        reserved = {(item["gpu_uuid"], int(item["gpu_index"])) for item in reservations}
        expected = set(zip(plan["target_gpu_uuids"], plan["target_gpu_indices"]))
        if extras_only:
            expected = {
                assignment
                for assignment in expected
                if assignment[0] not in source_uuids
            }
        if reserved != expected:
            return False
        by_uuid = {device.uuid: device for device in self._snapshot}
        for gpu_uuid, gpu_index in expected:
            device = by_uuid.get(str(gpu_uuid))
            if (
                device is None
                or str(gpu_uuid) in self._quarantines
                or device.index != int(gpu_index)
                or device.compute_pids
                or self._external.get(str(gpu_uuid))
                or device.memory_used_mib > self.config.max_idle_memory_mb
                or self._idle_counts.get(str(gpu_uuid), 0)
                < self.config.idle_confirmations
            ):
                return False
        return True

    def _scale_target_hard_conflict(
        self,
        plan: dict[str, Any],
    ) -> str | None:
        """Return a non-transient target conflict that requires safe fallback."""

        reservations = self.store.list_scale_up_reservations(plan_id=plan["id"])
        reserved = {(item["gpu_uuid"], int(item["gpu_index"])) for item in reservations}
        expected = set(zip(plan["target_gpu_uuids"], plan["target_gpu_indices"]))
        if reserved != expected:
            return "scale-up target reservation set is incomplete or inconsistent"
        by_uuid = {device.uuid: device for device in self._snapshot}
        for gpu_uuid, gpu_index in expected:
            device = by_uuid.get(str(gpu_uuid))
            if device is None:
                return f"scale-up target GPU disappeared: {gpu_uuid}"
            if device.index != int(gpu_index):
                return f"scale-up target GPU index changed: {gpu_uuid}"
            quarantine = self._quarantines.get(str(gpu_uuid))
            if quarantine is not None and quarantine.collision_active:
                return f"scale-up target GPU is quarantined: {gpu_uuid}"
            if device.compute_pids or self._external.get(str(gpu_uuid)):
                return f"scale-up target GPU became externally occupied: {gpu_uuid}"
        return None

    def _scale_request_is_still_needed(self, attempt: dict[str, Any]) -> bool:
        plan = self._scale_plan_for_attempt(attempt)
        if plan is None or plan["state"] != ScaleUpState.SAVE_REQUESTED.value:
            return False
        if self._attempt_is_quarantine_affected(attempt) or set(
            plan["target_gpu_uuids"]
        ).intersection(self._quarantines):
            return False
        job = self.store.get_job(str(attempt["job_id"]))
        if job["state"] != JobState.PREEMPTING.value or attempt["state"] not in {
            AttemptState.SAVE_REQUESTED.value,
            AttemptState.SAVE_WITHDRAWING.value,
        }:
            return False
        # A queued job always gets first claim on newly idle capacity.  Once
        # the scale checkpoint is acknowledged, recovery is handled by the
        # durable plan rather than by this pre-ACK withdrawal predicate.
        if self._ready_pending_jobs():
            return False
        return self._scale_target_is_stable(plan, extras_only=True)

    def _withdraw_scale_request(
        self,
        attempt: dict[str, Any],
        reason: str,
    ) -> None:
        current = self.store.get_attempt(str(attempt["id"]))
        plan = self._scale_plan_for_attempt(current)
        if plan is None:
            raise RuntimeError("scale withdrawal has no durable plan")
        if plan["state"] not in {
            ScaleUpState.SAVE_REQUESTED.value,
            ScaleUpState.WITHDRAWN.value,
        }:
            raise StoreConflictError(
                "scale withdrawal cannot finish from plan state " f"{plan['state']}"
            )
        with self.store.transaction() as tx:
            tx.update_attempt(
                current["id"],
                state=AttemptState.RUNNING,
                expected_states=[
                    AttemptState.SAVE_REQUESTED,
                    AttemptState.SAVE_WITHDRAWING,
                ],
                preempt_nonce=None,
                preempt_requested_by_job_id=None,
                preempt_requested_at=None,
                preempt_deadline_at=None,
                checkpoint_deadline_at=None,
                term_deadline_at=None,
                kill_deadline_at=None,
                failure_reason=None,
            )
            tx.update_job(
                current["job_id"],
                state=JobState.RUNNING,
                state_reason=reason,
                expected_states=[JobState.PREEMPTING],
            )
            if plan["state"] == ScaleUpState.SAVE_REQUESTED.value:
                withdrawn = tx.transition_scale_up_plan(
                    plan["id"],
                    ScaleUpState.WITHDRAWN,
                    from_states=[ScaleUpState.SAVE_REQUESTED],
                    expected_version=plan["version"],
                )
                tx.append_event(
                    "SCALE_UP_WITHDRAWN",
                    job_id=current["job_id"],
                    attempt_id=current["id"],
                    payload={
                        **self._scale_plan_event_payload(withdrawn),
                        "reason": reason,
                    },
                )

    def _begin_scale_withdrawal(
        self,
        attempt: dict[str, Any],
        reason: str,
    ) -> dict[str, Any]:
        """Release opportunistic reservations before protocol-lock cleanup.

        An adapter may hold ``checkpoint.lock`` for an arbitrarily long epoch
        save.  Queue capacity cannot remain fenced for that duration.  The
        durable withdrawal therefore commits first while retaining the old
        nonce on a ``SAVE_WITHDRAWING`` attempt.  A later ACK or daemon restart
        can still identify and safely converge that in-flight protocol.
        """

        current = self.store.get_attempt(str(attempt["id"]))
        plan = self._scale_plan_for_attempt(current)
        if plan is None:
            raise RuntimeError("scale withdrawal has no durable plan")
        if current["state"] not in {
            AttemptState.SAVE_REQUESTED.value,
            AttemptState.SAVE_WITHDRAWING.value,
        }:
            return current
        if plan["state"] == ScaleUpState.WITHDRAWN.value:
            if current["state"] == AttemptState.SAVE_REQUESTED.value:
                self.store.update_attempt(
                    current["id"],
                    state=AttemptState.SAVE_WITHDRAWING,
                    failure_reason=reason,
                    expected_states=[AttemptState.SAVE_REQUESTED],
                    expected_version=current["version"],
                )
            return self.store.get_attempt(current["id"])
        if plan["state"] != ScaleUpState.SAVE_REQUESTED.value:
            raise StoreConflictError(
                "scale withdrawal cannot begin from plan state " f"{plan['state']}"
            )
        with self.store.transaction() as tx:
            if current["state"] == AttemptState.SAVE_REQUESTED.value:
                tx.update_attempt(
                    current["id"],
                    state=AttemptState.SAVE_WITHDRAWING,
                    failure_reason=reason,
                    expected_states=[AttemptState.SAVE_REQUESTED],
                    expected_version=current["version"],
                )
            withdrawn = tx.transition_scale_up_plan(
                plan["id"],
                ScaleUpState.WITHDRAWN,
                from_states=[ScaleUpState.SAVE_REQUESTED],
                expected_version=plan["version"],
            )
            tx.append_event(
                "SCALE_UP_WITHDRAWN",
                job_id=current["job_id"],
                attempt_id=current["id"],
                payload={
                    **self._scale_plan_event_payload(withdrawn),
                    "reason": reason,
                },
            )
        return self.store.get_attempt(current["id"])

    def _fail_scale_plan(
        self,
        plan: dict[str, Any],
        reason: str,
        *,
        expected_states: Iterable[str | ScaleUpState] | None = None,
    ) -> dict[str, Any]:
        current = self.store.get_scale_up_plan(str(plan["id"]))
        if current["state"] not in ACTIVE_SCALE_UP_STATES:
            return current
        with self.store.transaction() as tx:
            failed = tx.transition_scale_up_plan(
                current["id"],
                ScaleUpState.FAILED,
                from_states=(
                    expected_states
                    if expected_states is not None
                    else [current["state"]]
                ),
                expected_version=current["version"],
            )
            tx.append_event(
                "SCALE_UP_FAILED",
                job_id=current["job_id"],
                attempt_id=current["source_attempt_id"],
                payload={
                    **self._scale_plan_event_payload(failed),
                    "reason": reason,
                },
            )
        return failed

    def _plan_preemption(
        self,
        requester: dict[str, Any],
        victims: Iterable[VictimCandidate],
    ) -> None:
        now = self.clock()
        plans: list[dict[str, Any]] = []
        takeover_states = {
            AttemptState.SAVE_REQUESTED.value,
            AttemptState.SAVE_WITHDRAWING.value,
            AttemptState.CHECKPOINT_ACKED.value,
        }
        for candidate in victims:
            attempt = self.store.get_attempt(candidate.attempt_id)
            victim_job = self.store.get_job(candidate.job_id)
            if not victim_in_scope(requester,victim_job):
                raise StoreConflictError("requester may only interrupt explicit idle / opt-in yielding jobs in its scope")
            actual_mode = preemption_mode(requester["dispatch_mode"], candidate)
            if actual_mode is None:
                raise StoreConflictError("victim does not allow this preemption")
            previous_requester: dict[str, Any] | None = None
            scale_plan: dict[str, Any] | None = None
            is_takeover = attempt["state"] in takeover_states
            is_scale_takeover = is_takeover and self._is_scale_request(attempt)
            if is_takeover:
                if actual_mode != DispatchMode.PREEMPT_NOW.value:
                    raise StoreConflictError(
                        "only hard preemption can take over a checkpoint request"
                    )
                if is_scale_takeover:
                    scale_plan = self._scale_plan_for_attempt(attempt)
                    expected_plan_state = (
                        ScaleUpState.CHECKPOINT_ACKED.value
                        if attempt["state"] == AttemptState.CHECKPOINT_ACKED.value
                        else ScaleUpState.SAVE_REQUESTED.value
                    )
                    if scale_plan is None or scale_plan["state"] not in {
                        expected_plan_state,
                        ScaleUpState.WITHDRAWN.value,
                    }:
                        raise StoreConflictError(
                            "scale checkpoint request has no matching active plan"
                        )
                    if victim_job["priority"] >= requester["priority"]:
                        raise StoreConflictError(
                            "scale-up takeover requires a strictly higher priority"
                        )
                elif not str(attempt.get("preempt_nonce") or "").startswith("save-"):
                    raise StoreConflictError(
                        "checkpoint takeover requires a save request"
                    )
                else:
                    previous_requester_id = attempt.get("preempt_requested_by_job_id")
                    if not previous_requester_id:
                        raise StoreConflictError(
                            "save preemption has no requester to take over"
                        )
                    previous_requester = self.store.get_job(previous_requester_id)
                    if previous_requester["priority"] >= requester["priority"]:
                        raise StoreConflictError(
                            "preemption takeover requires a strictly higher priority"
                        )
            elif attempt["state"] != AttemptState.RUNNING.value:
                raise StoreConflictError("preemption candidate is no longer running")

            if actual_mode == DispatchMode.PREEMPT_SAVE.value:
                nonce = "save-" + secrets.token_hex(16)
                action_type = ActionType.REQUEST_SAVE
                new_state = AttemptState.SAVE_REQUESTED
                payload = {
                    "version": SCHEMA_VERSION,
                    "nonce": nonce,
                    "attempt_id": attempt["id"],
                    "requested_by_job_id": requester["id"],
                    "created_at": now,
                    "expires_at": now + self.config.preempt_ack_timeout_seconds,
                }
                dedupe = f"save:{attempt['id']}:{nonce}"
            else:
                nonce = (
                    "now-takeover-" if is_takeover else "now-"
                ) + secrets.token_hex(16)
                action_type = ActionType.TERM_UNIT
                new_state = AttemptState.TERM_REQUESTED
                payload = {
                    "unit_name": attempt["unit_name"],
                    "unit_token": attempt["unit_token"],
                    "invocation_id": attempt["invocation_id"],
                }
                dedupe = f"term:{attempt['id']}:{nonce}"
            plans.append(
                {
                    "attempt": attempt,
                    "victim_job": victim_job,
                    "mode": actual_mode,
                    "previous_requester": previous_requester,
                    "nonce": nonce,
                    "action_type": action_type,
                    "new_state": new_state,
                    "payload": payload,
                    "dedupe": dedupe,
                    "is_takeover": is_takeover,
                    "is_scale_takeover": is_scale_takeover,
                    "scale_plan": scale_plan,
                }
            )

        # Gang preemption is one durable decision: either every selected victim
        # (including save-request upgrades) and every action is committed, or
        # none is.
        with self.store.transaction() as tx:
            for plan in plans:
                attempt = plan["attempt"]
                victim_job = plan["victim_job"]
                nonce = plan["nonce"]
                action_type = plan["action_type"]
                new_state = plan["new_state"]
                if plan["is_scale_takeover"]:
                    scale_plan = plan["scale_plan"]
                    assert scale_plan is not None
                    if scale_plan["state"] != ScaleUpState.WITHDRAWN.value:
                        withdrawn_plan = tx.transition_scale_up_plan(
                            scale_plan["id"],
                            ScaleUpState.WITHDRAWN,
                            from_states=[scale_plan["state"]],
                            expected_version=scale_plan["version"],
                        )
                        tx.append_event(
                            "SCALE_UP_WITHDRAWN",
                            job_id=victim_job["id"],
                            attempt_id=attempt["id"],
                            payload={
                                **self._scale_plan_event_payload(withdrawn_plan),
                                "reason": (
                                    "automatic scale-up taken over by "
                                    f"{requester['id']} preempt-now"
                                ),
                            },
                        )
                tx.update_attempt(
                    attempt["id"],
                    state=new_state,
                    expected_states=[attempt["state"]],
                    expected_version=attempt["version"],
                    preempt_nonce=nonce,
                    preempt_requested_by_job_id=requester["id"],
                    preempt_requested_at=now,
                    preempt_deadline_at=(
                        now + self.config.preempt_ack_timeout_seconds
                        if new_state is AttemptState.SAVE_REQUESTED
                        else None
                    ),
                    checkpoint_deadline_at=None,
                    # TERM grace begins only after the outbox action actually
                    # reaches systemd.  Large gang actions are delivered over
                    # multiple ticks and must not time out while still queued.
                    term_deadline_at=None,
                    kill_deadline_at=None,
                    failure_reason=None,
                )
                tx.update_job(
                    victim_job["id"],
                    state=JobState.PREEMPTING,
                    state_reason=(
                        f"{requester['id']} "
                        + ("took over with " if plan["is_takeover"] else "requested ")
                        + plan["mode"]
                    ),
                    expected_states=[
                        JobState.PREEMPTING if plan["is_takeover"] else JobState.RUNNING
                    ],
                )
                tx.enqueue_action(
                    job_id=victim_job["id"],
                    attempt_id=attempt["id"],
                    action_type=action_type,
                    payload=plan["payload"],
                    dedupe_key=plan["dedupe"],
                    available_at=now,
                )
                if not plan["is_takeover"]:
                    tx.append_event(
                        "PREEMPT_REQUESTED",
                        job_id=victim_job["id"],
                        attempt_id=attempt["id"],
                        payload={
                            "requester_job_id": requester["id"],
                            "mode": plan["mode"],
                            "nonce": nonce,
                        },
                    )
                    continue
                previous_requester = plan["previous_requester"]
                scale_plan = plan["scale_plan"]
                event_payload: dict[str, Any] = {
                    "requester_job_id": requester["id"],
                    "previous_mode": (
                        "auto-scale-up"
                        if plan["is_scale_takeover"]
                        else DispatchMode.PREEMPT_SAVE.value
                    ),
                    "mode": DispatchMode.PREEMPT_NOW.value,
                    "nonce": nonce,
                    "victim_job_id": victim_job["id"],
                    "victim_attempt_id": attempt["id"],
                }
                if plan["is_scale_takeover"]:
                    assert scale_plan is not None
                    event_payload["scale_up_plan_id"] = scale_plan["id"]
                else:
                    assert previous_requester is not None
                    event_payload["previous_requester_job_id"] = previous_requester[
                        "id"
                    ]
                tx.append_event(
                    "PREEMPT_TAKEN_OVER",
                    job_id=victim_job["id"],
                    attempt_id=attempt["id"],
                    payload=event_payload,
                )
                if previous_requester is not None:
                    tx.append_event(
                        "PREEMPT_PROMISE_TAKEN_OVER",
                        job_id=previous_requester["id"],
                        payload=event_payload,
                    )

    def _save_takeover_candidates(
        self, requester: dict[str, Any]
    ) -> list[VictimCandidate]:
        """Return save waits a strictly higher hard requester may upgrade."""

        if requester.get("preempt_idle_only") or requester["dispatch_mode"] != DispatchMode.PREEMPT_NOW.value:
            return []
        candidates: list[VictimCandidate] = []
        takeover_states = {
            AttemptState.SAVE_REQUESTED.value,
            AttemptState.SAVE_WITHDRAWING.value,
            AttemptState.CHECKPOINT_ACKED.value,
        }
        for attempt in self.store.list_attempts(states=takeover_states, limit=10_000):
            if self._attempt_is_quarantine_affected(
                attempt
            ) or self._attempt_has_sharing(attempt):
                continue
            victim_job = self.store.get_job(attempt["job_id"])
            if not victim_in_scope(requester,victim_job):
                continue
            if victim_job.get("yield_policy", "legacy") in {"save", "never"}:
                continue
            candidate_gpu_count = len(attempt["gpu_uuids"])
            candidate_gpu_uuids = tuple(attempt["gpu_uuids"])
            if self._is_scale_request(attempt):
                scale_plan = self._scale_plan_for_attempt(attempt)
                expected_plan_state = (
                    ScaleUpState.CHECKPOINT_ACKED.value
                    if attempt["state"] == AttemptState.CHECKPOINT_ACKED.value
                    else ScaleUpState.SAVE_REQUESTED.value
                )
                if (
                    scale_plan is None
                    or scale_plan["state"]
                    not in {
                        expected_plan_state,
                        ScaleUpState.WITHDRAWN.value,
                    }
                    or victim_job["priority"] >= requester["priority"]
                ):
                    continue
                # Taking over a scale request atomically releases its idle
                # reservations as well as terminating the source attempt.
                # Model the full target so exact-set selection accounts for
                # every GPU made available by that one durable decision.
                if scale_plan["state"] != ScaleUpState.WITHDRAWN.value:
                    candidate_gpu_count = int(scale_plan["target_gpu_count"])
                    candidate_gpu_uuids = tuple(scale_plan["target_gpu_uuids"])
            else:
                if not str(attempt.get("preempt_nonce") or "").startswith("save-"):
                    continue
                previous_requester_id = attempt.get("preempt_requested_by_job_id")
                if (
                    not previous_requester_id
                    or previous_requester_id == requester["id"]
                ):
                    continue
                previous_requester = self.store.get_job(previous_requester_id)
                if previous_requester["priority"] >= requester["priority"]:
                    continue
            candidates.append(
                VictimCandidate(
                    attempt_id=attempt["id"],
                    job_id=victim_job["id"],
                    priority=victim_job["priority"],
                    gpu_count=candidate_gpu_count,
                    checkpoint_capability=victim_job["checkpoint_capability"],
                    yield_policy=victim_job.get("yield_policy", "legacy"),
                    restart_policy=victim_job["restart_policy"],
                    preempt_idle_only=victim_job.get("preempt_idle_only", False),
                    # select_victims deliberately accepts only RUNNING
                    # candidates.  These attempts are already selected
                    # victims; the synthetic state lets the same exact-set,
                    # minimal-release combinator choose which waits to
                    # upgrade without broadening its eligibility rules.
                    state=AttemptState.RUNNING.value,
                    gpu_uuids=candidate_gpu_uuids,
                    takeover=True,
                )
            )
        return candidates

    def _preemption_is_still_needed(self, attempt: dict[str, Any]) -> bool:
        if self._attempt_is_quarantine_affected(attempt) or self._attempt_has_sharing(
            attempt
        ):
            return False
        if self._is_scale_request(attempt):
            return self._scale_request_is_still_needed(attempt)
        requester_id = attempt.get("preempt_requested_by_job_id")
        if not requester_id:
            return False
        requester = self.store.get_job(requester_id)
        if requester["state"] != JobState.PENDING.value:
            return False
        if not victim_in_scope(requester,self.store.get_job(attempt["job_id"])):
            return False
        return not bool(
            self._select_free_devices_for_job(requester, self._free_devices())
        )

    def _rollback_undelivered_preemption(
        self,
        attempt: dict[str, Any],
        reason: str,
        *,
        fail_requester: bool = False,
    ) -> None:
        if self._is_scale_request(attempt):
            self._withdraw_scale_request(attempt, reason)
            return
        victim = self.store.get_job(attempt["job_id"])
        requester_id = attempt.get("preempt_requested_by_job_id")
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                state=AttemptState.RUNNING,
                expected_states=[
                    AttemptState.SAVE_REQUESTED,
                    AttemptState.SAVE_WITHDRAWING,
                    AttemptState.TERM_REQUESTED,
                ],
                preempt_nonce=None,
                preempt_requested_by_job_id=None,
                preempt_requested_at=None,
                preempt_deadline_at=None,
                checkpoint_deadline_at=None,
                term_deadline_at=None,
                kill_deadline_at=None,
                failure_reason=None,
            )
            tx.update_job(
                victim["id"],
                state=JobState.RUNNING,
                state_reason=reason,
                expected_states=[JobState.PREEMPTING],
            )
            tx.append_event(
                "PREEMPT_WITHDRAWN",
                job_id=victim["id"],
                attempt_id=attempt["id"],
                payload={"reason": reason},
            )
            if fail_requester and requester_id:
                requester = tx.get_job(requester_id)
                if requester["state"] == JobState.PENDING.value:
                    tx.update_job(
                        requester_id,
                        state=JobState.FAILED,
                        state_reason=reason,
                        expected_states=[JobState.PENDING],
                    )
                    tx.append_event(
                        "PREEMPT_TIMEOUT",
                        job_id=requester_id,
                        payload={
                            "victim_job_id": victim["id"],
                            "victim_attempt_id": attempt["id"],
                            "reason": reason,
                        },
                    )

    def _try_withdraw_save_request(
        self,
        attempt: dict[str, Any],
        reason: str,
        *,
        fail_requester: bool = False,
    ) -> bool:
        """Withdraw one request only while no adapter is in its ACK section."""

        current = self.store.get_attempt(str(attempt["id"]))
        if self._is_scale_request(current):
            # The plan/reservation decision is independent of filesystem lock
            # ownership.  Commit it first so ordinary queued work can use the
            # extra GPUs even while an adapter is still inside checkpoint I/O.
            current = self._begin_scale_withdrawal(current, reason)
        control_dir = Path(attempt["control_dir"])
        lock_path = control_dir / LOCK_FILE_NAME
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
        flags |= getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(lock_path, flags, 0o600)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeError("checkpoint protocol lock is not a regular file")
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return False
            current = self.store.get_attempt(attempt["id"])
            if (
                current["state"]
                not in {
                    AttemptState.SAVE_REQUESTED.value,
                    AttemptState.SAVE_WITHDRAWING.value,
                }
                or self._valid_ack(current) is not None
            ):
                return False
            if current["state"] == AttemptState.SAVE_REQUESTED.value:
                requester_id = current.get("preempt_requested_by_job_id")
                with self.store.transaction() as tx:
                    tx.update_attempt(
                        current["id"],
                        state=AttemptState.SAVE_WITHDRAWING,
                        failure_reason=reason,
                        expected_states=[AttemptState.SAVE_REQUESTED],
                    )
                    if not self._is_scale_request(current):
                        tx.append_event(
                            "PREEMPT_WITHDRAW_STARTED",
                            job_id=current["job_id"],
                            attempt_id=current["id"],
                            payload={
                                "reason": reason,
                                "fail_requester": fail_requester,
                            },
                        )
                    if (
                        fail_requester
                        and requester_id
                        and not self._is_scale_request(current)
                    ):
                        requester = tx.get_job(requester_id)
                        if requester["state"] == JobState.PENDING.value:
                            tx.update_job(
                                requester_id,
                                state=JobState.FAILED,
                                state_reason=reason,
                                expected_states=[JobState.PENDING],
                            )
                            tx.append_event(
                                "PREEMPT_TIMEOUT",
                                job_id=requester_id,
                                payload={
                                    "victim_job_id": current["job_id"],
                                    "victim_attempt_id": current["id"],
                                    "reason": reason,
                                },
                            )
                current = self.store.get_attempt(current["id"])
            request_path = control_dir / REQUEST_FILE_NAME
            try:
                request_path.unlink()
            except FileNotFoundError:
                pass
            else:
                directory_fd = os.open(
                    control_dir, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
                )
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
            self._rollback_undelivered_preemption(current, reason, fail_requester=False)
            return True
        finally:
            os.close(descriptor)

    def _fail_preemption_requester(self, attempt: dict[str, Any], reason: str) -> None:
        if self._is_scale_request(attempt):
            # Before an ACK, timeout is a withdrawn optimization rather than
            # a failed training job.  The adapter keeps running unchanged.
            return
        requester_id = attempt.get("preempt_requested_by_job_id")
        if not requester_id:
            return
        requester = self.store.get_job(requester_id)
        if requester["state"] != JobState.PENDING.value:
            return
        with self.store.transaction() as tx:
            tx.update_job(
                requester_id,
                state=JobState.FAILED,
                state_reason=reason,
                expected_states=[JobState.PENDING],
            )
            tx.append_event(
                "PREEMPT_TIMEOUT",
                job_id=requester_id,
                payload={
                    "victim_job_id": attempt["job_id"],
                    "victim_attempt_id": attempt["id"],
                    "reason": reason,
                },
            )

    def _repair_preemption_actions(self, attempt: dict[str, Any]) -> None:
        nonce = attempt.get("preempt_nonce")
        requester = attempt.get("preempt_requested_by_job_id")
        requested_at = attempt.get("preempt_requested_at")
        if not nonce or not requester or requested_at is None:
            return
        if (nonce.startswith("save-") or nonce.startswith("scale-")) and attempt[
            "state"
        ] == AttemptState.SAVE_REQUESTED.value:
            payload = {
                "version": SCHEMA_VERSION,
                "nonce": nonce,
                "attempt_id": attempt["id"],
                "requested_by_job_id": requester,
                "created_at": requested_at,
                "expires_at": attempt.get("preempt_deadline_at"),
            }
            self.store.enqueue_action(
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                action_type=ActionType.REQUEST_SAVE,
                payload=payload,
                dedupe_key=f"save:{attempt['id']}:{nonce}",
                available_at=requested_at,
            )
        if (
            nonce.startswith("now-")
            and attempt["state"] == AttemptState.TERM_REQUESTED.value
        ):
            self.store.enqueue_action(
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                action_type=ActionType.TERM_UNIT,
                payload={
                    "unit_name": attempt["unit_name"],
                    "unit_token": attempt["unit_token"],
                    "invocation_id": attempt["invocation_id"],
                },
                dedupe_key=f"term:{attempt['id']}:{nonce}",
                available_at=requested_at,
            )

    # -------------------------------------------------------------- lifecycle

    def _valid_ack(self, attempt: dict[str, Any]) -> dict[str, Any] | None:
        nonce = attempt.get("preempt_nonce")
        requester = attempt.get("preempt_requested_by_job_id")
        control_dir = attempt.get("control_dir")
        if not nonce or not requester or not control_dir:
            return None
        value = _small_json_file(Path(control_dir) / ACK_FILE_NAME)
        if value is None:
            return None
        if not checkpoint_acknowledged(
            value,
            nonce=nonce,
        ):
            return None
        checkpoint_path = value.get("checkpoint_path")
        if checkpoint_path is not None and (
            not isinstance(checkpoint_path, str)
            or not checkpoint_path
            or not Path(checkpoint_path).is_absolute()
            or len(checkpoint_path) > 16_384
            or "\x00" in checkpoint_path
            or "\n" in checkpoint_path
            or "\r" in checkpoint_path
        ):
            checkpoint_path = None
        return {**value, "checkpoint_path": checkpoint_path}

    def _record_checkpoint_ack(
        self,
        attempt: dict[str, Any],
        ack: dict[str, Any],
        *,
        expected_state: AttemptState,
    ) -> None:
        checkpoint_path = ack.get("checkpoint_path")
        deadline = self.clock() + self.config.checkpoint_exit_grace_seconds
        plan = self._scale_plan_for_attempt(attempt)
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                state=AttemptState.CHECKPOINT_ACKED,
                checkpoint_path=checkpoint_path,
                checkpoint_deadline_at=deadline,
                expected_states=[expected_state],
            )
            if plan is None:
                return
            if plan["state"] == ScaleUpState.WITHDRAWN.value:
                # The adapter won the filesystem race after queue capacity was
                # already unfenced.  Preserve a valid checkpoint for ordinary
                # recovery, but never reactivate the terminal plan or recreate
                # its reservations.
                if checkpoint_path is not None:
                    tx.update_scale_up_plan(
                        plan["id"],
                        checkpoint_path=str(checkpoint_path),
                        expected_states=[ScaleUpState.WITHDRAWN],
                        expected_version=plan["version"],
                    )
                return
            if checkpoint_path is None:
                failed = tx.transition_scale_up_plan(
                    plan["id"],
                    ScaleUpState.FAILED,
                    from_states=[ScaleUpState.SAVE_REQUESTED],
                    expected_version=plan["version"],
                )
                tx.append_event(
                    "SCALE_UP_FAILED",
                    job_id=attempt["job_id"],
                    attempt_id=attempt["id"],
                    payload={
                        **self._scale_plan_event_payload(failed),
                        "reason": (
                            "checkpoint acknowledgement omitted a valid "
                            "absolute checkpoint_path"
                        ),
                    },
                )
                return
            checkpointed = tx.transition_scale_up_plan(
                plan["id"],
                ScaleUpState.CHECKPOINT_ACKED,
                from_states=[ScaleUpState.SAVE_REQUESTED],
                expected_version=plan["version"],
                checkpoint_path=str(checkpoint_path),
            )
            tx.append_event(
                "SCALE_UP_CHECKPOINTED",
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                payload=self._scale_plan_event_payload(checkpointed),
            )

    def _reconcile_attempts(self) -> None:
        attempts = self.store.list_attempts(states=ACTIVE_ATTEMPT_STATES, limit=10_000)
        for attempt in attempts:
            self._repair_preemption_actions(attempt)
            status = self._statuses.get(attempt["id"])
            if status is None and attempt["id"] not in self._statuses:
                try:
                    status = self._verified_status(attempt)
                except UnitNotFoundError:
                    status = None
                except BackendError as exc:
                    self._set_health("degraded", f"{attempt['id']}: {exc}")
                    return
            if status is not None:
                self._record_unit_identity(attempt, status)
                self.store.heartbeat_leases(attempt["id"])
            if attempt["state"] in {
                AttemptState.PLANNED.value,
                AttemptState.STARTING.value,
            }:
                continue
            if status is None:
                if (
                    attempt.get("invocation_id")
                    and attempt["state"] != AttemptState.DRAINING.value
                ):
                    self._mark_lost_and_drain(
                        attempt, "managed systemd unit disappeared"
                    )
                continue
            canceled_children = False
            if (
                status.is_cleanup_ready
                and attempt["state"] in {
                    AttemptState.TERM_REQUESTED.value,
                    AttemptState.KILL_REQUESTED.value,
                    AttemptState.DRAINING.value,
                }
                and self.store.get_job(attempt["job_id"])["state"] == JobState.CANCELED.value
                and status.control_group
            ):
                try:
                    canceled_children = bool(read_cgroup_tree_processes(status.control_group))
                except RuntimeError as exc:
                    self._set_health("degraded", f"{attempt['id']}: {exc}")
                    continue
            if (
                status.is_cleanup_ready
                and attempt["state"] != AttemptState.DRAINING.value
                and not canceled_children
            ):
                self._on_unit_exited(attempt, status)
                continue
            if attempt["state"] == AttemptState.SAVE_WITHDRAWING.value:
                ack = self._valid_ack(attempt)
                if ack is not None:
                    self._record_checkpoint_ack(
                        attempt,
                        ack,
                        expected_state=AttemptState.SAVE_WITHDRAWING,
                    )
                else:
                    self._try_withdraw_save_request(
                        attempt,
                        attempt.get("failure_reason")
                        or "completing checkpoint request withdrawal",
                    )
            elif attempt["state"] == AttemptState.SAVE_REQUESTED.value:
                ack = self._valid_ack(attempt)
                if ack is not None:
                    self._record_checkpoint_ack(
                        attempt,
                        ack,
                        expected_state=AttemptState.SAVE_REQUESTED,
                    )
                else:
                    if not self._preemption_is_still_needed(attempt):
                        if self._try_withdraw_save_request(
                            attempt, "requester no longer needs preemption"
                        ):
                            continue
                    deadline = attempt.get("preempt_deadline_at")
                    if deadline is not None and self.clock() >= deadline:
                        reason = (
                            f"{attempt['id']}: no epoch checkpoint ACK before deadline"
                        )
                        self._fail_preemption_requester(attempt, reason)
                        self._try_withdraw_save_request(attempt, reason)
            elif attempt["state"] == AttemptState.CHECKPOINT_ACKED.value:
                deadline = attempt.get("checkpoint_deadline_at")
                if deadline is not None and self.clock() >= deadline:
                    self._enqueue_term_after_checkpoint(attempt)
            elif attempt["state"] == AttemptState.TERM_REQUESTED.value or (
                attempt["state"] == AttemptState.DRAINING.value and canceled_children
            ):
                deadline = attempt.get("term_deadline_at")
                if (
                    deadline is not None
                    and self.clock() >= deadline
                ):
                    self._enqueue_kill(attempt)
            elif attempt["state"] == AttemptState.KILL_REQUESTED.value:
                deadline = attempt.get("kill_deadline_at")
                if (
                    deadline is not None
                    and self.clock() >= deadline
                ):
                    self._set_health(
                        "stuck",
                        f"{attempt['id']}: unit still present after KILL deadline",
                    )

        self._finalize_draining_attempts()
        self._finalize_terminal_leases()

    def _record_unit_identity(self, attempt: dict[str, Any], status: Any) -> None:
        changes: dict[str, Any] = {}
        if not attempt.get("invocation_id"):
            changes["invocation_id"] = status.invocation_id
        if status.main_pid > 0 and not attempt.get("main_pid"):
            changes["main_pid"] = status.main_pid
            ticks = process_start_ticks(status.main_pid)
            if ticks is not None:
                changes["start_ticks"] = ticks
        if attempt["state"] in {
            AttemptState.PLANNED.value,
            AttemptState.STARTING.value,
        }:
            changes["state"] = AttemptState.RUNNING
        job = self.store.get_job(attempt["job_id"])
        if (
            job["state"] == JobState.CANCELED.value
            and attempt["state"]
            in {
                AttemptState.PLANNED.value,
                AttemptState.STARTING.value,
                AttemptState.RUNNING.value,
            }
            and not status.is_cleanup_ready
        ):
            # START may have created the transient unit and then crashed before
            # committing its identity. Cancellation must not wait for that
            # claimed START action to expire: atomically record the recovered
            # identity and enqueue a separately claimable exact-unit TERM.
            now = self.clock()
            with self.store.transaction() as tx:
                tx.update_attempt(
                    attempt["id"],
                    state=AttemptState.TERM_REQUESTED,
                    invocation_id=status.invocation_id,
                    main_pid=(
                        status.main_pid
                        if status.main_pid > 0
                        else attempt.get("main_pid")
                    ),
                    start_ticks=(
                        changes.get("start_ticks") or attempt.get("start_ticks")
                    ),
                    term_deadline_at=None,
                    expected_states=[
                        AttemptState.PLANNED,
                        AttemptState.STARTING,
                        AttemptState.RUNNING,
                    ],
                )
                tx.enqueue_action(
                    job_id=job["id"],
                    attempt_id=attempt["id"],
                    action_type=ActionType.TERM_UNIT,
                    payload={
                        "unit_name": attempt["unit_name"],
                        "unit_token": attempt["unit_token"],
                        "invocation_id": status.invocation_id,
                    },
                    dedupe_key=f"cancel-term:{attempt['id']}",
                    available_at=now,
                )
                tx.append_event(
                    "CANCELED_START_UNIT_RECOVERED",
                    job_id=job["id"],
                    attempt_id=attempt["id"],
                    payload={
                        "invocation_id": status.invocation_id,
                        "main_pid": status.main_pid,
                    },
                )
            return
        if changes:
            self.store.update_attempt(attempt["id"], **changes)
        if job["state"] == JobState.STARTING.value:
            self.store.update_job(
                job["id"],
                state=JobState.RUNNING,
                state_reason="systemd unit running",
                expected_states=[JobState.STARTING],
            )
        self._complete_scale_up_if_running(attempt)

    def _on_unit_exited(self, attempt: dict[str, Any], status: Any) -> None:
        ack = self._valid_ack(attempt)
        checkpoint_path = (
            ack.get("checkpoint_path") if ack else attempt.get("checkpoint_path")
        )
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                state=AttemptState.DRAINING,
                exit_code=status.exec_main_status,
                checkpoint_path=checkpoint_path,
                expected_states=[
                    AttemptState.RUNNING,
                    AttemptState.SAVE_REQUESTED,
                    AttemptState.SAVE_WITHDRAWING,
                    AttemptState.CHECKPOINT_ACKED,
                    AttemptState.TERM_REQUESTED,
                    AttemptState.KILL_REQUESTED,
                ],
            )
            tx.enqueue_action(
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                action_type=ActionType.CLEANUP_UNIT,
                payload={
                    "unit_name": attempt["unit_name"],
                    "unit_token": attempt["unit_token"],
                    "invocation_id": status.invocation_id,
                },
                dedupe_key=f"cleanup:{attempt['id']}:{status.invocation_id}",
                available_at=attempt["created_at"],
            )

    def _mark_lost_and_drain(self, attempt: dict[str, Any], reason: str) -> None:
        self.store.update_attempt(
            attempt["id"],
            state=AttemptState.DRAINING,
            failure_reason=reason,
            expected_states=list(ACTIVE_ATTEMPT_STATES),
        )

    def _enqueue_term_after_checkpoint(self, attempt: dict[str, Any]) -> None:
        now = self.clock()
        plan = self._scale_plan_for_attempt(attempt)
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                state=AttemptState.TERM_REQUESTED,
                term_deadline_at=None,
                expected_states=[AttemptState.CHECKPOINT_ACKED],
            )
            tx.enqueue_action(
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                action_type=ActionType.TERM_UNIT,
                payload={
                    "unit_name": attempt["unit_name"],
                    "unit_token": attempt["unit_token"],
                    "invocation_id": attempt["invocation_id"],
                },
                dedupe_key=f"term-after-ack:{attempt['id']}:{attempt['preempt_nonce']}",
                available_at=now,
            )
            if (
                plan is not None
                and plan["state"] == ScaleUpState.CHECKPOINT_ACKED.value
            ):
                tx.transition_scale_up_plan(
                    plan["id"],
                    ScaleUpState.TERM_REQUESTED,
                    from_states=[ScaleUpState.CHECKPOINT_ACKED],
                    expected_version=plan["version"],
                )

    def _enqueue_kill(self, attempt: dict[str, Any]) -> None:
        now = self.clock()
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                state=AttemptState.KILL_REQUESTED,
                kill_deadline_at=None,
                expected_states=[AttemptState.TERM_REQUESTED, AttemptState.DRAINING],
            )
            tx.enqueue_action(
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                action_type=ActionType.KILL_UNIT,
                payload={
                    "unit_name": attempt["unit_name"],
                    "unit_token": attempt["unit_token"],
                    "invocation_id": attempt["invocation_id"],
                },
                dedupe_key=f"kill:{attempt['id']}:{attempt.get('preempt_nonce') or 'cancel'}",
                available_at=now,
            )

    def _attempt_gpus_released(self, attempt: dict[str, Any]) -> bool:
        by_uuid = {item.uuid: item for item in self._snapshot}
        status = self._statuses.get(attempt["id"])
        if status is not None and not status.is_cleanup_ready:
            self._release_counts[attempt["id"]] = 0
            return False
        if status is not None and status.control_group:
            try:
                remaining = read_cgroup_tree_processes(status.control_group)
            except RuntimeError:
                self._release_counts[attempt["id"]] = 0
                return False
            if remaining:
                self._release_counts[attempt["id"]] = 0
                return False
        if self._attempt_has_sharing(attempt):
            # Sharing tasks end independently of neighbours. Only an exact,
            # quiescent unit (or its durable successful cleanup) proves this.
            proven_exit = (
                status is not None and status.main_pid == 0 and status.is_cleanup_ready
            )
            if not proven_exit and status is None:
                proven_exit = any(
                    action["state"] == ActionState.DONE.value
                    and action["action_type"] == ActionType.CLEANUP_UNIT.value
                    and isinstance(action.get("result"), dict)
                    and action["result"].get("cleaned") is True
                    for action in self.store.list_actions(
                        attempt_id=attempt["id"], limit=1000
                    )
                )
            if proven_exit:
                # This retires one holder, not the GPU: all other leases and
                # physical occupancy still fence the card. Waiting for GPU
                # idleness would strand completed/canceled sharing tasks.
                return True
        for uuid_value in attempt["gpu_uuids"]:
            device = by_uuid.get(uuid_value)
            if (
                device is None
                or device.compute_pids
                or device.memory_used_mib > self.config.max_idle_memory_mb
            ):
                self._release_counts[attempt["id"]] = 0
                return False
        count = self._release_counts.get(attempt["id"], 0) + 1
        self._release_counts[attempt["id"]] = count
        return count >= self.config.release_confirmations

    def _finalize_draining_attempts(self) -> None:
        for attempt in self.store.list_attempts(
            states=[AttemptState.DRAINING], limit=10_000
        ):
            if not self._attempt_gpus_released(attempt):
                continue
            self._finalize_attempt(attempt)

    def _finalize_terminal_leases(self) -> None:
        leases = self.store.list_leases()
        for attempt_id in sorted({item["attempt_id"] for item in leases}):
            attempt = self.store.get_attempt(attempt_id)
            if attempt["state"] in ACTIVE_ATTEMPT_STATES:
                continue
            if self._attempt_gpus_released(attempt):
                self.store.release_leases(attempt_id=attempt_id, reason="terminal attempt GPU release confirmed")

    def _finalize_scale_attempt(
        self,
        attempt: dict[str, Any],
        job: dict[str, Any],
        plan: dict[str, Any],
        ack: dict[str, Any] | None,
    ) -> bool:
        """Finalize a scale source without entering generic preemption logic."""

        checkpoint_path = (
            ack.get("checkpoint_path") if ack is not None else None
        ) or attempt.get("checkpoint_path")
        exit_code = attempt.get("exit_code")
        plan_is_active = plan["state"] in ACTIVE_SCALE_UP_STATES
        if job["state"] == JobState.CANCELED.value:
            attempt_state = AttemptState.CANCELED
            job_state = JobState.CANCELED
            reason = "canceled by user"
            terminal_plan_state = ScaleUpState.CANCELED
        elif checkpoint_path:
            attempt_state = AttemptState.PREEMPTED
            job_state = JobState.PENDING
            reason = (
                "checkpointed for automatic scale-up "
                f"{plan['from_gpu_count']}->{plan['target_gpu_count']} GPUs"
            )
            terminal_plan_state = None
        elif ack is not None:
            attempt_state = AttemptState.EXITED_FAILURE
            job_state = JobState.FAILED
            reason = (
                "automatic scale-up checkpoint acknowledgement omitted a valid "
                "absolute checkpoint_path; refusing unsafe restart"
            )
            terminal_plan_state = ScaleUpState.FAILED
        elif exit_code == 0:
            attempt_state = AttemptState.EXITED_SUCCESS
            job_state = JobState.SUCCEEDED
            reason = "command exited successfully before scale-up checkpoint"
            terminal_plan_state = ScaleUpState.WITHDRAWN
        else:
            attempt_state = AttemptState.EXITED_FAILURE
            job_state = JobState.FAILED
            reason = attempt.get("failure_reason") or (
                "command exited before automatic scale-up checkpoint: "
                f"status {exit_code}"
            )
            terminal_plan_state = ScaleUpState.FAILED

        with self.store.transaction() as tx:
            current_plan = tx.get_scale_up_plan(plan["id"])
            tx.update_attempt(
                attempt["id"],
                state=attempt_state,
                failure_reason=(
                    reason if attempt_state == AttemptState.EXITED_FAILURE else None
                ),
                expected_states=[AttemptState.DRAINING],
            )
            tx.update_job(
                job["id"],
                state=job_state,
                state_reason=reason,
                expected_states=[
                    JobState.RUNNING,
                    JobState.PREEMPTING,
                    JobState.CANCELED,
                    JobState.STARTING,
                ],
            )
            tx.release_leases(attempt_id=attempt["id"], reason="scale attempt finalized: " + attempt_state.value)

            if checkpoint_path and current_plan["state"] in {
                ScaleUpState.SAVE_REQUESTED.value,
                ScaleUpState.CHECKPOINT_ACKED.value,
                ScaleUpState.TERM_REQUESTED.value,
            }:
                if current_plan["state"] == ScaleUpState.SAVE_REQUESTED.value:
                    current_plan = tx.transition_scale_up_plan(
                        current_plan["id"],
                        ScaleUpState.CHECKPOINT_ACKED,
                        from_states=[ScaleUpState.SAVE_REQUESTED],
                        expected_version=current_plan["version"],
                        checkpoint_path=str(checkpoint_path),
                    )
                    tx.append_event(
                        "SCALE_UP_CHECKPOINTED",
                        job_id=job["id"],
                        attempt_id=attempt["id"],
                        payload=self._scale_plan_event_payload(current_plan),
                    )
                current_plan = tx.transition_scale_up_plan(
                    current_plan["id"],
                    ScaleUpState.RESTART_PENDING,
                    from_states=[
                        ScaleUpState.CHECKPOINT_ACKED,
                        ScaleUpState.TERM_REQUESTED,
                    ],
                    expected_version=current_plan["version"],
                )
                # Source leases and the pre-existing extra reservations are
                # converted into one complete target fence in this same outer
                # transaction.  There is no crash window in which another job
                # can acquire half of the successor assignment.
                tx.reserve_full_scale_up_target(
                    current_plan["id"],
                    reservation_token=current_plan["reservation_token"],
                )
            elif terminal_plan_state is not None and plan_is_active:
                current_plan = tx.transition_scale_up_plan(
                    current_plan["id"],
                    terminal_plan_state,
                    from_states=[current_plan["state"]],
                    expected_version=current_plan["version"],
                )
                event_type = (
                    "SCALE_UP_WITHDRAWN"
                    if terminal_plan_state == ScaleUpState.WITHDRAWN
                    else "SCALE_UP_FAILED"
                )
                if terminal_plan_state != ScaleUpState.CANCELED:
                    tx.append_event(
                        event_type,
                        job_id=job["id"],
                        attempt_id=attempt["id"],
                        payload={
                            **self._scale_plan_event_payload(current_plan),
                            "reason": reason,
                        },
                    )

            tx.append_event(
                "ATTEMPT_FINISHED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload={
                    "attempt_state": attempt_state.value,
                    "job_state": job_state.value,
                    "reason": reason,
                },
            )
        self._release_counts.pop(attempt["id"], None)
        return True

    def _finalize_attempt(self, attempt: dict[str, Any]) -> None:
        actions = self.store.list_actions(attempt_id=attempt["id"], limit=1000)
        # A queued unit cleanup already removes the payload record; only an
        # attempt that never got one (a start failure) needs its own.
        if Path(attempt["control_dir"]).with_suffix(".payload.json").exists() and not any(
            action["action_type"] == ActionType.CLEANUP_UNIT.value for action in actions
        ):
            self.store.enqueue_action(
                job_id=attempt["job_id"], attempt_id=attempt["id"],
                action_type=ActionType.CLEANUP_UNIT, payload={},
                dedupe_key=f"cleanup:{attempt['id']}:{attempt.get('invocation_id')}",
                available_at=self.clock(),
            )
        job = self.store.get_job(attempt["job_id"])
        nonce = attempt.get("preempt_nonce") or ""
        requester = attempt.get("preempt_requested_by_job_id")
        ack = self._valid_ack(attempt)
        checkpoint_path = ack.get("checkpoint_path") if ack else None
        exit_code = attempt.get("exit_code")
        signal_delivered = any(
            action["state"] == ActionState.DONE.value
            and action["action_type"]
            in {ActionType.TERM_UNIT.value, ActionType.KILL_UNIT.value}
            and isinstance(action.get("result"), dict)
            and action["result"].get("signal") in {"TERM", "KILL"}
            for action in actions
        )
        signal_action_ids = {
            action["id"]
            for action in actions
            if action["action_type"]
            in {ActionType.TERM_UNIT.value, ActionType.KILL_UNIT.value}
        }
        signal_delivery_ambiguous = any(
            event["event_type"] == "SIGNAL_DELIVERY_INTENT"
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("action_id") in signal_action_ids
            and event["payload"].get("preempt_nonce") == nonce
            for event in self.store.list_events(attempt_id=attempt["id"], limit=100_000)
        )
        scale_plan = self._scale_plan_for_attempt(attempt)
        if scale_plan is not None:
            self._finalize_scale_attempt(attempt, job, scale_plan, ack)
            return
        if job["state"] == JobState.CANCELED.value:
            attempt_state = AttemptState.CANCELED
            job_state = JobState.CANCELED
            reason = "canceled by user"
        elif (
            requester
            and nonce.startswith("now-")
            and (
                signal_delivered
                or signal_delivery_ambiguous
                or exit_code not in {None, 0}
            )
        ):
            attempt_state = AttemptState.PREEMPTED
            if job["restart_policy"] == RestartPolicy.ON_PREEMPT.value:
                job_state = JobState.PENDING
                reason = f"preempted immediately by {requester}"
            else:
                job_state = JobState.CANCELED
                reason = f"preempted by {requester}; restart disabled"
        elif requester and nonce.startswith("save-") and ack is not None:
            if (
                job["restart_policy"] == RestartPolicy.ON_PREEMPT.value
                and not checkpoint_path
            ):
                # An ACK proves that rank zero saved *something*, but without
                # its durable location gpuq cannot safely resume this job.
                # Failing explicitly is preferable to restarting from scratch
                # or falling back to an older checkpoint.
                attempt_state = AttemptState.EXITED_FAILURE
                job_state = JobState.FAILED
                reason = (
                    "checkpoint acknowledgement omitted a valid absolute "
                    "checkpoint_path; refusing unsafe automatic restart"
                )
            else:
                attempt_state = AttemptState.PREEMPTED
                if job["restart_policy"] == RestartPolicy.ON_PREEMPT.value:
                    job_state = JobState.PENDING
                    reason = f"checkpointed and preempted by {requester}"
                else:
                    job_state = JobState.CANCELED
                    reason = f"checkpointed for {requester}; restart disabled"
        elif exit_code == 0:
            attempt_state = AttemptState.EXITED_SUCCESS
            job_state = JobState.SUCCEEDED
            reason = "command exited successfully"
        else:
            attempt_state = AttemptState.EXITED_FAILURE
            job_state = JobState.FAILED
            reason = attempt.get("failure_reason") or f"command exit status {exit_code}"
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                state=attempt_state,
                failure_reason=(
                    reason
                    if attempt_state
                    in {
                        AttemptState.EXITED_FAILURE,
                        AttemptState.LOST,
                        AttemptState.STUCK,
                    }
                    else None
                ),
                expected_states=[AttemptState.DRAINING],
            )
            tx.update_job(
                job["id"],
                state=job_state,
                state_reason=reason,
                expected_states=[
                    JobState.RUNNING,
                    JobState.PREEMPTING,
                    JobState.CANCELED,
                    JobState.STARTING,
                ],
            )
            tx.release_leases(attempt_id=attempt["id"], reason="attempt finalized: " + attempt_state.value)
            tx.append_event(
                "ATTEMPT_FINISHED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload={
                    "attempt_state": attempt_state.value,
                    "job_state": job_state.value,
                    "reason": reason,
                },
            )
        self._release_counts.pop(attempt["id"], None)

    # --------------------------------------------------------------- outbox

    def _signal_delivery_intended(
        self,
        attempt: dict[str, Any],
        action_id: str,
        signal_name: str,
    ) -> bool:
        """Return whether delivery may already have crossed the side effect."""

        return any(
            event["event_type"] == "SIGNAL_DELIVERY_INTENT"
            and isinstance(event.get("payload"), dict)
            and event["payload"].get("action_id") == action_id
            for event in self.store.list_events(
                attempt_id=attempt["id"],
                limit=100_000,
            )
        )

    def _blocked_start_action_ids(self) -> set[str]:
        """Keep new starts off quarantined GPUs without blocking other actions."""

        blocked: set[str] = set()
        for action in self.store.list_actions(
            states=[ActionState.PENDING], limit=100_000
        ):
            if action["action_type"] != ActionType.START_UNIT.value:
                continue
            attempt_id = action.get("attempt_id")
            if not isinstance(attempt_id, str):
                continue
            attempt = self.store.get_attempt(attempt_id)
            job = self.store.get_job(str(action["job_id"]))
            # A canceled START is a recovery probe: _execute_start will never
            # create new work and may discover the exact crash-window unit so
            # it can be terminated safely.  Likewise, a status observed in
            # this tick proves that executing the action only records identity.
            if (
                job["state"] == JobState.CANCELED.value
                or attempt_id in self._statuses
                or attempt["state"]
                not in {
                    AttemptState.PLANNED.value,
                    AttemptState.STARTING.value,
                    AttemptState.RUNNING.value,
                }
            ):
                continue
            if set(attempt["gpu_uuids"]).intersection(self._quarantines):
                blocked.add(str(action["id"]))
            elif job.get("share_gpu") and not self._shared_devices_for_job(
                job, exclude_attempt_id=attempt_id
            ):
                blocked.add(str(action["id"]))
        return blocked

    def _record_start_capacity_block(
        self,
        action: dict[str, Any],
        blocked: StartCapacityBlocked,
    ) -> None:
        attempt_id = str(action["attempt_id"])
        finding = CollisionFinding(
            gpu_uuid=blocked.gpu_uuid,
            gpu_index=blocked.gpu_index,
            kind="start-target-busy",
            pids=blocked.pids,
            lease_attempt_id=attempt_id,
        )
        self._quarantines[blocked.gpu_uuid] = GpuQuarantine(
            gpu_uuid=blocked.gpu_uuid,
            gpu_index=blocked.gpu_index,
            findings=(finding,),
            affected_attempt_ids=(attempt_id,),
            collision_active=True,
            clean_scans=0,
        )
        self._quarantine_affected_attempt_ids = set().union(
            *(set(item.affected_attempt_ids) for item in self._quarantines.values())
        )
        self._idle_counts[blocked.gpu_uuid] = 0
        self._release_counts[attempt_id] = 0

    def _process_actions(self) -> None:
        actions = self.store.claim_actions(
            self.worker_id,
            limit=4,
            lease_seconds=30.0,
            exclude_action_ids=self._blocked_start_action_ids(),
        )
        for action in actions:
            claim_token = action["claim_token"]
            try:
                if action["action_type"] == ActionType.START_UNIT.value:
                    if self._observe_only:
                        job = self.store.get_job(action["job_id"])
                        if job["state"] != JobState.CANCELED.value:
                            self.store.fail_action(
                                action["id"],
                                "observe-only mode",
                                claim_token=claim_token,
                                retry=True,
                                available_at=self.clock() + 1.0,
                            )
                            continue
                    result = self._execute_start(action)
                elif action["action_type"] == ActionType.REQUEST_SAVE.value:
                    result = self._execute_save_request(action)
                elif action["action_type"] == ActionType.TERM_UNIT.value:
                    result = self._execute_signal(action, kill=False)
                elif action["action_type"] == ActionType.KILL_UNIT.value:
                    result = self._execute_signal(action, kill=True)
                elif action["action_type"] == ActionType.CLEANUP_UNIT.value:
                    result = self._execute_cleanup(action)
                else:
                    raise RuntimeError(f"unknown action type: {action['action_type']}")
                if result.get("sharing_deferred"):
                    continue
                self.store.complete_action(
                    action["id"], claim_token=claim_token, result=result
                )
            except StartCapacityBlocked as exc:
                # A process can appear after the tick snapshot.  Keep the
                # already-reserved lease, delay only this start, and let the
                # next complete observation build the structured quarantine.
                self.store.fail_action(
                    action["id"],
                    str(exc),
                    claim_token=claim_token,
                    retry=True,
                    available_at=self.clock(),
                )
                self._record_start_capacity_block(action, exc)
                continue
            except (
                BackendError,
                OSError,
                StoreConflictError,
                RuntimeError,
                ValueError,
            ) as exc:
                LOGGER.warning("outbox action %s failed: %s", action["id"], exc)
                self.store.fail_action(
                    action["id"],
                    str(exc),
                    claim_token=claim_token,
                    retry=True,
                    available_at=self.clock()
                    + min(30.0, 2.0 ** min(action["attempt_count"], 5)),
                )
                self._invalidate_observation_history()
                self._set_health("degraded", f"action {action['id']}: {exc}")
                return

    def _fresh_devices_for_start(
        self, expected_uuids: list[str], expected_indices: list[int]
    ) -> dict[str, GpuDevice]:
        if len(expected_uuids) != len(expected_indices):
            raise GpuIndexDriftError("reserved GPU UUID/index vectors differ")
        devices = tuple(self.gpu_provider.snapshot())
        by_uuid = {item.uuid: item for item in devices}
        for uuid_value, expected_index in zip(expected_uuids, expected_indices):
            device = by_uuid.get(uuid_value)
            if device is None:
                raise RuntimeError(f"reserved GPU disappeared: {uuid_value}")
            if device.index != expected_index:
                raise GpuIndexDriftError(
                    f"GPU index changed for {uuid_value}: "
                    f"planned {expected_index}, current {device.index}"
                )
            if (
                device.compute_pids
                or device.memory_used_mib > self.config.max_idle_memory_mb
            ):
                raise StartCapacityBlocked(
                    uuid_value,
                    device.index,
                    device.compute_pids,
                )
        return by_uuid

    def _execute_start(self, action: dict[str, Any]) -> dict[str, Any]:
        attempt = self.store.get_attempt(action["attempt_id"])
        job = self.store.get_job(action["job_id"])
        payload = action["payload"]
        if job["state"] == JobState.CANCELED.value:
            if attempt["state"] not in {
                AttemptState.PLANNED.value,
                AttemptState.STARTING.value,
            }:
                return {"stale": True, "reason": "job is canceled"}
            return self._recover_canceled_start(action, attempt, payload)
        if attempt["state"] not in {
            AttemptState.PLANNED.value,
            AttemptState.STARTING.value,
            AttemptState.RUNNING.value,
        }:
            return {"stale": True, "attempt_state": attempt["state"]}
        try:
            status = self.systemd.status(
                unit_name=payload["unit_name"],
            )
        except UnitNotFoundError:
            try:
                if job.get("share_gpu"):
                    devices = tuple(self.gpu_provider.snapshot())
                    selected = self._shared_devices_for_job(
                        job,
                        devices=devices,
                        exclude_attempt_id=attempt["id"],
                        fresh=True,
                    )
                    if not selected:
                        # Keep only this START queued. No quarantine is needed
                        # for expected sharing occupancy or a temporary budget shortage.
                        self.store.fail_action(
                            action["id"],
                            "shared GPU budget/availability changed",
                            claim_token=action["claim_token"],
                            retry=True,
                            available_at=self.clock() + 1,
                        )
                        return {"sharing_deferred": True}
                    if selected[0].index != attempt["gpu_indices"][0]:
                        raise GpuIndexDriftError("shared GPU index changed")
                else:
                    self._fresh_devices_for_start(
                        payload["gpu_uuids"], payload["gpu_indices"]
                    )
            except GpuIndexDriftError as exc:
                self._abort_unstarted_attempt(attempt, str(exc))
                return {"replan": True, "reason": str(exc)}
            control_dir = Path(attempt["control_dir"])
            launch_path = control_dir / _LAUNCH_FILE_NAME
            launch_spec = {
                "version": SCHEMA_VERSION,
                "argv": payload["argv"],
                "cwd": payload["cwd"],
                "env": payload["env"],
            }
            existing_launch = _small_json_file(launch_path, _MAX_LAUNCH_SPEC_BYTES)
            if existing_launch is not None and existing_launch != launch_spec:
                raise RuntimeError("launch specification identity conflict")
            if existing_launch is None:
                if launch_path.exists() or launch_path.is_symlink():
                    raise RuntimeError("launch specification path is unsafe")
                atomic_write_json(launch_path, launch_spec, mode=0o600)
            try:
                status = self.systemd.start(
                    unit_name=payload["unit_name"],
                    description_token=payload["unit_token"],
                    argv=[
                        "/usr/bin/python3",
                        str(self.config.archive_path),
                        "_exec",
                        str(launch_path),
                    ],
                    cwd=str(control_dir),
                    env={},
                    log_path=payload["log_path"],
                    **({"delegate": True} if payload["env"].get("GPUQ_CONSOLE_OCI") == "1" else {}),
                )
            except ValueError as exc:
                reason = f"invalid launch specification: {exc}"
                with self.store.transaction() as tx:
                    tx.update_attempt(
                        attempt["id"],
                        state=AttemptState.LOST,
                        failure_reason=reason,
                        expected_states=[
                            AttemptState.PLANNED,
                            AttemptState.STARTING,
                        ],
                    )
                    tx.release_leases(attempt_id=attempt["id"], reason="invalid launch specification")
                    tx.update_job(
                        job["id"],
                        state=JobState.FAILED,
                        state_reason=reason,
                        expected_states=[JobState.STARTING],
                    )
                    tx.append_event(
                        "START_REJECTED",
                        job_id=job["id"],
                        attempt_id=attempt["id"],
                        payload={"reason": reason},
                    )
                return {"rejected": True, "reason": reason}
        ticks = process_start_ticks(status.main_pid) if status.main_pid > 0 else None
        changes: dict[str, Any] = {
            "state": AttemptState.RUNNING,
            "invocation_id": status.invocation_id,
        }
        if status.main_pid > 0:
            changes["main_pid"] = status.main_pid
        if ticks is not None:
            changes["start_ticks"] = ticks
        with self.store.transaction() as tx:
            tx.update_attempt(
                attempt["id"],
                expected_states=[
                    AttemptState.PLANNED,
                    AttemptState.STARTING,
                    AttemptState.RUNNING,
                ],
                **changes,
            )
            tx.update_job(
                job["id"],
                state=JobState.RUNNING,
                state_reason="systemd unit started",
                expected_states=[JobState.STARTING, JobState.RUNNING],
            )
            tx.append_event(
                "UNIT_STARTED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload={
                    "unit_name": status.unit_name,
                    "invocation_id": status.invocation_id,
                    "main_pid": status.main_pid,
                },
            )
        return {
            "unit_name": status.unit_name,
            "invocation_id": status.invocation_id,
            "main_pid": status.main_pid,
        }

    def _recover_canceled_start(
        self,
        action: dict[str, Any],
        attempt: dict[str, Any],
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        """Resolve the start-crash ambiguity without launching new work."""

        try:
            status = self.systemd.status(
                unit_name=payload["unit_name"],
            )
        except UnitNotFoundError:
            self._cancel_unstarted_attempt(
                attempt,
                "job canceled before unit creation",
                exclude_action_id=action["id"],
            )
            return {"aborted": True, "unit_found": False}

        self._record_unit_identity(attempt, status)
        current = self.store.get_attempt(attempt["id"])
        if status.is_cleanup_ready:
            self._on_unit_exited(current, status)
            return {"aborted": True, "unit_found": True, "already_exited": True}
        if current["state"] == AttemptState.TERM_REQUESTED.value:
            # Reconciliation may already have atomically recovered the exact
            # canceled unit and created the independent cancel-term action.
            return {
                "aborted": True,
                "unit_found": True,
                "term_already_requested": True,
                "invocation_id": status.invocation_id,
            }

        now = self.clock()
        with self.store.transaction() as tx:
            tx.update_attempt(
                current["id"],
                state=AttemptState.TERM_REQUESTED,
                term_deadline_at=None,
                expected_states=[AttemptState.RUNNING],
            )
            tx.enqueue_action(
                job_id=current["job_id"],
                attempt_id=current["id"],
                action_type=ActionType.TERM_UNIT,
                payload={
                    "unit_name": current["unit_name"],
                    "unit_token": current["unit_token"],
                    "invocation_id": status.invocation_id,
                },
                dedupe_key=f"cancel-term:{current['id']}",
                available_at=now,
            )
            tx.append_event(
                "CANCELED_START_RECOVERED",
                job_id=current["job_id"],
                attempt_id=current["id"],
                payload={"invocation_id": status.invocation_id},
            )
        return {
            "aborted": True,
            "unit_found": True,
            "invocation_id": status.invocation_id,
        }

    def _execute_save_request(self, action: dict[str, Any]) -> dict[str, Any]:
        attempt = self.store.get_attempt(action["attempt_id"])
        if attempt["state"] != AttemptState.SAVE_REQUESTED.value or attempt.get(
            "preempt_nonce"
        ) != action["payload"].get("nonce"):
            return {"stale": True, "attempt_state": attempt["state"]}
        control_path = Path(attempt["control_dir"])
        try:
            control_path.resolve(strict=True).relative_to(
                self.config.control_dir.resolve(strict=True)
            )
        except (OSError, RuntimeError, ValueError) as exc:
            raise RuntimeError(
                "attempt control directory escaped configured root"
            ) from exc
        request_path = control_path / REQUEST_FILE_NAME
        existing = _small_json_file(request_path)
        if (
            existing is None
            and not request_path.exists()
            and not self._preemption_is_still_needed(attempt)
        ):
            self._rollback_undelivered_preemption(
                attempt, "requester no longer needs preemption"
            )
            return {"withdrawn": True}
        if existing is not None:
            if existing != action["payload"]:
                raise RuntimeError("checkpoint request file identity conflict")
        else:
            atomic_write_json(request_path, action["payload"], mode=0o600)
        return {"request_path": str(request_path), "nonce": action["payload"]["nonce"]}

    def _execute_signal(self, action: dict[str, Any], *, kill: bool) -> dict[str, Any]:
        attempt = self.store.get_attempt(action["attempt_id"])
        victim_job = self.store.get_job(attempt["job_id"])
        allowed_state = (
            AttemptState.KILL_REQUESTED.value
            if kill
            else AttemptState.TERM_REQUESTED.value
        )
        if attempt["state"] != allowed_state:
            return {"stale": True, "attempt_state": attempt["state"]}
        if (
            not kill
            and str(attempt.get("preempt_nonce") or "").startswith("now-")
            and not str(attempt.get("preempt_nonce") or "").startswith("now-takeover-")
            and victim_job["state"] != JobState.CANCELED.value
            and not self._signal_delivery_intended(attempt, action["id"], "TERM")
            and not self._preemption_is_still_needed(attempt)
        ):
            self._rollback_undelivered_preemption(
                attempt, "requester no longer needs preemption"
            )
            return {"withdrawn": True}
        try:
            status = self._verified_status(attempt)
        except UnitNotFoundError:
            return {"already_exited": True, "unit_missing": True}
        if status is None:
            return {"already_exited": True}
        if status.is_cleanup_ready and not (
            victim_job["state"] == JobState.CANCELED.value
            and status.control_group
            and read_cgroup_tree_processes(status.control_group)
        ):
            return {"already_exited": True}
        method = self.systemd.kill if kill else self.systemd.terminate
        signal_name = "KILL" if kill else "TERM"
        # Commit the delivery intent immediately before the external side
        # effect.  If the daemon dies after systemd receives the signal but
        # before the outbox completion is recorded, recovery conservatively
        # requeues an on-preempt victim instead of silently losing it.
        self.store.append_event(
            "SIGNAL_DELIVERY_INTENT",
            job_id=attempt["job_id"],
            attempt_id=attempt["id"],
            payload={
                "action_id": action["id"],
                "signal": signal_name,
                "preempt_nonce": attempt.get("preempt_nonce"),
                "invocation_id": attempt.get("invocation_id"),
            },
        )
        method(
            unit_name=attempt["unit_name"],
        )
        delivered_at = self.clock()
        deadline_field = "kill_deadline_at" if kill else "term_deadline_at"
        deadline = attempt.get(deadline_field)
        if deadline is None:
            deadline = delivered_at + self.config.term_grace_seconds
        with self.store.transaction() as tx:
            if attempt.get(deadline_field) is None:
                if kill:
                    tx.update_attempt(
                        attempt["id"],
                        expected_states=[allowed_state],
                        kill_deadline_at=deadline,
                    )
                else:
                    tx.update_attempt(
                        attempt["id"],
                        expected_states=[allowed_state],
                        term_deadline_at=deadline,
                    )
            tx.append_event(
                "SIGNAL_DELIVERED",
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                payload={
                    "action_id": action["id"],
                    "signal": signal_name,
                    "preempt_nonce": attempt.get("preempt_nonce"),
                    "invocation_id": attempt.get("invocation_id"),
                    "delivered_at": delivered_at,
                    "deadline_at": deadline,
                },
            )
        return {"signal": signal_name, "deadline_at": deadline}

    def _execute_cleanup(self, action: dict[str, Any]) -> dict[str, Any]:
        attempt = self.store.get_attempt(action["attempt_id"])
        # The host runner saved this outside the container's control mount.
        path = Path(attempt["control_dir"]).with_suffix(".payload.json")
        def remove_payload() -> None:
            try:
                with path.open() as stream:
                    payload = json.load(stream)
            except FileNotFoundError:
                return
            try:
                subprocess.run(payload["argv"], env=payload["env"],
                               capture_output=True, check=True, timeout=10)
            except (subprocess.SubprocessError, KeyError) as exc:
                raise RuntimeError("任务容器记录暂未清理，请稍后按原编号查询。") from exc
            path.unlink(missing_ok=True)
        try:
            self.systemd.cleanup(
                unit_name=attempt["unit_name"],
                **({"before_unload": remove_payload} if path.exists() else {}),
            )
        except UnitNotFoundError:
            remove_payload()
            return {"already_unloaded": True}
        return {"cleaned": True}

    # -------------------------------------------------------------- scheduler

    def _attempt_has_sharing(self, attempt: dict[str, Any]) -> bool:
        if self.store.get_job(attempt["job_id"]).get("share_gpu"):
            return True
        return any(
            lease["gpu_uuid"] in attempt["gpu_uuids"]
            and self.store.get_job(lease["job_id"]).get("share_gpu")
            for lease in self.store.list_leases()
        )

    def _shared_devices_for_job(
        self,
        job: dict[str, Any],
        *,
        devices: tuple[GpuDevice, ...] | None = None,
        exclude_attempt_id: str | None = None,
        fresh: bool = False,
    ) -> list[GpuDevice]:
        """Admit using each shared holder's larger reserved/actual allocation."""
        if not job.get("share_gpu") or len(job["requested_gpu_uuids"]) != 1:
            return []
        gpu_uuid = job["requested_gpu_uuids"][0]
        snapshot = self._snapshot if devices is None else devices
        device = next((d for d in snapshot if d.uuid == gpu_uuid), None)
        if device is None or gpu_uuid in self._quarantines:
            return []
        reservations = self.store.list_scale_up_reservations()
        if any(r["gpu_uuid"] == gpu_uuid for r in reservations):
            return []
        leases = self.store.list_leases()
        statuses = self._statuses
        process_owners = self._process_owners
        if fresh:
            attempts = self.store.list_attempts(
                states=ACTIVE_ATTEMPT_STATES, limit=10000
            )
            statuses, problems = self._collect_statuses(attempts)
            if problems:
                return []
            self._audit_gpu_fences(attempts, leases, reservations, snapshot, statuses)
            process_owners = {}
            _, _, collisions = self._classify_processes(
                snapshot, statuses, leases, reservations,
                process_owners=process_owners,
            )
            if any(c.gpu_uuid == gpu_uuid for c in collisions):
                return []
        shared = []
        for lease in leases:
            if (
                lease["gpu_uuid"] != gpu_uuid
                or lease["attempt_id"] == exclude_attempt_id
            ):
                continue
            holder = self.store.get_attempt(lease["attempt_id"])
            holder_job = self.store.get_job(lease["job_id"])
            if holder["state"] not in {
                AttemptState.RUNNING.value,
                AttemptState.PLANNED.value,
                AttemptState.STARTING.value,
            }:
                return []
            if holder_job["state"] not in {
                JobState.RUNNING.value,
                JobState.STARTING.value,
            }:
                return []
            if (
                holder["state"] == AttemptState.RUNNING.value
                and holder["id"] not in statuses
            ):
                return []
            # An ordinary attempt still waiting for START needs an empty GPU.
            if (
                not holder_job.get("share_gpu")
                and holder["state"] != AttemptState.RUNNING.value
            ):
                return []
            if holder_job.get("share_gpu"):
                shared.append((lease, holder_job))
        usable_mb = device.memory_total_mib - self.config.max_idle_memory_mb
        if self._shared_memory_used(device, shared, process_owners) + int(job["vram_mb"]) > usable_mb:
            return []
        return [device]

    def _shared_memory_used(
        self,
        device: GpuDevice,
        shared: list[tuple[dict[str, Any], dict[str, Any]]],
        process_owners: dict[int, str | None],
    ) -> int:
        """Keep other usage actual; count each known shared job only once."""
        attributed = committed = 0
        # An unreadable PID cgroup could belong to any holder on this GPU.
        owners_known = all(pid in process_owners for pid in device.compute_pids)
        for lease, job in shared:
            reserved = int(job["vram_mb"])
            memory = [device.compute_memory_mib.get(pid) for pid in device.compute_pids
                      if process_owners.get(pid) == lease["attempt_id"]]
            if owners_known and all(value is not None for value in memory):
                actual = sum(memory)
                attributed += actual
                committed += max(reserved, actual)
            else:
                # Unknown ownership/memory: actual stays in the physical total
                # and the full reservation remains added, as before.
                committed += reserved
        return max(0, device.memory_used_mib - attributed) + committed

    def _free_devices(self) -> list[GpuDevice]:
        leased = {item["gpu_uuid"] for item in self.store.list_leases()}
        reserved = {
            item["gpu_uuid"] for item in self.store.list_scale_up_reservations()
        }
        by_uuid = {item.uuid: item for item in self._snapshot}
        result: list[GpuDevice] = []
        for uuid_value in self.config.managed_gpu_uuids:
            device = by_uuid[uuid_value]
            if (
                uuid_value not in leased
                and uuid_value not in reserved
                and uuid_value not in self._quarantines
                and not device.compute_pids
                and device.memory_used_mib <= self.config.max_idle_memory_mb
                and self._idle_counts.get(uuid_value, 0)
                >= self.config.idle_confirmations
            ):
                result.append(device)
        return sorted(result, key=lambda item: item.index)

    def _running_candidates(self) -> list[VictimCandidate]:
        result: list[VictimCandidate] = []
        for attempt in self.store.list_attempts(
            states=[AttemptState.RUNNING], limit=10_000
        ):
            if self._attempt_is_quarantine_affected(
                attempt
            ) or self._attempt_has_sharing(attempt):
                continue
            job = self.store.get_job(attempt["job_id"])
            result.append(
                VictimCandidate(
                    attempt_id=attempt["id"],
                    job_id=job["id"],
                    priority=job["priority"],
                    gpu_count=len(attempt["gpu_uuids"]),
                    checkpoint_capability=job["checkpoint_capability"],
                    yield_policy=job.get("yield_policy", "legacy"),
                    restart_policy=job["restart_policy"],
                    preempt_idle_only=job.get("preempt_idle_only", False),
                    state=attempt["state"],
                    gpu_uuids=tuple(attempt["gpu_uuids"]),
                )
            )
        return result

    def _scale_up_in_cooldown(
        self,
        job_id: str,
        attempt: dict[str, Any],
    ) -> bool:
        latest = self.store.list_scale_up_plans(job_id=job_id, limit=1)
        markers = [attempt.get("started_at")]
        if latest:
            markers.append(latest[0].get("finished_at") or latest[0].get("updated_at"))
        marker = max(float(item) for item in markers if item is not None)
        return self.clock() < marker + self.config.scale_up_cooldown_seconds

    def _plan_scale_up(
        self,
        job: dict[str, Any],
        attempt: dict[str, Any],
        extras: list[GpuDevice],
    ) -> dict[str, Any]:
        now = self.clock()
        nonce = "scale-" + secrets.token_hex(16)
        target_assignments = list(zip(attempt["gpu_uuids"], attempt["gpu_indices"])) + [
            (device.uuid, device.index) for device in extras
        ]
        with self.store.transaction() as tx:
            plan = tx.create_scale_up_plan(
                job["id"],
                attempt["id"],
                target_assignments,
                nonce=nonce,
            )
            tx.update_attempt(
                attempt["id"],
                state=AttemptState.SAVE_REQUESTED,
                expected_states=[AttemptState.RUNNING],
                expected_version=attempt["version"],
                preempt_nonce=nonce,
                preempt_requested_by_job_id=job["id"],
                preempt_requested_at=now,
                preempt_deadline_at=(now + self.config.preempt_ack_timeout_seconds),
                checkpoint_deadline_at=None,
                term_deadline_at=None,
                kill_deadline_at=None,
                failure_reason=None,
            )
            tx.update_job(
                job["id"],
                state=JobState.PREEMPTING,
                state_reason=(
                    "automatic scale-up requested "
                    f"{plan['from_gpu_count']}->{plan['target_gpu_count']} GPUs"
                ),
                expected_states=[JobState.RUNNING],
                expected_version=job["version"],
            )
            payload = {
                "version": SCHEMA_VERSION,
                "nonce": nonce,
                "attempt_id": attempt["id"],
                "requested_by_job_id": job["id"],
                "created_at": now,
                "expires_at": now + self.config.preempt_ack_timeout_seconds,
            }
            tx.enqueue_action(
                job_id=job["id"],
                attempt_id=attempt["id"],
                action_type=ActionType.REQUEST_SAVE,
                payload=payload,
                dedupe_key=f"save:{attempt['id']}:{nonce}",
                available_at=now,
            )
            tx.append_event(
                "SCALE_UP_REQUESTED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload=self._scale_plan_event_payload(plan),
            )
        return plan

    def _schedule_scale_ups(self) -> None:
        # Expansion is opportunistic.  Any queued work gets a complete normal
        # scheduling pass before a running job may reserve additional GPUs.
        if self._ready_pending_jobs():
            return
        free = self._free_devices()
        if not free:
            return
        attempts = {
            attempt["job_id"]: attempt
            for attempt in self.store.list_attempts(
                states=[AttemptState.RUNNING], limit=10_000
            )
        }
        for job in self.store.list_jobs(states=[JobState.RUNNING], limit=10_000):
            if not bool(job.get("auto_scale_up", False)):
                continue
            if self.store.get_active_scale_up_plan(job["id"]) is not None:
                continue
            attempt = attempts.get(job["id"])
            if (
                attempt is None
                or self._attempt_is_quarantine_affected(attempt)
                or self._attempt_has_sharing(attempt)
            ):
                continue
            if self._scale_up_in_cooldown(job["id"], attempt):
                continue
            current_count = len(attempt["gpu_uuids"])
            target_count = select_scale_target(
                current_gpu_count=current_count,
                free_gpu_count=len(free),
                allowed_gpu_counts=self._allowed_gpu_counts(job),
            )
            if target_count is None:
                continue
            extras = free[: target_count - current_count]
            self._plan_scale_up(job, attempt, extras)
            used = {device.uuid for device in extras}
            free = [device for device in free if device.uuid not in used]
            if not free:
                return

    def _plan_scale_up_restart(
        self,
        job: dict[str, Any],
        plan: dict[str, Any],
    ) -> dict[str, Any]:
        if set(plan["target_gpu_uuids"]).intersection(self._quarantines):
            raise RuntimeError("scale-up restart target includes a quarantined GPU")
        attempt_id = "A" + uuid.uuid4().hex
        unit_name = f"gpuq-{attempt_id.lower()}"
        unit_token = f"attempt:{attempt_id}"
        control_path, log_path = self._create_attempt_paths(job["id"], attempt_id)
        checkpoint_path = plan.get("checkpoint_path")
        if not checkpoint_path:
            raise RuntimeError("scale-up restart has no durable checkpoint")
        with self.store.transaction() as tx:
            attempt = tx.create_attempt(
                job["id"],
                attempt_id=attempt_id,
                state=AttemptState.PLANNED,
                gpu_uuids=plan["target_gpu_uuids"],
                gpu_indices=plan["target_gpu_indices"],
                unit_name=unit_name,
                unit_token=unit_token,
                boot_id=self.boot_id,
                control_dir=str(control_path),
                log_path=str(log_path),
                launch_resume_checkpoint_path=str(checkpoint_path),
                resume_from_attempt_id=plan["source_attempt_id"],
            )
            planned, _ = tx.consume_scale_up_reservations(
                plan["id"],
                attempt["id"],
                lease_token=attempt["id"],
                reservation_token=plan["reservation_token"],
                expected_version=plan["version"],
            )
            tx.update_job(
                job["id"],
                state=JobState.STARTING,
                state_reason=(
                    "automatic scale-up restart reserved "
                    f"{planned['target_gpu_count']} GPUs"
                ),
                expected_states=[JobState.PENDING],
            )
            tx.enqueue_action(
                job_id=job["id"],
                attempt_id=attempt["id"],
                action_type=ActionType.START_UNIT,
                payload=self._start_payload(job, attempt),
                dedupe_key=f"start:{attempt['id']}",
                available_at=attempt["created_at"],
            )
            start_payload = {
                "gpu_uuids": list(attempt["gpu_uuids"]),
                "gpu_indices": list(attempt["gpu_indices"]),
                "assigned_gpu_count": len(attempt["gpu_uuids"]),
                "min_gpu_count": self._minimum_gpu_count(job),
                "max_gpu_count": int(job["gpu_count"]),
                "elastic_gpu_count": bool(job.get("elastic_gpu_count", False)),
                "target_global_batch_size": job.get("target_global_batch_size"),
                "per_device_micro_batch_size": job.get("per_device_micro_batch_size"),
                "allowed_gpu_counts": list(self._allowed_gpu_counts(job)),
                "scale_up_plan_id": planned["id"],
            }
            tx.append_event(
                "START_PLANNED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload=start_payload,
            )
            tx.append_event(
                "SCALE_UP_RESTART_PLANNED",
                job_id=job["id"],
                attempt_id=attempt["id"],
                payload=self._scale_plan_event_payload(planned),
            )
        return attempt

    def _complete_scale_up_if_running(self, attempt: dict[str, Any]) -> None:
        plan = self.store.get_active_scale_up_plan(str(attempt["job_id"]))
        if (
            plan is None
            or plan["state"] != ScaleUpState.RESTART_PLANNED.value
            or plan.get("successor_attempt_id") != attempt["id"]
        ):
            return
        current_attempt = self.store.get_attempt(attempt["id"])
        current_job = self.store.get_job(attempt["job_id"])
        if (
            current_attempt["state"] != AttemptState.RUNNING.value
            or current_job["state"] != JobState.RUNNING.value
        ):
            return
        with self.store.transaction() as tx:
            completed = tx.transition_scale_up_plan(
                plan["id"],
                ScaleUpState.COMPLETED,
                from_states=[ScaleUpState.RESTART_PLANNED],
                expected_version=plan["version"],
            )
            tx.append_event(
                "SCALE_UP_COMPLETED",
                job_id=attempt["job_id"],
                attempt_id=attempt["id"],
                payload={
                    **self._scale_plan_event_payload(completed),
                    "assigned_gpu_count": len(current_attempt["gpu_uuids"]),
                },
            )

    def _schedule_scale_up_restarts(self) -> None:
        pending = self._ready_pending_jobs()
        restart_plans: list[dict[str, Any]] = []
        ordinary_pending = False
        for job in pending:
            plan = self.store.get_active_scale_up_plan(job["id"])
            if plan is not None and plan["state"] == ScaleUpState.RESTART_PENDING.value:
                restart_plans.append(plan)
            else:
                ordinary_pending = True
        if ordinary_pending:
            # Scale-up is opportunistic even after its checkpoint has been
            # taken.  A job which entered the ordinary queue while the source
            # was draining gets first claim on all fenced capacity.  The
            # scale job keeps its checkpoint and falls back through the normal
            # pending path after those ordinary jobs have been considered.
            for plan in restart_plans:
                self._fail_scale_plan(
                    plan,
                    "ordinary queued work has scheduling priority",
                    expected_states=[ScaleUpState.RESTART_PENDING],
                )
            return
        while pending:
            head = pending[0]
            plan = self.store.get_active_scale_up_plan(head["id"])
            if plan is None or plan["state"] != ScaleUpState.RESTART_PENDING.value:
                # The ordinary-pending pass above already released every
                # opportunistic reservation before reaching this branch.
                return
            hard_conflict = self._scale_target_hard_conflict(plan)
            if hard_conflict is not None:
                self._fail_scale_plan(
                    plan,
                    hard_conflict,
                    expected_states=[ScaleUpState.RESTART_PENDING],
                )
                pending = self._ready_pending_jobs()
                continue
            if not self._scale_target_is_stable(plan, extras_only=False):
                restart_deadline = float(plan["updated_at"]) + float(
                    self.config.scale_up_restart_timeout_seconds
                )
                if self.clock() >= restart_deadline:
                    self._fail_scale_plan(
                        plan,
                        "scale-up restart target did not become stably idle "
                        "before timeout",
                        expected_states=[ScaleUpState.RESTART_PENDING],
                    )
                    pending = self._ready_pending_jobs()
                    continue
                return
            self._plan_scale_up_restart(head, plan)
            pending = self._ready_pending_jobs()

    def _reconcile_scale_up_plans(self) -> None:
        for plan in self.store.list_scale_up_plans(
            states=ACTIVE_SCALE_UP_STATES,
            limit=10_000,
        ):
            if plan["state"] == ScaleUpState.RESTART_PENDING.value:
                job = self.store.get_job(plan["job_id"])
                if job["state"] == JobState.CANCELED.value:
                    self.store.transition_scale_up_plan(
                        plan["id"],
                        ScaleUpState.CANCELED,
                        from_states=[ScaleUpState.RESTART_PENDING],
                        expected_version=plan["version"],
                    )
                continue
            if plan["state"] != ScaleUpState.RESTART_PLANNED.value:
                continue
            successor_id = plan.get("successor_attempt_id")
            if not successor_id:
                self._fail_scale_plan(plan, "scale-up successor identity is missing")
                continue
            successor = self.store.get_attempt(str(successor_id))
            if successor["state"] == AttemptState.RUNNING.value:
                self._complete_scale_up_if_running(successor)
            elif successor["state"] not in ACTIVE_ATTEMPT_STATES:
                self._fail_scale_plan(
                    plan,
                    "scale-up successor did not reach RUNNING",
                    expected_states=[ScaleUpState.RESTART_PLANNED],
                )

    @staticmethod
    def _minimum_gpu_count(job: dict[str, Any]) -> int:
        """Return the declared lower bound for this job.

        Pinned and strict jobs retain their exact historical allocation.
        Elastic sizing is deliberately restricted to ``placement=any``; input
        validation enforces the same invariant at the API boundary.  Batch
        divisibility may raise the effective launch floor above this value.
        """

        maximum = int(job["gpu_count"])
        if job.get("placement") == "any" and bool(job.get("elastic_gpu_count", False)):
            return int(job.get("min_gpu_count", maximum))
        return maximum

    @staticmethod
    def _allowed_gpu_counts(job: dict[str, Any]) -> tuple[int, ...]:
        """Return every world size this job may use, in ascending order.

        Elastic jobs without batch metadata preserve the contiguous historical
        range.  Batch-aware jobs additionally require an integral gradient
        accumulation factor:

        ``target_global_batch_size % (world_size * micro_batch_size) == 0``.

        Persisted rows are expected to contain either both batch fields or
        neither.  A corrupt/partial pair is fail-closed as an empty set so it
        cannot acquire leases or trigger preemption.
        """

        minimum = Coordinator._minimum_gpu_count(job)
        maximum = int(job["gpu_count"])
        candidates = tuple(range(minimum, maximum + 1))
        target = job.get("target_global_batch_size")
        micro_batch = job.get("per_device_micro_batch_size")
        if target is None and micro_batch is None:
            return candidates
        if (target is None) != (micro_batch is None):
            raise RuntimeError(
                "persisted batch metadata must provide both "
                "target_global_batch_size and per_device_micro_batch_size"
            )
        assert target is not None
        assert micro_batch is not None
        try:
            result = compatible_world_sizes(
                target,
                micro_batch,
                minimum,
                maximum,
            )
        except ValueError as exc:
            raise RuntimeError(f"invalid persisted batch metadata: {exc}") from exc
        if not result:
            raise RuntimeError(
                "persisted batch metadata has no legal GPU count in the "
                "declared range"
            )
        return result

    @staticmethod
    def _select_free_devices_for_job(
        job: dict[str, Any], free: list[GpuDevice]
    ) -> list[GpuDevice]:
        if job.get("placement") != "pinned":
            legal_counts = Coordinator._allowed_gpu_counts(job)
            usable_counts = [count for count in legal_counts if count <= len(free)]
            if not usable_counts:
                return []
            # An attempt consumes the largest legal capacity available at its
            # start decision.  Its lease set is immutable for its lifetime.
            return free[: usable_counts[-1]]
        if int(job["gpu_count"]) not in Coordinator._allowed_gpu_counts(job):
            return []
        by_uuid = {device.uuid: device for device in free}
        requested = job.get("requested_gpu_uuids", [])
        if any(uuid_value not in by_uuid for uuid_value in requested):
            return []
        return [by_uuid[uuid_value] for uuid_value in requested]

    def _promised_preemption_gpu_uuids(self, requester: dict[str, Any]) -> set[str]:
        active_promise_states = {
            AttemptState.SAVE_REQUESTED.value,
            AttemptState.CHECKPOINT_ACKED.value,
            AttemptState.TERM_REQUESTED.value,
            AttemptState.KILL_REQUESTED.value,
            AttemptState.DRAINING.value,
        }
        terminal_promise_states = {
            AttemptState.PREEMPTED.value,
            AttemptState.EXITED_SUCCESS.value,
            AttemptState.EXITED_FAILURE.value,
            AttemptState.CANCELED.value,
            AttemptState.LOST.value,
            AttemptState.STUCK.value,
        }
        leases = {lease["gpu_uuid"]: lease for lease in self.store.list_leases()}
        by_uuid = {device.uuid: device for device in self._snapshot}
        promised: set[str] = set()
        attempts = self.store.list_attempts(
            states=active_promise_states | terminal_promise_states,
            limit=10_000,
        )
        for attempt in attempts:
            if not victim_in_scope(requester,self.store.get_job(attempt["job_id"])):
                continue
            if self._attempt_is_quarantine_affected(
                attempt
            ) or self._attempt_has_sharing(attempt):
                continue
            if self._is_scale_request(attempt):
                # Self-reserved scale capacity is not a promise made to any
                # queued preemption requester and cannot be taken over through
                # the normal victim protocol.
                continue
            promise_owner_id = attempt.get("preempt_requested_by_job_id")
            if not promise_owner_id:
                continue
            own_promise = promise_owner_id == requester["id"]
            if not own_promise:
                promise_owner = self.store.get_job(promise_owner_id)
                if promise_owner["priority"] >= requester["priority"]:
                    continue
                if attempt["state"] in {
                    AttemptState.SAVE_REQUESTED.value,
                    AttemptState.CHECKPOINT_ACKED.value,
                } and (requester["dispatch_mode"] != DispatchMode.PREEMPT_SAVE.value):
                    # A higher hard-preemption job upgrades only the minimal
                    # save victim set selected by _select_save_takeovers.
                    # Queue jobs do not rely on a reversible save request.
                    continue
            for uuid_value in attempt["gpu_uuids"]:
                if uuid_value not in self.config.managed_gpu_uuids:
                    continue
                lease = leases.get(uuid_value)
                if attempt["state"] in active_promise_states:
                    # Active victims retain their leases.  A lease owned by a
                    # different attempt or a foreign PID invalidates the
                    # promise rather than expanding the preemption blast
                    # radius based on ambiguous capacity.
                    if lease is not None and lease["attempt_id"] != attempt["id"]:
                        continue
                    if self._external.get(uuid_value):
                        continue
                    promised.add(uuid_value)
                    continue

                # A terminal victim remains a promise only during the short
                # release/idle-confirmation gap.  If another job leased the
                # GPU, or an external process occupied it, that capacity no
                # longer belongs to this requester.
                device = by_uuid.get(uuid_value)
                if (
                    lease is None
                    and device is not None
                    and not device.compute_pids
                    and not self._external.get(uuid_value)
                    and device.memory_used_mib <= self.config.max_idle_memory_mb
                ):
                    promised.add(uuid_value)
        return promised

    def _has_quarantined_active_preemption_for(self, requester_id: str) -> bool:
        """Keep an ambiguous in-flight victim from widening the blast radius."""

        for attempt in self.store.list_attempts(
            states=ACTIVE_ATTEMPT_STATES,
            limit=10_000,
        ):
            if attempt.get(
                "preempt_requested_by_job_id"
            ) == requester_id and self._attempt_is_quarantine_affected(attempt):
                return True
        return False

    def _ready_pending_jobs(self) -> list[dict[str, Any]]:
        return [job for job in self.store.list_jobs(states=[JobState.PENDING], limit=10_000)
                if job["id"] not in self._dependency_waiting]

    def _reconcile_dependencies(self) -> set[str]:
        waiting = set()
        # Parents were submitted first. Propagate a canceled chain in this pass.
        for job in sorted(self.store.list_jobs(states=[JobState.PENDING], limit=10_000), key=lambda row: row["sequence"]):
            names, failed = [], None
            for dependency_id in job.get("after", []):
                try:
                    dependency = self.store.get_job(dependency_id)
                except StoreNotFoundError:
                    failed = "依赖作业不存在"
                    break
                name = dependency["display_metadata"].get("name") or dependency["name"]
                if dependency["state"] in {"FAILED", "CANCELED", "LOST"}:
                    failed = f"依赖作业 {name} 失败/已取消，未运行"
                    break
                if dependency["state"] != "SUCCEEDED":
                    names.append(name)
            reason = (failed or ("等待依赖：" + "、".join(names) if names else ""))[:400] or None
            if failed:
                self.store.update_job(job["id"], state=JobState.CANCELED, state_reason=reason)
            elif names:
                waiting.add(job["id"])
                if job["state_reason"] != reason:
                    self.store.update_job(job["id"], state_reason=reason)
            elif job.get("after") and str(job["state_reason"] or "").startswith("等待依赖："):
                self.store.update_job(job["id"], state_reason=None)
        return waiting

    def _schedule(self) -> None:
        pending = [
            job
            for job in self._ready_pending_jobs()
            if not job.get("share_gpu")
        ]
        fallback_plans = {
            job["id"]: self._pending_scale_fallback_plan(job) for job in pending
        }
        # A terminal scale-up plan still has a durable checkpoint and must
        # recover, but it may not use its original queue sequence to jump back
        # ahead of ordinary work which caused the opportunistic reservation to
        # be released.  Stable partitioning preserves priority/FIFO order
        # within both groups, including across daemon restarts.
        pending.sort(key=lambda job: fallback_plans[job["id"]] is not None)
        free = self._free_devices()
        backfill_only = False
        for job in pending:
            fallback_plan = fallback_plans[job["id"]]
            scale_plan = self.store.get_active_scale_up_plan(job["id"])
            if (
                scale_plan is not None
                and scale_plan["state"] == ScaleUpState.RESTART_PENDING.value
            ):
                # The exact target is durably fenced and is handled by
                # _schedule_scale_up_restarts.  Never launch this lineage on a
                # different assignment through the generic pending path.
                break
            if fallback_plan is not None:
                fallback_count = int(fallback_plan["from_gpu_count"])
                selected = free[:fallback_count] if len(free) >= fallback_count else []
            else:
                selected = self._select_free_devices_for_job(job, free)
            if selected:
                self._plan_start(
                    job,
                    selected,
                    scale_fallback_plan=fallback_plan,
                )
                selected_uuids = {device.uuid for device in selected}
                free = [device for device in free if device.uuid not in selected_uuids]
                continue
            free_uuids = {device.uuid for device in free}
            required_uuids = (
                frozenset(job["requested_gpu_uuids"])
                if job.get("placement") == "pinned"
                else None
            )

            if backfill_only:
                if required_uuids is None:
                    # A flexible job which cannot start immediately ends
                    # backfill.  In particular, it may not preempt work on
                    # behalf of a lower-ranked queue entry.
                    break
                # Preserve every currently-free member of this pinned
                # request.  Later jobs may use only GPUs irrelevant to all
                # earlier pinned blockers, so they cannot delay those jobs.
                free = [device for device in free if device.uuid not in required_uuids]
                continue

            promised_uuids = self._promised_preemption_gpu_uuids(job)
            available_uuids = free_uuids | promised_uuids
            allowed_gpu_counts = self._allowed_gpu_counts(job)
            launch_floor = (
                int(fallback_plan["from_gpu_count"])
                if fallback_plan is not None
                else (allowed_gpu_counts[0] if allowed_gpu_counts else None)
            )
            promised_capacity_ready = (
                False
                if launch_floor is None
                else (
                    required_uuids.issubset(available_uuids)
                    if required_uuids is not None
                    else len(available_uuids) >= launch_floor
                )
            )
            has_quarantined_preemption = self._has_quarantined_active_preemption_for(
                str(job["id"])
            )
            if (
                not promised_capacity_ready
                and launch_floor is not None
                and not has_quarantined_preemption
            ):
                candidates = self._running_candidates()
                candidates.extend(self._save_takeover_candidates(job))
                victims = select_victims(
                    requester_priority=job["priority"],
                    requester_gpu_count=job["gpu_count"],
                    requester_min_gpu_count=launch_floor,
                    free_gpu_count=len(available_uuids),
                    dispatch_mode=job["dispatch_mode"],
                    candidates=candidates,
                    required_gpu_uuids=required_uuids,
                    free_gpu_uuids=frozenset(available_uuids),
                    preempt_idle_only=bool(job.get("preempt_idle_only", False)),
                    preempt_opt_in_only=bool(job.get("preempt_opt_in_only", False)),
                )
                if victims:
                    self._plan_preemption(job, victims)

            if required_uuids is not None:
                # Safe pinned backfill: reserve this blocked job's free
                # target GPUs, but let lower-ranked jobs consume unrelated
                # idle GPUs.  Only the first blocked job is allowed to plan
                # preemption; jobs examined during backfill can start from
                # free capacity but cannot displace running work.
                free = [device for device in free if device.uuid not in required_uuids]
                backfill_only = True
                continue

            if promised_capacity_ready:
                # Earlier ticks already committed enough victim capacity for
                # this requester. Do not expand the blast radius while those
                # exact attempts save/terminate/drain.
                break
            # Conservative head-of-line scheduling.  A lower-ranked job never
            # starts while an earlier flexible job is blocked.
            break

    # ------------------------------------------------------------------- API

    def _schedule_shared(self) -> None:
        # Explicit sharing can use an occupied card even while ordinary work
        # waits for idle cards. It never initiates preemption.
        for job in self._ready_pending_jobs():
            if not job.get("share_gpu"):
                continue
            if job.get("hami_core"):
                try:
                    runtime_library(self.config.archive_path)
                except ValueError:
                    with self.store.transaction() as tx:
                        tx.update_job(
                            job["id"],
                            state=JobState.FAILED,
                            state_reason="requested HAMi runtime is unavailable",
                            expected_states=[JobState.PENDING],
                        )
                        tx.append_event(
                            "START_REJECTED",
                            job_id=job["id"],
                            payload={"reason": "HAMi runtime unavailable"},
                        )
                    continue
            selected = self._shared_devices_for_job(job)
            if selected:
                self._plan_start(job, selected)

    def handle_api(self, operation: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            if operation in {"fleet_offer", "fleet_admit", "fleet_retry"}:
                from .cluster_node import node_api
                return node_api(self, operation, arguments)
            if operation == "submit":
                return self._api_submit(arguments)
            if operation == "set_job_display":
                return self._api_set_job_display(arguments)
            if operation == "status":
                return self._api_status(arguments)
            if operation == "show":
                return self._api_show(arguments)
            if operation == "job_watch":
                return self._api_job_watch(arguments)
            if operation == "cancel":
                return self._api_cancel(arguments)
            if operation == "retry":
                return self._api_retry(arguments)
            if operation == "set_priority":
                return self._api_set_priority(arguments)
            if operation == "set_priority_rank":
                return self._api_set_priority(arguments, rank_only=True)
            if operation == "log_path":
                return self._api_log_path(arguments)
            if operation == "events":
                return self._api_events(arguments)
            if operation == "health":
                _request_fields(arguments, allowed=set())
                return self._health_payload()
            if operation == "set_observe_only":
                return self._api_set_observe(arguments)
            raise ApiError("NOT_FOUND", f"unknown operation: {operation}")

    def _new_job_id(self) -> str:
        for _ in range(10):
            candidate = "J" + uuid.uuid4().hex[:12]
            try:
                self.store.get_job(candidate)
            except StoreNotFoundError:
                return candidate
        raise RuntimeError("could not allocate a unique job id")

    def _api_submit(self, arguments: dict[str, Any]) -> dict[str, Any]:
        try:
            submission = validate_submission(
                arguments,
                len(self.config.managed_gpu_uuids),
                max_request_bytes=self.config.max_request_bytes,
                managed_gpu_uuids=self.config.managed_gpu_uuids,
            )
            submission["id"] = self._new_job_id()
            if submission.get("hami_core"):
                runtime_library(self.config.archive_path)
            if submission.get("share_gpu"):
                device = next(
                    (
                        d
                        for d in self._snapshot
                        if d.uuid == submission["requested_gpu_uuids"][0]
                    ),
                    None,
                )
                if (
                    device is not None
                    and submission["vram_mb"]
                    > device.memory_total_mib - self.config.max_idle_memory_mb
                ):
                    raise ValueError("shared VRAM budget exceeds this GPU's capacity")
            with self.store.transaction() as tx:
                job = tx.submit_job(submission)
                tx.append_event(
                    "JOB_SUBMITTED",
                    job_id=job["id"],
                    payload={
                        "priority": job["priority"],
                        "dispatch_mode": job["dispatch_mode"],
                        "gpu_count": job["gpu_count"],
                        "min_gpu_count": job["min_gpu_count"],
                        "elastic_gpu_count": job["elastic_gpu_count"],
                        "auto_scale_up": job.get("auto_scale_up", False),
                        "target_global_batch_size": job.get("target_global_batch_size"),
                        "per_device_micro_batch_size": job.get(
                            "per_device_micro_batch_size"
                        ),
                        "allowed_gpu_counts": list(self._allowed_gpu_counts(job)),
                        "placement": job["placement"],
                        "requested_gpu_uuids": job["requested_gpu_uuids"],
                        "owner": job["owner"],
                    },
                )
        except (ValueError, StoreConflictError) as exc:
            raise ApiError("BAD_SUBMISSION", str(exc)) from exc
        if job.get("after"):
            self._dependency_waiting = self._reconcile_dependencies()
            job = self.store.get_job(job["id"])
        return {
            "job_id": job["id"],
            "state": job["state"],
            "priority": f"P{job['priority']}",
            "dispatch_mode": job["dispatch_mode"],
            "preempt_idle_only": job.get("preempt_idle_only", False),
            "preempt_opt_in_only": job.get("preempt_opt_in_only", False),
            "gpu_count": job["gpu_count"],
            "min_gpu_count": job["min_gpu_count"],
            "elastic_gpu_count": job["elastic_gpu_count"],
            "auto_scale_up": job.get("auto_scale_up", False),
            "target_global_batch_size": job.get("target_global_batch_size"),
            "per_device_micro_batch_size": job.get("per_device_micro_batch_size"),
            "allowed_gpu_counts": list(self._allowed_gpu_counts(job)),
            "placement": job["placement"],
            "requested_gpu_uuids": job["requested_gpu_uuids"],
        }

    def _api_set_job_display(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"job_id", "metadata"}, required={"job_id", "metadata"})
        try:
            job = self.store.set_job_display(arguments["job_id"], arguments["metadata"])
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        except StoreConflictError as exc:
            raise ApiError("CONFLICT", str(exc)) from exc
        except (ValueError, TypeError) as exc:
            raise ApiError("BAD_REQUEST", str(exc)) from exc
        return {"job_id": job["id"], "display_metadata": job["display_metadata"]}

    def _api_status(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"all", "limit"})
        show_all = arguments.get("all", False)
        limit = arguments.get("limit", 100)
        if not isinstance(show_all, bool):
            raise ApiError("BAD_REQUEST", "all must be boolean")
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 1000
        ):
            raise ApiError("BAD_REQUEST", "limit must be between 1 and 1000")
        states = None if show_all else _ACTIVE_JOB_STATES
        full_jobs = self.store.list_jobs(states=states, limit=limit)
        summary_fields = (
            "after",
            "display_metadata",
            "hami_core",
            "sm_percent",
            "share_gpu",
            "vram_mb",
            "id",
            "sequence",
            "name",
            "owner",
            "priority",
            "priority_name",
            "dispatch_mode",
            "checkpoint_capability",
            "yield_policy",
            "preempt_idle_only",
            "preempt_opt_in_only",
            "restart_policy",
            "gpu_count",
            "min_gpu_count",
            "elastic_gpu_count",
            "auto_scale_up",
            "target_global_batch_size",
            "per_device_micro_batch_size",
            "placement",
            "requested_gpu_uuids",
            "state",
            "state_reason",
            "created_at",
            "updated_at",
            "started_at",
            "finished_at",
        )
        listed_job_ids = {str(job["id"]) for job in full_jobs}
        active_attempts: dict[str, dict[str, Any]] = {}
        for attempt in self.store.list_attempts(
            states=ACTIVE_ATTEMPT_STATES,
            limit=100_000,
        ):
            job_id = str(attempt["job_id"])
            if job_id in listed_job_ids and job_id not in active_attempts:
                active_attempts[job_id] = attempt
        jobs = []
        for job in full_jobs:
            summary = {key: job.get(key) for key in summary_fields}
            summary["allowed_gpu_counts"] = list(self._allowed_gpu_counts(job))
            active_attempt = active_attempts.get(str(job["id"]))
            active_scale_plan = self.store.get_active_scale_up_plan(str(job["id"]))
            summary.update(
                {
                    "active_attempt_id": (
                        active_attempt["id"] if active_attempt is not None else None
                    ),
                    "assigned_gpu_count": (
                        len(active_attempt["gpu_uuids"])
                        if active_attempt is not None
                        else None
                    ),
                    "assigned_gpu_uuids": (
                        list(active_attempt["gpu_uuids"])
                        if active_attempt is not None
                        else []
                    ),
                    "assigned_gpu_indices": (
                        list(active_attempt["gpu_indices"])
                        if active_attempt is not None
                        else []
                    ),
                    "scale_up_plan": self._scale_plan_status(active_scale_plan),
                    "scale_up_state": (
                        active_scale_plan["state"]
                        if active_scale_plan is not None
                        else None
                    ),
                    "scale_from_gpu_count": (
                        active_scale_plan["from_gpu_count"]
                        if active_scale_plan is not None
                        else None
                    ),
                    "scale_target_gpu_count": (
                        active_scale_plan["target_gpu_count"]
                        if active_scale_plan is not None
                        else None
                    ),
                    "progress": self._progress_status(active_attempt),
                    "gpuMetrics": gpu_metrics(active_attempt, self.clock(), available=self._gpu_samples_available),
                }
            )
            jobs.append(summary)
        by_uuid = {item.uuid: item for item in self._snapshot}
        managed_indices = [
            str(by_uuid[item].index)
            for item in self.config.managed_gpu_uuids
            if item in by_uuid
        ]
        managed_gpus = [
            {"index": by_uuid[item].index, "uuid": item}
            for item in self.config.managed_gpu_uuids
            if item in by_uuid
        ]
        external = []
        for device in self._snapshot:
            pids = sorted(self._external.get(device.uuid, set()))
            if pids:
                external.append(
                    {
                        "index": device.index,
                        "uuid": device.uuid,
                        "pids": pids,
                        "managed_pool": device.uuid in self.config.managed_gpu_uuids,
                    }
                )
        return {
            "daemon": {
                **self._health_payload(),
                "capabilities": ["job-display-v1", "priority-policy-v1", "preempt-idle-only-v1", "priority-rank-v1", "preempt-opt-in-only-v1", "elastic-batch-v1", "gpu-placement-v1", "gpu-sharing-v1"],
                "observe_only": self._observe_only,
                "managed_indices": managed_indices,
                "managed_gpus": managed_gpus,
                "managed_gpu_uuids": list(self.config.managed_gpu_uuids),
            },
            "jobs": jobs,
            "external": external,
            "gpu_usage": self._gpu_usage(),
        }

    def _gpu_usage(self) -> list[dict[str, Any]]:
        leases = self.store.list_leases()
        result = []
        for device in self._snapshot:
            holders = [lease for lease in leases if lease["gpu_uuid"] == device.uuid]
            shared = []
            for lease in holders:
                job = self.store.get_job(lease["job_id"])
                if job.get("share_gpu"):
                    shared.append((lease, job))
            budget = sum(int(job["vram_mb"]) for _, job in shared)
            result.append(
                {
                    "index": device.index,
                    "memory_used_mb": device.memory_used_mib,
                    "memory_total_mb": device.memory_total_mib,
                    "shared_reserved_mb": budget,
                    "shared_jobs": len(shared),
                    "sharing_headroom_mb": max(
                        0,
                        device.memory_total_mib
                        - self.config.max_idle_memory_mb
                        - self._shared_memory_used(device, shared, self._process_owners),
                    ),
                }
            )
        return result

    def _api_show(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"job_id", "history_before_id", "history_limit"}, required={"job_id"})
        history_limit = arguments.get("history_limit", 256)
        if type(history_limit) is not int or not 1 <= history_limit <= 256:
            raise ApiError("BAD_REQUEST", "history_limit must be an integer from 1 to 256")
        try:
            job = self.store.get_job(str(arguments["job_id"]))
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        plans = self.store.list_scale_up_plans(job_id=job["id"], limit=1000)
        attempts = self.store.list_attempts(job_id=job["id"], limit=1000)
        try:
            history = self.store.list_allocation_history(job_id=job["id"],
                before_id=arguments.get("history_before_id"), limit=history_limit + 1)
        except ValueError as exc:
            raise ApiError("BAD_REQUEST", str(exc)) from exc
        more_history = len(history) > history_limit
        history = history[:history_limit]
        return {
            "job": {
                **job,
                "allowed_gpu_counts": list(self._allowed_gpu_counts(job)),
                "scale_up_plan": self._scale_plan_status(
                    self.store.get_active_scale_up_plan(job["id"])
                ),
            },
            "attempts": attempts,
            "progress": self._progress_status(attempts[0] if attempts else None),
            "gpuMetrics": gpu_metrics(attempts[0] if attempts else None, self.clock(), available=self._gpu_samples_available),
            "leases": self.store.list_leases(job_id=job["id"]),
            "allocation_history": history,
            "allocation_history_available": True,
            "allocation_history_truncated": more_history,
            "allocation_history_next_before_id": history[-1]["id"] if more_history else None,
            "scale_up_plans": plans,
            "scale_up_reservations": self.store.list_scale_up_reservations(
                job_id=job["id"]
            ),
        }

    def _progress_status(self, attempt: dict[str, Any] | None) -> dict[str, Any] | None:
        if attempt is None:
            return None
        attempt_id = str(attempt["id"])
        row = self.store.get_attempt_progress(attempt_id)
        error = self._progress_errors.get(attempt_id)
        if row is None:
            return {
                "reported": False,
                "stale": False,
                "error": error,
                "heartbeat_age_seconds": None,
                "progress_age_seconds": None,
                "snapshot": None,
            }
        now = float(self.clock())
        raw_snapshot = row["snapshot"]
        public_fields = (
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
        )
        snapshot = {key: raw_snapshot.get(key) for key in public_fields}
        snapshot["updated_at"] = row["updated_at"]
        return {
            "reported": True,
            "source": "training-self-report",
            "stale": row.get("stalled_at") is not None,
            "error": error,
            "heartbeat_age_seconds": max(0.0, now - float(row["heartbeat_at"])),
            "progress_age_seconds": max(0.0, now - float(row["advanced_at"])),
            "snapshot": snapshot,
        }

    def _api_job_watch(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"job_id"}, required={"job_id"})
        try:
            job = self.store.get_job(str(arguments["job_id"]))
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        attempts = self.store.list_attempts(job_id=job["id"], limit=1)
        attempt = attempts[0] if attempts else None
        job_fields = (
            "id",
            "name",
            "owner",
            "priority",
            "priority_name",
            "state",
            "state_reason",
            "created_at",
            "started_at",
            "finished_at",
        )
        attempt_fields = (
            "id",
            "ordinal",
            "state",
            "gpu_uuids",
            "gpu_indices",
            "created_at",
            "started_at",
            "finished_at",
            "exit_code",
            "failure_reason",
        )
        return {
            "job": {key: job.get(key) for key in job_fields},
            "latest_attempt": (
                {key: attempt.get(key) for key in attempt_fields}
                if attempt is not None
                else None
            ),
            "progress": self._progress_status(attempt),
            "latest_event_id": self.store.latest_event_id(job["id"]),
        }

    def _api_cancel(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"job_id"}, required={"job_id"})
        try:
            job = self.store.get_job(str(arguments["job_id"]))
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        if job["state"] in TERMINAL_JOB_STATES:
            return {"job_id": job["id"], "state": job["state"], "idempotent": True}
        attempts = self.store.list_attempts(
            job_id=job["id"], states=ACTIVE_ATTEMPT_STATES, limit=10
        )
        scale_plan = self.store.get_active_scale_up_plan(job["id"])
        now = self.clock()
        with self.store.transaction() as tx:
            tx.update_job(
                job["id"],
                state=JobState.CANCELED,
                state_reason="canceled by user",
                expected_states=list(_ACTIVE_JOB_STATES),
            )
            if scale_plan is not None:
                tx.transition_scale_up_plan(
                    scale_plan["id"],
                    ScaleUpState.CANCELED,
                    from_states=[scale_plan["state"]],
                    expected_version=scale_plan["version"],
                )
            for attempt in attempts:
                for pending in tx.list_actions(
                    states=[ActionState.PENDING],
                    attempt_id=attempt["id"],
                    limit=100,
                ):
                    if pending[
                        "action_type"
                    ] == ActionType.REQUEST_SAVE.value and not pending.get(
                        "claim_token"
                    ):
                        tx.fail_action(
                            pending["id"], "job canceled; save request withdrawn"
                        )
                if attempt["state"] in {
                    AttemptState.PLANNED.value,
                    AttemptState.STARTING.value,
                } and not attempt.get("invocation_id"):
                    # Keep the lease and START action until the worker proves
                    # whether systemd created a crash-window unit.
                    continue
                if attempt["state"] in {
                    AttemptState.TERM_REQUESTED.value,
                    AttemptState.KILL_REQUESTED.value,
                    AttemptState.DRAINING.value,
                }:
                    continue
                else:
                    tx.update_attempt(
                        attempt["id"],
                        state=AttemptState.TERM_REQUESTED,
                        term_deadline_at=None,
                        expected_states=list(ACTIVE_ATTEMPT_STATES),
                    )
                    tx.enqueue_action(
                        job_id=job["id"],
                        attempt_id=attempt["id"],
                        action_type=ActionType.TERM_UNIT,
                        payload={
                            "unit_name": attempt["unit_name"],
                            "unit_token": attempt["unit_token"],
                            "invocation_id": attempt["invocation_id"],
                        },
                        dedupe_key=f"cancel-term:{attempt['id']}",
                        available_at=now,
                    )
            tx.append_event(
                "JOB_CANCELED",
                job_id=job["id"],
                payload={"active_attempts": [item["id"] for item in attempts]},
            )
        return {"job_id": job["id"], "state": JobState.CANCELED.value}

    def _api_set_priority(self, arguments: dict[str, Any], *, rank_only: bool = False) -> dict[str, Any]:
        field = "priority" if rank_only else "priority_class"
        _request_fields(arguments, allowed={"job_id", field},
                              required={"job_id", field})
        if not isinstance(arguments["job_id"], str) or not arguments["job_id"]:
            raise ApiError("BAD_REQUEST", "job_id must be a non-empty string")
        try:
            method = self.store.set_pending_priority_rank if rank_only else self.store.set_pending_priority_class
            updated = method(arguments["job_id"], arguments[field])
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        except StoreConflictError as exc:
            raise ApiError("CONFLICT", str(exc)) from exc
        except ValueError as exc:
            raise ApiError("BAD_REQUEST", str(exc)) from exc
        return {
            "job_id": updated["id"], "state": updated["state"],
            **({} if rank_only else {"priority_class": arguments["priority_class"]}),
            **{key: updated[key] for key in ("priority", "priority_name", "yield_policy", "restart_policy", "dispatch_mode")},
            "preempt_idle_only": updated["preempt_idle_only"],
        }

    def _api_retry(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"job_id"}, required={"job_id"})
        try:
            job = self.store.get_job(str(arguments["job_id"]))
            if job["state"] not in TERMINAL_JOB_STATES:
                raise ApiError("CONFLICT", "only a terminal job can be retried")
            active_attempts = self.store.list_attempts(
                job_id=job["id"], states=ACTIVE_ATTEMPT_STATES, limit=1
            )
            if active_attempts or self.store.list_leases(job_id=job["id"]):
                raise ApiError(
                    "CONFLICT",
                    "job cleanup is still in progress; retry after its attempt drains",
                )
            inbound_preemptions = [
                attempt
                for attempt in self.store.list_attempts(
                    states=ACTIVE_ATTEMPT_STATES, limit=10_000
                )
                if attempt.get("preempt_requested_by_job_id") == job["id"]
            ]
            if inbound_preemptions:
                raise ApiError(
                    "CONFLICT",
                    "preemption cleanup is still in progress; retry after "
                    "the victim request is withdrawn or drained",
                )
            with self.store.transaction() as tx:
                updated = tx.update_job(
                    job["id"],
                    state=JobState.PENDING,
                    state_reason="manually retried",
                    expected_states=TERMINAL_JOB_STATES,
                )
                tx.append_event("JOB_RETRIED", job_id=job["id"])
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        except StoreConflictError as exc:
            raise ApiError("CONFLICT", str(exc)) from exc
        return {"job_id": updated["id"], "state": updated["state"]}

    def _api_log_path(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(arguments, allowed={"job_id"}, required={"job_id"})
        try:
            job = self.store.get_job(str(arguments["job_id"]))
            attempts = self.store.list_attempts(job_id=job["id"], limit=1)
        except StoreNotFoundError as exc:
            raise ApiError("NOT_FOUND", str(exc)) from exc
        if not attempts or not attempts[0].get("log_path"):
            raise ApiError("NOT_FOUND", "job has no attempt log yet")
        return {"path": attempts[0]["log_path"]}

    def _api_events(self, arguments: dict[str, Any]) -> list[dict[str, Any]]:
        _request_fields(arguments, allowed={"job_id", "limit", "after_id"})
        limit = arguments.get("limit", 100)
        if (
            isinstance(limit, bool)
            or not isinstance(limit, int)
            or not 1 <= limit <= 1000
        ):
            raise ApiError("BAD_REQUEST", "limit must be between 1 and 1000")
        after_id = arguments.get("after_id", 0)
        if isinstance(after_id, bool) or not isinstance(after_id, int) or after_id < 0:
            raise ApiError("BAD_REQUEST", "after_id must be a non-negative integer")
        job_id = arguments.get("job_id")
        return self.store.list_events(
            after_id=after_id,
            job_id=job_id,
            limit=limit,
        )

    def _api_set_observe(self, arguments: dict[str, Any]) -> dict[str, Any]:
        _request_fields(
            arguments,
            allowed={"observe_only"},
            required={"observe_only"},
        )
        value = arguments["observe_only"]
        if not isinstance(value, bool):
            raise ApiError("BAD_REQUEST", "observe_only must be boolean")
        self.store.set_setting("observe_only", value)
        self._observe_only = value
        self.store.append_event("DAEMON_MODE_CHANGED", payload={"observe_only": value})
        return {"observe_only": value}

    def _quarantine_payloads(self) -> list[dict[str, Any]]:
        required_clean = max(2, int(self.config.idle_confirmations))
        result: list[dict[str, Any]] = []
        for quarantine in sorted(
            self._quarantines.values(), key=lambda item: item.gpu_index
        ):
            reasons = []
            for finding in quarantine.findings:
                reasons.append(
                    {
                        "kind": finding.kind,
                        "pids": list(finding.pids),
                        "lease_attempt_id": finding.lease_attempt_id,
                        "process_attempt_id": finding.process_attempt_id,
                        "reservation_plan_id": finding.reservation_plan_id,
                        "reservation_source_attempt_id": (
                            finding.reservation_source_attempt_id
                        ),
                    }
                )
            result.append(
                {
                    "index": quarantine.gpu_index,
                    "uuid": quarantine.gpu_uuid,
                    "collision_active": quarantine.collision_active,
                    "clean_scans": quarantine.clean_scans,
                    "required_clean_scans": required_clean,
                    "reasons": reasons,
                    "affected_attempt_ids": list(quarantine.affected_attempt_ids),
                }
            )
        return result

    def _health_payload(self) -> dict[str, Any]:
        managed_quarantines = set(self.config.managed_gpu_uuids).intersection(
            self._quarantines
        )
        if not managed_quarantines:
            capacity_health = "ok"
        elif len(managed_quarantines) == len(self.config.managed_gpu_uuids):
            capacity_health = "blocked"
        else:
            capacity_health = "partial"
        schedulable = self._free_devices() if self._health == "ok" else []
        return {
            "health": self._health,
            "error": self._last_error,
            "recovery_scans": self._recovery_scans,
            "boot_id": self.boot_id,
            "capacity_health": capacity_health,
            "quarantined_gpus": self._quarantine_payloads(),
            "schedulable_gpu_indices": [item.index for item in schedulable],
            "schedulable_gpu_uuids": [item.uuid for item in schedulable],
        }

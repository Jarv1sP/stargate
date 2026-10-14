from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Iterable, Sequence

from .constants import CheckpointCapability, DispatchMode


def priority_class_contract(value: Any) -> dict[str, Any]:
    """The small, opt-in Console contract; legacy submissions stay unchanged."""
    if not isinstance(value, str) or value not in {"idle", "normal", "high"}:
        raise ValueError("priority_class must be idle, normal or high")
    return {
        "priority": {"idle": 0, "normal": 2, "high": 4}[value],
        "yield_policy": "now" if value == "idle" else "never",
        "restart_policy": "never",
        "dispatch_mode": "queue",
    }


def is_idle_victim(
    priority: int, yield_policy: str, restart_policy: str, preempt_idle_only: bool = False
) -> bool:
    """Do not enroll historical P0/now jobs into the new opt-in policy."""
    return preempt_idle_only is True and priority == 0 and yield_policy == "now" and restart_policy == "never"


def victim_in_scope(requester: dict[str, Any], victim: dict[str, Any]) -> bool:
    if requester.get('preempt_idle_only') and not is_idle_victim(
        victim['priority'], victim.get('yield_policy','legacy'), victim['restart_policy'], victim.get('preempt_idle_only',False)
    ):
        return False
    return not requester.get('preempt_opt_in_only') or victim.get('yield_policy','legacy') in {'now','save'}


@dataclass(frozen=True, slots=True)
class VictimCandidate:
    attempt_id: str
    job_id: str
    priority: int
    gpu_count: int
    checkpoint_capability: str
    state: str = "RUNNING"
    gpu_uuids: tuple[str, ...] = ()
    takeover: bool = False
    yield_policy: str = "legacy"
    restart_policy: str = "on-preempt"
    preempt_idle_only: bool = False


def validate_yield_policy(value: Any, checkpoint_capability: str, share_gpu: bool) -> str:
    if not isinstance(value, str) or value not in {"legacy", "never", "now", "save"}:
        raise ValueError("yield_policy must be legacy, never, now or save")
    if value == "save" and checkpoint_capability != CheckpointCapability.EPOCH_V1.value:
        raise ValueError("--yield save requires --checkpointable and an epoch checkpoint adapter")
    if share_gpu and value in {"now", "save"}:
        raise ValueError("automatic yielding is not supported for shared GPU jobs")
    return value


def preemption_mode(mode: str, candidate: VictimCandidate) -> str | None:
    """Resolve requester intent against the victim's explicit contract."""
    if candidate.yield_policy == "never":
        return None
    if mode == DispatchMode.QUEUE.value:
        if candidate.yield_policy == "now":
            return DispatchMode.PREEMPT_NOW.value
        if candidate.yield_policy == "save" and candidate.checkpoint_capability == CheckpointCapability.EPOCH_V1.value:
            return DispatchMode.PREEMPT_SAVE.value
        return None
    if mode == DispatchMode.PREEMPT_SAVE.value or candidate.yield_policy == "save":
        return DispatchMode.PREEMPT_SAVE.value if candidate.checkpoint_capability == CheckpointCapability.EPOCH_V1.value else None
    return DispatchMode.PREEMPT_NOW.value




def select_scale_target(
    *,
    current_gpu_count: int,
    free_gpu_count: int,
    allowed_gpu_counts: Sequence[int],
) -> int | None:
    """Return the largest legal scale-up target reachable without preemption.

    The coordinator supplies already-confirmed idle capacity.  This pure policy
    function never rounds to an illegal world size and never recommends a
    no-op or scale-down.  A malformed scheduling contract fails closed instead
    of silently choosing a surprising allocation.
    """

    if (
        isinstance(current_gpu_count, bool)
        or not isinstance(current_gpu_count, int)
        or current_gpu_count <= 0
    ):
        raise ValueError("current_gpu_count must be a positive integer")
    if (
        isinstance(free_gpu_count, bool)
        or not isinstance(free_gpu_count, int)
        or free_gpu_count < 0
    ):
        raise ValueError("free_gpu_count must be a non-negative integer")
    counts = tuple(allowed_gpu_counts)
    if not counts or any(
        isinstance(value, bool) or not isinstance(value, int) or value <= 0
        for value in counts
    ):
        raise ValueError("allowed_gpu_counts must contain positive integers")
    if any(left >= right for left, right in zip(counts, counts[1:])):
        raise ValueError("allowed_gpu_counts must be strictly increasing")
    if current_gpu_count not in counts:
        raise ValueError("current_gpu_count must be an allowed GPU count")
    capacity = current_gpu_count + free_gpu_count
    candidates = [value for value in counts if current_gpu_count < value <= capacity]
    return candidates[-1] if candidates else None


def select_victims(
    *,
    requester_priority: int,
    requester_gpu_count: int,
    requester_min_gpu_count: int | None = None,
    free_gpu_count: int,
    dispatch_mode: str,
    candidates: Sequence[VictimCandidate],
    required_gpu_uuids: frozenset[str] | None = None,
    free_gpu_uuids: frozenset[str] = frozenset(),
    preempt_idle_only: bool = False,
    preempt_opt_in_only: bool = False,
) -> tuple[VictimCandidate, ...]:
    """Choose a deterministic, minimally harmful victim set.

    ``requester_gpu_count`` is the maximum allocation.  Elastic requests may
    provide a smaller ``requester_min_gpu_count`` launch floor; preemption
    satisfies only that floor and never interrupts extra work merely to reach
    the maximum.  Strict requests omit it (or set it equal to the maximum).

    Lower-priority jobs are preferred before higher-priority jobs.  Subject to
    that, the policy minimizes over-release, then new interruptions (an
    already-preempting takeover is preferred), then the number of interrupted
    jobs, and finally uses stable attempt IDs as a tie breaker.
    """

    mode = DispatchMode(dispatch_mode)
    minimum_gpu_count = (
        requester_gpu_count
        if requester_min_gpu_count is None
        else requester_min_gpu_count
    )
    if (
        minimum_gpu_count <= 0
        or requester_gpu_count <= 0
        or minimum_gpu_count > requester_gpu_count
    ):
        raise ValueError(
            "requester GPU counts must satisfy "
            "1 <= requester_min_gpu_count <= requester_gpu_count"
        )
    if required_gpu_uuids is None:
        needed = minimum_gpu_count - free_gpu_count
        if needed <= 0:
            return ()
        missing_required: frozenset[str] | None = None
    else:
        if minimum_gpu_count != requester_gpu_count:
            raise ValueError("pinned GPU requests cannot use an elastic minimum")
        if len(required_gpu_uuids) != requester_gpu_count:
            raise ValueError("pinned GPU set must match requester_gpu_count")
        missing_required = required_gpu_uuids - free_gpu_uuids
        if not missing_required:
            return ()
        needed = len(missing_required)
    eligible: list[VictimCandidate] = []
    for candidate in candidates:
        if preempt_opt_in_only and candidate.yield_policy not in {'now','save'}:
            continue
        if preempt_idle_only and not is_idle_victim(
            candidate.priority, candidate.yield_policy, candidate.restart_policy, candidate.preempt_idle_only
        ):
            continue
        if candidate.priority >= requester_priority or candidate.gpu_count <= 0:
            continue
        if candidate.state != "RUNNING":
            continue
        if preemption_mode(mode.value, candidate) is None:
            continue
        eligible.append(candidate)
    eligible.sort(key=lambda item: (item.priority, item.attempt_id))
    if not eligible:
        return ()
    if missing_required is not None:
        # Active leases make GPU ownership disjoint, so every missing pinned
        # UUID has exactly one possible victim.  Enforce that invariant here
        # instead of exploring an exponential set of redundant combinations.
        owner_by_uuid: dict[str, VictimCandidate] = {}
        for candidate in eligible:
            for uuid_value in missing_required.intersection(candidate.gpu_uuids):
                existing = owner_by_uuid.get(uuid_value)
                if existing is not None and existing.attempt_id != candidate.attempt_id:
                    raise ValueError("victim candidates overlap on a required GPU UUID")
                owner_by_uuid[uuid_value] = candidate
        if not missing_required.issubset(owner_by_uuid):
            return ()
        selected_ids = {
            owner_by_uuid[uuid_value].attempt_id for uuid_value in missing_required
        }
        return tuple(
            candidate for candidate in eligible if candidate.attempt_id in selected_ids
        )

    # Exact bounded knapsack.  At most one best subset is retained for each
    # (released capacity, highest victim priority) state.  An optimal subset
    # is inclusion-minimal, so its over-release is smaller than its largest
    # member; states beyond this bound cannot win.  This changes the old
    # 2**N enumeration into O(N * managed-GPU-count * priority-levels).
    maximum_candidate_size = max(item.gpu_count for item in eligible)
    release_limit = needed + maximum_candidate_size - 1
    states: dict[
        tuple[int, int],
        tuple[VictimCandidate, ...],
    ] = {(0, -1): ()}

    def tail_key(
        combination: tuple[VictimCandidate, ...],
    ) -> tuple[int, int, int, tuple[str, ...]]:
        return (
            sum(not item.takeover for item in combination),
            len(combination),
            sum(item.priority for item in combination),
            tuple(item.attempt_id for item in combination),
        )

    for candidate in eligible:
        updated = dict(states)
        for (released, highest_priority), combination in states.items():
            next_released = released + candidate.gpu_count
            if next_released > release_limit:
                continue
            next_highest = max(highest_priority, candidate.priority)
            next_combination = (*combination, candidate)
            state_key = (next_released, next_highest)
            current = updated.get(state_key)
            if current is None or tail_key(next_combination) < tail_key(current):
                updated[state_key] = next_combination
        states = updated

    choices = [
        (
            (
                highest_priority,
                released - needed,
                *tail_key(combination),
            ),
            combination,
        )
        for (released, highest_priority), combination in states.items()
        if released >= needed and combination
    ]
    if not choices:
        return ()
    return min(choices, key=lambda item: item[0])[1]



from __future__ import annotations

import math
import os
from dataclasses import dataclass
from typing import Literal, Mapping


BatchRounding = Literal["error", "floor", "ceil", "nearest"]
LearningRateRule = Literal["none", "linear", "sqrt"]
MAX_SIGNED_64 = 2**63 - 1
_ACTUAL_WORLD_SIZE_ENV = (
    "WORLD_SIZE",
    "GPUQ_ASSIGNED_GPU_COUNT",
    "GPUQ_ACTUAL_GPU_COUNT",
    "GPUQ_WORLD_SIZE",
)
_TARGET_GLOBAL_BATCH_ENV = "GPUQ_TARGET_GLOBAL_BATCH_SIZE"
_PER_DEVICE_MICRO_BATCH_ENV = "GPUQ_PER_DEVICE_MICRO_BATCH_SIZE"


def _positive_integer(value: object, name: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 1 <= value <= MAX_SIGNED_64
    ):
        raise ValueError(
            f"{name} must be a positive integer no greater than {MAX_SIGNED_64}"
        )
    return value


def _environment_integer(raw: str, name: str) -> int:
    if not raw.isascii() or not raw.isdecimal():
        raise ValueError(
            f"{name} must be a positive decimal integer no greater than "
            f"{MAX_SIGNED_64}"
        )
    value = int(raw)
    if not 1 <= value <= MAX_SIGNED_64:
        raise ValueError(
            f"{name} must be a positive decimal integer no greater than "
            f"{MAX_SIGNED_64}"
        )
    return value


def compatible_world_sizes(
    target_global_batch_size: int,
    per_device_micro_batch_size: int,
    min_world_size: int,
    max_world_size: int,
) -> tuple[int, ...]:
    """Return exact-batch-compatible world sizes within an inclusive range."""

    target = _positive_integer(
        target_global_batch_size,
        "target_global_batch_size",
    )
    micro_batch = _positive_integer(
        per_device_micro_batch_size,
        "per_device_micro_batch_size",
    )
    minimum = _positive_integer(min_world_size, "min_world_size")
    maximum = _positive_integer(max_world_size, "max_world_size")
    if minimum > maximum:
        raise ValueError("min_world_size must not exceed max_world_size")
    return tuple(
        world_size
        for world_size in range(minimum, maximum + 1)
        if target % (world_size * micro_batch) == 0
    )


def _resolve_batch_parameter(
    explicit: int | None,
    *,
    environment_name: str,
    parameter_name: str,
    environ: Mapping[str, str],
) -> int:
    if explicit is not None:
        return _positive_integer(explicit, parameter_name)
    raw = environ.get(environment_name)
    if raw is None:
        raise ValueError(
            f"{parameter_name} is unavailable; pass it explicitly or launch "
            f"through a batch-aware gpuq job"
        )
    return _environment_integer(raw, environment_name)


def resolve_world_size(
    world_size: int | None = None,
    *,
    environ: Mapping[str, str] | None = None,
) -> int:
    """Use the explicit worker count, then torchrun or gpuq's count."""

    if world_size is not None:
        return _positive_integer(world_size, "world_size")
    source = os.environ if environ is None else environ
    for name in _ACTUAL_WORLD_SIZE_ENV:
        raw = source.get(name)
        if raw is not None:
            return _environment_integer(raw, name)
    raise ValueError("world size is unavailable; pass world_size or launch through gpuq")


@dataclass(frozen=True, slots=True)
class ElasticBatchPlan:
    world_size: int
    target_global_batch_size: int
    per_device_micro_batch_size: int
    gradient_accumulation_steps: int
    effective_global_batch_size: int
    exact: bool
    lr_linear_scale: float

    def scale_learning_rate(
        self,
        base_learning_rate: float,
        *,
        rule: LearningRateRule = "linear",
    ) -> float:
        """Scale a reference LR explicitly; exact global batches return it unchanged."""

        if (
            isinstance(base_learning_rate, bool)
            or not isinstance(base_learning_rate, (int, float))
            or not math.isfinite(float(base_learning_rate))
            or base_learning_rate < 0
        ):
            raise ValueError("base_learning_rate must be a finite non-negative number")
        if rule == "none":
            factor = 1.0
        elif rule == "linear":
            factor = self.lr_linear_scale
        elif rule == "sqrt":
            factor = math.sqrt(self.lr_linear_scale)
        else:
            raise ValueError("learning-rate rule must be none, linear, or sqrt")
        return float(base_learning_rate) * factor


def plan_elastic_batch(
    target_global_batch_size: int | None = None,
    per_device_micro_batch_size: int | None = None,
    *,
    world_size: int | None = None,
    rounding: BatchRounding = "error",
    environ: Mapping[str, str] | None = None,
) -> ElasticBatchPlan:
    """Plan accumulation without silently changing optimization semantics.

    The default requires an exact integer accumulation count.  Explicit
    rounding returns both the resulting effective batch and its linear LR
    ratio so callers can make a project-specific learning-rate decision.
    """

    source = os.environ if environ is None else environ
    target = _resolve_batch_parameter(
        target_global_batch_size,
        environment_name=_TARGET_GLOBAL_BATCH_ENV,
        parameter_name="target_global_batch_size",
        environ=source,
    )
    micro_batch = _resolve_batch_parameter(
        per_device_micro_batch_size,
        environment_name=_PER_DEVICE_MICRO_BATCH_ENV,
        parameter_name="per_device_micro_batch_size",
        environ=source,
    )
    resolved_world_size = resolve_world_size(
        world_size,
        environ=source,
    )
    if rounding not in {"error", "floor", "ceil", "nearest"}:
        raise ValueError("rounding must be error, floor, ceil, or nearest")

    samples_per_micro_step = resolved_world_size * micro_batch
    quotient, remainder = divmod(target, samples_per_micro_step)
    if remainder == 0:
        accumulation_steps = quotient
    elif rounding == "error":
        raise ValueError(
            "target global batch is not divisible by "
            "world_size * per_device_micro_batch_size"
        )
    elif rounding == "floor":
        if quotient < 1:
            raise ValueError("floor rounding would produce zero accumulation steps")
        accumulation_steps = quotient
    elif rounding == "ceil":
        accumulation_steps = quotient + 1
    else:
        lower = quotient if quotient >= 1 else None
        upper = quotient + 1
        candidates = [upper] if lower is None else [lower, upper]
        # Prefer the larger effective batch on an exact-distance tie.
        accumulation_steps = min(
            candidates,
            key=lambda steps: (
                abs(samples_per_micro_step * steps - target),
                -steps,
            ),
        )

    effective = samples_per_micro_step * accumulation_steps
    return ElasticBatchPlan(
        world_size=resolved_world_size,
        target_global_batch_size=target,
        per_device_micro_batch_size=micro_batch,
        gradient_accumulation_steps=accumulation_steps,
        effective_global_batch_size=effective,
        exact=effective == target,
        lr_linear_scale=effective / target,
    )

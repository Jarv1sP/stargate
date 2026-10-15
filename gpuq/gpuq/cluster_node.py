"""Local admission remains atomic with the existing GPUQ leases/outbox.

Receipts live in the existing transactional settings table. A rejected token
stays rejected even if retried after more capacity becomes free. Thus a hub
can safely try another host only after observing a durable rejection.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import subprocess
import uuid
from typing import Any

from .constants import JobState
from .policy import select_victims
from .rpc import ApiError
from .submission import validate_submission


def preflight(config_path: str, spec: dict[str, Any]) -> dict[str, Any]:
    from .cli import build_parser, prepare_submission
    from .config import Config
    try:
        args = build_parser().parse_args(["--config", config_path, *spec["args"]])
    except SystemExit as exc:
        raise ValueError("invalid node submission arguments") from exc
    if args.elastic_start and args.gpus:
        # A six-GPU host can still run a [2,8] elastic task. Its local maximum
        # becomes six; exact batch-compatible counts are computed as usual.
        args.gpus = min(args.gpus, len(Config.from_json(config_path).managed_gpu_uuids))
    config, submission = prepare_submission(args)
    cwd = Path(submission["cwd"])
    paths = list(spec.get("require_paths", []))
    command = submission["argv"]
    for value in paths:
        path = Path(value)
        if not path.is_absolute():
            path = cwd / path
        if not path.exists() or not os.access(path, os.R_OK):
            raise ValueError(f"required path is missing/unreadable: {path}")
    modules = list(spec.get("require_modules", []))
    if modules:
        if not Path(command[0]).name.startswith("python"):
            raise ValueError("--require-module needs an explicit Python interpreter")
        for module in modules:
            if not re.fullmatch(r"[A-Za-z_]\w*(\.[A-Za-z_]\w*)*", module):
                raise ValueError("invalid Python module: " + module)
        probe = subprocess.run([command[0], "-c", "import importlib.util,json,sys; m=json.loads(sys.argv[1]); sys.exit(0 if all(importlib.util.find_spec(x) is not None for x in m) else 1)", json.dumps(modules)], cwd=cwd, env={**os.environ, **submission["env"]}, capture_output=True, timeout=15)
        if probe.returncode:
            raise ValueError("required Python modules unavailable: " + ",".join(modules))
    model = spec.get("gpu_model")
    minimum = spec.get("min_vram_mb", 0)
    if model or minimum:
        # This version only admits homogeneous matching pools so elastic
        # restarts and expansions cannot later escape the hardware contract.
        result = subprocess.check_output(["nvidia-smi", "--query-gpu=uuid,name,memory.total", "--format=csv,noheader,nounits"], text=True, timeout=10)
        devices = {r[0].strip(): (r[1].strip(), int(r[2].strip())) for line in result.splitlines() if len(r := line.split(",")) == 3}
        for gpu_uuid in config.managed_gpu_uuids:
            name, memory = devices[gpu_uuid]
            if (model and model.lower() not in name.lower()) or memory < minimum:
                raise ValueError(f"pool hardware does not match: {name}, {memory} MiB")
    from .protocol import Client
    offer = Client(config.socket_path, timeout=15).call("fleet_offer", {"submission": submission})
    return {"submission": submission, **offer}


def offer(coordinator: Any, submission: dict[str, Any], allow_preempt: bool = True) -> dict[str, Any]:
    if coordinator.health_name != "ok":
        return {"kind": "unavailable", "reason": "node status is unknown; retry with the same admission token"}
    if coordinator.observe_only:
        return {"kind": "busy", "reason": "node is in observe-only mode"}
    if submission.get("share_gpu"):
        raise ValueError("cluster placement does not support sharing; select --host explicitly")
    pending = coordinator.store.list_jobs(states=[JobState.PENDING], limit=10000)
    if any(not j.get("share_gpu") and j["priority"] >= submission["priority"] for j in pending):
        return {"kind": "busy", "reason": "earlier equal/higher-priority local queue"}
    free = coordinator._free_devices()
    selected = coordinator._select_free_devices_for_job(submission, free)
    if selected:
        return {"kind": "idle", "count": len(selected)}
    if allow_preempt:
        legal = coordinator._allowed_gpu_counts(submission)
        victims = select_victims(
            requester_priority=submission["priority"], requester_gpu_count=submission["gpu_count"],
            requester_min_gpu_count=legal[0], free_gpu_count=len(free),
            dispatch_mode=submission["dispatch_mode"], candidates=coordinator._running_candidates(),
            required_gpu_uuids=frozenset(submission["requested_gpu_uuids"]) if submission["placement"] == "pinned" else None,
            free_gpu_uuids=frozenset(d.uuid for d in free),
            preempt_idle_only=bool(submission.get("preempt_idle_only", False)),
            preempt_opt_in_only=bool(submission.get("preempt_opt_in_only", False)),
        )
        if victims:
            return {"kind": "preempt", "count": legal[0]}
    return {"kind": "busy", "reason": "insufficient eligible GPUs"}


def node_api(coordinator: Any, operation: str, arguments: dict[str, Any]) -> dict[str, Any]:
    def validated() -> dict[str, Any]:
        config = coordinator.config
        return validate_submission(arguments["submission"], len(config.managed_gpu_uuids), max_request_bytes=config.max_request_bytes, managed_gpu_uuids=config.managed_gpu_uuids)
    if operation == "fleet_offer":
        return offer(coordinator, validated())
    allowed = {"token", "job_id"} if operation == "fleet_retry" else {"token", "submission", "allow_preempt"}
    arguments = {key: value for key, value in arguments.items() if key in allowed}
    token = str(uuid.UUID(arguments["token"]))
    key = "fleet.admission." + token
    with coordinator.store.transaction() as tx:
        old = tx.get_setting(key)
        if old is not None:
            return old["result"]
        if "submission" in arguments:
            arguments["submission"] = validated()
        if operation == "fleet_retry":
            result = coordinator._api_retry({"job_id": arguments["job_id"]})
            tx.set_setting(key, {"result": result})
            return result
        try:
            submission = arguments["submission"]
            choice = offer(coordinator, submission, arguments.get("allow_preempt") is True)
        except (ValueError, OSError, ApiError) as exc:
            choice = {"kind": "busy", "reason": str(exc)}
        if choice["kind"] == "unavailable":
            raise ApiError("UNAVAILABLE", choice["reason"])
        if choice["kind"] == "busy":
            result = {"accepted": False, "reason": choice["reason"]}
        else:
            # No socket or systemd operation occurs in this transaction.
            # Job, leases/preemption decisions, outbox and receipt commit together.
            submitted = coordinator._api_submit(submission)
            job = tx.get_job(submitted["job_id"])
            if job["state"] != "PENDING":
                result = {"accepted": True, "job_id": job["id"]}
            else:
                free = coordinator._free_devices()
                selected = coordinator._select_free_devices_for_job(job, free)
                if selected:
                    coordinator._plan_start(job, selected)
                else:
                    victims = select_victims(
                        requester_priority=job["priority"], requester_gpu_count=job["gpu_count"],
                        requester_min_gpu_count=coordinator._allowed_gpu_counts(job)[0], free_gpu_count=len(free),
                        dispatch_mode=job["dispatch_mode"], candidates=coordinator._running_candidates(),
                        required_gpu_uuids=frozenset(job["requested_gpu_uuids"]) if job["placement"] == "pinned" else None,
                        free_gpu_uuids=frozenset(d.uuid for d in free),
                        preempt_idle_only=bool(job.get("preempt_idle_only", False)),
                        preempt_opt_in_only=bool(job.get("preempt_opt_in_only", False)),
                    )
                    if not victims:
                        raise RuntimeError("admission changed under coordinator lock")
                    coordinator._plan_preemption(job, victims)
                result = {"accepted": True, "job_id": job["id"]}
        tx.set_setting(key, {"result": result})
        return result

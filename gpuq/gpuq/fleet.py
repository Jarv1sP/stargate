"""SSH front end. Each host remains the sole authority for its own leases."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import uuid
from typing import Any, Sequence

ALLOWED = {'_cluster', 'attach', 'cancel', 'events', 'health', 'list', 'logs', 'q', 'queue', 'retry', 'run', 'set-display', 'set-priority', 'set-rank', 'show', 'status', 'submit', 'watch'}
MAX_PACKET = 1024 * 1024


def host_paths(host: dict[str, Any]) -> tuple[str, str]:
    """Require explicit remote paths; never guess the service user's home."""
    paths = []
    for key in ("binary", "config"):
        # Private deployment: retain existing inventory path defaults.
        defaults = {"binary": "/home/platform-user/bin/gpu", "config": "/data1/gpu-scheduler/config.json"}
        value = host.get(key, defaults[key])
        if not isinstance(value, str) or not value.startswith("/") or any(ord(c) < 32 or ord(c) == 127 for c in value):
            raise ValueError(f"fleet host requires explicit absolute {key} path")
        paths.append(value)
    return paths[0], paths[1]


def load_inventory(path: str | Path) -> dict[str, Any]:
    data = json.loads(Path(path).read_text())
    if not isinstance(data, dict) or not isinstance(data.get("hosts"), dict) or not data["hosts"]:
        raise ValueError("fleet inventory needs a nonempty hosts object")
    for name, host in data["hosts"].items():
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", name) or not isinstance(host, dict):
            raise ValueError("invalid fleet host")
        destination = host.get("ssh", name)
        if not isinstance(destination, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.@:-]*", destination):
            raise ValueError("invalid SSH destination")
        try:
            host_paths(host)
        except ValueError as exc:
            raise ValueError(f"{name}: {exc}") from exc
        for key in ("identity_file", "known_hosts_file"):
            if key in host and (not isinstance(host[key], str) or not host[key].startswith("/") or any(ord(c) < 32 for c in host[key])):
                raise ValueError(f"{key} must be an absolute path")
    if data.get("local_host") is not None and data["local_host"] not in data["hosts"]:
        raise ValueError("local_host must be in hosts")
    if data.get("coordinator") is not None and data["coordinator"] not in data["hosts"]:
        raise ValueError("coordinator must be in hosts")
    return data


def validate_remote_argv(argv: Any) -> str:
    if not isinstance(argv, list) or not argv or not all(isinstance(v, str) and "\0" not in v for v in argv):
        raise ValueError("invalid remote argv")
    offset = 1 if argv[0] == "--json" else 0
    if offset >= len(argv) or argv[offset] not in ALLOWED:
        raise ValueError("remote command is not allowed")
    options = argv[offset + 1:argv.index("--") if "--" in argv else len(argv)]
    for value in options:
        if value.split("=", 1)[0] in {"--host", "--fleet-config", "--all-hosts", "--config"}:
            raise ValueError("nested remote routing is not allowed")
    # Also catch argparse abbreviations, e.g. q --all-h.
    from .cli import build_parser
    parsed = build_parser().parse_args(argv)
    if parsed.host or getattr(parsed, "all_hosts", False):
        raise ValueError("nested remote routing is not allowed")
    return argv[offset]


def remote_entry(config: str) -> int:
    from .sync import forced_receiver
    transfer_result = forced_receiver(config)
    if transfer_result is not None:
        return transfer_result
    raw = sys.stdin.buffer.read(MAX_PACKET + 1)
    if len(raw) > MAX_PACKET:
        raise ValueError("remote packet is too large")
    packet = json.loads(raw)
    if not isinstance(packet, dict):
        raise ValueError("invalid remote packet")
    validate_remote_argv(packet["argv"])
    from .cli import main
    return main(["--config", config, *packet["argv"]])


def ssh_command(host: dict[str, Any]) -> list[str]:
    binary, config = host_paths(host)
    cmd = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2"]
    if host.get("identity_file"):
        cmd += ["-o", "IdentitiesOnly=yes", "-i", host["identity_file"]]
    if host.get("known_hosts_file"):
        cmd += ["-o", "UserKnownHostsFile=" + host["known_hosts_file"]]
    command = [binary, "--config", config, "_remote"]
    return [*cmd, host["ssh"], shlex.join(command)]


def packet(argv: list[str]) -> bytes:
    validate_remote_argv(argv)
    value = json.dumps({"version": 1, "argv": argv}).encode()
    if len(value) > MAX_PACKET:
        raise ValueError("remote packet is too large")
    return value


def forward(inventory: dict[str, Any], name: str, argv: list[str]) -> int:
    if name not in inventory["hosts"]:
        raise ValueError(f"unknown fleet host: {name}")
    command = validate_remote_argv(argv)
    argv = list(argv)
    submit_key = None
    if command in {"submit", "run"}:
        if "--" not in argv:
            raise ValueError("remote submission requires -- before the training command")
        boundary = argv.index("--")
        options = argv[:boundary]
        if not any(v == "--cwd" or v.startswith("--cwd=") for v in options):
            raise ValueError("remote submission requires explicit --cwd on the target host")
        if "--submit-key" in options:
            submit_key = options[options.index("--submit-key") + 1]
        else:
            submit_key = next((v.split("=", 1)[1] for v in options if v.startswith("--submit-key=")), None)
        if submit_key is None:
            submit_key = str(uuid.uuid4())
            argv[boundary:boundary] = ["--submit-key", submit_key]
        owner = os.environ.get("GPUQ_SUBMITTER") or os.environ.get("GPUQ_OWNER")
        if owner and not any(v.split("=", 1)[0] in {"-u", "--owner", "--submitter"} for v in options):
            argv[argv.index("--"):argv.index("--")] = ["--submitter", owner]
        print(f"[{name}] submit-key={submit_key} (reuse this key if the connection fails)", file=sys.stderr)
    host = inventory["hosts"][name]
    if inventory.get("local_host") == name:
        from .cli import main
        return main(["--config", host_paths(host)[1], *argv])
    try:
        return subprocess.run(ssh_command({"ssh": name, **host}), input=packet(argv), check=False).returncode
    except KeyboardInterrupt:
        print("Detached; remote job was not canceled. Query by host and job ID.", file=sys.stderr)
        return 130


def query_all(inventory: dict[str, Any], *, all_jobs: bool = False, limit: int = 100, as_json: bool = False) -> int:
    argv = ["--json", "q", "--limit", str(limit)] + (["--all"] if all_jobs else [])
    def query(item: tuple[str, dict[str, Any]]) -> tuple[str, dict[str, Any]]:
        name, host = item
        try:
            if inventory.get("local_host") == name:
                from .config import Config
                from .protocol import Client
                config = Config.from_json(host_paths(host)[1])
                result = Client(config.socket_path, timeout=10).call("status", {"all": all_jobs, "limit": limit})
            else:
                completed = subprocess.run(ssh_command({"ssh": name, **host}), input=packet(argv), capture_output=True, timeout=15, check=False)
                if completed.returncode:
                    raise ValueError(completed.stderr.decode(errors="replace").strip() or f"remote exit {completed.returncode}")
                result = json.loads(completed.stdout)
            if not isinstance(result, dict) or "daemon" not in result or "jobs" not in result:
                raise ValueError("invalid status response")
            return name, {"reachable": True, "status": result}
        except Exception as exc:
            return name, {"reachable": False, "error": str(exc)}
    with ThreadPoolExecutor(max_workers=min(8, len(inventory["hosts"]))) as pool:
        results = dict(pool.map(query, inventory["hosts"].items()))
    fleet_queue = None
    fleet_error = None
    if inventory.get("coordinator"):
        from .cluster import hub_call
        try:
            fleet_queue = hub_call(inventory, "status", {"all": all_jobs, "limit": limit})
        except Exception as exc:
            fleet_error = str(exc)
    if as_json:
        print(json.dumps({"hosts": results, "fleet": fleet_queue, "fleet_error": fleet_error}, ensure_ascii=False))
    else:
        if fleet_queue is not None:
            from .cluster import print_queue
            print_queue(fleet_queue)
        if fleet_error:
            print("FLEET UNKNOWN: " + fleet_error)
        from .cli import format_status_table
        for name, item in results.items():
            print(f"\n=== {name} ===")
            if not item["reachable"]:
                print("UNKNOWN / 不可达: " + item["error"])
                continue
            status = item["status"]
            daemon = status["daemon"]
            print(f"health={daemon.get('health')}; capacity={daemon.get('capacity_health')}; schedulable={daemon.get('schedulable_gpu_indices', [])}")
            indices = {v["uuid"]: str(v["index"]) for v in daemon.get("managed_gpus", [])}
            for line in format_status_table(status["jobs"], indices):
                print(line)
            for gpu in status.get("gpu_usage", []):
                print(f"GPU {gpu['index']}: VRAM {gpu['memory_used_mb']}/{gpu['memory_total_mb']} MiB; shared={gpu['shared_jobs']}")
            for external in status.get("external", []):
                print("protected external: " + json.dumps(external, ensure_ascii=False))
    return 0 if not fleet_error and all(v["reachable"] for v in results.values()) else 2


def routing_argv(argv: Sequence[str]) -> list[str]:
    """Remove frontend globals only, never tokens from the training command."""
    remaining: list[str] = []
    i = 0
    while i < len(argv):
        value = argv[i]
        if not value.startswith("-"):
            remaining.extend(argv[i:])
            break
        if value in {"--host", "--fleet-config", "--config"}:
            i += 2
            continue
        if any(value.startswith(k + "=") for k in ("--host", "--fleet-config", "--config")):
            i += 1
            continue
        remaining.append(value)
        i += 1
    return remaining

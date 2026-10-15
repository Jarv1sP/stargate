"""Single-authority durable fleet queue, using LAN SSH and local GPUQ admission.

There is deliberately no automatic leader failover. An ambiguous dispatch is
replayed only against the same node/token; only a durable rejection releases
the task to try another node. Running/resuming jobs stay on that node.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import logging
import math
import os
from pathlib import Path
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid
from typing import Any, Sequence

from .config import Config
from .fleet import load_inventory, packet, ssh_command
from .protocol import Client, ProtocolError
from .rpc import RpcServer

LOG = logging.getLogger(__name__)
TERMINAL = {"SUCCEEDED", "FAILED", "CANCELED", "LOST"}
SUBMIT_EXTRAS = {"--hosts", "--require-path", "--require-module", "--gpu-model", "--min-vram-gb"}
DB_NAME = "fleet.db"
APP_ID = 0x46515431


def socket_path() -> Path:
    return Path(f"/run/user/{os.getuid()}/gpuq-fleet/fleet.sock")


def json_text(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def local_rpc(scope: str, operation: str, payload: dict[str, Any], config_path: str) -> Any:
    if scope == "hub":
        if operation not in {"submit", "status", "show", "cancel", "resolve", "retry", "board_list", "board_post", "board_delete"}:
            raise ValueError("unsupported fleet operation")
        return Client(socket_path(), timeout=25).call(operation, payload)
    if operation == "preflight":
        from .cluster_node import preflight
        try:
            return preflight(config_path, payload)
        except (ValueError, OSError, subprocess.SubprocessError, ProtocolError) as exc:
            return {"kind": "unavailable", "reason": str(exc)}
    config = Config.from_json(config_path)
    if operation not in {"fleet_admit", "fleet_retry", "job_watch", "cancel"}:
        raise ValueError("unsupported node operation")
    return Client(config.socket_path, timeout=20).call(operation, payload)


def rpc_to(inventory: dict[str, Any], host: str, scope: str, operation: str, payload: dict[str, Any]) -> Any:
    node = inventory["hosts"][host]
    if inventory.get("local_host") == host:
        return local_rpc(scope, operation, payload, node.get("config", "/data1/gpu-scheduler/config.json"))
    argv = ["_cluster", scope, operation, json_text(payload)]
    result = subprocess.run(ssh_command({"ssh": host, **node}), input=packet(argv), capture_output=True, timeout=25)
    if result.returncode:
        raise ProtocolError(result.stderr.decode(errors="replace").strip() or result.stdout.decode(errors="replace")[:1000])
    data = json.loads(result.stdout)
    if isinstance(data, dict) and data.get("ok") is False:
        raise ProtocolError(str(data.get("error")))
    return data


def rpc_entry(args: Any) -> int:
    payload = json.loads(args.payload)
    if not isinstance(payload, dict):
        raise ValueError("cluster payload must be an object")
    print(json_text(local_rpc(args.scope, args.operation, payload, args.config)))
    return 0


class QueueStore:
    def __init__(self, path: Path, *, initialize: bool = False):
        if not initialize and not path.is_file():
            raise ValueError("fleet database is missing; refusing to create an empty replacement")
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None, timeout=10)
        self.conn.row_factory = sqlite3.Row
        if initialize:
            self.conn.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self.conn.executescript(f"""
                BEGIN IMMEDIATE;
                CREATE TABLE IF NOT EXISTS fleet_jobs (
                  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                  id TEXT UNIQUE NOT NULL, submit_key TEXT UNIQUE NOT NULL,
                  digest TEXT NOT NULL, spec TEXT NOT NULL, priority INTEGER NOT NULL,
                  name TEXT NOT NULL, owner TEXT NOT NULL,
                  state TEXT NOT NULL DEFAULT 'PENDING', created REAL NOT NULL,
                  updated REAL NOT NULL, target TEXT, token TEXT, admission TEXT,
                  remote_job TEXT, cancel_requested INTEGER NOT NULL DEFAULT 0,
                  reasons TEXT NOT NULL DEFAULT '{{}}', snapshot TEXT
                );
                CREATE TABLE IF NOT EXISTS board (
                  id INTEGER PRIMARY KEY AUTOINCREMENT, message_key TEXT UNIQUE NOT NULL,
                  owner TEXT NOT NULL, body TEXT NOT NULL, created REAL NOT NULL,
                  job_id TEXT, job_host TEXT
                );
                CREATE TABLE IF NOT EXISTS board_receipts (
                  message_key TEXT PRIMARY KEY, digest TEXT NOT NULL,
                  message_id INTEGER NOT NULL, created REAL NOT NULL
                );
                PRAGMA application_id={APP_ID}; PRAGMA user_version=1;
                COMMIT;
            """)
            os.chmod(path, 0o600)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=FULL")

    def close(self) -> None:
        self.conn.close()

    @staticmethod
    def decode(row: Any) -> dict[str, Any]:
        result = dict(row)
        for key in ("spec", "reasons", "admission", "snapshot"):
            result[key] = json.loads(result[key]) if result[key] is not None else None
        return result

    def get(self, job_id: str) -> dict[str, Any]:
        with self.lock:
            row = self.conn.execute("SELECT * FROM fleet_jobs WHERE id=?", (job_id,)).fetchone()
            if row is None:
                raise ValueError("unknown fleet job: " + job_id)
            return self.decode(row)

    def rows(self, *, all_jobs: bool = False, limit: int = 1000) -> list[dict[str, Any]]:
        with self.lock:
            query = "SELECT * FROM fleet_jobs"
            if not all_jobs:
                query += " WHERE state NOT IN ('SUCCEEDED','FAILED','CANCELED','LOST')"
            query += " ORDER BY priority DESC, sequence LIMIT ?"
            return [self.decode(row) for row in self.conn.execute(query, (limit,))]

    def update(self, job_id: str, **values: Any) -> None:
        allowed = {"state", "target", "token", "admission", "remote_job", "cancel_requested", "reasons", "snapshot"}
        values = {key: value for key, value in values.items() if key in allowed}
        values["updated"] = time.time()
        with self.lock:
            self.conn.execute("UPDATE fleet_jobs SET " + ",".join(k + "=?" for k in values) + " WHERE id=?", (*[json_text(v) if k in {"admission", "reasons", "snapshot"} and v is not None else v for k, v in values.items()], job_id))

    def submit(self, spec: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any]:
        digest = hashlib.sha256(json_text(spec).encode()).hexdigest()
        with self.lock:
            old = self.conn.execute("SELECT * FROM fleet_jobs WHERE submit_key=?", (identity["submit_key"],)).fetchone()
            if old is not None:
                if old["digest"] != digest:
                    raise ValueError("submit-key reused with different fleet submission")
                return self.decode(old)
            job_id = "F" + uuid.uuid4().hex[:16]
            now = time.time()
            self.conn.execute("INSERT INTO fleet_jobs(id,submit_key,digest,spec,priority,name,owner,created,updated) VALUES(?,?,?,?,?,?,?,?,?)", (job_id, identity["submit_key"], digest, json_text(spec), identity["priority"], identity["name"], identity["owner"], now, now))
            return self.get(job_id)

    def board(self, op: str, data: dict[str, Any]) -> Any:
        with self.lock:
            if op == "board_list":
                limit = data.get("limit", 20)
                if type(limit) is not int or not 1 <= limit <= 100:
                    raise ValueError("board limit must be 1..100")
                return {"messages": [dict(row) for row in self.conn.execute("SELECT id,owner,body,created,job_id,job_host FROM board ORDER BY id DESC LIMIT ?", (limit,))]}
            if op == "board_post":
                from .util import validate_label
                raw_owner = data.get("owner")
                if not isinstance(raw_owner, str):
                    raise ValueError("message owner must be a string")
                owner = validate_label(raw_owner, "owner")
                key = str(uuid.UUID(data["message_key"]))
                body = data.get("body")
                if not isinstance(body, str) or not body.strip() or len(body) > 2000 or any((ord(c) < 32 and c not in "\n\t") or 127 <= ord(c) < 160 for c in body):
                    raise ValueError("message must contain 1..2000 characters without terminal control codes")
                digest = hashlib.sha256(json_text({"owner": owner, "body": body, "job_id": data.get("job_id"), "job_host": data.get("job_host")}).encode()).hexdigest()
                old = self.conn.execute("SELECT * FROM board_receipts WHERE message_key=?", (key,)).fetchone()
                if old:
                    exists = self.conn.execute("SELECT 1 FROM board WHERE id=?", (old["message_id"],)).fetchone()
                    return {"message_id": "B" + str(old["message_id"]), "deleted": not bool(exists)}
                now = time.time()
                self.conn.execute("BEGIN IMMEDIATE")
                try:
                    cursor = self.conn.execute("INSERT INTO board(message_key,owner,body,created,job_id,job_host) VALUES(?,?,?,?,?,?)", (key, owner, body, now, data.get("job_id"), data.get("job_host")))
                    message_id = cursor.lastrowid
                    self.conn.execute("INSERT INTO board_receipts VALUES(?,?,?,?)", (key, digest, message_id, now))
                    self.conn.execute("COMMIT")
                except BaseException:
                    self.conn.execute("ROLLBACK")
                    raise
                return {"message_id": "B" + str(message_id), "deleted": False}
            if op == "board_delete":
                value = data.get("message_id", "")
                if not isinstance(value, str) or not value.startswith("B") or not value[1:].isdigit():
                    raise ValueError("message ID must be B followed by digits")
                self.conn.execute("DELETE FROM board WHERE id=?", (int(value[1:]),))
                return {"message_id": value, "deleted": True}
            raise ValueError("unknown board operation")

    def cleanup_board(self, terminal_local: Sequence[tuple[str, str]] = ()) -> None:
        with self.lock:
            self.conn.execute("DELETE FROM board WHERE job_host IS NULL AND job_id IN (SELECT id FROM fleet_jobs WHERE state IN ('SUCCEEDED','FAILED','CANCELED','LOST'))")
            self.conn.executemany("DELETE FROM board WHERE job_host=? AND job_id=?", terminal_local)
            # Deleted message bodies are not retained as soft-deleted rows.
            # Only bounded, text-free retry receipts remain for up to 7 days.
            self.conn.execute("DELETE FROM board_receipts WHERE created<? OR message_key NOT IN (SELECT message_key FROM board_receipts ORDER BY created DESC LIMIT 10000)", (time.time() - 7 * 86400,))
            self.conn.execute("PRAGMA incremental_vacuum(100)")
            self.conn.execute("PRAGMA wal_checkpoint(PASSIVE)")

    def board_local_jobs(self) -> list[tuple[str, str]]:
        with self.lock:
            return [tuple(row) for row in self.conn.execute("SELECT DISTINCT job_host,job_id FROM board WHERE job_host IS NOT NULL")]


def validate_spec(spec: Any, inventory: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    from .cli import build_parser, resolve_job_identity
    if not isinstance(spec, dict):
        raise ValueError("fleet submission must be an object")
    spec = {key: value for key, value in spec.items() if key in {"args", "hosts", "require_paths", "require_modules", "gpu_model", "min_vram_mb"}}
    hosts = spec["hosts"]
    if not isinstance(hosts, list) or not hosts or len(set(hosts)) != len(hosts) or not all(h in inventory["hosts"] for h in hosts):
        raise ValueError("unknown/duplicate/empty candidate hosts")
    argv = spec["args"]
    if not isinstance(argv, list) or not argv or argv[0] not in {"submit", "run"} or not all(isinstance(v, str) and "\0" not in v for v in argv):
        raise ValueError("invalid fleet submit argv")
    if len(json_text(spec).encode()) > 180000:
        raise ValueError("fleet submission is too large")
    if "--" not in argv:
        raise ValueError("cluster submit requires -- before training command")
    try:
        parsed = build_parser().parse_args(argv)
    except SystemExit as exc:
        raise ValueError("invalid fleet submission arguments") from exc
    if parsed.hosts or parsed.host or parsed.watch or parsed.share or parsed.hami or parsed.sm_percent:
        raise ValueError("unsupported nested routing/watch/sharing in fleet submission")
    if any((parsed.require_path, parsed.require_module, parsed.gpu_model, parsed.min_vram_gb)):
        raise ValueError("fleet constraints must be explicit specification fields")
    if not parsed.cwd or not Path(parsed.cwd).is_absolute():
        raise ValueError("cluster submit requires an absolute --cwd on the candidates")
    command = list(parsed.command)
    if command and command[0] == "--":
        command.pop(0)
    if not command or not Path(command[0]).is_absolute():
        raise ValueError("cluster submit requires an absolute executable/interpreter path")
    key = str(uuid.UUID(parsed.submit_key))
    if parsed.gpus is not None and not 1 <= parsed.gpus <= 1024:
        raise ValueError("GPU count must be 1..1024")
    if parsed.min_gpus is not None and (not parsed.elastic_start or not parsed.gpus or not 1 <= parsed.min_gpus <= parsed.gpus):
        raise ValueError("invalid elastic minimum GPU count")
    name, owner = resolve_job_identity(command, requested_name=parsed.name, requested_owner=parsed.owner)
    for field in ("require_paths", "require_modules"):
        values = spec[field]
        if not isinstance(values, list) or len(values) > 64 or not all(isinstance(v, str) and v and "\0" not in v for v in values):
            raise ValueError("invalid " + field)
    if spec["gpu_model"] is not None and (not isinstance(spec["gpu_model"], str) or not spec["gpu_model"].strip()):
        raise ValueError("invalid GPU model")
    if type(spec["min_vram_mb"]) is not int or not 0 <= spec["min_vram_mb"] < 2**31:
        raise ValueError("invalid minimum VRAM")
    return spec, {"submit_key": key, "priority": parsed.priority, "name": name, "owner": owner}


class FleetCoordinator:
    def __init__(self, store: QueueStore, inventory: dict[str, Any], transport: Any = rpc_to):
        self.store, self.inventory, self.transport = store, inventory, transport
        # Serializes placement/cancel decisions, not the (slow) network calls.
        self.decision = threading.RLock()
        self.board_checked_at = 0.0

    @staticmethod
    def public(job: dict[str, Any]) -> dict[str, Any]:
        return {k: job[k] for k in ("id", "submit_key", "priority", "name", "owner", "state", "created", "updated", "target", "remote_job", "cancel_requested", "reasons", "snapshot")} | {"hosts": job["spec"]["hosts"]}

    def api(self, op: str, data: dict[str, Any]) -> Any:
        if op == "board_post" and data.get("job_id") is None and data.get("job_host") is not None:
            raise ValueError("non-task messages cannot have a task host")
        if op == "board_post" and data.get("job_id") is not None:
            job_id = data["job_id"]
            host = data.get("job_host")
            if not isinstance(job_id, str):
                raise ValueError("invalid attached job ID")
            if job_id.startswith("F"):
                if host is not None:
                    raise ValueError("F jobs do not need --on-host")
                state = self.store.get(job_id)["state"]
            elif job_id.startswith("J") and isinstance(host, str) and host in self.inventory["hosts"]:
                state = self.node(host, "job_watch", {"job_id": job_id})["job"]["state"]
            else:
                raise ValueError("task messages need an F ID or a J ID with a valid host")
            if state in TERMINAL:
                raise ValueError("task has already ended; use --general for a persistent message")
        with self.decision:
            if op in {"board_list", "board_post", "board_delete"}:
                return self.store.board(op, data)
            if op == "submit":
                spec, identity = validate_spec(data, self.inventory)
                return self.public(self.store.submit(spec, identity))
            if op == "status":
                limit = data.get("limit", 100)
                if type(limit) is not int or not 1 <= limit <= 1000:
                    raise ValueError("fleet limit must be 1..1000")
                return {"jobs": [self.public(j) for j in self.store.rows(all_jobs=data.get("all") is True, limit=limit)]}
            job = self.store.get(data["job_id"])
            if op in {"show", "resolve"}:
                return self.public(job)
            if op == "cancel":
                if job["state"] not in TERMINAL:
                    self.store.update(job["id"], cancel_requested=1, state="CANCELING" if job["token"] else "CANCELED")
                return self.public(self.store.get(job["id"]))
            if op == "retry":
                if job["state"] not in TERMINAL:
                    raise ValueError("only terminal fleet jobs can be retried")
                # Retry remains on the admitted machine; there is no implicit
                # cross-host checkpoint transfer or loss of local lineage.
                if job["remote_job"]:
                    self.store.update(job["id"], state="RETRYING", cancel_requested=0, admission={"token": str(uuid.uuid4()), "job_id": job["remote_job"]})
                else:
                    self.store.update(job["id"], state="PENDING", cancel_requested=0)
                return self.public(self.store.get(job["id"]))
            raise ValueError("unknown fleet operation")

    def node(self, host: str, op: str, data: dict[str, Any]) -> Any:
        return self.transport(self.inventory, host, "node", op, data)

    def process(self, job: dict[str, Any], blocked_hosts: set[str] | None = None) -> set[str]:
        job_id = job["id"]
        if job["remote_job"]:
            if job["cancel_requested"]:
                self.node(job["target"], "cancel", {"job_id": job["remote_job"]})
            if job["state"] == "RETRYING":
                self.node(job["target"], "fleet_retry", job["admission"])
            snapshot = self.node(job["target"], "job_watch", {"job_id": job["remote_job"]})
            with self.decision:
                latest = self.store.get(job_id)
                state = snapshot["job"]["state"]
                if latest["cancel_requested"] and state not in TERMINAL:
                    state = "CANCELING"
                self.store.update(job_id, state=state, snapshot=snapshot, reasons={})
            return set()
        if not job["token"]:
            if job["cancel_requested"]:
                self.store.update(job_id, state="CANCELED")
                return set()
            def probe(host: str) -> tuple[str, dict[str, Any]]:
                try:
                    return host, self.node(host, "preflight", job["spec"])
                except Exception as exc:
                    return host, {"kind": "unavailable", "reason": str(exc)}
            hosts = [h for h in job["spec"]["hosts"] if h not in (blocked_hosts or set())]
            if not hosts:
                self.store.update(job_id, reasons={"fleet": "waiting behind an earlier/higher-priority fleet job"})
                return set()
            with ThreadPoolExecutor(max_workers=len(hosts)) as pool:
                offers = list(pool.map(probe, hosts))
            eligible = [(host, item) for host, item in offers if item.get("kind") in {"idle", "preempt"}]
            reasons = {host: item.get("reason", item.get("kind")) for host, item in offers}
            with self.decision:
                latest = self.store.get(job_id)
                if latest["cancel_requested"] or latest["state"] in TERMINAL:
                    return set()
                if not eligible:
                    self.store.update(job_id, reasons=reasons)
                    return {host for host, item in offers if item["kind"] == "busy"}
                eligible.sort(key=lambda item: (item[1]["kind"] != "idle", -item[1]["count"], job["spec"]["hosts"].index(item[0])))
                host, chosen = eligible[0]
                token = str(uuid.uuid4())
                admission = {"token": token, "submission": chosen["submission"], "allow_preempt": chosen["kind"] == "preempt"}
                # Persist target + token + exact payload BEFORE sending anything
                # which may start work. This is the crash/timeout fence.
                self.store.update(job_id, state="DISPATCHING", target=host, token=token, admission=admission, reasons=reasons)
                job = self.store.get(job_id)
        result = self.node(job["target"], "fleet_admit", job["admission"])
        if not isinstance(result, dict) or type(result.get("accepted")) is not bool:
            raise ValueError("node admission is unknown; retry on the same node with the same token")
        with self.decision:
            latest = self.store.get(job_id)
            if result["accepted"]:
                remote_job = result.get("job_id")
                if not isinstance(remote_job, str) or not remote_job:
                    raise ValueError("node has not returned a job number; query again with the same admission token")
                self.store.update(job_id, remote_job=remote_job, state="CANCELING" if latest["cancel_requested"] else "ASSIGNED", reasons={})
            else:
                self.store.update(job_id, state="CANCELED" if latest["cancel_requested"] else "PENDING", target=None, token=None, admission=None, reasons={job["target"]: result.get("reason", "busy")})
        return set()

    def tick(self, stop_event: threading.Event | None = None) -> None:
        blocked: set[str] = set()
        for job in self.store.rows():
            if stop_event is not None and stop_event.is_set():
                break
            try:
                blocked.update(self.process(job, blocked))
            except Exception as exc:
                LOG.warning("fleet job %s: %s", job["id"], exc)
                self.store.update(job["id"], reasons={job.get("target") or "fleet": "UNKNOWN: " + str(exc)})
        terminal_local = []
        if time.monotonic() - self.board_checked_at >= 30:
            for host, job_id in self.store.board_local_jobs():
                if stop_event is not None and stop_event.is_set():
                    break
                try:
                    if self.node(host, "job_watch", {"job_id": job_id})["job"]["state"] in TERMINAL:
                        terminal_local.append((host, job_id))
                except Exception:
                    pass  # UNKNOWN is not completion; keep its messages.
            self.board_checked_at = time.monotonic()
        self.store.cleanup_board(terminal_local)


def run_daemon(inventory_path: str) -> int:
    from .daemon import DaemonLock
    logging.basicConfig(level=logging.INFO)
    inventory = load_inventory(inventory_path)
    if inventory.get("coordinator") != inventory.get("local_host"):
        raise ValueError("fleet-daemon must run only on the configured coordinator")
    root = Path(inventory.get("queue_root", "/data1/gpu-scheduler/fleet"))
    runtime = socket_path().parent
    runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    with DaemonLock(root / "daemon.lock", os.getuid()):
        store = QueueStore(root / DB_NAME)
        coordinator = FleetCoordinator(store, inventory)
        server = RpcServer(socket_path(), coordinator.api, os.getuid(), 262144)
        def loop() -> None:
            while not stop.is_set():
                coordinator.tick(stop)
                stop.wait(2)
        worker = threading.Thread(target=loop)
        rpc = threading.Thread(target=server.serve_forever)
        worker.start()
        rpc.start()
        try:
            while not stop.wait(0.5):
                if not worker.is_alive() or not rpc.is_alive():
                    raise RuntimeError("fleet service thread exited")
        finally:
            stop.set()
            server.shutdown()
            worker.join()
            rpc.join()
            store.close()
    return 0


def hub_call(inventory: dict[str, Any], operation: str, payload: dict[str, Any]) -> Any:
    hub = inventory.get("coordinator")
    if not isinstance(hub, str) or hub not in inventory["hosts"]:
        raise ValueError("fleet coordinator is not configured")
    return rpc_to(inventory, hub, "hub", operation, payload)


def cli_spec(args: Any, argv: list[str], inventory: dict[str, Any]) -> dict[str, Any]:
    from .cli import resolve_job_identity
    if args.host:
        raise ValueError("--host and --hosts cannot be combined")
    if args.watch:
        raise ValueError("submit first, then gpu watch F_ID")
    boundary = argv.index("--") if "--" in argv else len(argv)
    submit_index = next(i for i, v in enumerate(argv) if v in {"submit", "run"})
    clean = [argv[submit_index]]
    index = submit_index + 1
    while index < boundary:
        value = argv[index]
        if value.split("=", 1)[0] in SUBMIT_EXTRAS:
            index += 1 if "=" in value else 2
        else:
            clean.append(value)
            index += 1
    key = args.submit_key or str(uuid.uuid4())
    if not args.submit_key:
        clean += ["--submit-key", key]
    if not args.owner:
        _, owner = resolve_job_identity(list(args.command), requested_name=args.name, requested_owner=None)
        clean += ["--submitter", owner]
    clean += argv[boundary:]
    hosts = list(inventory["hosts"]) if args.hosts == "all" else args.hosts.split(",")
    memory = args.min_vram_gb
    if memory is not None and (not math.isfinite(memory) or memory <= 0):
        raise ValueError("--min-vram-gb must be positive and finite")
    spec = {"args": clean, "hosts": hosts, "require_paths": args.require_path, "require_modules": args.require_module, "gpu_model": args.gpu_model, "min_vram_mb": 0 if memory is None else math.ceil(memory * 1024)}
    validate_spec(spec, inventory)
    print(f"fleet submit-key={key} (reuse after an uncertain connection)", file=sys.stderr)
    return spec


def print_queue(result: dict[str, Any]) -> None:
    print("FLEET JOB          PRI STATE        HOST / LOCAL JOB                 SUBMITTER TASK")
    for job in result["jobs"]:
        location = f"{job['target'] or '-'} / {job['remote_job'] or '-'}"
        print(f"{job['id']} P{job['priority']} {job['state']:<12} {location:<32} {job['owner']} {job['name']}")
        if job["reasons"]:
            print("  " + json_text(job["reasons"]))


def route_cli(args: Any, argv: list[str]) -> int | None:
    if args.command_name == "board":
        if args.host:
            raise ValueError("the board is shared; --host is not needed")
        inventory = load_inventory(args.fleet_config)
        action = args.board_action or "list"
        payload: dict[str, Any]
        if action == "post":
            from .cli import resolve_job_identity
            _, owner = resolve_job_identity(["board"], requested_name=None, requested_owner=args.owner)
            key = args.message_key or str(uuid.uuid4())
            job_id = args.job
            if args.on_host and (not job_id or job_id.startswith("F")):
                raise ValueError("--on-host is only for local J jobs")
            host = (args.on_host or inventory.get("local_host")) if job_id and job_id.startswith("J") else None
            payload = {"owner": owner, "body": args.text, "message_key": key, "job_id": job_id, "job_host": host}
            print(f"board message-key={key} (reuse after uncertain connection)", file=sys.stderr)
        elif action == "delete":
            payload = {"message_id": args.message_id}
        else:
            payload = {"limit": args.limit}
        result = hub_call(inventory, "board_" + action, payload)
        if args.json or action != "list":
            print(json_text(result))
        elif not result["messages"]:
            print("留言板暂无留言")
        else:
            for message in result["messages"]:
                stamp = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime(message["created"]))
                attached = (str(message["job_host"] or "fleet") + "/" + message["job_id"]) if message["job_id"] else "非任务留言"
                print(f"B{message['id']} | {stamp} | {message['owner']} | {attached}\n{message['body']}\n")
        return 0
    if getattr(args, "cluster", False):
        if args.host or args.all_hosts:
            raise ValueError("use --cluster without --host/--all-hosts")
        result = hub_call(load_inventory(args.fleet_config), "status", {"all": args.all, "limit": args.limit})
        if args.json:
            print(json_text(result))
        else:
            print_queue(result)
        return 0
    if getattr(args, "hosts", None):
        inventory = load_inventory(args.fleet_config)
        result = hub_call(inventory, "submit", cli_spec(args, argv, inventory))
        if args.json:
            print(json_text(result))
        else:
            print(f"{result['id']} {result['state']}; candidates={','.join(result['hosts'])}")
        return 0
    if any(getattr(args, key, None) for key in ("require_path", "require_module", "gpu_model", "min_vram_gb")):
        raise ValueError("cross-host readiness/hardware constraints require --hosts")
    job_id = getattr(args, "job_id", None)
    if not isinstance(job_id, str) or not job_id.startswith("F") or args.host:
        return None
    inventory = load_inventory(args.fleet_config)
    command = args.command_name
    if command in {"show", "cancel", "retry"}:
        print(json_text(hub_call(inventory, command, {"job_id": job_id})))
        return 0
    if command in {"logs", "events", "watch", "attach"}:
        if command in {"watch", "attach"}:
            from .cli import format_watch_line
            try:
                while True:
                    job = hub_call(inventory, "show", {"job_id": job_id})
                    if args.json:
                        raise ValueError("gpu watch cannot be combined with --json")
                    if job["snapshot"]:
                        print(job_id + " @" + job["target"] + " " + format_watch_line(job["snapshot"]), flush=True)
                    else:
                        print_queue({"jobs": [job]})
                    if job["state"] in TERMINAL:
                        return 0 if job["state"] == "SUCCEEDED" else 1
                    time.sleep(2)
            except KeyboardInterrupt:
                return 130
        job = hub_call(inventory, "resolve", {"job_id": job_id})
        if not job["remote_job"]:
            raise ValueError("fleet job has not been assigned; use gpu show " + job_id)
        from .fleet import forward
        forwarded = (["--json"] if args.json else []) + [command, job["remote_job"]]
        if command == "logs":
            forwarded += ["--lines", str(args.lines)] + (["--follow"] if args.follow else [])
        elif command == "events":
            forwarded += ["--limit", str(args.limit)]
        return forward(inventory, job["target"], forwarded)
    raise ValueError("unsupported operation for a fleet job")

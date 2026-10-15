"""Host integration backends used by gpuq.

The scheduler must treat both GPU discovery and process ownership as security
boundaries:

* a partial or ambiguous ``nvidia-smi`` response is never interpreted as an
  idle GPU;
* signals target the controlled gpuq unit namespace and its current cgroup.

Commands are always passed to the injected runner as an argument vector with
``shell=False``.  Besides making the production path safe, the small runner
interface keeps this module straightforward to test without a live GPU or
user-systemd instance.
"""

from __future__ import annotations

import csv
import io
import math
import os
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Callable, Mapping, Sequence


Runner = Callable[..., subprocess.CompletedProcess[str]]
CgroupReader = Callable[[Path], str]

_GPU_UUID_RE = re.compile(r"^GPU-[A-Za-z0-9][A-Za-z0-9-]*$")
_ENV_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_UNIT_STEM_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")
_DESCRIPTION_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]*$")
_STATE_VALUE_RE = re.compile(r"^[A-Za-z0-9_.:-]+$")


class BackendError(RuntimeError):
    """Base class for host-backend failures."""


class BackendTimeoutError(BackendError):
    """A backend command did not finish before its bounded timeout."""


class BackendCommandError(BackendError):
    """A backend command completed unsuccessfully."""

    def __init__(
        self,
        operation: str,
        returncode: int,
        *,
        stderr: str = "",
    ) -> None:
        self.operation = operation
        self.returncode = returncode
        self.stderr = stderr
        detail = _single_line(stderr)
        message = f"{operation} failed with exit code {returncode}"
        if detail:
            message += f": {detail[:300]}"
        super().__init__(message)


class BackendProtocolError(BackendError):
    """A backend returned syntactically or semantically invalid data."""


class NvidiaSmiError(BackendError):
    """GPU state could not be established safely."""


class UnitNotFoundError(BackendError):
    """The requested transient unit is not loaded."""


class UnitIdentityError(BackendError):
    """A unit name resolved to something other than the expected job."""


class UnitNotReadyError(BackendError):
    """A unit is not yet safe to clean up."""


def _single_line(value: object) -> str:
    if not isinstance(value, str):
        return ""
    return " ".join(value.strip().splitlines())


def _validate_timeout(timeout: float) -> float:
    if isinstance(timeout, bool):
        raise ValueError("timeout must be a positive finite number")
    value = float(timeout)
    if not math.isfinite(value) or value <= 0:
        raise ValueError("timeout must be a positive finite number")
    return value


def _run_checked(
    runner: Runner,
    argv: Sequence[str],
    *,
    timeout: float,
    operation: str,
) -> subprocess.CompletedProcess[str]:
    """Run one bounded, non-shell command and normalize runner failures."""

    command = list(argv)
    try:
        result = runner(
            command,
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
            shell=False,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as exc:
        raise BackendTimeoutError(
            f"{operation} timed out after {timeout:g} seconds"
        ) from exc
    except OSError as exc:
        raise BackendCommandError(operation, 127, stderr=str(exc)) from exc

    returncode = getattr(result, "returncode", None)
    stdout = getattr(result, "stdout", None)
    stderr = getattr(result, "stderr", None)
    if isinstance(returncode, bool) or not isinstance(returncode, int):
        raise BackendProtocolError(f"{operation} runner returned no integer status")
    if not isinstance(stdout, str) or not isinstance(stderr, str):
        raise BackendProtocolError(f"{operation} runner returned non-text output")
    if returncode != 0:
        raise BackendCommandError(operation, returncode, stderr=stderr)
    return result


@dataclass(frozen=True, slots=True)
class GpuDevice:
    """One physical GPU snapshot from ``nvidia-smi``."""

    index: int
    uuid: str
    memory_total_mib: int
    memory_used_mib: int
    memory_free_mib: int
    utilization_percent: int
    compute_pids: tuple[int, ...]

    # Compatibility aliases retain explicit MiB storage while keeping callers
    # that use the shorter names readable.
    @property
    def memory_total_mb(self) -> int:
        return self.memory_total_mib

    @property
    def memory_used_mb(self) -> int:
        return self.memory_used_mib

    @property
    def memory_free_mb(self) -> int:
        return self.memory_free_mib


class NvidiaSmiProvider:
    """Strict, fail-closed NVIDIA GPU/process discovery."""

    GPU_QUERY = (
        "index,uuid,memory.total,memory.used,memory.free,utilization.gpu"
    )
    COMPUTE_QUERY = "gpu_uuid,pid"

    def __init__(
        self,
        *,
        runner: Runner = subprocess.run,
        binary: str = "nvidia-smi",
        timeout: float = 5.0,
    ) -> None:
        if not isinstance(binary, str) or not binary or "\x00" in binary:
            raise ValueError("binary must be a non-empty command path")
        self._runner = runner
        self._binary = binary
        self._timeout = _validate_timeout(timeout)

    def snapshot(self) -> tuple[GpuDevice, ...]:
        """Return a complete host snapshot or raise ``NvidiaSmiError``.

        There is intentionally no best-effort mode.  If either the device or
        process query is unavailable, the caller cannot safely allocate a GPU.
        """

        try:
            gpu_result = _run_checked(
                self._runner,
                [
                    self._binary,
                    f"--query-gpu={self.GPU_QUERY}",
                    "--format=csv,noheader,nounits",
                ],
                timeout=self._timeout,
                operation="nvidia-smi GPU query",
            )
            rows = self._parse_gpu_rows(gpu_result.stdout)

            process_result = _run_checked(
                self._runner,
                [
                    self._binary,
                    f"--query-compute-apps={self.COMPUTE_QUERY}",
                    "--format=csv,noheader,nounits",
                ],
                timeout=self._timeout,
                operation="nvidia-smi compute-process query",
            )
            pids = self._parse_compute_rows(
                process_result.stdout,
                known_uuids={row[1] for row in rows},
            )
        except (
            BackendCommandError,
            BackendProtocolError,
            BackendTimeoutError,
        ) as exc:
            raise NvidiaSmiError(f"GPU state is unavailable: {exc}") from exc

        devices = [
            GpuDevice(
                index=index,
                uuid=uuid,
                memory_total_mib=total,
                memory_used_mib=used,
                memory_free_mib=free,
                utilization_percent=utilization,
                compute_pids=tuple(sorted(pids[uuid])),
            )
            for index, uuid, total, used, free, utilization in rows
        ]
        return tuple(sorted(devices, key=lambda device: device.index))

    # ``query`` is a convenient name for dependency-injected schedulers.
    query = snapshot

    @staticmethod
    def _parse_gpu_rows(
        text: str,
    ) -> list[tuple[int, str, int, int, int, int]]:
        parsed = _csv_rows(text, empty_allowed=False, operation="GPU query")
        result: list[tuple[int, str, int, int, int, int]] = []
        seen_indices: set[int] = set()
        seen_uuids: set[str] = set()

        for row_number, row in enumerate(parsed, start=1):
            if len(row) != 6:
                raise BackendProtocolError(
                    f"GPU query row {row_number} has {len(row)} fields, expected 6"
                )
            index = _parse_nonnegative_int(row[0], f"GPU row {row_number} index")
            uuid = row[1].strip()
            total = _parse_nonnegative_int(
                row[2], f"GPU row {row_number} total memory"
            )
            used = _parse_nonnegative_int(
                row[3], f"GPU row {row_number} used memory"
            )
            free = _parse_nonnegative_int(
                row[4], f"GPU row {row_number} free memory"
            )
            utilization = _parse_nonnegative_int(
                row[5], f"GPU row {row_number} utilization"
            )

            if not _GPU_UUID_RE.fullmatch(uuid):
                raise BackendProtocolError(
                    f"GPU query row {row_number} has an invalid UUID"
                )
            if index in seen_indices or uuid in seen_uuids:
                raise BackendProtocolError("GPU query contains duplicate identity data")
            if total <= 0 or used > total or free > total:
                raise BackendProtocolError(
                    f"GPU query row {row_number} has inconsistent memory values"
                )
            if utilization > 100:
                raise BackendProtocolError(
                    f"GPU query row {row_number} has invalid utilization"
                )

            seen_indices.add(index)
            seen_uuids.add(uuid)
            result.append((index, uuid, total, used, free, utilization))
        return result

    @staticmethod
    def _parse_compute_rows(
        text: str,
        *,
        known_uuids: set[str],
    ) -> dict[str, set[int]]:
        result: dict[str, set[int]] = {
            uuid: set() for uuid in known_uuids
        }
        for row_number, row in enumerate(
            _csv_rows(
                text,
                empty_allowed=True,
                operation="compute-process query",
            ),
            start=1,
        ):
            if len(row) != 2:
                raise BackendProtocolError(
                    "compute-process query row "
                    f"{row_number} has {len(row)} fields, expected 2"
                )
            uuid = row[0].strip()
            if uuid not in result:
                raise BackendProtocolError(
                    f"compute-process row {row_number} references an unknown GPU"
                )
            pid = _parse_nonnegative_int(
                row[1], f"compute-process row {row_number} PID"
            )
            if pid <= 0:
                raise BackendProtocolError(
                    f"compute-process row {row_number} has an invalid PID"
                )
            result[uuid].add(pid)
        return result


def _csv_rows(
    text: str,
    *,
    empty_allowed: bool,
    operation: str,
) -> list[list[str]]:
    if not isinstance(text, str):
        raise BackendProtocolError(f"{operation} returned non-text output")
    if "\x00" in text:
        raise BackendProtocolError(f"{operation} output contains NUL bytes")
    if not text.strip():
        if empty_allowed:
            return []
        raise BackendProtocolError(f"{operation} returned no rows")
    try:
        rows = list(csv.reader(io.StringIO(text), skipinitialspace=True))
    except csv.Error as exc:
        raise BackendProtocolError(f"{operation} returned invalid CSV") from exc
    if any(not row or all(not field.strip() for field in row) for row in rows):
        raise BackendProtocolError(f"{operation} returned a blank CSV row")
    return rows


def _parse_nonnegative_int(raw: str, field: str) -> int:
    value = raw.strip()
    if not value or not value.isascii() or not value.isdecimal():
        raise BackendProtocolError(f"{field} is not a non-negative integer")
    return int(value)


@dataclass(frozen=True, slots=True)
class SystemdUnitStatus:
    """Identity and lifecycle data for one managed transient service."""

    unit_name: str
    description: str
    invocation_id: str | None
    control_group: str
    main_pid: int
    exec_main_status: int
    result: str
    active_state: str
    sub_state: str
    load_state: str
    exec_main_code: str

    @property
    def is_active(self) -> bool:
        return self.active_state in {"active", "activating", "reloading"}

    @property
    def is_terminal(self) -> bool:
        return self.active_state in {"inactive", "failed"}

    @property
    def is_cleanup_ready(self) -> bool:
        return self.is_terminal or (
            self.active_state == "active" and self.sub_state == "exited"
        )


class UserSystemdBackend:
    """Launch and control jobs as isolated user-systemd transient services."""

    SHOW_PROPERTIES = (
        "Id",
        "Description",
        "LoadState",
        "ActiveState",
        "SubState",
        "Result",
        "ExecMainCode",
        "ExecMainStatus",
        "InvocationID",
        "ControlGroup",
        "MainPID",
    )

    def __init__(
        self,
        *,
        runner: Runner = subprocess.run,
        systemd_run_binary: str = "systemd-run",
        systemctl_binary: str = "systemctl",
        env_binary: str = "/usr/bin/env",
        timeout: float = 10.0,
        unit_prefix: str = "gpuq-",
        cgroup_root: os.PathLike[str] | str = "/sys/fs/cgroup",
        cgroup_reader: CgroupReader | None = None,
    ) -> None:
        for label, binary in (
            ("systemd_run_binary", systemd_run_binary),
            ("systemctl_binary", systemctl_binary),
            ("env_binary", env_binary),
        ):
            if not isinstance(binary, str) or not binary or "\x00" in binary:
                raise ValueError(f"{label} must be a non-empty command path")
        if (
            not isinstance(unit_prefix, str)
            or not unit_prefix
            or not _UNIT_STEM_RE.fullmatch(unit_prefix)
        ):
            raise ValueError("unit_prefix contains unsupported characters")

        self._runner = runner
        self._systemd_run = systemd_run_binary
        self._systemctl = systemctl_binary
        if not PurePosixPath(env_binary).is_absolute():
            raise ValueError("env_binary must be an absolute path")
        self._env_binary = env_binary
        self._timeout = _validate_timeout(timeout)
        self._unit_prefix = unit_prefix
        root = self._validate_absolute_path(cgroup_root, "cgroup_root")
        self._cgroup_root = Path(root)
        self._cgroup_reader = cgroup_reader or self._read_cgroup_file

    def start(
        self,
        *,
        unit_name: str,
        description_token: str,
        argv: Sequence[str],
        cwd: os.PathLike[str] | str,
        env: Mapping[str, str] | None,
        log_path: os.PathLike[str] | str,
        delegate: bool = False,
    ) -> SystemdUnitStatus:
        """Start one new transient service and return its verified identity.

        Existing/conflicting units are deliberately left untouched.  In
        particular, this method never issues ``stop``, ``reset-failed``, or a
        wildcard operation in an attempt to reuse a name.
        """

        unit = self._canonical_unit_name(unit_name)
        token = self._validate_description_token(description_token)
        command_argv = self._validate_job_argv(argv)
        working_directory = self._validate_absolute_path(cwd, "cwd")
        output_path = self._validate_absolute_path(log_path, "log_path")
        environment = self._validate_env(env or {})
        if type(delegate) is not bool:
            raise ValueError("delegate must be a boolean")
        description = self.description_for(token)

        command = [
            self._systemd_run,
            "--user",
            f"--unit={unit}",
            "--property=Type=exec",
            "--property=RemainAfterExit=yes",
            "--property=KillMode=control-group",
            "--property=Restart=no",
            "--property=StandardInput=null",
            f"--property=StandardOutput=append:{output_path}",
            f"--property=StandardError=append:{output_path}",
            f"--property=Description={description}",
            f"--working-directory={working_directory}",
        ]
        # Only an explicitly admitted OCI launch needs child cgroup ownership.
        # Existing units and ordinary new tasks retain their prior recipe.
        if delegate:
            command.append("--property=Delegate=yes")
        command.append("--")
        command.extend([self._env_binary, "-i", "--"])
        command.extend(f"{key}={value}" for key, value in environment)
        command.extend(command_argv)

        _run_checked(
            self._runner,
            command,
            timeout=self._timeout,
            operation=f"start systemd unit {unit}",
        )
        return self.status(
            unit_name=unit,
        )

    def status(
        self,
        *,
        unit_name: str,
    ) -> SystemdUnitStatus:
        """Read the current state of a managed gpuq unit."""

        unit = self._canonical_unit_name(unit_name)
        command = [
            self._systemctl,
            "--user",
            "show",
            "--no-pager",
        ]
        command.extend(f"--property={name}" for name in self.SHOW_PROPERTIES)
        command.extend(["--", unit])
        result = _run_checked(
            self._runner,
            command,
            timeout=self._timeout,
            operation=f"query systemd unit {unit}",
        )
        properties = self._parse_show_output(result.stdout)
        return self._validated_status(
            unit=unit,
            properties=properties,
        )

    def terminate(
        self,
        *,
        unit_name: str,
    ) -> SystemdUnitStatus:
        """Send TERM to the current managed unit control group."""

        return self._signal(
            unit_name=unit_name,
            signal_name="TERM",
        )

    def kill(
        self,
        *,
        unit_name: str,
    ) -> SystemdUnitStatus:
        """Send KILL to the current managed unit control group."""

        return self._signal(
            unit_name=unit_name,
            signal_name="KILL",
        )

    def cleanup(
        self,
        *,
        unit_name: str,
    ) -> SystemdUnitStatus:
        """Unload a finished transient unit after its cgroup is empty.

        This is intentionally separate from :meth:`start`: a naming conflict
        is never cleaned up implicitly.  An empty cgroup is verified at the
        last possible point before issuing an exact-unit lifecycle command.
        Failed transient units must be reset rather than stopped: with
        ``RemainAfterExit=yes``, ``stop`` leaves their failed state loaded.
        """

        unit = self._canonical_unit_name(unit_name)
        status = self.status(
            unit_name=unit,
        )
        if not status.is_cleanup_ready:
            raise UnitNotReadyError(
                f"systemd unit {unit} is not in a cleanup-safe state "
                f"({status.active_state}/{status.sub_state})"
            )
        if status.main_pid != 0:
            raise UnitNotReadyError(
                f"systemd unit {unit} has terminal state with nonzero MainPID"
            )
        self._assert_cgroup_empty(status.control_group)
        lifecycle_command = (
            "reset-failed" if status.active_state == "failed" else "stop"
        )
        _run_checked(
            self._runner,
            [
                self._systemctl,
                "--user",
                lifecycle_command,
                "--",
                unit,
            ],
            timeout=self._timeout,
            operation=f"clean up systemd unit {unit}",
        )
        try:
            remaining = self.status(
                unit_name=unit,
            )
        except UnitNotFoundError:
            return status
        raise UnitNotReadyError(
            f"systemd unit {unit} remained loaded after cleanup "
            f"({remaining.active_state}/{remaining.sub_state})"
        )

    def _signal(
        self,
        *,
        unit_name: str,
        signal_name: str,
    ) -> SystemdUnitStatus:
        unit = self._canonical_unit_name(unit_name)
        status = self.status(
            unit_name=unit,
        )
        _run_checked(
            self._runner,
            [
                self._systemctl,
                "--user",
                "kill",
                "--kill-who=all",
                f"--signal={signal_name}",
                "--",
                unit,
            ],
            timeout=self._timeout,
            operation=f"signal systemd unit {unit}",
        )
        return status

    def description_for(self, description_token: str) -> str:
        token = self._validate_description_token(description_token)
        return f"GPUQ managed job token:{token}"

    def _canonical_unit_name(self, unit_name: str) -> str:
        if not isinstance(unit_name, str) or not unit_name:
            raise ValueError("unit_name must be a non-empty string")
        if unit_name != unit_name.strip() or "\x00" in unit_name:
            raise ValueError("unit_name contains unsupported characters")
        stem = unit_name[:-8] if unit_name.endswith(".service") else unit_name
        if stem.endswith(".service"):
            raise ValueError("unit_name has more than one .service suffix")
        if (
            len(stem.encode("utf-8")) > 200
            or not _UNIT_STEM_RE.fullmatch(stem)
            or not stem.startswith(self._unit_prefix)
        ):
            raise ValueError(
                f"unit_name must start with {self._unit_prefix!r} and contain "
                "only letters, digits, dot, underscore, and hyphen"
            )
        return f"{stem}.service"

    @staticmethod
    def _validate_description_token(token: str) -> str:
        if (
            not isinstance(token, str)
            or len(token) > 160
            or not _DESCRIPTION_TOKEN_RE.fullmatch(token)
        ):
            raise ValueError("description_token contains unsupported characters")
        return token

    @staticmethod
    def _validate_job_argv(argv: Sequence[str]) -> list[str]:
        if isinstance(argv, (str, bytes)) or not argv:
            raise ValueError("argv must be a non-empty sequence of arguments")
        result: list[str] = []
        for item in argv:
            if (
                not isinstance(item, str)
                or not item
                or "\x00" in item
                or "$" in item
                or "%" in item
            ):
                raise ValueError(
                    "systemd-facing argv must contain non-empty strings "
                    "without NUL, dollar, or percent"
                )
            result.append(item)
        if not PurePosixPath(result[0]).is_absolute():
            raise ValueError("argv[0] must be an absolute executable path")
        return result

    @staticmethod
    def _validate_absolute_path(
        value: os.PathLike[str] | str,
        label: str,
    ) -> str:
        try:
            raw = os.fspath(value)
        except TypeError as exc:
            raise ValueError(f"{label} must be a filesystem path") from exc
        if isinstance(raw, bytes) or "\x00" in raw or "\n" in raw or "\r" in raw:
            raise ValueError(f"{label} contains unsupported characters")
        if not PurePosixPath(raw).is_absolute():
            raise ValueError(f"{label} must be an absolute path")
        return raw

    @staticmethod
    def _validate_env(env: Mapping[str, str]) -> list[tuple[str, str]]:
        result: list[tuple[str, str]] = []
        for key, value in env.items():
            if not isinstance(key, str) or not _ENV_NAME_RE.fullmatch(key):
                raise ValueError(f"invalid environment variable name: {key!r}")
            if (
                not isinstance(value, str)
                or "\x00" in value
                or "\n" in value
                or "\r" in value
                or "$" in value
                or "%" in value
            ):
                raise ValueError(f"invalid value for environment variable {key}")
            result.append((key, value))
        result.sort(key=lambda item: item[0])
        return result

    @classmethod
    def _parse_show_output(cls, text: str) -> dict[str, str]:
        if not isinstance(text, str) or not text.strip() or "\x00" in text:
            raise BackendProtocolError("systemctl show returned invalid output")
        properties: dict[str, str] = {}
        for line in text.splitlines():
            if not line or "=" not in line:
                raise BackendProtocolError("systemctl show returned a malformed line")
            key, value = line.split("=", 1)
            if key not in cls.SHOW_PROPERTIES:
                continue
            properties[key] = value
        missing = set(cls.SHOW_PROPERTIES).difference(properties)
        if missing:
            raise BackendProtocolError(
                "systemctl show omitted properties: " + ", ".join(sorted(missing))
            )
        return properties

    def _validated_status(
        self,
        *,
        unit: str,
        properties: Mapping[str, str],
    ) -> SystemdUnitStatus:
        if properties["LoadState"] == "not-found":
            raise UnitNotFoundError(f"systemd unit {unit} is not loaded")
        if properties["Id"] != unit:
            raise UnitIdentityError("systemd returned a different unit ID")

        invocation = properties.get("InvocationID", "").lower() or None

        main_pid = _parse_systemd_nonnegative_int(properties["MainPID"], "MainPID")
        exec_status = _parse_systemd_nonnegative_int(
            properties["ExecMainStatus"],
            "ExecMainStatus",
        )
        for name in (
            "LoadState",
            "ActiveState",
            "SubState",
            "Result",
            "ExecMainCode",
        ):
            if not _STATE_VALUE_RE.fullmatch(properties[name]):
                raise BackendProtocolError(
                    f"systemctl show returned invalid {name}"
                )

        active_state = properties["ActiveState"]
        sub_state = properties["SubState"]
        cleanup_ready = active_state in {"inactive", "failed"} or (
            active_state == "active" and sub_state == "exited"
        )
        control_group = properties["ControlGroup"]
        if control_group:
            if (
                not control_group.startswith("/")
                or PurePosixPath(control_group).name != unit
                or any(
                    part in {".", ".."}
                    for part in PurePosixPath(control_group).parts
                )
                or "\x00" in control_group
            ):
                raise UnitIdentityError("systemd unit control group does not match")
        elif not cleanup_ready:
            # systemd removes an empty cgroup after a RemainAfterExit service
            # reaches active/exited (and may do so for other terminal states).
            # While a unit can still run, however, absence is ambiguous and
            # must fail closed.
            raise UnitIdentityError("running systemd unit has no control group")

        return SystemdUnitStatus(
            unit_name=unit,
            description=properties["Description"],
            invocation_id=invocation,
            control_group=control_group,
            main_pid=main_pid,
            exec_main_status=exec_status,
            result=properties["Result"],
            active_state=active_state,
            sub_state=sub_state,
            load_state=properties["LoadState"],
            exec_main_code=properties["ExecMainCode"],
        )

    @staticmethod
    def _read_cgroup_file(path: Path) -> str:
        return path.read_text(encoding="ascii")

    def _assert_cgroup_empty(self, control_group: str) -> None:
        if not control_group:
            # A cgroup cannot be removed while it contains processes.  The
            # verified terminal/active-exited state is checked by cleanup()
            # immediately before reaching this method.
            return
        relative_parts = PurePosixPath(control_group).parts[1:]
        cgroup_path = self._cgroup_root.joinpath(*relative_parts)
        events_path = cgroup_path / "cgroup.events"
        try:
            raw = self._cgroup_reader(events_path)
        except FileNotFoundError:
            # cgroups cannot be removed while populated.  A missing tree is
            # therefore an empty tree; a present tree without cgroup.events
            # is ambiguous and must fail closed.
            if not cgroup_path.exists():
                return
            raise UnitNotReadyError(
                "could not verify the systemd unit cgroup population"
            )
        except OSError as exc:
            raise UnitNotReadyError(
                "could not verify the systemd unit cgroup population"
            ) from exc
        if not isinstance(raw, str) or "\x00" in raw:
            raise UnitNotReadyError("systemd unit cgroup events data is invalid")

        events: dict[str, str] = {}
        for line in raw.splitlines():
            fields = line.split()
            if (
                len(fields) != 2
                or not fields[0].isascii()
                or not fields[0].replace("_", "").isalnum()
                or not fields[1].isascii()
                or not fields[1].isdecimal()
                or fields[0] in events
            ):
                raise UnitNotReadyError(
                    "systemd unit cgroup events data is invalid"
                )
            events[fields[0]] = fields[1]
        populated = events.get("populated")
        if populated not in {"0", "1"}:
            raise UnitNotReadyError(
                "systemd unit cgroup events omitted a valid populated state"
            )
        if populated != "0":
            raise UnitNotReadyError(
                "systemd unit cgroup tree still contains processes"
            )


def _parse_systemd_nonnegative_int(raw: str, field: str) -> int:
    if not raw or not raw.isascii() or not raw.isdecimal():
        raise BackendProtocolError(f"systemctl show returned invalid {field}")
    return int(raw)

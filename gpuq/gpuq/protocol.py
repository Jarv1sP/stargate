from __future__ import annotations

import os
import socket
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .util import json_dumps, reject_duplicate_json


PROTOCOL_VERSION = 1
DEFAULT_MAX_REQUEST_BYTES = 262_144
MAX_RESPONSE_BYTES = 4 * 1024 * 1024


class ProtocolError(RuntimeError):
    pass


def encode_request(
    operation: str,
    arguments: dict[str, Any],
    request_id: str,
) -> bytes:
    """Encode exactly one request using the protocol's on-wire representation."""

    request = {
        "version": PROTOCOL_VERSION,
        "request_id": request_id,
        "op": operation,
        "args": arguments,
    }
    return (json_dumps(request) + "\n").encode("utf-8")


@dataclass(frozen=True)
class Client:
    socket_path: Path
    timeout: float = 120.0
    max_response_bytes: int = MAX_RESPONSE_BYTES
    # Keep max_response_bytes in its historical positional slot; request
    # limits are new and callers should normally pass this field by keyword.
    max_request_bytes: int = DEFAULT_MAX_REQUEST_BYTES

    def __post_init__(self) -> None:
        for name, value in (
            ("max_request_bytes", self.max_request_bytes),
            ("max_response_bytes", self.max_response_bytes),
        ):
            if isinstance(value, bool) or not isinstance(value, int) or value < 1:
                raise ValueError(f"{name} must be a positive integer")

    def call(self, operation: str, arguments: dict[str, Any] | None = None, *, request_id: str | None = None) -> Any:
        request_id = request_id or str(uuid.uuid4())
        deadline = time.monotonic() + self.timeout
        for attempt in range(3):
            try:
                return self._call_once(operation, arguments, request_id=request_id, timeout=max(.001,deadline-time.monotonic()))
            except ProtocolError as error:
                if (operation not in {"status", "show", "job_watch", "queue", "gpus", "events"}
                        or not isinstance(error.__cause__, OSError) or attempt == 2
                        or time.monotonic() >= deadline):
                    raise
                time.sleep(min(.1 * (attempt + 1), max(0, deadline-time.monotonic())))

    def _call_once(
        self,
        operation: str,
        arguments: dict[str, Any] | None = None,
        *,
        request_id: str | None = None,
        timeout: float | None = None,
    ) -> Any:
        request_id = request_id or str(uuid.uuid4())
        wire = encode_request(operation, arguments or {}, request_id)
        if len(wire) > self.max_request_bytes:
            raise ProtocolError(
                f"request is too large ({len(wire)} bytes; "
                f"limit {self.max_request_bytes})"
            )
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout if timeout is None else timeout)
        try:
            sock.connect(os.fspath(self.socket_path))
            sock.sendall(wire)
            chunks: list[bytes] = []
            size = 0
            while True:
                chunk = sock.recv(65_536)
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > self.max_response_bytes:
                    raise ProtocolError("response is too large")
                if b"\n" in chunk:
                    break
        except OSError as exc:
            raise ProtocolError(
                f"cannot reach gpuq daemon at {self.socket_path}: {exc}"
            ) from exc
        finally:
            sock.close()
        raw = b"".join(chunks)
        if not raw.endswith(b"\n"):
            raise ProtocolError("truncated daemon response")
        try:
            response = reject_duplicate_json(raw[:-1].decode("utf-8", errors="strict"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise ProtocolError(f"invalid daemon response: {exc}") from exc
        # The daemon rejects a different SO_PEERCRED uid before reading any
        # request, so this exact connection-level denial has no request id.
        # Surface it as a refusal, never as a result or a retry instruction.
        if (
            isinstance(response, dict)
            and set(response) == {"request_id", "ok", "error"}
            and response["request_id"] is None
            and response["ok"] is False
            and response["error"] == {
                "code": "FORBIDDEN", "message": "peer uid is not allowed"
            }
        ):
            raise ProtocolError(
                "FORBIDDEN: peer uid is not allowed; run native GPUQ as its "
                "configured service user (host ROOT is a different identity)"
            )
        if not isinstance(response, dict) or response.get("request_id") != request_id:
            raise ProtocolError("daemon response does not match request")
        if response.get("ok") is not True:
            error = response.get("error")
            if not isinstance(error, dict):
                raise ProtocolError("daemon returned an unspecified error")
            code = error.get("code", "ERROR")
            message = error.get("message", "request failed")
            raise ProtocolError(f"{code}: {message}")
        return response.get("result")

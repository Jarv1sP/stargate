from __future__ import annotations

import json

import errno
import os
import socket
import socketserver
import stat
import struct
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, cast

from .protocol import MAX_RESPONSE_BYTES
from .util import json_dumps


class ApiError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def prepare_socket_path(path: Path, uid: int) -> None:
    parent = path.parent
    info = parent.stat()
    if not stat.S_ISDIR(info.st_mode):
        raise RuntimeError(f"socket parent is not a directory: {parent}")
    if info.st_uid != uid:
        raise RuntimeError(f"socket parent is not owned by uid {uid}: {parent}")
    if path.exists() or path.is_symlink():
        existing = path.lstat()
        if not stat.S_ISSOCK(existing.st_mode):
            raise RuntimeError(f"refusing to remove non-socket path: {path}")
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        probe.settimeout(0.5)
        try:
            probe.connect(os.fspath(path))
        except OSError as exc:
            if exc.errno not in (errno.ECONNREFUSED, errno.ENOENT):
                raise RuntimeError(f"cannot validate existing socket {path}: {exc}") from exc
        else:
            raise RuntimeError(f"another gpuq daemon is listening at {path}")
        finally:
            probe.close()
        path.unlink()


class _ThreadingUnixServer(
    socketserver.ThreadingMixIn, socketserver.UnixStreamServer
):
    # Shutdown waits for in-flight API calls.  The daemon must retain its
    # process-wide lock and open Store until no handler can mutate state.
    daemon_threads = False
    block_on_close = True
    allow_reuse_address = False

    def __init__(
        self,
        path: Path,
        handler: Callable[[str, dict[str, Any]], Any],
        allowed_uid: int,
        max_request_bytes: int,
    ) -> None:
        self.api_handler = handler
        self.allowed_uid = allowed_uid
        self.max_request_bytes = max_request_bytes
        self.connection_slots = threading.BoundedSemaphore(32)
        super().__init__(os.fspath(path), _RequestHandler)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self.connection_slots.acquire(blocking=False):
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connection_slots.release()
            raise

    def shutdown_request(self, request: Any) -> None:
        try:
            super().shutdown_request(request)
        finally:
            self.connection_slots.release()


class _RequestHandler(socketserver.BaseRequestHandler):
    def _response(
        self,
        request_id: str | None,
        *,
        result: Any = None,
        error: ApiError | None = None,
    ) -> None:
        if error is None:
            payload = {"request_id": request_id, "ok": True, "result": result}
        else:
            payload = {
                "request_id": request_id,
                "ok": False,
                "error": {"code": error.code, "message": error.message},
            }
        try:
            wire = (json_dumps(payload) + "\n").encode("utf-8")
        except (TypeError, ValueError, OverflowError):
            wire = self._compact_error(
                request_id,
                "INTERNAL",
                "daemon result could not be encoded",
            )
        if len(wire) > MAX_RESPONSE_BYTES:
            wire = self._compact_error(
                request_id,
                "RESPONSE_TOO_LARGE",
                "response exceeds the 4 MiB protocol limit",
            )
        # The compact fallback has fixed-size fields and a canonical UUID (or
        # null) request id, so this assertion guards future accidental growth.
        if len(wire) > MAX_RESPONSE_BYTES:
            wire = (
                b'{"error":{"code":"INTERNAL","message":"response limit '
                b'failure"},"ok":false,"request_id":null}\n'
            )
        try:
            self.request.sendall(wire)
        except OSError:
            pass

    @staticmethod
    def _compact_error(request_id: str | None, code: str, message: str) -> bytes:
        payload = {
            "request_id": request_id,
            "ok": False,
            "error": {"code": code, "message": message},
        }
        return (json_dumps(payload) + "\n").encode("utf-8")

    def handle(self) -> None:
        server = cast(_ThreadingUnixServer, self.server)
        self.request.settimeout(2.0)
        credentials = self.request.getsockopt(
            socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i")
        )
        _, uid, _ = struct.unpack("3i", credentials)
        if uid != server.allowed_uid:
            self._response(None, error=ApiError("FORBIDDEN", "peer uid is not allowed"))
            return
        data = bytearray()
        while len(data) <= server.max_request_bytes:
            try:
                chunk = self.request.recv(
                    min(65_536, server.max_request_bytes + 1)
                )
            except socket.timeout:
                self._response(None, error=ApiError("TIMEOUT", "request timed out"))
                return
            if not chunk:
                self._response(None, error=ApiError("TRUNCATED", "missing newline"))
                return
            data.extend(chunk)
            newline = data.find(b"\n")
            if newline >= 0:
                if newline != len(data) - 1:
                    self._response(
                        None, error=ApiError("BAD_REQUEST", "one request per connection")
                    )
                    return
                break
        if len(data) > server.max_request_bytes:
            self._response(None, error=ApiError("TOO_LARGE", "request is too large"))
            return
        request_id: str | None = None
        try:
            raw = data[:-1].decode("utf-8", errors="strict")
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ApiError("BAD_REQUEST", "request must be an object")
            request_id = str(uuid.UUID(str(request["request_id"])))
            operation = request["op"]
            arguments = request["args"]
            if not isinstance(operation, str) or not operation.isascii():
                raise ApiError("BAD_REQUEST", "invalid operation")
            if not isinstance(arguments, dict):
                raise ApiError("BAD_REQUEST", "args must be an object")
            result = server.api_handler(operation, arguments)
        except UnicodeDecodeError:
            self._response(request_id, error=ApiError("BAD_UTF8", "invalid UTF-8"))
            return
        except ValueError as exc:
            self._response(request_id, error=ApiError("BAD_REQUEST", str(exc)))
            return
        except ApiError as exc:
            self._response(request_id, error=exc)
            return
        except Exception:
            self._response(
                request_id,
                error=ApiError("INTERNAL", "internal daemon error; inspect service log"),
            )
            return
        self._response(request_id, result=result)


class RpcServer:
    def __init__(
        self,
        path: Path,
        handler: Callable[[str, dict[str, Any]], Any],
        allowed_uid: int,
        max_request_bytes: int,
    ) -> None:
        prepare_socket_path(path, allowed_uid)
        self.path = path
        self.server = _ThreadingUnixServer(
            path, handler, allowed_uid, max_request_bytes
        )
        os.chmod(path, 0o600)
        self._socket_inode = path.lstat().st_ino
        self._closed = False

    def serve_forever(self) -> None:
        self.server.serve_forever(poll_interval=0.2)

    def shutdown(self) -> None:
        self.server.shutdown()
        self.close()

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.server.server_close()
        try:
            info = self.path.lstat()
            if stat.S_ISSOCK(info.st_mode) and info.st_ino == self._socket_inode:
                self.path.unlink()
        except FileNotFoundError:
            pass

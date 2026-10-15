"""Ephemeral Caddy queue: raw TCP only, no application imports or database.

Runs in Caddy's network namespace, binds loopback; control uses a private Unix
socket. No request is forwarded before release or replayed after a TCP failure.
"""
import asyncio
import json
import os
import resource
import sys
from pathlib import Path


class HoldProxy:
    def __init__(self, limit=64):
        self.limit, self.target = limit, None
        self.opened = asyncio.Event()
        self.empty = asyncio.Event(); self.empty.set()
        self.clients = set()
        self.server = None
        self.control = None
        self.done = asyncio.Event()
        self.failures = 0

    async def client(self, reader, writer):
        if len(self.clients) >= self.limit:
            self.failures += 1
            writer.write(b'HTTP/1.1 503 Service Unavailable\r\nRetry-After: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
            await writer.drain();writer.close();return
        self.clients.add(writer);self.empty.clear();upstream = None
        try:
            # Do not read the request body while waiting; StreamReader buffers
            # are bounded, rather than collecting a whole upload in memory.
            await self.opened.wait()
            source, upstream = await asyncio.open_connection(*self.target, limit=16384)
            async def copy(incoming, outgoing):
                while chunk := await incoming.read(16384):
                    outgoing.write(chunk);await outgoing.drain()
                if outgoing.can_write_eof():outgoing.write_eof()
            await asyncio.gather(copy(reader,upstream),copy(source,writer))
        except (OSError,asyncio.CancelledError):
            self.failures += 1
        finally:
            writer.close()
            if upstream:upstream.close()
            self.clients.discard(writer)
            if not self.clients:self.empty.set()

    async def command(self, reader, writer):
        try:
            item=json.loads(await reader.readline())
            if item['op']=='release':
                if self.opened.is_set() and tuple(item['target'])!=self.target:raise ValueError('cannot retarget forwarded requests')
                self.target=tuple(item['target']);self.opened.set()
            elif item['op']=='finish':
                self.server.close();await self.server.wait_closed()
                async def finish():
                    await self.empty.wait();self.done.set()
                asyncio.create_task(finish())
            elif item['op']!='status':raise ValueError('unknown command')
            writer.write(json.dumps({'pending':len(self.clients),'released':self.opened.is_set(),'failures':self.failures}).encode()+b'\n')
        except Exception as error:
            writer.write(json.dumps({'error':type(error).__name__}).encode()+b'\n')
        await writer.drain();writer.close()

    async def start(self, control_path):
        self.server=await asyncio.start_server(self.client,'127.0.0.1',0,limit=16384)
        self.control=await asyncio.start_unix_server(self.command,str(control_path));os.chmod(control_path,0o600)
        return self.server.sockets[0].getsockname()[1]

    async def close(self):
        self.server.close();self.control.close()
        await self.server.wait_closed();await self.control.wait_closed()


async def main():
    # Cap this small control process, not another Portal/container.
    resource.setrlimit(resource.RLIMIT_AS,(96*1024**2,96*1024**2))
    os.umask(0o077);path=Path(sys.argv[1]);proxy=HoldProxy()
    port=await proxy.start(path)
    Path(sys.argv[2]).write_text(json.dumps({'port':port,'pid':os.getpid()}))
    try:await proxy.done.wait()
    finally:
        Path(sys.argv[2]).write_text(json.dumps({'port':port,'pid':os.getpid(),'finished':True,'failures':proxy.failures}))
        await proxy.close();path.unlink(missing_ok=True)
        path.parent.rmdir()

if __name__=='__main__':asyncio.run(main())

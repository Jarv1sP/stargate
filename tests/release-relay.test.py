import asyncio
import json
import tempfile
import unittest
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'deploy/release'))
from hold_proxy import HoldProxy


class HoldProxyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory();self.path=Path(self.temp.name)/'control.sock'
        self.proxy=HoldProxy();self.port=await self.proxy.start(self.path);self.writes=[]
        async def application(reader,writer):
            headers=await reader.readuntil(b'\r\n\r\n');length=int(headers.split(b'Content-Length: ')[1].split(b'\r\n')[0])
            payload=await reader.readexactly(length);self.writes.append(payload)
            writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');await writer.drain();writer.close()
        self.server=await asyncio.start_server(application,'127.0.0.1',0)
        self.target=['127.0.0.1',self.server.sockets[0].getsockname()[1]]

    async def asyncTearDown(self):
        await self.proxy.close();self.server.close();await self.server.wait_closed();self.temp.cleanup()

    async def command(self,value):
        reader,writer=await asyncio.open_unix_connection(str(self.path));writer.write(json.dumps(value).encode()+b'\n');await writer.drain()
        result=json.loads(await reader.readline());writer.close();await writer.wait_closed();return result

    async def test_post_is_held_and_forwarded_exactly_once_after_release(self):
        reader,writer=await asyncio.open_connection('127.0.0.1',self.port)
        payload=b'fixed-smoke-random-test-bytes'
        writer.write(b'POST /api/call HTTP/1.1\r\nHost: fixture\r\nContent-Length: '+str(len(payload)).encode()+b'\r\n\r\n'+payload);await writer.drain();writer.write_eof()
        await asyncio.sleep(.03);self.assertEqual(self.writes,[])
        self.assertEqual((await self.command({'op':'status'}))['pending'],1)
        await self.command({'op':'release','target':self.target})
        response=await asyncio.wait_for(reader.read(),1);self.assertIn(b'200 OK',response)
        self.assertEqual(self.writes,[payload]);writer.close();await writer.wait_closed()
        await self.command({'op':'finish'});await asyncio.wait_for(self.proxy.done.wait(),1)

    async def test_forwarded_connection_cannot_be_retargeted_or_replayed(self):
        await self.command({'op':'release','target':self.target})
        refused=await self.command({'op':'release','target':['127.0.0.1',9]})
        self.assertIn('error',refused);self.assertEqual(self.proxy.target,tuple(self.target))
        await self.command({'op':'finish'});await asyncio.wait_for(self.proxy.done.wait(),1)

if __name__=='__main__':unittest.main()

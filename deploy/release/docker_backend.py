"""VPS adapter. Called only by the explicitly approved release command."""
import copy
import http.client
import json
import os
import socket
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote, urlsplit

HOLD_SECONDS = 15


class DockerSocket(http.client.HTTPConnection):
    def __init__(self):super().__init__('localhost', timeout=15)
    def connect(self):
        self.sock=socket.socket(socket.AF_UNIX);self.sock.settimeout(15)
        self.sock.connect('/var/run/docker.sock')


class DockerBackend:
    def __init__(self, directory, resources):
        self.root=Path(directory);self.resources=resources;self.stopping_after_failure=False
        self.manifest=json.loads((self.root/'manifest.json').read_text())
        self.old=None;self.new=None;self.holds=[];self.active_hold=None;self.stop_requests=set()

    def check(self, name):
        if not self.stopping_after_failure:self.resources.checkpoint(name)
        else:self.resources.observe(name)

    def command(self, argv, data=None, timeout=20, env=None):
        self.check('before '+argv[0])
        if self.active_hold and not self.active_hold.get('released'):
            timeout=min(timeout,max(.1,self.active_hold['deadline']-time.monotonic()))
        p=subprocess.Popen(argv,stdin=subprocess.PIPE if data is not None else None,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env)
        deadline=time.monotonic()+timeout;first=True
        try:
            while True:
                try:
                    out,error=p.communicate(input=data if first else None,timeout=min(1,max(.01,deadline-time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    first=False
                    # Observe ownership after a start/stop command returns.
                    if argv[:2] not in (['docker','start'],['docker','stop']):self.check('waiting '+argv[0])
                    if time.monotonic()>=deadline:raise
        except BaseException:
            p.terminate()
            try:p.communicate(timeout=2)
            except subprocess.TimeoutExpired:p.kill();p.communicate()
            raise
        self.check('after '+argv[0])
        if p.returncode:
            (self.root/'command-errors.private.log').open('ab').write(error)
            raise RuntimeError('command failed: '+argv[0]+' (details kept private)')
        return out

    def inspect(self, identity):return json.loads(self.command(['docker','inspect',identity]))[0]
    def running(self, identity):return self.inspect(identity)['State']['Running']
    def stop_budget(self, hold):hold['deadline']=time.monotonic()+HOLD_SECONDS

    def running_portals(self):
        ids=self.command(['docker','ps','-q','--filter','name=^/amax-console($|-)']).decode().split()
        return ids

    def api(self, method, path, body):
        conn=DockerSocket()
        try:
            conn.request(method,path,json.dumps(body),{'Content-Type':'application/json'})
            reply=conn.getresponse();raw=reply.read()
            if reply.status>=300:raise RuntimeError('Docker API rejected '+path)
            return json.loads(raw) if raw else None
        finally:conn.close()

    def caddy(self, method='GET', path='/config/', body=None):
        pid=self.inspect(self.manifest.get('caddyContainer','caddy'))['State']['Pid']
        script="import http.client,sys;c=http.client.HTTPConnection('127.0.0.1',2019,timeout=10);c.request(sys.argv[1],sys.argv[2],sys.stdin.buffer.read(),{'Content-Type':'application/json'});r=c.getresponse();b=r.read();sys.stdout.buffer.write(b);sys.exit(0 if r.status==200 else 1)"
        return self.command(['nsenter','--target',str(pid),'--net','python3','-I','-B','-c',script,method,path],data=body or b'')

    def preflight(self):
        self.old=self.inspect('amax-console')
        if self.old['HostConfig']['Memory']>512*1024**2:raise RuntimeError('current Portal exceeds memory policy')
        self.command(['docker','tag',self.old['Image'],self.manifest['rollback']])
        self.original_caddy=self.caddy()
        config=json.loads(self.original_caddy);matches=[]
        def walk(value,path=''):
            if isinstance(value,dict):
                dyn=value.get('dynamic_upstreams',{})
                if value.get('handler')=='reverse_proxy' and (dyn.get('name')=='amax-console' or any(v.get('dial')=='amax-console:8080' for v in value.get('upstreams',[]))):matches.append((path,value))
                for key,item in value.items():walk(item,path+'/'+key)
            elif isinstance(value,list):
                for i,item in enumerate(value):walk(item,path+'/'+str(i))
        walk(config)
        if len(matches)!=1:raise RuntimeError('Portal Caddy handler is not unique')
        self.caddy_path,self.original_handler=matches[0]
        self.network=next(iter(self.old['NetworkSettings']['Networks']))
        self.origin=urlsplit(dict(item.split('=',1) for item in self.old['Config']['Env'])['PUBLIC_ORIGIN'])
        return self.old['Id']

    def create_stopped(self, limit):
        command=['node','portal-rollout.mjs','http://127.0.0.1:9',self.manifest['revision']]
        name='amax-console-staged-'+self.manifest['revision'][:12]
        body=copy.deepcopy(self.old['Config']);body['Image']=self.manifest['tag'];body['Hostname']='';body['Cmd']=command
        body['Labels']['org.opencontainers.image.revision']=self.manifest['revision']
        environment=dict(item.split('=',1) for item in self.old['Config']['Env'])
        changes=self.manifest.get('environmentChanges',{})
        for key,value in changes.items():
            if value is None:environment.pop(key,None)
            else:environment[key]=value
        body['Env']=[key+'='+value for key,value in environment.items()]
        override=self.root/'portal-image.override.json'
        override.write_text(json.dumps({'services':{'amax-console':{'image':self.manifest['tag'],'command':command,'mem_limit':limit,'restart':'unless-stopped','environment':changes}}}))
        oldfiles=self.old['Config']['Labels']['com.docker.compose.project.config_files'].split(',')
        chain=oldfiles+[str(override)]
        body['Labels']['com.docker.compose.project.config_files']=','.join(chain)
        body['HostConfig']=copy.deepcopy(self.old['HostConfig']);body['HostConfig']['Memory']=limit
        body['HostConfig']['RestartPolicy']={'Name':'unless-stopped','MaximumRetryCount':0}
        binds=[v for v in body['HostConfig'].get('Binds',[]) if v.split(':')[1]!='/app/dist/machines.js']
        body['HostConfig']['Binds']=binds+[str(self.root.parent.parent/'private/machines.js')+':/app/dist/machines.js:ro']
        body['NetworkingConfig']={'EndpointsConfig':{self.network:{'Aliases':['amax-console','amax-console-handoff']}}}
        self.new=self.api('POST','/containers/create?name='+quote(name),body)['Id']
        value=self.inspect(self.new)
        if value['State']['Running']:raise RuntimeError('candidate unexpectedly running')
        return self.new

    def hold_command(self, hold, item):
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(3);conn.connect(str(hold['socket']));conn.sendall(json.dumps(item).encode()+b'\n')
            data=conn.makefile('rb').readline();reply=json.loads(data)
            if 'error' in reply:raise RuntimeError('hold control failed')
            return reply

    def hold(self):
        pid=self.inspect(self.manifest.get('caddyContainer','caddy'))['State']['Pid']
        index=uuid.uuid4().hex[:12]
        # Unix socket names have a small platform limit; release paths may be long.
        control=Path(tempfile.mkdtemp(prefix='stargate-hold-'))/'control.sock'
        state=self.root/f'hold-{index}.json'
        log=(self.root/f'hold-{index}.log').open('ab')
        process=subprocess.Popen(['nsenter','--target',str(pid),'--net','python3','-I','-B',str(Path(__file__).with_name('hold_proxy.py')),str(control),str(state)],stdout=log,stderr=log,start_new_session=True)
        log.close()
        deadline=time.monotonic()+3
        try:
            while not state.exists():
                if process.poll() is not None or time.monotonic()>deadline:raise RuntimeError('hold process unavailable')
                self.check('starting hold relay');time.sleep(.05)
            value=json.loads(state.read_text())
        except BaseException:
            process.terminate();process.wait(timeout=3)
            control.unlink(missing_ok=True);control.parent.rmdir();raise
        hold={'socket':control,'state':state,'process':process,'deadline':time.monotonic()+HOLD_SECONDS,'released':False};self.holds.append(hold);self.active_hold=hold
        handler=copy.deepcopy(self.original_handler);handler.pop('dynamic_upstreams',None)
        handler['upstreams']=[{'dial':'127.0.0.1:'+str(value['port'])}]
        handler['transport']={**handler.get('transport',{}),'protocol':'http','keep_alive':{'enabled':False}}
        self.caddy('PATCH','/config'+self.caddy_path,json.dumps(handler).encode())
        return hold

    def control(self, identity, action):
        pid=self.inspect(identity)['State']['Pid'];path='/proc/'+str(pid)+'/root/tmp/portal-rollout-control.sock'
        timeout=15 if action=='activate' else 3
        conn=http.client.HTTPConnection('localhost',timeout=timeout)
        conn.sock=socket.socket(socket.AF_UNIX);conn.sock.settimeout(timeout);conn.sock.connect(path)
        try:
            conn.request('GET' if action=='state' else 'POST','/'+action);response=conn.getresponse();result=json.loads(response.read())
            if response.status!=200:raise RuntimeError('Portal control rejected '+action)
            return result
        finally:conn.close()

    def budget(self, hold):
        self.check('hold-wait')
        if time.monotonic()>=hold['deadline']:raise RuntimeError('short hold expired')

    def drain(self, identity, hold):
        deadline=min(hold['deadline'],time.monotonic()+6)
        while self.running(identity):
            self.budget(hold);state=self.control(identity,'state')
            if state.get('businessForwarding',state.get('forwarding',0))==0 and state.get('pending',0)==0:return
            if time.monotonic()>=deadline:raise RuntimeError('in-flight business request did not drain; do not kill it')
            time.sleep(.1)

    def stop(self, identity, hold):
        if not self.running(identity):return
        if identity not in self.stop_requests:
            self.stop_requests.add(identity)
            self.command(['docker','stop','--time','10',identity])
        while self.running(identity):self.budget(hold);time.sleep(.1)

    def start(self, identity, hold):
        self.budget(hold)
        if self.running_portals():raise RuntimeError('another Portal still running')
        if identity==self.new:
            self.command(['docker','rename',self.old['Id'],'amax-console-previous-'+self.old['Id'][:12]])
            self.command(['docker','rename',identity,'amax-console'])
        self.command(['docker','start',identity]);self.stop_requests.discard(identity);self.budget(hold)
        if identity==self.new:
            while True:
                self.budget(hold)
                try:self.control(identity,'state');break
                except (OSError,http.client.HTTPException):time.sleep(.1)
            self.control(identity,'hold');self.control(identity,'activate')

    def healthy(self, identity, hold):
        while True:
            self.budget(hold)
            if not self.running(identity):raise RuntimeError('Portal exited during startup')
            info=self.inspect(identity);ip=info['NetworkSettings']['Networks'][self.network]['IPAddress']
            try:
                conn=http.client.HTTPConnection(ip,8080,timeout=1);conn.request('GET','/healthz',headers={'Host':self.origin.netloc})
                response=conn.getresponse();body=json.loads(response.read());conn.close()
                if response.status==200 and body.get('phase')=='active':return
            except (OSError,ValueError,http.client.HTTPException):pass
            time.sleep(.1)

    def release(self, hold, identity):
        info=self.inspect(identity);ip=info['NetworkSettings']['Networks'][self.network]['IPAddress']
        self.hold_command(hold,{'op':'release','target':[ip,8080]});hold['released']=True
        self.caddy('PATCH','/config'+self.caddy_path,json.dumps(self.original_handler).encode())
        status=self.hold_command(hold,{'op':'finish'});self.active_hold=None
        if status['failures']:raise RuntimeError('held connection failed; no request replayed')
        # The tiny relay exits once queued connections finish, without killing writers.

    def restore_old(self):
        item=self.inspect(self.new)
        if item['Name']=='/amax-console':self.command(['docker','rename',self.new,'amax-console-rejected-'+self.new[:12]])
        if self.inspect(self.old['Id'])['Name']!='/amax-console':
            self.command(['docker','rename',self.old['Id'],'amax-console'])
        data=Path(next(m['Source'] for m in self.old['Mounts'] if m['Destination']=='/data'))
        marker=data/'portal-rollout/active';temporary=marker.with_name('active.restore')
        owner=marker.parent.stat()
        temporary.write_text(self.old['Config']['Cmd'][3])
        os.chown(temporary,owner.st_uid,owner.st_gid);os.chmod(temporary,0o600);os.replace(temporary,marker)
        self.command(['docker','start',self.old['Id']])

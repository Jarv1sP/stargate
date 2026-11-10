// Synthetic four-node storage state. No private inventory or production data.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {once} from 'node:events';
import http from 'node:http';
import {writeHeapSnapshot} from 'node:v8';
import {pbkdf2Sync} from 'node:crypto';
import {MACHINES} from './machines.js';
import {standaloneClientInfo} from '../../client-bundle.mjs';

const [mode,directory]=process.argv.slice(2),root=resolve(directory);
const database=join(root,'portal.sqlite'),bootstrap=join(root,'bootstrap.json');
const checkedAt='2026-11-08T00:00:00.000Z';
const mib=bytes=>Math.round(bytes/1024/1024*10)/10;
export function storageFixture(index,part){
  if(part==='quota')return {volumes:[{kind:'shared',usedBytes:1e12,availableBytes:2e12,totalBytes:3e12}],checkedAt};
  if(part==='datasets')return {datasets:Array.from({length:2000},(_,i)=>({dataset:'dataset-'+i,uploadedBy:'builtin-admin',size:i*4096,complete:true,modifiedAt:checkedAt})),complete:true,checkedAt};
  const projects=Array.from({length:1000},(_,i)=>({ownerId:'builtin-admin',project:'project-'+i,size:i*4096,complete:true,
    outputs:{size:i*8192,complete:true,count:3},environment:{size:1048576,complete:true}}));
  const datasets=Array.from({length:2000},(_,i)=>({dataset:'dataset-'+i,uploadedBy:'builtin-admin',size:i*4096,complete:true,modifiedAt:checkedAt}));
  const items=Array.from({length:20000},(_,i)=>({kind:'external',path:'/fixture/data'+index+'/'+('directory-'.repeat(38))+i,bytes:i*4096}));
  items.push(...projects.map(row=>({kind:'project',ownerId:row.ownerId,project:row.project,files:row.size,outputs:row.outputs.size,environment:row.environment.size})));
  const result={checkedAt,scannedAt:checkedAt,quota:{volumes:[{kind:'shared',usedBytes:1e12,availableBytes:2e12,totalBytes:3e12}],checkedAt},
    datasets:{datasets,complete:true,checkedAt},projects:{projects,complete:true,checkedAt,
      disks:[{mountPoint:'/fixture/data'+index,totalBytes:3e12,usedBytes:1e12,availableBytes:2e12,media:'ssd',roles:['workspace','datasets'],accounting:'quota',items}]}};
  return part?result[part]:result;
}

if(mode==='seed'){
  await mkdir(root,{recursive:true});
  await writeFile(bootstrap,JSON.stringify({username:'admin',password:'Synthetic-Memory-Fixture-Only!'}));
  const {TeamAccounts}=await import('../../accounts/index.mjs');
  const accounts=new TeamAccounts(database+'.accounts.sqlite'),salt=Buffer.alloc(16);
  accounts.importLegacy({users:[{id:'builtin-admin',username:'admin',name:'管理员',role:'admin',enabled:true}],credentials:new Map([
    ['admin',{salt,hash:pbkdf2Sync('Synthetic-Memory-Fixture-Only!',salt,600000,32,'sha256'),iterations:600000}]
  ])});accounts.close();
  const storage=Object.fromEntries(MACHINES.map(({id},i)=>[id,storageFixture(i)]));
  const data=JSON.stringify({schema:2,users:[{id:'builtin-admin',limits:{},total:0}],jobs:[],sequence:0,storage});
  const db=new DatabaseSync(database);
  db.exec('CREATE TABLE portal_state_v2(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');
  db.prepare('INSERT INTO portal_state_v2 VALUES(1,?)').run(data);db.close();
  await writeFile(join(root,'fixture.json'),JSON.stringify({stateBytes:Buffer.byteLength(data),machines:MACHINES.length}));
}else if(mode==='measure'||mode==='profile'){
  const {createPortalServer}=await import('../../portal-server.mjs');
  const measurements=[];
  const sample=stage=>{
    const memory=process.memoryUsage();
    measurements.push({stage,rssMiB:mib(memory.rss),heapMiB:mib(memory.heapUsed),externalMiB:mib(memory.external),peakMiB:mib(process.resourceUsage().maxRSS*1024)});
    console.log('PORTAL_MEMORY_STAGE '+JSON.stringify(measurements.at(-1)));
  };
  // The bridge creates one fresh node response at a time, as JSON RPC does.
  const bridge=async(machine,operation,args)=>{
    if(operation==='projects.storage.limits.sync')return {synced:true,count:args.limits.length};
    return storageFixture(MACHINES.findIndex(value=>value.id===machine),operation==='projects.quota'?'quota':operation==='datasets.list'?'datasets':'projects');
  };
  const port=await new Promise(resolvePort=>{const server=http.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolvePort(port));});});
  const origin='http://127.0.0.1:'+port;
  const {server,service}=await createPortalServer({database,bootstrap,origin,secure:false,bridge});
  clearInterval(service.executionTimer);clearInterval(service.notificationTimer);clearInterval(service.maintenanceTimer);clearInterval(service.transferTimer);
  server.listen(port,'127.0.0.1');await once(server,'listening');
  await new Promise(resolveIdle=>setTimeout(resolveIdle,250));sample('idle');
  if(mode==='profile'){
    global.gc();sample('idle-after-gc');writeHeapSnapshot(join(root,'idle.heapsnapshot'));
  }
  const token=service.issueSession({userId:'builtin-admin',username:'admin',role:'admin'});
  const drain=(path,body)=>new Promise((resolveDrain,reject)=>{
    const request=http.request(origin+path,{method:body?'POST':'GET',headers:body?{'content-type':'application/json',origin,authorization:'Bearer '+token}:{}},response=>{
      let bytes=0;response.on('data',chunk=>bytes+=chunk.length);response.on('error',reject);response.on('end',()=>{assert.equal(response.statusCode,200);resolveDrain(bytes);});
    });request.on('error',reject);request.end(body&&JSON.stringify(body));
  });
  try{
    for(let i=0;i<3;i++){service.save();sample('save-'+i);}
    for(let i=0;i<2;i++){
      for(const {id} of MACHINES)service.scheduleStorageRefresh(id,0);
      await service.refreshStorage();sample('refresh-'+i);
      const bytes=await drain('/api/call',{operation:'storage.snapshot',args:{}});assert.ok(bytes>35e6);sample('storage-page-'+i);
      assert.ok(await drain('/')>1000);sample('html-'+i);
      assert.equal(await drain('/gpuctl.mjs'),(await standaloneClientInfo(origin)).bytes);sample('cli-download-'+i);
    }
    await new Promise(resolveIdle=>setTimeout(resolveIdle,250));sample('settled');
    const fixture=JSON.parse(await readFile(join(root,'fixture.json'),'utf8'));
    const report={...fixture,phase:process.env.PORTAL_MEMORY_PHASE||'single',node:process.version,platform:process.platform,measurements,peakMiB:mib(process.resourceUsage().maxRSS*1024)};
    console.log('PORTAL_MEMORY '+JSON.stringify(report));
    await writeFile(join(root,'memory-report.json'),JSON.stringify(report,null,2)+'\n');
    if(process.env.PORTAL_MEMORY_ENFORCE==='1'){
      assert.ok(report.peakMiB<=300,`Portal peak RSS ${report.peakMiB} MiB exceeds 300 MiB`);
      if(report.phase==='steady')assert.ok(measurements[0].rssMiB<=200,`Portal idle RSS ${measurements[0].rssMiB} MiB exceeds 200 MiB`);
    }
  }finally{server.closeAllConnections();await new Promise(resolveClose=>server.close(resolveClose));}
}else throw Error('Expected seed, measure or profile');

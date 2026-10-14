import {EventEmitter} from 'node:events';
import {Writable,PassThrough} from 'node:stream';
import {writeFileSync} from 'node:fs';
import {createCampusNativeAgent as nativeAgent} from '../client-campus-native.mjs?finalization-fixture-real';

export async function fixtureRuntime(){return {platform:'windows',arch:'x64',interop:false};}
export function fixtureAgent(pin,options,{mode,proof,payload}){
  const calls=[];let kills=0,upload,announcementReads=0;
  const save=()=>writeFileSync(proof,JSON.stringify({calls,kills,announcementReads}),{mode:0o600});
  return nativeAgent(pin,{...options,timeoutMs:50,shutdownTimeoutMs:30,
    extract:async()=>({path:'/fixture/owned-helper',cleanup:async()=>{}}),
    spawnProcess:()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();
      const alive=setInterval(()=>{},1000);
      child.kill=()=>{clearInterval(alive);kills++;save();if(mode==='normal')queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});return true;};
      child.stdin=new Writable({write(bytes,_encoding,done){
        const n=bytes.readUInt32BE(0),frame=JSON.parse(bytes.subarray(4,4+n)),body=JSON.parse(bytes.subarray(4+n));
        if(body.operation==='community.announcements.pending'){
          announcementReads++;save();const raw=Buffer.from(JSON.stringify({result:{posts:[]}}));
          const header=Buffer.from(JSON.stringify({schema:1,seq:frame.seq,ok:true,status:200,bodyBytes:raw.length}));
          const size=Buffer.alloc(4);size.writeUInt32BE(header.length);child.stdout.write(Buffer.concat([size,header,raw]));done();return;
        }
        calls.push({operation:body.operation,args:body.args});save();
        let data,status=200;
        if(body.operation==='state')data={state:{demo:false,gpuqConnected:true,machines:[],users:[],jobs:[],limits:{},maintenance:{}}};
        else if(body.operation==='community.comments.create'){
          if(mode==='denied'){status=403;data={error:'fixture permission denied'};}
          else data={result:{comment:{id:'159',postId:body.args.postId,body:body.args.body},duplicate:false}};
        }else if(body.operation==='jobs.completion')data={result:{id:body.args.jobId,completed:false,state:'UNCONFIRMED',reason:'FIXTURE_PENDING'}};
        else if(body.operation.startsWith('data.upload.')){
          const args=body.args;
          if(body.operation==='data.upload.status')data={result:upload||{path:'payload',state:'ABSENT'}};
          else if(body.operation==='data.upload.begin'){upload={key:args.key,path:args.path,totalSize:args.totalSize,offset:0,state:'UPLOADING'};data={result:{...upload}};}
          else if(body.operation==='data.upload.chunk'){
            if(mode==='push-denied'){status=403;data={error:'fixture permission denied'};}
            else{const bytes=Buffer.from(args.data,'base64');if(bytes.toString('base64')!==payload||args.offset!==upload.offset)throw Error('Payload or original ACK changed');upload.offset+=bytes.length;data={result:{...upload}};}
          }else if(body.operation==='data.upload.finish'){upload={...upload,state:'COMPLETE',executable:args.executable};data={result:{...upload,...(mode==='push-invalid-ack'?{sha256:'0'.repeat(64)}:{})}};}
          else throw Error('unexpected fixture upload');
        }
        else throw Error('unexpected fixture operation');
        const raw=Buffer.from(JSON.stringify(data));
        const incomplete=mode==='lost-ack'&&body.operation!=='state';
        const header=Buffer.from(JSON.stringify({schema:1,seq:frame.seq,ok:true,status,bodyBytes:raw.length}));
        const size=Buffer.alloc(4);size.writeUInt32BE(header.length);
        child.stdout.write(Buffer.concat([size,header,incomplete?raw.subarray(0,1):raw]));done();
      }});
      return child;
    }
  });
}

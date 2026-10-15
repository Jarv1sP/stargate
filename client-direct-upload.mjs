import {Agent} from 'node:https';
import {connect as tlsConnect} from 'node:tls';
import {createHash,timingSafeEqual} from 'node:crypto';

const denied=message=>{throw Error(message);};
const probeError=(message,uploadProbeCode)=>Object.assign(Error(message),{uploadProbeCode,code:uploadProbeCode});
const connectionCode=error=>{
  switch(error?.code){
    case 'ECONNREFUSED':return 'TCP_REFUSED';
    case 'ENOTFOUND':case 'EAI_AGAIN':return 'DNS_FAILED';
    case 'ENETUNREACH':case 'EHOSTUNREACH':return 'NETWORK_UNREACHABLE';
    case 'ETIMEDOUT':return 'TCP_TIMEOUT';
    case 'ECONNRESET':case 'EPIPE':return 'CONNECTION_FAILED';
    default:return 'TLS_FAILED';
  }
};

export function pinnedUploadAgent(certificateSha256,{connect=tlsConnect,timeoutMs=15000,dialEndpoint,serverName,signal}={}){
  if(!/^[a-f0-9]{64}$/.test(certificateSha256||''))denied('Invalid upload certificate pin');
  const agent=new Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1});
  agent.createConnection=(options,callback)=>{
    let socket,finished=false,tcpConnected=false;
    const finish=(error)=>{if(finished)return;finished=true;clearTimeout(timer);if(error){socket?.destroy();callback(error);}else callback(null,socket);};
    const timer=setTimeout(()=>finish(probeError('Direct upload TLS connection timed out',tcpConnected?'HANDSHAKE_TIMEOUT':'TCP_TIMEOUT')),timeoutMs);timer.unref?.();
    try{
      const dial=dialEndpoint?new URL(dialEndpoint):undefined;
      socket=connect({...options,...(dial?{host:dial.hostname,port:Number(dial.port||443),servername:serverName||options.servername}:{}),signal,rejectUnauthorized:false,minVersion:'TLSv1.2',ALPNProtocols:['http/1.1']});
      socket.once('connect',()=>{tcpConnected=true;});
      socket.once('error',error=>finish(probeError('Direct upload TLS connection failed',tcpConnected&&['ECONNRESET','EPIPE'].includes(error.code)?'HANDSHAKE_EOF':connectionCode(error))));
      socket.once('secureConnect',()=>{
        try{
          const raw=socket.getPeerCertificate(true)?.raw;
          if(!raw||!timingSafeEqual(createHash('sha256').update(raw).digest(),Buffer.from(certificateSha256,'hex')))
            return finish(probeError('Direct upload certificate does not match the authorized node','CERTIFICATE_MISMATCH'));
          finish();
        }catch{finish(probeError('Direct upload certificate validation failed','TLS_FAILED'));}
      });
    }catch(error){finish(probeError('Direct upload TLS connection failed',connectionCode(error)));}
    // Deliberately do not return the unverified socket to Agent.
    return undefined;
  };
  return agent;
}

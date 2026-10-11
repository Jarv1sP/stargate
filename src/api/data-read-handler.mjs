import {DATA_READ_ROUTE,parseDataReadRequest} from '../contracts/data-read.mjs';
import {readJson, reply, replyError} from './json-http.mjs';
import {sourceReadStatuses} from './source-read-statuses.mjs';

const statusByCode={...sourceReadStatuses,UNAUTHENTICATED:401,FORBIDDEN:403,SOURCE_NODE_MISMATCH:503};

/** Authentication supplies the actor; clients cannot choose an actor in JSON. */
export function createDataReadHandler({authenticate,resolveDataRead,reportError=console.error}){
  return async(req,res)=>{
    if(req.url!==DATA_READ_ROUTE)return reply(res,404,{error:{code:'NOT_FOUND'}});
    if(req.method!=='POST')return reply(res,405,{error:{code:'METHOD_NOT_ALLOWED'}});
    if(req.headers['content-type']?.split(';')[0].trim()!=='application/json')return reply(res,415,{error:{code:'JSON_REQUIRED'}});
    try{
      const actor=await authenticate(req);
      const request=parseDataReadRequest(await readJson(req));
      const result=await resolveDataRead.execute(actor,request);
      reply(res,200,{result});
    }catch(error){
      replyError(res,error,statusByCode,reportError);
    }
  };
}

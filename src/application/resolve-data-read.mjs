import {readObservation} from '../domain/data-source.mjs';

/**
 * access.requireRead(actor, request): verifies current machine/source grants.
 * sources.inspect(request): returns a read observation; cannot prepare/copy.
 * Resolves a location, not a training reservation or a completed mount.
 */
export class ResolveDataRead{
  constructor({access,sources}){this.access=access;this.sources=sources;}

  async execute(actor,request,{reads}={}){
    if(reads){
      const observation=await reads.inspect(this.sources,request,{actor,check:()=>this.access.requireRead(actor,request)});
      return readObservation(request,observation);
    }
    await this.access.requireRead(actor,request);
    let observation;
    try{observation=await this.sources.inspect(request,{actor});}
    finally{await this.access.requireRead(actor,request);}
    return readObservation(request, observation);
  }
}

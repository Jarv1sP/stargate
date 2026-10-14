// A lost reply retains the original payload and key until a definite result.
export function createSubmissionKeys(){
  const pending=new Map();
  return {
    request(channel,payload){const signature=JSON.stringify(payload),previous=pending.get(channel);const record=previous?.uncertain?previous:previous?.signature===signature?previous:{key:crypto.randomUUID(),signature,request:structuredClone(payload),uncertain:false};pending.set(channel,record);return {...record.request,key:record.key};},
    uncertain(channel){const record=pending.get(channel);if(record)record.uncertain=true;},
    confirmed(channel){pending.delete(channel);},
    hasUncertain(channel){return pending.get(channel)?.uncertain===true;},
    reset(){pending.clear();}
  };
}

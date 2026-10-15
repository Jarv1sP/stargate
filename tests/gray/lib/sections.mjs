import {AssertionFailure} from './context.mjs';
// 独立子检查继续执行；任何失败都会令整步失败，不重试、不豁免。
export async function sections(ctx,items){
  const errors=[];
  for(const [name,run] of items){try{await run();}catch(error){errors.push(name+'：'+error.message);ctx.note(name+' 失败：'+error.message);}}
  if(errors.length)throw new AssertionFailure(errors.join('；'));
}

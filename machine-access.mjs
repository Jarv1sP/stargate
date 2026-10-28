// Server grants apply to reads and writes alike; current GPU use is unrelated.
export const canUseMachine=(user,machine)=>user?.enabled===true&&(user.role==='admin'||user.limits?.[machine]>0);
export const availableMachines=(user,machines)=>machines.filter(machine=>canUseMachine(user,machine.id));
export function assertMachineAccess(user,machine,machines){
  const available=availableMachines(user,machines);
  if(!available.length)throw Object.assign(Error('你还没有开通任何服务器，请联系管理员审批额度。'),{status:403});
  if(!machines.some(row=>row.id===machine))throw Object.assign(Error('请选择列表中的服务器。'),{status:400});
  if(!canUseMachine(user,machine))throw Object.assign(Error(`你没有 ${machine} 的使用权限。你可以使用：${available.map(row=>row.id).join('、')}。需要其他服务器请联系管理员开通。`),{status:403});
}

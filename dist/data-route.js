// Presentation only. A private address or a low latency is not proof of a
// direct path. Callers must supply a route reported by the transport itself.
const routes = {
  'campus-direct': {label:'校内直传', path:['本机','实验室入口','目标服务器'], note:'数据集字节不经平台中转。'},
  'tail-upload': {label:'Tail 备用上传', path:['本机','专用 Tail 入口','目标服务器'], note:'只改变本次上传入口，不改变默认路由。Tail 中继可能影响速度。'},
  'vps-relay': {label:'平台中转', path:['本机','平台中转','目标服务器'], note:'传输速度受平台中转带宽限制。'},
  'cloud-pull': {label:'服务器直下', path:['下载源','目标服务器'], note:'文件由目标服务器直接下载。'},
  'node-lan': {label:'实验室内网', path:['源服务器','目标服务器'], note:'文件在服务器之间传输。'},
};
export function routePresentation(route){
  const kind=typeof route==='string'?route:route?.kind;
  return routes[kind]?{kind,...routes[kind],path:[...routes[kind].path]}:{kind:'unknown',label:'通道待确认',path:[],note:'尚未收到传输通道信息。'};
}
export function transferBytes(value){
  const bytes=Number(value);
  if(value===null||value===undefined||!Number.isFinite(bytes)||bytes<0)return '—';
  if(bytes<1024)return bytes.toLocaleString('en-US')+' B';
  if(bytes<1024**2)return (bytes/1024).toFixed(1)+' KiB';
  if(bytes<1024**3)return (bytes/1024**2).toFixed(1)+' MiB';
  return (bytes/1024**3).toFixed(2)+' GiB';
}

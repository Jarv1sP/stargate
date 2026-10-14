// Protocol references: OpenList's AliyundriveShare driver; QR login parameters
// from itxve/aliyundriver-refresh-token (MIT, credited in THIRD_PARTY_NOTICES).
// Only provider-owned HTTPS endpoints receive account/share credentials.
import QRCode from 'qrcode';
const SAFE_FAILURE=Symbol('aliyun-safe-failure');
const fail=(message,status=502)=>{throw Object.assign(Error(message),{status,[SAFE_FAILURE]:true});};
const API='https://api.alipan.com';
const QR='https://passport.aliyundrive.com/newlogin/qrcode/';
const BASE={appName:'aliyun_drive',fromSite:'52',appEntrance:'web',isMobile:'false',lang:'zh_CN',returnUrl:'',bizParams:''};
const STAGES=new Map([
  [QR+'generate.do','二维码生成'],[QR+'query.do','扫码确认'],
  ['https://auth.alipan.com/v2/account/token','令牌刷新'],
  [API+'/v2/share_link/get_share_token','分享令牌'],
  [API+'/adrive/v3/file/list','分享列表'],
  [API+'/v2/file/get_share_link_download_url','分享下载'],
]);
const ERROR_CODES=new Set(['AccessTokenInvalid','AccessTokenExpired','InvalidRefreshToken','RefreshTokenExpired','InvalidParameter','InvalidParameter.RefreshToken','Forbidden','ForbiddenNoPermission','AccessDenied','NotFound','TooManyRequests','RequestTooFrequent','InvalidSharePwd','ShareLinkTokenInvalid','ShareLinkTokenExpired','ShareLink.Cancelled','ShareLink.Expired','ShareLink.NotFound']);
function stageFor(value){try{const u=new URL(value);return STAGES.get(u.origin+u.pathname)||'云盘请求';}catch{return '云盘请求';}}
export function shareReference(value,password=''){
  let url;try{url=new URL(value);}catch{fail('请填写完整的阿里云盘分享链接。',400);}
  if(url.protocol!=='https:'||!['www.alipan.com','www.aliyundrive.com','alipan.com','aliyundrive.com'].includes(url.hostname)||url.port||url.username||url.password)fail('仅支持阿里云盘官方 HTTPS 分享链接。',400);
  const match=/^\/s\/([A-Za-z0-9_-]{4,128})\/?$/.exec(url.pathname);
  if(!match||typeof password!=='string'||!/^[A-Za-z0-9]{0,16}$/.test(password))fail('分享链接或提取码格式不正确。',400);
  return {shareId:match[1],password};
}
export class AliyunShare{
  constructor({load,save,request=fetch,now=Date.now}){this.load=load;this.save=save;this.request=request;this.now=now;this.access=null;this.credentialGeneration=0;this.loginGeneration=0;this.refreshFlight=null;}
  connected(){return !!this.load();}
  clear(){this.access=null;this.credentialGeneration++;this.loginGeneration++;this.refreshFlight=null;}
  current(generation){if(generation!==this.credentialGeneration)fail('云盘连接已更改，请重新操作。',409);}
  async json(url,body,headers={},form=false){
    const stage=stageFor(url);
    try{
      const response=await this.request(url,{method:body===undefined?'GET':'POST',redirect:'error',signal:AbortSignal.timeout(8000),headers:{'Content-Type':form?'application/x-www-form-urlencoded;charset=UTF-8':'application/json',...headers},...(body===undefined?{}:{body:form?new URLSearchParams(body).toString():JSON.stringify(body)})});
      const diagnostic=stage+' HTTP '+response.status;
      let bytes=0,raw='';const decoder=new TextDecoder();for await(const part of response.body||[]){bytes+=part.length;if(bytes>1024*1024)fail('阿里云盘返回内容过大。['+diagnostic+']');raw+=decoder.decode(part,{stream:true});}raw+=decoder.decode();
      let data;try{data=JSON.parse(raw);}catch{if(response.ok)fail('阿里云盘返回格式异常。['+diagnostic+']');}
      const code=data?.code||data?.Code,known=ERROR_CODES.has(code)?'; '+code:code?'; 未识别的服务错误':'';
      if(!response.ok)fail((response.status===429?'阿里云盘请求较多，请稍后重试。':'阿里云盘暂时无法响应，请稍后重试。')+'['+diagnostic+known+']');
      if(code)fail('阿里云盘拒绝了请求，请检查分享有效期、提取码或重新授权。['+diagnostic+known+']');return data;
    }catch(error){if(error?.[SAFE_FAILURE])throw error;fail('阿里云盘连接失败，请稍后重试；未切换到平台中转下载。['+stage+']');}
  }
  async begin(){
    const generation=this.credentialGeneration,loginGeneration=++this.loginGeneration;
    const data=(await this.json(QR+'generate.do?'+new URLSearchParams(BASE)))?.content?.data;
    this.current(generation);if(loginGeneration!==this.loginGeneration)fail('二维码已被新请求替代，请使用最新二维码。',409);
    if(typeof data?.codeContent!=='string'||data.codeContent.length>4096||typeof data.ck!=='string'||data.ck.length>4096||!data.t)fail('阿里云盘扫码接口暂不可用。');
    let url;try{url=new URL(data.codeContent);}catch{fail('阿里云盘返回了无效二维码。');}
    if(url.protocol!=='https:'||!/(^|\.)(aliyundrive\.com|alipan\.com)$/.test(url.hostname)||url.username||url.password)fail('二维码不是阿里云盘官方地址。');
    const image=await QRCode.toDataURL(data.codeContent,{width:240,margin:2});
    this.current(generation);if(loginGeneration!==this.loginGeneration)fail('二维码已被新请求替代，请使用最新二维码。',409);
    return {secret:{ck:data.ck,t:String(data.t),generation,loginGeneration},image,expiresAt:this.now()+600000};
  }
  async poll(secret){
    if(!secret||secret.loginGeneration!==this.loginGeneration)fail('二维码已失效，请重新获取。',409);
    this.current(secret.generation);
    const data=(await this.json(QR+'query.do?appName=aliyun_drive&fromSite=52',{...BASE,ck:secret.ck,t:secret.t},{},true))?.content?.data;
    this.current(secret.generation);if(secret.loginGeneration!==this.loginGeneration)fail('二维码已失效，请重新获取。',409);
    if(!['NEW','SCANED','CONFIRMED','EXPIRED','CANCELED'].includes(data?.qrCodeStatus))fail('阿里云盘扫码状态异常，请重新获取二维码。');
    if(data.qrCodeStatus==='CONFIRMED'){
      let login;try{login=JSON.parse(Buffer.from(data.bizExt,'base64').toString('utf8')).pds_login_result;}catch{fail('扫码响应不完整，请重新授权。');}
      if(typeof login?.refreshToken!=='string'||login.refreshToken.length<16||login.refreshToken.length>8192)fail('授权凭据未收到，请重新扫码。');
      this.save({refreshToken:login.refreshToken,connectedAt:new Date(this.now()).toISOString()});this.clear();
    }
    return {state:data.qrCodeStatus};
  }
  async token(){
    if(this.access&&this.access.until>this.now()+60000)return this.access.value;
    if(this.refreshFlight?.generation===this.credentialGeneration)return this.refreshFlight.promise;
    const generation=this.credentialGeneration;
    const credentials=this.load();if(!credentials)fail('管理员尚未连接阿里云盘；可以先使用 HTTPS 下载链接。',409);
    const flight={generation,promise:null};
    flight.promise=(async()=>{
      const data=await this.json('https://auth.alipan.com/v2/account/token',{refresh_token:credentials.refreshToken,grant_type:'refresh_token'});
      this.current(generation);
      if(typeof data.access_token!=='string'||typeof data.refresh_token!=='string')fail('阿里云盘授权已失效，请管理员重新扫码。',409);
      // Persist the single rotated credential only if this account connection
      // still exists. A late refresh must never resurrect a disconnected login.
      this.save({...credentials,refreshToken:data.refresh_token});
      this.access={value:data.access_token,until:this.now()+Math.min(Number(data.expires_in)||3600,7200)*1000};return data.access_token;
    })();
    this.refreshFlight=flight;
    try{return await flight.promise;}finally{if(this.refreshFlight===flight)this.refreshFlight=null;}
  }
  async shareToken(source){
    const data=await this.json(API+'/v2/share_link/get_share_token',{share_id:source.shareId,share_pwd:source.password});
    if(typeof data.share_token!=='string')fail('分享已失效或提取码不正确。',400);return data.share_token;
  }
  async list(source){
    const share=await this.shareToken(source);const files=[];let marker='';
    for(let page=0;page<5;page++){
      const data=await this.json(API+'/adrive/v3/file/list',{share_id:source.shareId,parent_file_id:'root',limit:100,marker,order_by:'name',order_direction:'ASC'},{'x-share-token':share});
      if(!Array.isArray(data.items))fail('无法读取分享文件。');
      for(const file of data.items){
        if(file.type!=='file')continue;
        if(typeof file.file_id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(file.file_id)||typeof file.name!=='string'||file.name.length>512||!Number.isSafeInteger(file.size)||file.size<0)continue;
        files.push({id:file.file_id,name:file.name,size:file.size,driveId:typeof file.drive_id==='string'?file.drive_id:''});
      }
      marker=data.next_marker||'';if(!marker)return files;
    }
    fail('分享内容过多。请将压缩包作为单个文件分享后再导入。',400);
  }
  async resolve(source,file){
    const generation=this.credentialGeneration;
    const access=await this.token(),share=await this.shareToken(source);
    this.current(generation);
    const data=await this.json(API+'/v2/file/get_share_link_download_url',{share_id:source.shareId,file_id:file.id,drive_id:file.driveId,expire_sec:600},{Authorization:'Bearer '+access,'x-share-token':share,'X-Canary':'client=web,app=share,version=v2.3.1'});
    this.current(generation);
    let url;try{url=new URL(data.download_url);}catch{fail('阿里云盘没有提供下载直链，可能需要重新授权或检查会员权限。');}
    // Node independently verifies all DNS answers and every redirect before I/O.
    if(url.protocol!=='https:'||url.username||url.password)fail('阿里云盘返回了不安全的下载地址。');return url.href;
  }
}

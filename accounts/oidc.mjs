import * as oidc from 'openid-client';
import {randomBytes,timingSafeEqual} from 'node:crypto';

const denied=()=>{throw Object.assign(Error('登录验证已失效，请重新从登录入口开始。'),{status:401});};
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));

export function centralLogin(service,origin,secure){
  const settings=service.accounts.config;
  const transactions=new Map();let discovered;
  const transactionName=secure?'__Host-amax_oidc':'amax_oidc';
  const transactionCookie=value=>`${transactionName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${value?300:0}${secure?'; Secure':''}`;
  async function configuration(){
    if(discovered)return discovered;
    const issuer=new URL(settings.issuer);
    const options=!secure&&['127.0.0.1','localhost'].includes(issuer.hostname)?{execute:[oidc.allowInsecureRequests]}:{};
    discovered=await oidc.discovery(issuer,settings.clientId,settings.clientSecret,undefined,options);
    oidc.enableNonRepudiationChecks(discovered);
    return discovered;
  }
  return async function handle(req,res,headers,cookie){
    const current=new URL(req.url,origin);
    if(!['/auth/login','/auth/callback','/auth/register'].includes(current.pathname))return false;
    if(req.method!=='GET')return false;
    const redirect=(location,cookies=[])=>{res.writeHead(302,{...headers,Location:location,'Set-Cookie':cookies});res.end();return true;};
    if(current.pathname==='/auth/register')return redirect(new URL('/register',settings.portalOrigin).href);
    const config=await configuration();
    if(current.pathname==='/auth/login'){
      for(const [key,entry] of transactions)if(entry.expires<Date.now())transactions.delete(key);
      if(transactions.size>=512)throw Object.assign(Error('登录请求较多，请稍后重试。'),{status:429});
      const state=oidc.randomState(),nonce=oidc.randomNonce(),verifier=oidc.randomPKCECodeVerifier();
      const browser=randomBytes(32).toString('hex');
      const redirectTo=oidc.buildAuthorizationUrl(config,{redirect_uri:origin+'/auth/callback',scope:'openid profile portal',
        state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',
        ...(current.searchParams.get('prompt')==='login'?{prompt:'login'}:{})});
      transactions.set(state,{browser,nonce,verifier,expires:Date.now()+300000});
      return redirect(redirectTo.href,[transactionCookie(browser)]);
    }
    const state=current.searchParams.get('state'),transaction=transactions.get(state);
    const browser=(req.headers.cookie||'').split(/;\s*/).find(part=>part.startsWith(transactionName+'='))?.slice(transactionName.length+1);
    if(!transaction||transaction.expires<Date.now()||!equal(browser,transaction.browser))denied();
    transactions.delete(state);
    const tokens=await oidc.authorizationCodeGrant(config,current,{expectedState:state,expectedNonce:transaction.nonce,pkceCodeVerifier:transaction.verifier,idTokenExpected:true});
    const token=service.accounts.oidcSession(tokens.claims());
    service.refreshAccounts();service.save();
    return redirect('/',[cookie(token),transactionCookie('')]);
  };
}

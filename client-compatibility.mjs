const shQuote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
const psQuote=value=>"'"+String(value).replaceAll("'","''")+"'";
export function clientUpgradeMessage(origin,platform){
  const base=new URL(origin);
  if(base.username||base.password||base.pathname!=='/'||base.search||base.hash||!['https:','http:'].includes(base.protocol))throw Error('Invalid installer origin');
  const linux=`curl -fsS --max-redirs 0 ${shQuote(base.origin+'/install.sh')} | sh`;
  const windows=`$i = Invoke-WebRequest ${psQuote(base.origin+'/install.ps1')} -UseBasicParsing -MaximumRedirection 0; & ([scriptblock]::Create($i.Content))`;
  return '客户端过旧，请用官方安装器升级，再重试原命令。'+(platform==='win32'?'\nPowerShell: '+windows:platform?'\nLinux / macOS / WSL: '+linux:'\nLinux / macOS / WSL: '+linux+'\nPowerShell: '+windows);
}

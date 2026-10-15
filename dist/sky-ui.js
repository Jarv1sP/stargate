// Decorative, approximate readings; no external service or network request.
export function skyReading(date=new Date()){
  const days=864e5,phase=((date.getTime()-Date.UTC(2000,0,6,18,14))/(29.530588853*days)%1+1)%1;
  const moon=phase<.03||phase>.97?'新月':phase<.22?'蛾眉月':phase<.28?'上弦月':phase<.47?'盈凸月':phase<.53?'满月':phase<.72?'亏凸月':phase<.78?'下弦月':'残月';
  const k=Math.cos(2*Math.PI*phase),wax=phase<.5,path=`M0,-6 A6,6 0 0 ${wax?1:0} 0,6 A${Math.max(.001,Math.abs(k)*6)},6 0 0 ${wax?(k>0?0:1):(k>0?1:0)} 0,-6`;
  const epoch=Date.UTC(2026,10,15),period=780*days,window=epoch+Math.max(0,Math.ceil((date.getTime()-epoch)/period))*period;
  const marsDays=Math.max(0,Math.ceil((window-date.getTime())/days));
  return {utc:date.toISOString().slice(11,19)+' UTC',moon,path,marsDays,mars:`火星窗口 ≈ ${marsDays} 天`};
}

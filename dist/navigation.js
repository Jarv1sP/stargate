// Transfers share the dataset navigation.
export const roomOrder=['resources','work','jobs','datasets','community','workshop'];
const pages=new Set([...roomOrder,'transfers','me','admin']);
export function pageForRoute(route){
  const value=String(route??'').replace(/^#/,'');
  if(value==='storage')return 'datasets';
  if(value==='storage/transfers')return 'transfers';
  if(/^admin(?:\/[a-z][a-z0-9-]{0,63})?$/.test(value))return 'admin';
  return value==='datasets/transfers'?'transfers':pages.has(value)?value:null;
}
export const roomForPage=page=>page==='transfers'?'datasets':page;
export const hashForPage=page=>page==='transfers'?'#datasets/transfers':'#'+page;

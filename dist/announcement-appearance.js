export const defaultAppearance=Object.freeze({layout:'standard',background:'#101113',text:'#f2f2f2',accent:'#87ceeb'});
export function normalizeAppearance(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))value={};
  const appearance={...defaultAppearance};
  if(['standard','centered','compact'].includes(value.layout))appearance.layout=value.layout;
  for(const key of ['background','text','accent']){
    if(typeof value[key]==='string'&&/^#[0-9a-f]{6}$/i.test(value[key]))appearance[key]=value[key].toLowerCase();
  }
  return appearance;
}
export function applyAnnouncementAppearance(element,appearance={}){
  const value=normalizeAppearance(appearance);element.dataset.layout=value.layout;
  for(const key of ['background','text','accent'])element.style.setProperty('--announcement-'+key,value[key]);
}

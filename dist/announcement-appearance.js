export const defaultAppearance=Object.freeze({layout:'standard',background:'#101113',text:'#f2f2f2',accent:'#87ceeb'});
export function normalizeAppearance(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!Object.hasOwn(defaultAppearance,k)))throw Error('公告外观字段无效。');
  const appearance={...defaultAppearance,...value};
  if(!['standard','centered','compact'].includes(appearance.layout))throw Error('请选择标准、居中或紧凑布局。');
  for(const key of ['background','text','accent']){
    if(typeof appearance[key]!=='string'||!/^#[0-9a-f]{6}$/i.test(appearance[key]))throw Error('公告颜色须为 #RRGGBB。');
    appearance[key]=appearance[key].toLowerCase();
  }
  return appearance;
}
export function applyAnnouncementAppearance(element,appearance={}){
  const value=normalizeAppearance(appearance);element.dataset.layout=value.layout;
  for(const key of ['background','text','accent'])element.style.setProperty('--announcement-'+key,value[key]);
}

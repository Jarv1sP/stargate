export const diskMediaLabel=media=>media==='ssd'?'SSD':media==='hdd'?'HDD':media==='mixed'?'混合盘':'数据盘';
export function diskLabel(row={}){
  const media=diskMediaLabel(row.media),roles=row.roles??(row.kind==='shared'?['workspace','datasets']:[row.kind]);
  return roles.includes('workspace')&&roles.includes('datasets')?`${media} · 工作区与数据集共用`:roles.includes('workspace')?`工作区 · ${media}`:roles.includes('datasets')?`数据集 · ${media}`:media;
}

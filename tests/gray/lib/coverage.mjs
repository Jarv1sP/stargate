// 步骤中的 features 只说明覆盖范围；未映射的功能如实列出，不作为门禁。
export function featureItems(markdown){
  const active=markdown.split(/^## 删除的功能/m)[0];
  return active.split('\n').filter(line=>line.startsWith('- ')).map(line=>line.slice(2));
}
export function uncoveredFeatures(markdown,steps){
  const covered=new Set(steps.flatMap(step=>step.features||[]));
  return featureItems(markdown).filter(text=>!covered.has(text));
}

// Keep short feedback above the control layer, clear of visible actions.
export function toastPosition(target){
  let frame=0;
  const visible=element=>{
    if(element.closest('[inert]'))return null;
    const style=getComputedStyle(element),rect=element.getBoundingClientRect();
    return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)!==0&&rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth?rect:null;
  };
  function place(){
    if(!target.classList.contains('visible'))return;
    const box=target.getBoundingClientRect(),gap=8;
    const edge=Math.min(Math.max(16,parseFloat(getComputedStyle(target).getPropertyValue('--gutter'))||16),(innerWidth-box.width)/2);
    const anchors=[...document.querySelectorAll('#room-nav')].map(visible).filter(rect=>rect&&rect.top>innerHeight/2);
    const ceiling=Math.min(innerHeight-edge,...anchors.map(rect=>rect.top));
    const blockers=[...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,summary,[role=button]')].filter(element=>!target.contains(element)).map(visible).filter(Boolean);
    const positions=[ceiling-gap-box.height,...blockers.map(rect=>rect.top-gap-box.height)].filter(y=>y>=edge&&y+box.height<=ceiling-gap).sort((a,b)=>b-a);
    let point={x:innerWidth-edge-box.width,y:edge};
    // Centered first, as in the approved design; then the right and left edges.
    outer:for(const y of positions)for(const x of [(innerWidth-box.width)/2,innerWidth-edge-box.width,edge]){
      if(blockers.every(rect=>x+box.width<=rect.left-gap||x>=rect.right+gap||y+box.height<=rect.top-gap||y>=rect.bottom+gap)){point={x,y};break outer;}
    }
    Object.assign(target.style,{left:point.x+'px',top:point.y+'px',right:'auto',bottom:'auto'});
  }
  const queue=()=>{if(!target.classList.contains('visible')||frame)return;frame=requestAnimationFrame(()=>{frame=0;place();});};
  addEventListener('resize',queue);addEventListener('scroll',queue,{capture:true,passive:true});
  document.fonts?.addEventListener('loadingdone',queue);
  new MutationObserver(queue).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden','open']});
  return place;
}

// Approved spatial transitions. State changes take effect immediately; ghosts
// are inert, clipped to the viewport, and never carry application hooks.
export const reducedMotion=()=>matchMedia('(prefers-reduced-motion:reduce)').matches;
export const openDialogs=()=>[...document.querySelectorAll('dialog[open]')].filter(dialog=>!dialog.closest('[inert],[hidden]'));
const phone=()=>matchMedia('(max-width:759px)').matches;
const standard='cubic-bezier(.2,0,0,1)';
const underLayers=new Map(),entrances=new WeakMap(),boundDialogs=new WeakSet();
const snapshotProperties=['display','position','box-sizing','width','height','min-width','min-height','max-width','max-height','top','right','bottom','left','padding','margin','border','border-radius','background-color','background-image','color','opacity','overflow','overflow-wrap','white-space','font-family','font-size','font-weight','font-stretch','font-variation-settings','font-variant-numeric','text-overflow','line-height','letter-spacing','text-align','text-decoration','flex','flex-direction','flex-wrap','align-items','align-content','justify-content','gap','grid-template-columns','grid-template-rows','grid-column','grid-row','list-style','box-shadow','backdrop-filter'];

function cleanClone(element){
  const clone=element.cloneNode(true);
  const originals=[element,...element.querySelectorAll('*')],copies=[clone,...clone.querySelectorAll('*')];
  for(const [index,node] of copies.entries()){
    if(node.tagName==='DIALOG')node.removeAttribute('open');
    // cloneNode copies serialized style attributes, which strict CSP rejects.
    // Reapply only through the CSSOM, as with the actual application controls.
    node.removeAttribute('style');const style=originals[index].isConnected?getComputedStyle(originals[index]):originals[index].style;
    for(const property of snapshotProperties){const value=style.getPropertyValue(property);if(value)node.style.setProperty(property,value);}
    for(const attribute of [...node.attributes])if(['id','class','name','form','href'].includes(attribute.name)||attribute.name.startsWith('data-')||attribute.name.startsWith('on')||attribute.name.startsWith('aria-'))node.removeAttribute(attribute.name);
  }
  clone.setAttribute('aria-hidden','true');clone.inert=true;
  return clone;
}
function animationLayer(){
  const layer=document.createElement('div');layer.className='object-transition-layer';layer.setAttribute('aria-hidden','true');layer.setAttribute('popover','manual');layer.inert=true;document.body.append(layer);
  // A visual-only top-layer element keeps continuity above native sheet scrims.
  layer.showPopover?.();return layer;
}
function retire(layer,animation){animation.finished.then(()=>layer.remove(),()=>layer.remove());}

function restoreUnderLayer(dialog){
  const previous=underLayers.get(dialog);if(!previous)return null;
  underLayers.delete(dialog);previous.animation.cancel();
  return ()=>{if(previous.element.isConnected&&!reducedMotion())previous.element.animate([{transform:`translateX(${-previous.distance}px)`},{transform:'none'}],{duration:350,easing:standard});};
}
globalThis.addEventListener?.('resize',()=>{for(const [dialog,previous] of underLayers){previous.animation.cancel();underLayers.delete(dialog);}});
// Native Escape must always reach the real active dialog, including while a
// visual-only popover is finishing a previous exit.
globalThis.addEventListener?.('keydown',event=>{if(event.key==='Escape')for(const layer of document.querySelectorAll('.object-transition-layer'))layer.remove();},{capture:true});

export function revealSheet(dialog,{drilldown=false}={}){
  const reduce=reducedMotion();
  if(phone()&&drilldown&&!reduce){
    const element=openDialogs().filter(layer=>layer!==dialog).at(-1)||document.querySelector('[data-page]:not([hidden])');
    if(element){const distance=innerWidth*.3,animation=element.animate([{transform:'none'},{transform:`translateX(${-distance}px)`}],{duration:350,easing:standard,fill:'forwards'});underLayers.set(dialog,{element,distance,animation});}
  }
  const animation=dialog.animate(reduce?[{opacity:0},{opacity:1}]:[{transform:phone()&&!drilldown?'translateY(100%)':'translateX(100%)'},{transform:'none'}],{duration:reduce?0:phone()?drilldown?350:380:320,easing:standard});
  entrances.set(dialog,animation);
  if(!boundDialogs.has(dialog)){boundDialogs.add(dialog);dialog.addEventListener('close',()=>{if(dialog.open)return;entrances.get(dialog)?.cancel();restoreUnderLayer(dialog)?.();});}return animation;
}
export function fadeDialog(dialog){
  return dialog.animate(reducedMotion()?[{opacity:0},{opacity:1}]:[{opacity:0,transform:'scale(.98)'},{opacity:1,transform:'none'}],{duration:reducedMotion()?0:220,easing:standard});
}
export function captureObject(source){
  if(!source)return null;const rect=source.getBoundingClientRect(),style=getComputedStyle(source);
  if(!rect.width||!rect.height)return null;
  return {element:cleanClone(source),rect:{left:rect.left,top:rect.top,width:rect.width,height:rect.height},font:style.font,color:style.color};
}
export function dismissSheet(dialog,{drilldown=false,target=null}={}){
  if(!dialog?.open)return;
  entrances.get(dialog)?.cancel();const back=restoreUnderLayer(dialog);
  const rect=dialog.getBoundingClientRect(),clone=cleanClone(dialog),layer=animationLayer();
  clone.classList.add('exiting-layer');clone.style.inset='auto';clone.style.left=rect.left+'px';clone.style.top=rect.top+'px';clone.style.width=rect.width+'px';clone.style.height=rect.height+'px';clone.style.margin='0';layer.append(clone);
  if(target)sharedObject(dialog.querySelector('.sheet-object'),target);
  dialog.close();
  back?.();const reduce=reducedMotion();retire(layer,clone.animate(reduce?[{opacity:1},{opacity:0}]:[{transform:'none',opacity:1},{transform:phone()&&!drilldown?'translateY(100%)':'translateX(100%)',opacity:0}],{duration:reduce?0:phone()&&drilldown?350:220,easing:'cubic-bezier(.4,0,1,1)'}));
}
export function dismissReveal(dialog,element=dialog){
  if(!dialog?.open)return null;
  const rect=element.getBoundingClientRect(),clone=cleanClone(element),layer=animationLayer();
  clone.style.position='absolute';clone.style.left=rect.left+'px';clone.style.top=rect.top+'px';clone.style.width=rect.width+'px';clone.style.height=rect.height+'px';clone.style.margin='0';layer.append(clone);dialog.close();
  const animation=clone.animate(reducedMotion()?[{opacity:1},{opacity:0}]:[{clipPath:'inset(0)'},{clipPath:'inset(100% 0 0 0)'}],{duration:reducedMotion()?0:220,easing:'cubic-bezier(.4,0,1,1)'});retire(layer,animation);return animation;
}
export function sharedObject(source,target,{uniformScale=false}={}){
  if(!source||!target)return;
  const saved=source.element?source:captureObject(source);if(!saved)return;
  const from=saved.rect,to=target.getBoundingClientRect();
  if(!from.width||!from.height||!to.width||!to.height)return;
  const reduce=reducedMotion();
  if(reduce)return;
  const clone=cleanClone(saved.element),layer=animationLayer();clone.classList.add('flip-ghost');if(saved.font)clone.style.font=saved.font;clone.style.color=saved.color;
  clone.style.position='absolute';clone.style.left=from.left+'px';clone.style.top=from.top+'px';clone.style.width=from.width+'px';clone.style.height=from.height+'px';clone.style.transformOrigin='0 0';layer.append(clone);
  const scaleY=to.height/from.height,scaleX=uniformScale?scaleY:to.width/from.width;
  retire(layer,clone.animate([{transform:'none',opacity:1},{transform:`translate(${to.left-from.left}px,${to.top-from.top}px) scale(${scaleX},${scaleY})`,opacity:0}],{duration:320,easing:standard}));
  target.animate([{opacity:.4},{opacity:1}],{duration:320,easing:standard});
}

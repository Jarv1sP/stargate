import {reducedMotion} from './motion-ui.js';
const spring='cubic-bezier(.34,1.32,.5,1)';

// Centered sheets from the approved design: they spring in and fade out.
export function openSheet(dialog){
  if(dialog.open)return;dialog.showModal();
  if(!reducedMotion())dialog.animate([{opacity:0,transform:'translateY(4%) scale(.97)'},{opacity:1,transform:'none'}],{duration:450,easing:spring});
}
export function closeSheet(dialog){
  if(!dialog?.open)return;
  if(reducedMotion()){dialog.close();return;}
  dialog.animate([{opacity:1},{opacity:0,transform:'translateY(2%) scale(.98)'}],{duration:180,easing:'ease-in'}).finished.then(()=>dialog.close(),()=>dialog.close());
}

// One confirm sheet for destructive actions.
export function confirmSheet({title,body,action,run}){
  const dialog=document.createElement('dialog');dialog.className='pr-sheet sg-confirm';dialog.setAttribute('aria-label',title);
  dialog.innerHTML='<div class="pr-sheet-in"><div class="jr-confirm-title"></div><p class="jr-confirm-body"></p><p class="jr-error" hidden></p><div class="jr-actions"><button type="button" class="jr-btn ghost" data-confirm-back>算了</button><button type="button" class="jr-btn primary danger" data-confirm-go></button></div></div>';
  const q=selector=>dialog.querySelector(selector),go=q('[data-confirm-go]'),close=()=>{closeSheet(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});};
  q('.jr-confirm-title').textContent=title;q('.jr-confirm-body').textContent=body;go.textContent=action;
  q('[data-confirm-back]').addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
  go.addEventListener('click',async()=>{go.disabled=true;try{await run();close();}catch(error){q('.jr-error').textContent=error.message;q('.jr-error').hidden=false;go.disabled=false;}});
  document.body.append(dialog);openSheet(dialog);q('[data-confirm-back]').focus();
}

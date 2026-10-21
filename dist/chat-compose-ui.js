// Chat composer extras: Enter to send, @member suggestions, emoji and one picture.
// Pictures are re-encoded here (smaller, no EXIF) so the portal only stores and serves bytes.
import {CHAT_IMAGE,CHAT_EMOJIS} from './chat-content.js';
const RAW_LIMIT=30*1024*1024;
function el(tag,className,text){const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=String(text);return node;}
const encode=(canvas,type,quality)=>new Promise(resolve=>canvas.toBlob(resolve,type,quality));
const dataURL=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob);});
export async function compressChatImage(file){
  if(!file?.type?.startsWith('image/'))throw Error('只能发送图片文件。');
  if(file.size>RAW_LIMIT)throw Error('图片超过 30 MB，请先缩小后再发送。');
  let bitmap;try{bitmap=await createImageBitmap(file);}catch{throw Error('无法读取这张图片，请换 PNG、JPEG 或 WebP。');}
  try{
    let scale=Math.min(1,CHAT_IMAGE.maxSide/Math.max(bitmap.width,bitmap.height));
    for(let round=0;round<4;round++,scale*=.7){
      const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(bitmap.width*scale));canvas.height=Math.max(1,Math.round(bitmap.height*scale));
      const context=canvas.getContext('2d');context.drawImage(bitmap,0,0,canvas.width,canvas.height);let opaque=false;
      for(const quality of [.82,.65]){
        // Browsers without a WebP encoder hand back PNG; JPEG then needs an opaque backdrop.
        let blob=await encode(canvas,'image/webp',quality);
        if(blob?.type!=='image/webp'){
          if(!opaque){context.globalCompositeOperation='destination-over';context.fillStyle='#fff';context.fillRect(0,0,canvas.width,canvas.height);context.globalCompositeOperation='source-over';opaque=true;}
          blob=await encode(canvas,'image/jpeg',quality);
        }
        if(blob&&blob.size<=CHAT_IMAGE.maxBytes){const url=await dataURL(blob);return {type:blob.type,data:url.slice(url.indexOf(',')+1),width:canvas.width,height:canvas.height,preview:url};}
      }
    }
  }finally{bitmap.close?.();}
  throw Error('图片压缩后仍然过大，请裁剪后再发送。');
}
export function createChatComposer({form,input,members,onError}){
  let image=null,choices=[],active=0,busy=false;
  const tools=el('div','chat-tools'),emojiButton=el('button','chat-tool'),imageButton=el('button','chat-tool'),file=el('input');
  emojiButton.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M8 14s1 3 4 3 4-3 4-3M8 9h.01M16 9h.01"/></svg>';
  emojiButton.title='插入表情';imageButton.title='发送图片';
  emojiButton.type=imageButton.type='button';emojiButton.setAttribute('aria-label','插入表情');emojiButton.setAttribute('aria-expanded','false');
  imageButton.innerHTML='<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="m21 16-5-5-9 9"/></svg>';
  imageButton.setAttribute('aria-label','发送图片');file.type='file';file.accept=CHAT_IMAGE.types.join(',');file.hidden=true;
  const emojiPanel=el('div','chat-popover chat-emoji-panel');emojiPanel.hidden=true;emojiPanel.setAttribute('role','group');emojiPanel.setAttribute('aria-label','表情');
  for(const emoji of CHAT_EMOJIS){const option=el('button','chat-emoji',emoji);option.type='button';option.addEventListener('click',()=>{insert(emoji);toggleEmoji(false);});emojiPanel.append(option);}
  const mentionList=el('div','chat-popover chat-mention-list');mentionList.hidden=true;mentionList.setAttribute('role','listbox');mentionList.setAttribute('aria-label','提及成员');
  const attachment=el('div','chat-attachment');attachment.hidden=true;
  tools.append(emojiButton,imageButton,file);form.prepend(attachment);form.append(emojiPanel,mentionList);input.before(tools);
  const submit=form.querySelector('[type=submit]');
  function fit(){
    input.style.height='36px';input.style.height=(input.value?Math.min(140,Math.max(36,input.scrollHeight)):36)+'px';
    const ready=Boolean(input.value.trim()||image);submit.setAttribute('aria-disabled',String(!ready));submit.classList.toggle('is-ready',ready);
  }
  const resize=new ResizeObserver(()=>{if(input.clientWidth)fit();});resize.observe(input.parentElement);
  fit();
  const locked=()=>input.readOnly||input.disabled;
  function insert(text){
    if(locked())return;const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;
    input.setRangeText(text,start,end,'end');input.focus();input.dispatchEvent(new Event('input',{bubbles:true}));
  }
  function toggleEmoji(open=emojiPanel.hidden){emojiPanel.hidden=!open||locked();emojiButton.setAttribute('aria-expanded',String(!emojiPanel.hidden));if(open)closeMentions();}
  function renderAttachment(){
    attachment.replaceChildren();attachment.hidden=!image;input.required=!image;fit();if(!image)return;
    const preview=el('img');preview.src=image.preview;preview.alt='待发送的图片';
    const remove=el('button','community-text-button','移除');remove.type='button';remove.addEventListener('click',()=>{if(!locked()){image=null;renderAttachment();input.focus();}});
    attachment.append(preview,remove);
  }
  async function attach(source){
    if(!source||busy||locked())return;busy=true;imageButton.disabled=true;onError('');
    try{image=await compressChatImage(source);renderAttachment();input.focus();}
    catch(error){onError(error.message);}
    finally{busy=false;imageButton.disabled=false;}
  }
  // The @word right before the caret, if the caret sits at its end. Chinese text has no
  // space before @; only a letter or digit right before it (an e-mail address) is not a mention.
  function query(){const before=input.value.slice(0,input.selectionStart??0),match=/(?:^|[^A-Za-z0-9._%+-])@([^\s@]{0,24})$/u.exec(before);return match&&input.selectionStart===input.selectionEnd?match[1]:null;}
  function closeMentions(){choices=[];mentionList.hidden=true;input.removeAttribute('aria-activedescendant');}
  function suggest(){
    const word=locked()?null:query();if(word===null){closeMentions();return;}
    const lower=word.toLowerCase();
    // Everyone who matches, in name order; the list scrolls.
    choices=members().filter(user=>user.username.toLowerCase().includes(lower)||(user.name||'').toLowerCase().includes(lower))
      .sort((a,b)=>(a.name||a.username).localeCompare(b.name||b.username,'zh-CN'));
    if(!choices.length){closeMentions();return;}
    active=Math.min(active,choices.length-1);mentionList.replaceChildren();
    for(const [index,user] of choices.entries()){
      const option=el('div','chat-mention-option'+(index===active?' active':''));option.id='chat-mention-'+index;option.setAttribute('role','option');option.setAttribute('aria-selected',String(index===active));
      option.append(el('span','',user.name||user.username),el('small','','@'+user.username));
      // pointerdown keeps the textarea focused and its caret in place.
      option.addEventListener('pointerdown',event=>{event.preventDefault();pick(index);});mentionList.append(option);
    }
    mentionList.hidden=false;toggleEmoji(false);input.setAttribute('aria-activedescendant','chat-mention-'+active);
    mentionList.children[active].scrollIntoView({block:'nearest'});
  }
  function pick(index){
    const user=choices[index],word=query();if(!user||word===null)return;
    const end=input.selectionStart;input.setSelectionRange(end-word.length-1,end);closeMentions();insert('@'+user.username+' ');
  }
  emojiButton.addEventListener('click',()=>toggleEmoji());
  imageButton.addEventListener('click',()=>{if(!locked())file.click();});
  file.addEventListener('change',()=>{attach(file.files[0]);file.value='';});
  input.addEventListener('paste',event=>{const item=[...event.clipboardData?.files||[]].find(f=>f.type.startsWith('image/'));if(item){event.preventDefault();attach(item);}});
  form.addEventListener('dragover',event=>{if([...event.dataTransfer?.items||[]].some(i=>i.kind==='file'))event.preventDefault();});
  form.addEventListener('drop',event=>{const item=[...event.dataTransfer?.files||[]].find(f=>f.type.startsWith('image/'));if(item){event.preventDefault();attach(item);}});
  input.addEventListener('input',()=>{active=0;fit();suggest();});
  input.addEventListener('click',suggest);
  input.addEventListener('blur',()=>setTimeout(closeMentions,0));
  input.addEventListener('keydown',event=>{
    // An IME is still composing (Chinese input): Enter confirms the word, never sends.
    if(event.isComposing||event.keyCode===229)return;
    if(!mentionList.hidden){
      if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();active=(active+(event.key==='ArrowDown'?1:choices.length-1))%choices.length;suggest();return;}
      if(event.key==='Enter'||event.key==='Tab'){event.preventDefault();pick(active);return;}
      if(event.key==='Escape'){event.preventDefault();closeMentions();return;}
    }
    if(event.key==='Escape'&&!emojiPanel.hidden){toggleEmoji(false);return;}
    if(event.key==='Enter'&&!event.shiftKey&&!event.ctrlKey&&!event.altKey&&!event.metaKey){event.preventDefault();form.requestSubmit();}
  });
  document.addEventListener('pointerdown',event=>{if(!emojiPanel.hidden&&!emojiPanel.contains(event.target)&&event.target!==emojiButton)toggleEmoji(false);});
  return {
    payload(){return image?{body:input.value,image:{type:image.type,data:image.data,width:image.width,height:image.height}}:{body:input.value};},
    clear(){image=null;renderAttachment();closeMentions();toggleEmoji(false);},
    lock(value){emojiButton.disabled=value;imageButton.disabled=value||busy;if(value){toggleEmoji(false);closeMentions();}},
    destroy(){resize.disconnect();},
    hasImage:()=>!!image
  };
}

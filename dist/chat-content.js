// Chat content rules shared by the portal and the browser. A mention is plain
// "@username" text; nothing here produces or interprets HTML.
export const CHAT_IMAGE=Object.freeze({types:['image/webp','image/jpeg','image/png'],maxBytes:700000,maxSide:1600});
export const CHAT_EMOJIS=Object.freeze(['😀','😂','🤣','😊','😍','🤔','😅','😭','😎','🥳','😴','🙃','😮','😡','👍','👎','👌','🙏','👏','💪','🤝','🎉','🔥','✅','❌','❓','💡','🚀','⏳','🐛','☕','❤️']);
const wordChar=/[\p{L}\p{N}_-]/u;
// Longest username first, so "@li" never shadows "@lin".
export function chatSegments(body,users){
  const names=users.filter(user=>user?.username).sort((a,b)=>b.username.length-a.username.length),segments=[];let start=0;
  for(let at=body.indexOf('@');at>=0;at=body.indexOf('@',at+1)){
    if(at<start)continue;
    const user=names.find(user=>body.startsWith(user.username,at+1)&&!wordChar.test(body[at+1+user.username.length]||''));
    if(!user)continue;
    if(at>start)segments.push({text:body.slice(start,at)});
    segments.push({text:'@'+user.username,user});start=at+1+user.username.length;
  }
  if(start<body.length)segments.push({text:body.slice(start)});
  return segments;
}
export function mentionedUsers(body,users){return [...new Map(chatSegments(body,users).filter(part=>part.user).map(part=>[part.user.id,part.user])).values()];}

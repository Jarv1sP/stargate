// The opening is the loading screen. Its markup and splash.css are the first
// things in the page, so the Λ lift-off is already playing while the rest of
// the platform downloads; past one cycle splash.css shows a scan line. The cover
// opens once the lift-off has played through and the first room has rendered,
// and never later than 15 s after the page started (splash.css also steps aside
// then if this script never runs).
const LIMIT=15000,INTRO=/^(lift-|auth-lambda-ignite$)/;
export function installWordmark(){
  const root=document.querySelector('#startup-wordmark');if(!root||root.hidden)return;
  let done=false,cap=0;
  function finish(){if(done)return;done=true;clearTimeout(cap);root.classList.add('leaving');setTimeout(()=>{root.hidden=true;root.replaceChildren();},450);}
  const cycle=Promise.all(root.getAnimations({subtree:true}).filter(animation=>INTRO.test(animation.animationName)).map(animation=>animation.finished.catch(()=>{})));
  // shellUI runs this just before app.js renders the first room in the same
  // task, so the next task sees it rendered; two frames let it paint underneath.
  const ready=Promise.all([document.fonts?.ready,new Promise(resolve=>setTimeout(resolve))]).then(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  Promise.all([cycle,ready]).then(finish);
  cap=setTimeout(finish,Math.max(0,LIMIT-performance.now()));
  root.addEventListener('click',finish);
}

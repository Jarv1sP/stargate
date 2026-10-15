import {registerAdminSection} from './admin-ui.js';

// Move the original controls, retaining their DOM identity and handlers.
// The admin frame supplies the confirmed identity and aborts before unmount.
export const membersRoute=route=>String(route??'').replace(/^#/,'')==='users'?'#admin/members':route;
export function membersAdminUI(store,{getPage,render,unmount=()=>{}}){
  const parking=document.querySelector('#members-parking'),root=document.querySelector('#page-users');
  let context=null;
  const active=()=>!!context&&!context.signal.aborted&&!store.authPending&&getPage()==='admin'&&
    store.principal?.role==='admin'&&store.principal.userId===context.principal.userId;
  const unregister=registerAdminSection({id:'members',title:'成员与额度',order:30,
    mount(el,ctx){
      context=ctx;root.hidden=false;el.append(root);
      ctx.subscribe(()=>{if(active()){root.hidden=false;render();}});
    },
    unmount(){
      context=null;
      root.hidden=true;parking.append(root);
      document.querySelector('#editor').replaceChildren();document.querySelector('#user-list').replaceChildren();
      unmount();
    },
  });
  return {active,capture:()=>context,current:stamp=>!!stamp&&stamp===context&&active(),
    owns:node=>root.contains(node),dispose:unregister};
}

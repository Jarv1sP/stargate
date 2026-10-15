import {registerAdminSection} from './admin-ui.js';
import {operationalMaintenanceUI} from './maintenance-ui.js';
import {hostDiagnosticsUI} from './host-diagnostics-ui.js';

export function maintenanceAdminUI(store,experience,{getPage,toast,refresh}){
  let context=null,settings=null;
  const diagnostics=hostDiagnosticsUI(store,{toast});
  const active=ctx=>!!ctx&&ctx===context&&!ctx.signal.aborted&&!store.authPending&&getPage()==='admin'&&
    store.principal?.role==='admin'&&store.principal.userId===ctx.principal.userId;
  return registerAdminSection({id:'maintenance',title:'维护',order:40,
    mount(el,ctx){
      context=ctx;el.className='admin-maintenance';
      settings=document.createElement('div');settings.id='admin-maintenance-settings';el.append(settings);
      const renderSettings=operationalMaintenanceUI(store,toast,refresh,{host:settings,management:true,active:()=>active(ctx)});
      experience.mountAdmin(el,ctx);
      diagnostics.mount(el,ctx);
      function render(){
        if(!active(ctx))return;renderSettings();

      }
      el.addEventListener('click',event=>{if(event.target.closest('[data-maintenance-settings]')&&active(ctx))settings.querySelector('dialog')?.showModal();},{signal:ctx.signal});
      settings.addEventListener('close',()=>{if(active(ctx))el.querySelector('[data-maintenance-settings]')?.focus({preventScroll:true});},{capture:true,signal:ctx.signal});
      document.addEventListener('gpuq-maintenance-host',event=>{if(!active(ctx)||event.detail?.userId!==ctx.principal.userId)return;diagnostics.select(event.detail.machine);document.querySelector('#admin-host-diagnostics')?.scrollIntoView({block:'start',behavior:'instant'});},{signal:ctx.signal});
      ctx.subscribe(render);
    },
    unmount(){
      context=null;diagnostics.unmount();experience.unmountAdmin();
      settings?.querySelector('dialog')?.close();settings?.replaceChildren();settings=null;
    },
  });
}

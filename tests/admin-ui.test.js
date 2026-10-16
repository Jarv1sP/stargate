import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminRegistry,createAdminUI} from '../dist/admin-ui.js';

function fixture(t){
  const original={document:globalThis.document,location:globalThis.location,history:globalThis.history};
  class Element{
    constructor(){this.children=[];this.dataset={};this.hidden=false;this.parent=null;this.scrolls=0;this.events={};this.classList={toggle(){}};}
    append(...nodes){for(const node of nodes){node.remove?.();this.children.push(node);node.parent=this;}}
    insertBefore(node,next){node.remove?.();const index=this.children.indexOf(next);this.children.splice(index<0?this.children.length:index,0,node);node.parent=this;}
    remove(){if(this.parent){this.parent.children.splice(this.parent.children.indexOf(this),1);this.parent=null;}}
    replaceChildren(...nodes){for(const node of [...this.children])node.remove?.();this.append(...nodes);}
    setAttribute(){}removeAttribute(){}addEventListener(name,fn){this.events[name]=fn;}removeEventListener(name){delete this.events[name];}
    scrollIntoView(){this.scrolls++;}contains(node){return this.children.includes(node);}
  }
  const nodes=Object.fromEntries(['page-admin','admin-frame','admin-denied','admin-sections','admin-content'].map(id=>[id,new Element()]));
  globalThis.document={querySelector:selector=>nodes[selector.slice(1)],createElement:()=>new Element()};
  globalThis.location={hash:'#admin/second'};globalThis.history={replaceState(_a,_b,hash){location.hash=hash;}};
  t.after(()=>Object.assign(globalThis,original));
  let page='admin';const auth=[],toasts=[],navigated=[],events=[],contexts=new Map(),registry=createAdminRegistry();
  const store={principal:{userId:'admin-a',role:'admin'},authGeneration:1,onAuthChange(fn){auth.push(fn);return()=>{};}};
  const section=(id,order)=>({id,title:id,order,mount(el,ctx){events.push('mount:'+id);contexts.set(id,ctx);ctx.subscribe(()=>events.push('render:'+id));},unmount(){assert.equal(contexts.get(id).signal.aborted,true);events.push('unmount:'+id);}});
  registry.register(section('second',20));registry.register(section('first',10));
  const control=createAdminUI(store,{getPage:()=>page,navigate:route=>navigated.push(route),toast:message=>toasts.push(message)},registry);
  t.after(()=>control.dispose());
  return {nodes,registry,control,events,contexts,store,auth,toasts,navigated,section,setPage:value=>{page=value;}};
}

test('admin mounts every registered section in order and anchors scroll without remounting',t=>{
  const f=fixture(t);f.control.update();
  assert.deepEqual(f.events.filter(e=>e.startsWith('mount:')),['mount:first','mount:second']);
  const hosts=[...f.nodes['admin-content'].children];assert.equal(hosts.length,2);assert.equal(hosts[1].scrolls,1);
  location.hash='#admin/first';f.control.update();
  assert.equal(hosts[0].scrolls,1);assert.equal(f.control.currentSection(),'first');
  assert.deepEqual(f.events.filter(e=>e.startsWith('unmount:')),[]);
  f.control.update();assert.equal(hosts[0].scrolls,1,'ordinary refresh never jumps back to the anchor');
});
test('unregister affects one section; leaving or changing identity aborts all before unmount',t=>{
  const f=fixture(t);f.control.update();const first=f.contexts.get('first'),second=f.contexts.get('second');
  const remove=f.registry.register(f.section('temporary',30));const temporary=f.contexts.get('temporary');remove();
  assert.equal(temporary.signal.aborted,true);assert.equal(first.signal.aborted,false);assert.equal(second.signal.aborted,false);
  f.setPage('work');f.control.update();assert.equal(first.signal.aborted,true);assert.equal(second.signal.aborted,true);
  const count=f.events.length;first.toast('old');first.navigate('old');first.subscribe(()=>f.events.push('late'));
  assert.equal(f.events.length,count);assert.deepEqual(f.toasts,[]);assert.deepEqual(f.navigated,[]);
  f.setPage('admin');f.control.update();const current=f.contexts.get('first');assert.notEqual(current,first);
  f.auth[0]();assert.equal(current.signal.aborted,true);assert.equal(f.nodes['admin-frame'].hidden,true);
});
test('members cannot mount admin sections and account changes receive new section contexts',t=>{
  const f=fixture(t);f.store.principal.role='member';f.control.update();assert.equal(f.events.length,0);assert.equal(f.nodes['admin-denied'].hidden,false);
  f.store.principal.role='admin';f.control.update();const old=f.contexts.get('first');
  f.store.principal={userId:'admin-b',role:'admin'};f.store.authGeneration++;f.control.update();
  assert.equal(old.signal.aborted,true);assert.equal(f.contexts.get('first').principal.userId,'admin-b');
});

test('a failed mount can retry without aborting sibling sections',async t=>{
  const f=fixture(t);f.control.update();const sibling=f.contexts.get('first');let attempts=0,stopped=0;
  f.registry.register({id:'failing',title:'Failure',order:30,mount(){attempts++;if(attempts===1)throw Error('fixture failure');},unmount(){stopped++;}});
  const failure=f.nodes['admin-content'].children[2];assert.equal(failure.children[0].textContent,'暂时无法显示这个区块。');
  failure.children[1].events.click();await Promise.resolve();
  assert.equal(attempts,2);assert.equal(stopped,1);assert.equal(sibling.signal.aborted,false);
});

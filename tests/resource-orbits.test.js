import test from 'node:test';
import assert from 'node:assert/strict';
import {resourceOrbits} from '../dist/resource-orbits.js';

test('the orbit field stops in hidden rooms and background tabs, and honors live reduced-motion changes',t=>{
  const names=['document','matchMedia','requestAnimationFrame','cancelAnimationFrame','ResizeObserver','devicePixelRatio'],previous=new Map(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor] of previous)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];});
  let visible=true,next=0,drawn=0;const frames=new Map(),events={},motion={matches:false,addEventListener:(type,fn)=>{events.motion=fn;}};
  const context={setTransform(){},clearRect(){},save(){},translate(){},rotate(){},beginPath(){},ellipse(){},stroke(){drawn++;},fillRect(){},restore(){}};
  const canvas={isConnected:true,width:0,height:0,getContext:()=>context,getBoundingClientRect:()=>({width:600,height:290})};
  Object.assign(globalThis,{devicePixelRatio:3,document:{hidden:false,addEventListener:(type,fn)=>{events[type]=fn;}},matchMedia:()=>motion,
    requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id),ResizeObserver:class{observe(){}}});
  const update=resourceOrbits(canvas,()=>visible),tick=()=>{const [id,callback]=frames.entries().next().value;frames.delete(id);callback(1000);};
  update();assert.equal(canvas.width,1200,'the decorative canvas caps pixel density at two');assert.equal(frames.size,1);tick();assert.ok(drawn>0);
  visible=false;update();assert.equal(frames.size,0,'another room has no animation loop');
  visible=true;update();document.hidden=true;events.visibilitychange();assert.equal(frames.size,0,'background tabs have no animation loop');
  document.hidden=false;events.visibilitychange();assert.equal(frames.size,1);
  motion.matches=true;events.motion();assert.equal(frames.size,0,'enabling reduced motion cancels an existing loop');
  update();assert.equal(frames.size,0,'periodic monitoring updates cannot restart reduced motion');
  motion.matches=false;events.motion();assert.equal(frames.size,1);
  canvas.isConnected=false;tick();assert.equal(frames.size,0,'detaching the canvas cannot leave a live loop');
});

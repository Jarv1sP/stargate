// A decorative field behind the selected server. It has no loop while the
// compute room is hidden, the tab is in the background, or motion is reduced.
export function resourceOrbits(canvas,visible){
  const context=canvas.getContext('2d'),motion=matchMedia('(prefers-reduced-motion:reduce)');
  let frame=0,width=0,height=0;
  const paths=[{x:.48,y:.23,angle:-.22,speed:.000045,count:9},{x:.4,y:.35,angle:.25,speed:-.00006,count:7},{x:.56,y:.16,angle:-.05,speed:.00003,count:11}];
  function size(){
    const bounds=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);
    width=bounds.width;height=bounds.height;
    const w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;context?.setTransform(ratio,0,0,ratio,0,0);}
  }
  function draw(time){
    if(!context)return;
    context.clearRect(0,0,width,height);
    for(const [index,path] of paths.entries()){
      context.save();context.translate(width*.48,height*.48);context.rotate(path.angle);
      context.strokeStyle='rgba(242,242,239,.06)';context.lineWidth=1;context.beginPath();context.ellipse(0,0,width*path.x,height*path.y,0,0,Math.PI*2);context.stroke();
      for(let point=0;point<path.count;point++){
        const angle=point/path.count*Math.PI*2+index*.9+time*path.speed,x=Math.cos(angle)*width*path.x,y=Math.sin(angle)*height*path.y;
        context.fillStyle='rgba(242,242,239,.28)';context.fillRect(x-1,y-1,2,2);
      }
      context.restore();
    }
  }
  const active=()=>!!context&&canvas.isConnected&&visible()&&!document.hidden&&!motion.matches;
  function tick(time){frame=0;if(!active())return;draw(time);frame=requestAnimationFrame(tick);}
  function update(){
    size();if(frame)cancelAnimationFrame(frame);frame=0;
    if(active())frame=requestAnimationFrame(tick);else context?.clearRect(0,0,width,height);
  }
  new ResizeObserver(update).observe(canvas);
  document.addEventListener('visibilitychange',update);motion.addEventListener('change',update);
  return update;
}

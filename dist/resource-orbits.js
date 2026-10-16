// A Starlink-style field behind the selected server: three inclined shells of
// satellites over a faint star field. Reduced motion draws one still frame; the
// loop never runs while the compute room is hidden or the tab is in the background.
export function resourceOrbits(canvas,visible){
  const context=canvas.getContext('2d'),motion=matchMedia('(prefers-reduced-motion:reduce)');
  let frame=0,width=0,height=0;
  const shells=[{rx:.46,ry:.32,angle:-.2,speed:.00011,count:10},{rx:.38,ry:.45,angle:.16,speed:-.00015,count:8},{rx:.56,ry:.21,angle:-.04,speed:.00008,count:12}];
  // Fixed pseudo-random stars so a re-render never reshuffles the sky.
  const stars=Array.from({length:72},(_,index)=>{const seed=n=>{const x=Math.sin(index*12.9898+n*78.233)*43758.5453;return x-Math.floor(x);};return [seed(1),seed(2),seed(3)];});
  function size(){
    const bounds=canvas.getBoundingClientRect(),ratio=Math.min(devicePixelRatio||1,2);
    width=bounds.width;height=bounds.height;
    const w=Math.round(width*ratio),h=Math.round(height*ratio);
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;context?.setTransform(ratio,0,0,ratio,0,0);}
  }
  function draw(time){
    if(!context)return;
    context.clearRect(0,0,width,height);
    const still=motion.matches,cx=width*.62,cy=height*.5;
    for(const [x,y,glow] of stars){
      context.fillStyle=`rgba(242,242,239,${((.08+glow*.28)*(still?1:.75+.25*Math.sin(time/900+x*40))).toFixed(3)})`;
      context.fillRect(x*width,y*height,1,1);
    }
    for(const [index,shell] of shells.entries()){
      context.save();context.translate(cx,cy);context.rotate(shell.angle);
      context.strokeStyle='rgba(242,242,239,.12)';context.lineWidth=1;context.beginPath();context.ellipse(0,0,width*shell.rx,height*shell.ry,0,0,Math.PI*2);context.stroke();
      for(let point=0;point<shell.count;point++){
        const angle=point/shell.count*Math.PI*2+index*.7+time*shell.speed,front=Math.sin(angle)>0,size=front?2.4:1.4;
        context.fillStyle=front?'rgba(242,242,239,.9)':'rgba(242,242,239,.3)';
        context.fillRect(Math.cos(angle)*width*shell.rx-size/2,Math.sin(angle)*height*shell.ry-size/2,size,size);
      }
      context.restore();
    }
    // A Starlink train crosses every 18s: a string of evenly spaced lights on a slow diagonal.
    const phase=still?-1:(time%18000)/7000;
    if(phase>=0&&phase<1)for(let car=0;car<12;car++){
      const p=phase*1.35-car*.022;if(p<0||p>1)continue;
      context.fillStyle=`rgba(242,242,239,${(.85*Math.sin(Math.PI*p)).toFixed(3)})`;
      context.fillRect(width*(-.05+1.1*p),height*(.86-.62*p),2,2);
    }
  }
  const shown=()=>!!context&&canvas.isConnected&&visible()&&!document.hidden;
  function tick(time){frame=0;if(!shown()||motion.matches)return;draw(time);frame=requestAnimationFrame(tick);}
  let settle=0;
  function update(){
    size();if(frame)cancelAnimationFrame(frame);frame=0;
    if(!shown())context?.clearRect(0,0,width,height);
    // The still frame waits briefly for layout when the room has just been shown.
    else if(motion.matches){if(!width&&settle++<5)setTimeout(update,60);else{settle=0;draw(0);}}
    else frame=requestAnimationFrame(tick);
  }
  new ResizeObserver(update).observe(canvas);
  document.addEventListener('visibilitychange',update);motion.addEventListener('change',update);
  return update;
}

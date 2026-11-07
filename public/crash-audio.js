/* User-supplied reference loops, with synthesized fallback and a separate crash cue. */
function setupCrashAudio(button) {
  const AudioContext=window.AudioContext||window.webkitAudioContext;
  let ctx,master,noise,bed,active=false,game,latest,muted=false,unavailable=!AudioContext;
  const groups=new Set();
  const loops={};
  function loadLoops(){
    for(const [phase,file] of [['waiting','azmera-countdown-reference.mp3'],['flying','azmera-flight-reference.mp3']]){
      fetch(`/assets/audio/${file}`,{signal:AbortSignal.timeout(10000)})
        .then(response=>{if(!response.ok)throw new Error('Audio unavailable');return response.arrayBuffer();})
        .then(bytes=>ctx.decodeAudioData(bytes))
        .then(buffer=>{loops[phase]=buffer;if(active&&latest)safe(()=>ambience(latest));})
        .catch(()=>{/* Keep the synthesized fallback if the sample cannot load. */});
    }
  }
  try{muted=localStorage.getItem('azmera-game-muted')==='true';}catch{}
  function label(){
    button.textContent=unavailable?'Sound unavailable':muted?'🔇':'🔊';
    button.disabled=unavailable;button.setAttribute('aria-label',muted?'Enable game sound':'Mute game sound');button.setAttribute('aria-pressed',String(!muted&&!unavailable));button.title=muted?'Enable sound':'Mute sound';
  }
  function cleanup(group){if(!groups.delete(group))return;for(const node of group.nodes)try{node.disconnect();}catch{}if(bed===group)bed=null;}
  function stop(group){
    if(!group||group.stopping)return;group.stopping=true;
    const now=ctx.currentTime;group.gain.gain.cancelScheduledValues(now);group.gain.gain.setTargetAtTime(0,now,.02);
    for(const source of group.sources)try{source.stop(now+.12);}catch{}
    if(bed===group)bed=null;
  }
  function silence(){for(const group of groups)stop(group);}
  function safe(fn){try{fn();}catch{silence();unavailable=true;label();}}
  function ready(){
    if(!ctx){
      ctx=new AudioContext();master=ctx.createGain();master.gain.value=.22;
      const limiter=ctx.createDynamicsCompressor();limiter.threshold.value=-12;limiter.knee.value=16;limiter.ratio.value=8;
      master.connect(limiter);limiter.connect(ctx.destination);
      noise=ctx.createBuffer(1,Math.ceil(ctx.sampleRate*1.4),ctx.sampleRate);
      const data=noise.getChannelData(0);for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*.65;
      ctx.addEventListener('statechange',()=>{if(ctx.state!=='running')silence();});
      loadLoops();
    }
    ctx.resume().then(()=>{if(active&&latest&&!document.hidden&&!muted)safe(()=>ambience(latest));}).catch(()=>{muted=true;label();});
  }
  function group(sources,nodes,gain){const g={sources,nodes,gain};groups.add(g);sources[0].onended=()=>cleanup(g);return g;}
  function ambience(snapshot){
    if(!ctx||ctx.state!=='running'||muted||!active||document.hidden||!['waiting','flying'].includes(snapshot.round.phase))return;
    // Midrange fundamentals remain audible on small phone speakers.
    const now=ctx.currentTime,jet=game==='azmera-jet',base=jet?261.63:220,flying=snapshot.round.phase==='flying';
    const phase=snapshot.round.phase;
    if(loops[phase]){
      if(bed?.sample!==phase){
        stop(bed);const source=ctx.createBufferSource(),gain=ctx.createGain();source.buffer=loops[phase];source.loop=true;
        gain.gain.setValueAtTime(0,now);gain.gain.setTargetAtTime(flying?2.8:2,now,.3);
        source.connect(gain);gain.connect(master);source.start(now);
        bed=group([source],[source,gain],gain);bed.sample=phase;
      }
      return;
    }
    if(bed?.sample)stop(bed);
    const tension=Math.min(1,Math.max(0,snapshot.now-snapshot.round.starts)/45000);
    if(!bed){
      const gain=ctx.createGain(),filter=ctx.createBiquadFilter();filter.type='lowpass';filter.frequency.value=1400;filter.Q.value=.5;
      gain.gain.setValueAtTime(0,now);filter.connect(gain);gain.connect(master);
      const tones=[1,1.1892,1.5].map(ratio=>{const o=ctx.createOscillator();o.type='triangle';o.frequency.value=base*ratio;o.connect(filter);o.start();return o;});
      const pulse=ctx.createOscillator(),depth=ctx.createGain();pulse.frequency.value=.75;depth.gain.value=.025;pulse.connect(depth);depth.connect(gain.gain);pulse.start();
      bed=group([...tones,pulse],[...tones,pulse,depth,filter,gain],gain);bed.tones=tones;bed.pulse=pulse;bed.filter=filter;
    }
    bed.tones.forEach((tone,i)=>tone.frequency.setTargetAtTime(base*[1,1.1892,1.5][i]*(1+tension*.3),now,1.2));
    bed.gain.gain.setTargetAtTime(flying?.24:.16,now,.25);
    bed.filter.frequency.setTargetAtTime(1400+tension*800,now,1.2);
    bed.pulse.frequency.setTargetAtTime(.75+tension*1.1,now,1.2);
  }
  function boom(){
    const now=ctx.currentTime,gain=ctx.createGain(),filter=ctx.createBiquadFilter();
    filter.type='lowpass';filter.frequency.setValueAtTime(1100,now);filter.frequency.exponentialRampToValueAtTime(90,now+1.05);
    gain.gain.setValueAtTime(.0001,now);gain.gain.exponentialRampToValueAtTime(.65,now+.025);gain.gain.exponentialRampToValueAtTime(.0001,now+1.1);
    const burst=ctx.createBufferSource();burst.buffer=noise;burst.connect(filter);
    const bass=ctx.createOscillator();bass.type='sine';bass.frequency.setValueAtTime(game==='azmera-jet'?95:80,now);bass.frequency.exponentialRampToValueAtTime(30,now+.8);bass.connect(filter);
    filter.connect(gain);gain.connect(master);group([burst,bass],[burst,bass,filter,gain],gain);
    burst.start(now);bass.start(now);burst.stop(now+1.15);bass.stop(now+1.15);
  }
  function sync(snapshot,previous,fresh){
    latest=snapshot;
    safe(()=>{
      if(!active||muted||document.hidden||!ctx||ctx.state!=='running'){silence();return;}
      if(['waiting','flying'].includes(snapshot.round.phase)){ambience(snapshot);return;}
      stop(bed);
      if(fresh&&snapshot.round.phase==='crashed'&&previous?.round.id===snapshot.round.id&&['waiting','flying'].includes(previous.round.phase))boom();
      if(snapshot.round.phase==='void')silence();
    });
  }
  button.onclick=()=>{
    muted=!muted;try{localStorage.setItem('azmera-game-muted',String(muted));}catch{}label();
    if(muted)silence();else if(active)safe(ready);
  };
  document.addEventListener('visibilitychange',()=>{if(document.hidden){silence();latest=null;}});
  window.addEventListener('pagehide',silence);
  label();
  return {
    open(id){active=true;game=id;latest=null;if(!muted&&!unavailable&&!document.hidden)safe(ready);},
    sync,
    silence(){latest=null;silence();},
    close(){active=false;latest=null;silence();for(const g of [...groups])cleanup(g);if(ctx?.state==='running')ctx.suspend().catch(()=>{});}
  };
}

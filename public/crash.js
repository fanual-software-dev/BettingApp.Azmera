function resultColor(hundredths) {
  return hundredths<200?'result-red':hundredths<500?'result-yellow':hundredths<1000?'result-green':'result-magenta';
}
function setupCrash({ $, api, node, format, signedIn, login, artwork }) {
  let game, state, timer, stream, frame, revision=0, received=0, busy=false, selectedProof=null;
  let phaseChangedAt=0, pose={x:0,y:0,tilt:0}, departure={x:0,y:0,tilt:0};
  const reducedMotion=window.matchMedia('(prefers-reduced-motion: reduce)');
  const controls=[];
  const sound=setupCrashAudio($('crash-sound'));
  $('crash-stage').append($('crash-aircraft'));
  function showError(message,kind){$('crash-error').textContent=message;$('crash-error').dataset.kind=kind;}
  function acceptSnapshot(value){
    sound.sync(value,state,performance.now()-received<=3500);
    if(state?.round.id!==value.round.id||state?.round.phase!==value.round.phase){phaseChangedAt=performance.now();departure={...pose};}
    if(state?.round.id!==value.round.id)for(const c of controls)c.key=null;
    state=value;received=performance.now();
    if($('crash-error').dataset.kind==='connection')showError('','');
    render();
  }
  for(let slot=1;slot<=2;slot++) {
    const box=node('div','','crash-slot');
    const label=node('label',`Bet slot ${slot} · ETB`),amount=document.createElement('input');
    amount.type='number';amount.min='4';amount.max='4000';amount.step='0.01';amount.value='4';label.append(amount);
    const autoLabel=node('label','Auto cash-out (optional)'),auto=document.createElement('input');
    auto.type='number';auto.min='1.01';auto.step='0.01';auto.placeholder='e.g. 2.00';autoLabel.append(auto);
    const presets=node('div','','crash-presets');for(const n of [4,10,40,100]){const p=node('button',String(n),'secondary');p.type='button';p.onclick=()=>{amount.value=n;};presets.append(p);}
    const button=node('button','Bet'),result=node('small','');
    box.append(label,presets,autoLabel,button,result);$('crash-slots').append(box);
    const c={slot,amount,auto,button,result,presets,busy:false,key:null};controls.push(c);
    amount.oninput=auto.oninput=()=>{c.key=null;};
    button.onclick=async()=>{
      if(!signedIn()){login();return;}
      if(!state||c.busy)return;c.busy=true;button.disabled=true;$('crash-error').textContent='';
      const current=revision;
      try {
        const bet=state.bets.find(b=>b.slot===slot&&b.status!=='cancelled');
        if(bet?.status==='open') await api(`/api/crash/${game}/${state.round.phase==='waiting'?'cancel':'cashout'}`,{betId:bet.id});
        else {
          const stake=Math.round(Number(amount.value)*100),autoAt=auto.value?Math.round(Number(auto.value)*100):0;
          if(!Number.isSafeInteger(stake)||stake<400||stake>400000)throw new Error('Enter a stake from 4 to 4,000 ETB.');
          c.key ||= crypto.randomUUID();await api(`/api/crash/${game}/bet`,{roundId:state.round.id,slot,amount:stake,autoAt,acceptCash:$('crash-cash-consent').checked},c.key);c.key=null;
        }
        if(current===revision)await update();
      } catch(e){if(current===revision)showError(e instanceof TypeError?'Could not confirm that action. Reconnecting to check your bet status…':e.message,'action');}
      finally{c.busy=false;if(current===revision)render();}
    };
  }
  function render(){
    if(!state)return;
    const cash=state.mode==='cash';
    $('crash-cash-consent-label').hidden=!cash;
    $('crash-wallet').textContent=state.wallet?`${format(state.wallet.available)} ${cash?'ETB':'practice credits'}`:'Watching as guest';
    $('crash-credits').hidden=cash||!signedIn();
    $('crash-mode-label').parentElement.hidden=cash&&!state.paused;
    $('crash-mode-label').textContent=cash?(state.paused?'BETTING PAUSED':''):'Practice mode';
    $('crash-mode-rules').textContent=cash?'Cash bets use your verified deposit balance. If server processing stops for more than 3 seconds, unsettled bets are refunded; settled bets stand. Manual cash-outs take effect when processed by the server. No auto-repeat betting.':'Practice credits are separate from your cash wallet and cannot be withdrawn. No auto-repeat betting.';
    $('crash-stage').dataset.phase=state.round.phase;
    $('crash-phase').textContent=state.round.phase==='void'?'Round interrupted · unsettled stakes refunded':state.round.phase==='crashed'?'FLEW AWAY':state.round.phase==='waiting'?'Next round':'';
    $('crash-history').replaceChildren(...state.history.map(r=>{const b=node('button',r.status==='void'?'Interrupted':(r.crash/100).toFixed(2)+'×',`secondary ${r.status==='void'?'result-void':resultColor(r.crash)}`);b.onclick=()=>{selectedProof=`Round: ${r.id}\nStatus: ${r.status}\nCommitment: ${r.commitment}\nRevealed seed: ${r.seed}\nGenerated outcome: ${(r.crash/100).toFixed(2)}x`;$('crash-proof').textContent=selectedProof;$('crash-proof').parentElement.open=true;};return b;}));
    $('crash-proof').textContent=selectedProof||`Round: ${state.round.id}\nSHA-256 commitment: ${state.round.commitment}\nSeed: ${state.round.seed||'Revealed after the round'}`;
    for(const c of controls){
      const bet=state.bets.find(b=>b.slot===c.slot&&b.status!=='cancelled');
      const available=state.round.phase==='waiting'&&!bet&&!state.paused;
      c.amount.disabled=c.auto.disabled=!available||c.busy;
      for(const button of c.presets.children)button.disabled=!available||c.busy;
      c.button.disabled=c.busy||(!available&&!(bet?.status==='open'&&['waiting','flying'].includes(state.round.phase)));
      c.button.textContent=bet?.status==='open'?(state.round.phase==='waiting'?'Cancel bet':'Cash out'):available?'Bet':'Next round';
      c.button.className=bet?.status==='open'&&state.round.phase==='flying'?'cashout':'';
      if(!signedIn()){c.button.disabled=false;c.button.textContent='Log in to bet';}
      c.result.textContent=bet?(bet.status==='paid'?`Paid ${format(bet.payout)} ETB`:bet.status==='lost'?'Round lost':`Stake ${format(bet.stake)} ETB`):'';
    }
    $('crash-players').replaceChildren(...state.participants.map((p,i)=>{const r=node('div','','crash-player');r.append(node('span',`Player ${i+1}`),node('span',format(p.stake)+' ETB'),node('strong',p.status==='paid'?format(p.payout)+' ETB':p.status));return r;}));
    if(!state.participants.length)$('crash-players').append(node('p','No bets yet.'));
  }
  async function update(){
    if(busy||!game)return;busy=true;const current=revision;
    try{const value=await api(signedIn()?`/api/crash/${game}/state`:`/api/watch/${game}`,undefined,undefined,{signal:AbortSignal.timeout(10000)});if(current!==revision)return;acceptSnapshot(value);}
    catch(e){if(current===revision){showError(e.status?e.message:'Connection interrupted. Reconnecting…','connection');for(const c of controls)c.button.disabled=true;}}
    finally{if(current===revision)busy=false;}
  }
  function animate(){
    if(!game)return;
    if(state){const age=performance.now()-received,now=state.now+age,phase=state.round.phase;
      const multi=phase==='flying'?Math.min(100000,Math.exp(.12*Math.max(0,now-state.round.starts)/1000)):state.round.multiplier/100;
      $('crash-multiplier').textContent=age>3500?'Reconnecting…':phase==='waiting'?`${Math.max(0,Math.ceil((state.round.starts-now)/1000))}s`:multi.toFixed(2)+'×';
      if(age<=3500){
        const aircraft=$('crash-aircraft'),elapsed=Math.max(0,(now-state.round.starts)/1000),jet=game==='azmera-jet';
        const stage=$('crash-stage'),width=stage.clientWidth,height=stage.clientHeight;
        const start={x:10,y:height-aircraft.offsetHeight-12,tilt:0};
        const end={x:width-aircraft.offsetWidth-16,y:16,tilt:0};
        let opacity=1;
        if(reducedMotion.matches){pose=phase==='waiting'?start:end;opacity=['crashed','void'].includes(phase)?0:1;}
        else if(phase==='flying'){
          const t=Math.min(1,elapsed/6),takeoff=t*t*(3-2*t),cruise=Math.max(0,elapsed-6);
          const cycle=cruise*Math.PI*2/6,sweep=(1-Math.cos(cycle))/2;
          const dip=Math.min(height*.32,height-aircraft.offsetHeight-32);
          pose={x:start.x+(end.x-start.x)*takeoff-12*sweep,y:start.y+(end.y-start.y)*takeoff*takeoff+dip*sweep,tilt:-8*Math.sin(t*Math.PI)+7*Math.sin(cycle)};
        }else if(phase==='crashed'){
          const exit=Math.min(1,(performance.now()-phaseChangedAt)/850);
          pose={x:departure.x+exit*exit*$('crash-stage').clientWidth,y:departure.y-100*exit,tilt:departure.tilt-12*exit};
          opacity=1-Math.max(0,(exit-.6)/.4);
        }else if(phase==='void'){opacity=0;}
        else{pose=start;}
        aircraft.style.transform=`translate3d(${pose.x}px,${pose.y}px,0) rotate(${pose.tilt}deg)`;
        aircraft.style.opacity=String(opacity);
        $('crash-trail').style.opacity=['flying','crashed'].includes(phase)?'1':'0';
        if(phase==='flying'){
          const x=(pose.x+aircraft.offsetWidth*.2)/width*600,y=(pose.y+aircraft.offsetHeight*.75)/height*300;
          $('crash-trail').setAttribute('d',`M12 288 Q${x*.6} 288 ${x} ${y}`);
        }
      }
      if(age>3500){sound.silence();for(const c of controls)c.button.disabled=true;if(!timer)timer=setInterval(update,2000);}
    }frame=requestAnimationFrame(animate);
  }
  async function open(id){reset();game=id;sound.open(id);const current=revision;$('crash-title').textContent=id==='azmera-flight'?'Azmera Flight':'Azmera Jet';$('crash-aircraft').src=artwork(id);$('crash-aircraft').alt=$('crash-title').textContent+' aircraft';$('crash-aircraft').style.transform='translate(0,0)';$('crash-dialog').dataset.game=id;$('crash-dialog').showModal();await update();if(current!==revision)return;
    if(window.EventSource&&signedIn()){
      stream=new EventSource(`/api/crash/${game}/events`);
      stream.addEventListener('state',event=>{if(current!==revision)return;try{const value=JSON.parse(event.data);clearInterval(timer);timer=null;acceptSnapshot(value);}catch{if(!timer)timer=setInterval(update,2000);}});
      stream.onerror=()=>{if(current===revision&&!timer)timer=setInterval(update,2000);};
    }else timer=setInterval(update,1500);
    animate();
  }
  function reset(){sound.close();revision++;busy=false;stream?.close();stream=null;clearInterval(timer);timer=null;cancelAnimationFrame(frame);game=null;state=null;selectedProof=null;$('crash-cash-consent').checked=false;$('crash-dialog').close();$('crash-error').textContent='';$('crash-multiplier').textContent='Connecting…';for(const c of controls){c.button.disabled=true;c.key=null;} }
  $('crash-dialog').addEventListener('close',()=>{if(game)reset();});
  $('crash-credits').onclick=async()=>{try{await api(`/api/crash/${game}/credits`,{});await update();}catch(e){$('crash-error').textContent=e.message;}};
  return {reset,open};
}

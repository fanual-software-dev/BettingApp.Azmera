function setupDashboard({ $, api, node, format }) {
  let state, period = 'daily', page = 1, sequence = 0, timer;
  let bankroll, fundingKey=null;
  function tab(rules){
    $('dashboard-overview').hidden=rules;$('dashboard-rules').hidden=!rules;
    $('dashboard-overview-tab').setAttribute('aria-pressed',String(!rules));$('dashboard-rules-tab').setAttribute('aria-pressed',String(rules));
  }
  $('dashboard-overview-tab').onclick=()=>tab(false);
  $('dashboard-rules-tab').onclick=async()=>{
    tab(true);const current=sequence;$('rules-content').textContent='Loading rules…';
    try{
      const result=await api('/api/admin/game-rules');if(current!==sequence)return;
      $('rules-mode').textContent=`Current game mode: ${result.mode.toUpperCase()}`;
      const content=$('rules-content');content.replaceChildren();let code=false;
      for(const line of result.text.split('\n')){
        if(line.startsWith('```')){code=!code;continue;}if(!line.trim())continue;
        const heading=/^#+\s+/.test(line);
        content.append(node(heading?'h3':code?'pre':'p',line.replace(/^#+\s+/,'').replace(/\*\*/g,'').replace(/`/g,'')));
      }
    }catch(error){if(current===sequence)$('rules-content').textContent=error.message;}
  };
  $('bankroll-deposit').onclick=()=>{ $('dashboard-dialog').close(); $('cash-deposit').click(); };
  async function loadBankroll() {
    const current=sequence;
    const value=await api('/api/admin/crash');
    if(current!==sequence)return;
    bankroll=value;
    $('bankroll-status').textContent=`${value.mode.toUpperCase()} · ${value.paused?'Cash bets paused':'Cash bets enabled'} · Available ${format(value.available)} ETB · Reserved ${format(value.reserved)} ETB · Your verified wallet ${format(value.wallet.available)} ETB`;
    $('bankroll-pause').textContent=value.paused?'Resume cash bets':'Pause cash bets';
  }
  $('bankroll-form').oninput=()=>{fundingKey=null;};
  $('bankroll-form').onsubmit=async event=>{
    event.preventDefault();$('bankroll-error').textContent='';$('bankroll-fund').disabled=true;
    try{fundingKey ||= crypto.randomUUID();await api('/api/admin/crash',{action:'fund',amount:Math.round(Number($('bankroll-amount').value)*100),confirm:$('bankroll-confirm').checked},fundingKey);fundingKey=null;$('bankroll-form').reset();await loadBankroll();}
    catch(e){$('bankroll-error').textContent=e.message;}finally{$('bankroll-fund').disabled=false;}
  };
  $('bankroll-pause').onclick=async()=>{
    if(!bankroll)return;$('bankroll-pause').disabled=true;$('bankroll-error').textContent='';
    try{await api('/api/admin/crash',{action:'pause',paused:!bankroll.paused});await loadBankroll();}catch(e){$('bankroll-error').textContent=e.message;}finally{$('bankroll-pause').disabled=false;}
  };
  const date = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Addis_Ababa', year:'numeric',month:'short',day:'numeric' }).format(new Date(value));
  function render() {
    if (!state) return;
    const data = state.periods[period];
    $('dashboard-totals').textContent = `${state.totals.users} users · ${state.totals.registered} registered accounts`;
    $('dashboard-range').textContent = `${date(data.start)} – ${date(new Date(data.end).getTime()-1)} · Ethiopian time`;
    for (const button of document.querySelectorAll('[data-dashboard-period]')) button.setAttribute('aria-pressed', String(button.dataset.dashboardPeriod === period));
    const cards = $('dashboard-cards'); cards.replaceChildren();
    const joinedCards = $('dashboard-joined-cards'); joinedCards.replaceChildren();
    for (const [key,label] of [['daily','Daily'],['weekly','Weekly'],['monthly','Monthly'],['yearly','Yearly']]) {
      const joined = node('section', '', 'dashboard-card dashboard-joined');
      joined.append(node('small',label),node('strong',state.periods[key].joined)); joinedCards.append(joined);
    }
    for (const [key,label] of [['deposits','Deposit requests'],['withdrawals','Withdrawal requests']]) {
      const group = node('section', '', 'dashboard-payment-group');
      group.append(node('h3', `${label} · ${data[key].total}`));
      const grid = node('div', '', 'dashboard-status-grid');
      for (const [status, caption] of [['completed','Completed'],['pending','Pending'],['canceled','Canceled']]) {
        const card = node('div', '', `dashboard-card status-${status}`);
        card.append(node('small', caption),node('strong', data[key][status])); grid.append(card);
      }
      group.append(grid); cards.append(group);
    }
    const list = $('dashboard-users'); list.replaceChildren();
    for (const user of state.users) {
      const card = node('article', '', 'dashboard-user');
      const identity = node('div'); identity.append(node('strong',user.name),node('small',user.phone || 'Phone not shared'),node('small',`${user.id.replace('tg:','')} · ${user.registered ? 'Registered' : 'Bot visitor'}`));
      const wager = node('div','','dashboard-wager'); wager.append(node('small','Cash wager'),node('strong',`${format(user.cash_wager||0)} ETB`),node('small',`Test: ${format(user.total_wager)} ETB`));
      card.append(identity,wager); list.append(card);
    }
    if (!state.users.length) list.append(node('p','No users found.'));
    $('dashboard-page').textContent = `Page ${page} of ${Math.max(1,Math.ceil(state.matched/state.pageSize))} · ${state.matched} users`;
    $('dashboard-prev').disabled = page === 1;
    $('dashboard-next').disabled = page*state.pageSize >= state.matched;
  }
  async function load() {
    const current = ++sequence;
    $('dashboard-error').textContent = ''; $('dashboard-refresh').disabled = true;
    try {
      const result = await api(`/api/admin/dashboard?page=${page}&q=${encodeURIComponent($('dashboard-search').value)}`);
      if (current !== sequence) return;
      state = result; render(); await loadBankroll();
    } catch (error) { if (current === sequence) $('dashboard-error').textContent = error.message; }
    finally { if (current === sequence) $('dashboard-refresh').disabled = false; }
  }
  $('dashboard-open').onclick = () => { $('dashboard-dialog').showModal(); load(); };
  $('dashboard-refresh').onclick = load;
  for (const button of document.querySelectorAll('[data-dashboard-period]')) button.onclick = () => { period = button.dataset.dashboardPeriod; render(); };
  $('dashboard-search').oninput = () => { clearTimeout(timer); sequence++; page = 1; timer = setTimeout(load, 250); };
  $('dashboard-prev').onclick = () => { if (page>1) { page--; load(); } };
  $('dashboard-next').onclick = () => { if (state && page*state.pageSize<state.matched) { page++; load(); } };
  return { reset() { tab(false); $('rules-content').replaceChildren(); $('rules-mode').textContent=''; sequence++; clearTimeout(timer); state = null; bankroll=null; fundingKey=null; $('bankroll-form').reset(); $('bankroll-status').textContent=''; $('bankroll-error').textContent=''; page = 1; period = 'daily'; $('dashboard-dialog').close(); $('dashboard-open').hidden = true; $('dashboard-search').value = ''; for (const id of ['dashboard-cards','dashboard-users','dashboard-totals','dashboard-joined-cards','dashboard-range','dashboard-page','dashboard-error']) $(id).replaceChildren(); } };
}

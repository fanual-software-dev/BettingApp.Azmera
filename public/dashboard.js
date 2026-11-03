function setupDashboard({ $, api, node, format }) {
  let state, period = 'daily', page = 1, sequence = 0, timer;
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
      const wager = node('div','','dashboard-wager'); wager.append(node('small','Total wager (test)'),node('strong',`${format(user.total_wager)} ETB`));
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
      state = result; render();
    } catch (error) { if (current === sequence) $('dashboard-error').textContent = error.message; }
    finally { if (current === sequence) $('dashboard-refresh').disabled = false; }
  }
  $('dashboard-open').onclick = () => { $('dashboard-dialog').showModal(); load(); };
  $('dashboard-refresh').onclick = load;
  for (const button of document.querySelectorAll('[data-dashboard-period]')) button.onclick = () => { period = button.dataset.dashboardPeriod; render(); };
  $('dashboard-search').oninput = () => { clearTimeout(timer); sequence++; page = 1; timer = setTimeout(load, 250); };
  $('dashboard-prev').onclick = () => { if (page>1) { page--; load(); } };
  $('dashboard-next').onclick = () => { if (state && page*state.pageSize<state.matched) { page++; load(); } };
  return { reset() { sequence++; clearTimeout(timer); state = null; page = 1; period = 'daily'; $('dashboard-dialog').close(); $('dashboard-open').hidden = true; $('dashboard-search').value = ''; for (const id of ['dashboard-cards','dashboard-users','dashboard-totals','dashboard-joined-cards','dashboard-range','dashboard-page','dashboard-error']) $(id).replaceChildren(); } };
}

/* No credentials or provider secrets belong in this file. */
const $ = id => document.getElementById(id);
let messageTimer;
function showMessage(text, duration = 0) {
  clearTimeout(messageTimer);
  $('message').textContent = text;
  if (text && duration) messageTimer = setTimeout(() => { $('message').textContent = ''; }, duration);
}
// The server remembers explicit login using a persistent HttpOnly cookie.
let token = null;
const broadcastUI = setupBroadcasts({ $, api, node });
const dashboardUI = setupDashboard({ $, api, node, format: value => format(value) });
const crashUI = setupCrash({ $, api, node, format: value => format(value), signedIn: () => Boolean(token), login: () => openAuth('login'), artwork: id => { const game=config.games.find(game=>game.id===id); return game.playArtwork||game.artwork; } });
let userPhone = null;
try { sessionStorage.removeItem('azmera-token'); } catch { /* Remove legacy tab-only credentials. */ }
let authMode = 'login';
let filter = 'all';
let selectedGame;
let selectedProviderGame;
const supplierGames = new Set(['aviator', 'chicken-road']);
let config;
const format = value => (value / 100).toLocaleString('en-ET', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function amount(id) {
  const raw = $(id).value.trim();
  if (!/^\d+(\.\d{1,2})?$/.test(raw)) throw new Error('Enter a positive amount with at most two decimal places.');
  const [whole, fraction = ''] = raw.split('.');
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Enter a valid positive amount.');
  return value;
}
async function api(route, data, key = crypto.randomUUID(), options = {}) {
  const response = await fetch(route, {
    method: data === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    signal: options.signal,
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': key }) },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      clearSession();
      $('auth-description').textContent = 'Please close this Mini App and reopen it using Open Azmera in your bot to sign in again.';
    }
    throw Object.assign(new Error(result.error || 'Request failed'),{status:response.status});
  }
  return result;
}
function node(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
async function action(button, fn) {
  button.disabled = true; showMessage('');
  try { await fn(); } catch (error) { showMessage(error.message); }
  finally { button.disabled = false; }
}
function button(text, fn, secondary = false) {
  const el = node('button', text, secondary ? 'secondary' : '');
  el.addEventListener('click', () => action(el, fn)); return el;
}
async function refresh() {
  const requestedToken = token;
  const state = await api('/api/me');
  if (!token || token !== requestedToken) return;
  $('account').hidden = false;
  for (const id of ['header-login', 'header-register', 'sidebar-login']) $(id).hidden = true;
  for (const id of ['wallet-open', 'header-deposit', 'profile-open', 'header-balance', 'logout']) $(id).hidden = false;
  $('header-balance').textContent = `${format(state.wallet.available)} ETB`;
  $('profile-open').textContent = state.user.name.slice(0, 1).toUpperCase();
  $('signed-in-name').textContent = state.user.name;
  $('broadcast-open').hidden = state.paymentRole !== 'owner';
  $('dashboard-open').hidden = state.paymentRole !== 'owner';
  const staff = ['owner', 'agent'].includes(state.paymentRole);
  document.querySelector('.user-actions').classList.toggle('staff-actions', staff);
  for (const id of ['wallet-open','header-deposit','header-balance','customer-wallet','customer-tracking']) $(id).hidden = staff;
  userPhone = state.user.phone;
  $('account-phone').textContent = userPhone || 'Phone number not shared';
  $('share-phone').hidden = !state.user.id.startsWith('tg:') || Boolean(userPhone);
  $('balance').textContent = format(state.wallet.available);
  $('reserved').textContent = `Reserved: ${format(state.wallet.reserved)} ETB`;
  for (const id of ['sandbox-wallet','sandbox-pending','sandbox-history']) $(id).hidden = staff || !config.localLogin;
  await paymentUI.refresh();
  $('pending').replaceChildren();
  for (const round of state.rounds) {
    const row = node('div', '', 'transaction');
    const text = node('div', `${round.game_id} · ${format(round.stake)} ETB`);
    text.append(node('small', 'Test round awaiting a simulated result'));
    const controls = node('div', '', 'row');
    for (const outcome of ['win', 'loss', 'refund']) controls.append(button(`Simulate ${outcome}`, async () => { await api('/api/sandbox/settlements', { roundId: round.id, outcome }); await refresh(); }, true));
    row.append(text, controls); $('pending').append(row);
  }
  for (const withdrawal of state.withdrawals) {
    const row = node('div', '', 'transaction');
    const text = node('div', `Withdrawal · ${format(withdrawal.amount)} ETB`);
    text.append(node('small', 'Test funds reserved; no payment sent'));
    const controls = node('div', '', 'row');
    for (const outcome of ['paid', 'failed']) controls.append(button(`Simulate ${outcome}`, async () => { await api('/api/sandbox/withdrawal-results', { withdrawalId: withdrawal.id, outcome }); await refresh(); }, true));
    row.append(text, controls); $('pending').append(row);
  }
  if (!$('pending').children.length) $('pending').append(node('p', 'No pending transactions.'));
  $('history').replaceChildren();
  for (const entry of state.history) {
    const row = node('div', '', 'transaction');
    const info = node('div', entry.result.type.replaceAll('_', ' '));
    info.append(node('small', `${new Date(entry.created).toLocaleString()} · ${entry.kind}`));
    row.append(info, node('strong', `${entry.amount > 0 ? '+' : ''}${format(entry.amount)} ETB`, entry.amount > 0 ? 'positive' : ''));
    $('history').append(row);
  }
  if (!state.history.length) $('history').append(node('p', 'Your test wallet activity will appear here.'));
  const activities = await Promise.all([...supplierGames].map(async id => ({ id, ...await api(`/api/${id}/activity`) })));
  for (const activity of activities) {
    $(`${activity.id}-activity-panel`).hidden = !activity.bets.length;
    const container = $(`${activity.id}-activity`);
    container.replaceChildren();
    for (const bet of activity.bets) {
      const row = node('div', '', 'transaction');
      const info = node('div', `Stake ${format(bet.stake)} ETB · ${bet.status}`);
      info.append(node('small', `Round ${bet.round_id}`));
      row.append(info, node('strong', `Return ${format(bet.payout)} ETB`));
      container.append(row);
    }
  }
}
async function login(route, data = {}) {
  await api(route, data); token = 'cookie-session';
  await refresh(); $('auth-dialog').close();
  if (route !== '/api/auth/local' && !userPhone) $('phone-dialog').showModal();
}
function sharePhone(button) {
  const tg = window.Telegram?.WebApp;
  if (!tg?.initData || !tg.isVersionAtLeast?.('6.9')) {
    showMessage('Open this app in an updated Telegram app to share your phone number.');
    return;
  }
  button.disabled = true;
  try {
    tg.requestContact(async shared => {
      try {
        if (!shared) { showMessage('Phone number was not shared.', 2000); return; }
        $('phone-dialog').close();
        const session = token;
        for (let attempt = 0; attempt < 10; attempt++) {
          if (!session || token !== session) return;
          await refresh();
          if (userPhone) { showMessage('Telegram phone number saved.', 2000); return; }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        showMessage('Your number has not arrived yet. Refresh your profile shortly.');
      } catch (error) { showMessage(error.message); }
      finally { button.disabled = false; }
    });
  } catch (error) { button.disabled = false; showMessage(error.message); }
}
$('share-phone').onclick = () => sharePhone($('share-phone'));
$('confirm-share-phone').onclick = () => sharePhone($('confirm-share-phone'));
$('login').onclick = () => action($('login'), () => login('/api/auth/local'));
$('deposit').onclick = () => action($('deposit'), async () => { await api('/api/sandbox/deposits', { amount: amount('amount') }); await refresh(); showMessage('Test credits added. No real money was collected.', 2000); });
$('withdraw').onclick = () => action($('withdraw'), async () => { await api('/api/sandbox/withdrawals', { amount: amount('amount') }); await refresh(); });
$('bet').onclick = () => action($('bet'), async () => { if(!token){openAuth('login');return;} await api('/api/sandbox/bets', { gameId: selectedGame, amount: amount('stake') }); await refresh(); });
$('refresh').onclick = () => action($('refresh'), refresh);
$('launch-provider').onclick = () => action($('launch-provider'), async () => {
  const game = selectedProviderGame;
  if (!game) return;
  if(!token){openAuth('login');return;}
  const launched = await api('/api/games/launch', { gameId: game.id });
  if (!launched.launchUrl) throw new Error(`${game.name} is currently unavailable.`);
  $('game-title').textContent = `${game.name} · provider sandbox`;
  $('game-frame').title = `${game.name} supplier game`;
  $('game-player').hidden = false;
  $('game-loading').hidden = false;
  $('game-frame').src = launched.launchUrl;
  $('game-player').scrollIntoView({ behavior: 'smooth' });
});
$('game-frame').onload = () => { if ($('game-frame').hasAttribute('src')) $('game-loading').hidden = true; };
$('close-game').onclick = () => action($('close-game'), async () => {
  $('game-frame').removeAttribute('src'); $('game-player').hidden = true; await refresh();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) refresh().catch(error => { showMessage(error.message); });
});
async function boot() {
  config = await api('/api/config');
  if (config.manualPayments) {
    $('app-footer').textContent = 'Azmera Bet - Manual payment review. Game integrations are still in development.';
  }

  $('login').hidden = !config.localLogin;
  const tg = window.Telegram?.WebApp;
  const insideTelegram = Boolean(tg?.initData || (tg?.platform && tg.platform !== 'unknown'));
  const showTelegramLink = Boolean(config.botUrl) && !insideTelegram;
  $('telegram-links').hidden = !showTelegramLink;
  $('telegram-open').hidden = !showTelegramLink;
  if (config.botUrl) $('telegram-open').href = config.botUrl;
  for (const game of config.games) {
    const card = button('', async () => {
      if(game.engine==='crash'){await crashUI.open(game.id);return;}
      if (game.status === 'coming-soon') {
        $('info-title').textContent = game.name;
        $('info-description').textContent = 'Coming soon. This game is in our catalog, but gameplay is not connected yet.';
        $('info-dialog').showModal();
        return;
      }
      $('account-dialog').showModal();
      $('simulator').hidden = true;
      $('provider-panel').hidden = !supplierGames.has(game.id);
      selectedProviderGame = supplierGames.has(game.id) ? game : null;
      if (supplierGames.has(game.id)) {
        $('provider-name').textContent = game.name;
        $('provider-status').textContent = 'Checking availability…';
        $('launch-provider').textContent = `Open ${game.name}`;
        $('launch-provider').disabled = true;
        const status = token ? await api(`/api/integrations/${game.id}`) : {launchReady:false};
        if (selectedProviderGame?.id !== game.id) return;
        $('provider-status').textContent = status.launchReady
          ? `${game.name} is available with test credits in the provider sandbox.`
          : `${game.name} is coming soon. Real-money play is not available yet.`;
        $('launch-provider').disabled = !status.launchReady;
        $('provider-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      selectedGame = game.id; $('selected-game').textContent = `${game.name} · sandbox`;
      $('simulator').hidden = false; $('simulator').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    card.className = `game art-${game.id} theme-${game.category.toLowerCase()}`;
    card.dataset.category = game.category;
    card.dataset.name = normalizeSearch(game.name);
    const info = node('span', '', 'game-info');
    info.append(node('strong', game.name), node('em', game.engine==='crash' ? 'PLAY NOW' : game.status === 'coming-soon' || supplierGames.has(game.id) ? 'COMING SOON' : 'PREVIEW'));
    const badges=node('span','','game-badges');
    for(const key of config.gameBadges?.games?.[game.id]||[]){
      const definition=config.gameBadges.definitions?.[key];if(!definition)continue;
      const badge=node('span',definition.label,'game-badge');badge.title=definition.title||definition.label;badge.setAttribute('aria-label',badge.title);
      if(/^#[0-9a-f]{6}$/i.test(definition.color||''))badge.style.color=definition.color;
      if(/^#[0-9a-f]{6}$/i.test(definition.background||''))badge.style.backgroundColor=definition.background;
      badges.append(badge);
    }
    card.dataset.gameId=game.id;
    if(game.id==='azmera-flight')card.id='open-flight';
    if(game.id==='azmera-jet')card.id='open-jet';
    const art = node('span', '', 'game-art');
    if (game.artwork) {
      const logo = document.createElement('img');
      logo.src = game.artwork;
      logo.alt = `${game.name} artwork`;
      logo.loading = 'lazy';
      logo.addEventListener('error', () => { art.replaceChildren(node('span', game.name, 'art-title')); }, { once: true });
      art.append(logo);
    } else {
      art.classList.add('placeholder-art');
      art.append(node('span', game.category === 'Slots' ? '\u2726' : '\u2197', 'art-emblem'), node('span', game.name, 'art-title'));
    }
    card.append(art, info, badges); $('games').append(card);
  }
  filterGames();
  loadRecentWins();
  tg?.ready(); tg?.expand();
  $('auth-telegram').hidden = !showTelegramLink;
  $('telegram-open').onclick = event => { event.preventDefault(); openTelegram(); };
  token = 'cookie-session';
  try { await refresh(); } catch (error) { if (token) throw error; }
}
function clearSession() {
  token = null;
  broadcastUI.reset();
  dashboardUI.reset();
  crashUI.reset();
  $('feedback-dialog').close();$('feedback-form').reset();$('feedback-result').textContent='';
  userPhone = null;
  $('account-phone').textContent = '';
  $('phone-dialog').close();
  paymentUI.reset();
  try { sessionStorage.removeItem('azmera-token'); } catch { /* Already cleared in memory. */ }
  $('account').hidden = true;
  $('account-dialog').close();
  $('game-frame').removeAttribute('src');
  $('game-player').hidden = true;
  $('provider-panel').hidden = true;
  $('simulator').hidden = true;
  for (const id of ['wallet-open', 'header-deposit', 'profile-open', 'header-balance', 'logout']) $(id).hidden = true;
  for (const id of ['header-login', 'header-register', 'sidebar-login']) $(id).hidden = false;
  for (const id of ['history', 'pending', 'aviator-activity', 'chicken-road-activity', 'signed-in-name', 'header-balance']) $(id).replaceChildren();
}
function openAuth(mode) {
  authMode = mode;
  const registration = mode === 'register';
  $('auth-title').textContent = registration ? 'Create your account' : 'Welcome back';
  $('auth-description').textContent = registration
    ? 'Create an Azmera account with your Telegram ID and name. You can browse without registering.'
    : 'Log in with your Telegram account. This device stays signed in for up to 30 days, unless you log out.';
  $('consent-label').hidden = !registration;
  $('registration-consent').checked = false;
  $('registration-consent').required = registration;
  $('auth-submit').textContent = registration ? 'Register with Telegram' : 'Log in with Telegram';
  $('auth-switch').textContent = registration ? 'Already registered? Log in' : 'New here? Register';
  $('auth-error').textContent = '';
  $('auth-dialog').showModal();
}
function openTelegram() {
  const tg = window.Telegram?.WebApp;
  if (tg?.initData) { tg.close(); return; }
  if (tg?.openTelegramLink && tg.platform !== 'unknown') tg.openTelegramLink(config.botUrl);
  else if (config.botUrl) window.location.assign(config.botUrl);
}
$('auth-form').onsubmit = async event => {
  event.preventDefault();
  const submit = $('auth-submit'); submit.disabled = true; $('auth-error').textContent = '';
  try {
    if (authMode === 'register' && !$('registration-consent').checked) throw new Error('Please confirm account creation first.');
    const initData = window.Telegram?.WebApp?.initData;
    if (!initData) throw new Error('Open this app using Open Azmera inside the Telegram bot, then choose Register or Log in.');
    await login(`/api/auth/${authMode}`, { initData, consent: true });
    showMessage(authMode === 'register' ? 'Account created. You are now logged in.' : 'You are now logged in.', 2000);
  } catch (error) { $('auth-error').textContent = error.message; }
  finally { submit.disabled = false; }
};
$('auth-switch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
$('header-register').onclick = () => openAuth('register');
for (const id of ['header-login', 'sidebar-login']) $(id).onclick = () => openAuth('login');
$('auth-telegram').onclick = openTelegram;
$('logout').onclick = () => action($('logout'), async () => {
  await api('/api/auth/logout', {});
  clearSession(); setSidebar(false);
  showMessage('You have logged out. You can keep browsing as a guest.', 2000);
});
function openAccount() { if (!token) openAuth('login'); else $('account-dialog').showModal(); }
for (const id of ['wallet-open', 'profile-open']) $(id).onclick = openAccount;
$('header-deposit').onclick = () => { if (!token) openAuth('login'); else $('cash-deposit').click(); };
for (const el of document.querySelectorAll('[data-close]')) el.onclick = () => $(el.dataset.close).close();
for (const el of document.querySelectorAll('[data-view]')) el.onclick = () => {
  setSidebar(false);
  if (el.dataset.view === 'account') openAccount();
  else $('game-section').scrollIntoView({ behavior: 'smooth' });
};
for (const el of document.querySelectorAll('[data-info]')) el.onclick = () => {
  $('info-title').textContent = el.dataset.info;
  $('info-description').textContent = el.dataset.info === 'Support'
    ? 'Support contact details will be published before launch.'
    : `${el.dataset.info} is not available in this preview. No rewards or bonuses are currently offered.`;
  $('info-dialog').showModal();
};
function setSidebar(open) {
  $('sidebar').classList.toggle('open', open);
  $('sidebar-backdrop').hidden = !open;
  $('menu-toggle').setAttribute('aria-expanded', String(open));
}
$('menu-toggle').onclick = () => setSidebar(!$('sidebar').classList.contains('open'));
$('sidebar-backdrop').onclick = () => setSidebar(false);
let feedbackKey=null, feedbackBusy=false;
$('feedback-open').onclick=()=>{setSidebar(false);$('feedback-dialog').showModal();};
$('feedback-form').oninput=()=>{if(!feedbackBusy)feedbackKey=null;};
$('feedback-form').onsubmit=async event=>{
  event.preventDefault();if(feedbackBusy)return;
  if(!token){openAuth('login');return;}
  feedbackBusy=true;$('feedback-submit').disabled=true;$('feedback-result').textContent='Sending…';
  try{
    feedbackKey ||= crypto.randomUUID();
    const result=await api('/api/feedback',{subject:$('feedback-subject').value,email:$('feedback-email').value,message:$('feedback-message').value},feedbackKey);
    if(result.status==='sent'){$('feedback-form').reset();feedbackKey=null;$('feedback-result').textContent='Thank you! Your feedback has been sent.';}
    else $('feedback-result').textContent='Your submission is being processed. Please keep this reference: '+result.id;
  }catch(error){$('feedback-result').textContent=error.message;if(error.status===503)feedbackKey=null;}
  finally{feedbackBusy=false;$('feedback-submit').disabled=false;}
};
document.addEventListener('keydown', event => { if (event.key === 'Escape') setSidebar(false); });
document.addEventListener('click', event => {
  if (!$('sidebar').contains(event.target) && !$('menu-toggle').contains(event.target)) setSidebar(false);
});
window.matchMedia('(max-width: 760px)').addEventListener('change', () => setSidebar(false));
function filterGames() {
  let count = 0;
  for (const card of $('games').children) {
    card.hidden = (filter !== 'all' && card.dataset.category !== filter) || !normalizeSearch($('game-search').value).split(' ').filter(Boolean).every(term => card.dataset.name.includes(term));
    if (!card.hidden) count++;
  }
  $('no-games').hidden = count !== 0;
  $('game-count').textContent = `${count} of ${config.games.length} games`;
  $('clear-search').hidden = !$('game-search').value;
}
function normalizeSearch(value) { return value.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim(); }
let winsLoading=false;
async function loadRecentWins(){
  if(winsLoading||document.hidden)return;winsLoading=true;
  try{
    const {wins}=await api('/api/recent-wins');const list=$('recent-wins');list.replaceChildren();
    for(const win of wins){
      const game=config.games.find(g=>g.id===win.gameId);if(!game)continue;
      const card=node('article','','big-win');const icon=document.createElement('img');icon.src=game.artwork;icon.alt='';
      const info=node('div');info.append(node('strong',game.name),node('small','Player · Cash payout'));
      const prize=node('div','','big-win-prize');prize.append(node('strong',`${format(win.payout)} ETB`),node('span',`${(win.multiplier/100).toFixed(2)}×`,resultColor(win.multiplier)));
      card.append(icon,info,prize);list.append(card);
    }
    if(!list.children.length)list.append(node('p','No cash wins of 1,000 ETB or more in the last 24 hours.'));
  }catch{if(!$('recent-wins').children.length)$('recent-wins').append(node('p','Recent wins are temporarily unavailable.'));}
  finally{winsLoading=false;}
}
setInterval(()=>{if(config)loadRecentWins();},15000);
$('clear-search').onclick = () => { $('game-search').value = ''; filterGames(); $('game-search').focus(); };
$('game-search').oninput = filterGames;
for (const el of document.querySelectorAll('[data-filter]')) el.onclick = () => {
  filter = el.dataset.filter;
  for (const other of document.querySelectorAll('[data-filter]')) other.classList.toggle('active', other === el);
  $('games-heading').textContent = filter === 'all' ? 'All games' : `${filter} games`;
  filterGames();
};
const paymentUI = setupPayments({ $, api, amount, format, node, refreshAccount:refresh, showMessage, getConfig:()=>config, isSignedIn:()=>Boolean(token) });
boot().catch(error => { showMessage(error.message); });

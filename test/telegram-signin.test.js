import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';

function initData(id, name) {
  const values = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: name }), query_id: `test-${id}` };
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('fixture-bot-token').digest();
  return new URLSearchParams({ ...values, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}

test('Telegram HTTP sign-in returns verified identity and isolates account wallets', async t => {
  const store = new Store(':memory:');
  const server = createApp(readConfig({ TELEGRAM_BOT_TOKEN: 'fixture-bot-token', TELEGRAM_BOT_USERNAME: 'AzmeraPlay_bot' }), store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = (value, route = 'register', consent = true) => fetch(base + '/api/auth/' + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: value, consent }) });
  await fetch(base + '/');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal((await login(initData(111, 'Alice'), 'register', false)).status, 400);
  assert.equal((await login(initData(111, 'Alice'), 'login')).status, 404);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  assert.equal((await login(initData(111, 'Alice'), 'telegram')).status, 410);
  const alice = await (await login(initData(111, 'Alice'))).json();
  assert.equal(alice.user.id, 'tg:111');
  store.deposit(alice.user.id, 1000, 'alice-funds');
  assert.equal((await login(initData(111, 'Alice'))).status, 409);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM registration_consents').get().n, 1);
  const loggedIn = await (await login(initData(111, 'Alice'), 'login')).json();
  assert.equal(loggedIn.user.id, alice.user.id);
  const loggedOut = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${loggedIn.token}` }, body: '{}' });
  assert.equal(loggedOut.status, 200);
  assert.equal((await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${loggedIn.token}` } })).status, 401);
  assert.equal((await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${alice.token}` } })).status, 200);

  const bob = await (await login(initData(222, 'Bob'))).json();
  const me = await (await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${bob.token}` } })).json();
  assert.equal(me.user.name, 'Bob'); assert.equal(me.wallet.available, 0);
  const tampered = initData(111, 'Alice').replace('Alice', 'Mallory');
  assert.equal((await login(tampered)).status, 401);
  assert.equal((await login('')).status, 401);
  store.user('local-developer', 'Developer'); store.session('local-developer', 'old-local-token');
  assert.equal((await fetch(base + '/api/me', { headers: { Authorization: 'Bearer old-local-token' } })).status, 401);
  const publicConfig = await (await fetch(base + '/api/config')).json();
  assert.equal(publicConfig.botUrl, 'https://t.me/AzmeraPlay_bot');
  assert.equal(publicConfig.localLogin, false);
  assert.ok(!JSON.stringify(publicConfig).includes('fixture-bot-token'));
});

test('persistent cookies survive reopening, enforce expiry and revoke on logout', async t => {
  const store = new Store(':memory:');
  const config = readConfig({ TELEGRAM_BOT_TOKEN: 'fixture-bot-token', PUBLIC_APP_URL: 'https://azmera.example' });
  const server = createApp(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: config.publicUrl }, body: JSON.stringify({ initData: initData(333, 'Cookie User'), consent: true }) });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Secure/); assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Max-Age=2592000/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 200);
  // Closing the client does not delete a server session. Simulate reusing its persistent cookie.
  store.db.prepare('UPDATE sessions SET expires=?').run(Date.now() + 86400000);
  const me = await (await fetch(base + '/api/me', { headers: { Cookie: cookie } })).json();
  assert.equal(me.user.id, 'tg:333');
  const forbidden = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: 'https://other.example' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const logout = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: config.publicUrl }, body: '{}' });
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: config.publicUrl }, body: '{}' })).status, 200);
  const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ initData: initData(333, 'Cookie User'), consent: true }) });
  const expiredCookie = login.headers.get('set-cookie').split(';')[0];
  store.db.prepare('UPDATE sessions SET expires=?').run(Date.now()-1);
  assert.equal((await fetch(base + '/api/me', { headers: { Cookie: expiredCookie } })).status, 401);
});

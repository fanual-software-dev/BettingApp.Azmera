import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { AviatorService, launchOrigins, validateLaunchUrl } from '../src/aviator.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

// This fake implements OUR internal interface; it is not a SPRIBE emulator.
function setup(t, override = {}) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.user('a', 'Alice'); store.user('b', 'Bob');
  store.deposit('a', 10000, 'fund-alice'); store.deposit('b', 10000, 'fund-bob-1');
  const config = readConfig({ SPRIBE_GAME_ID: 'supplier-game', SPRIBE_OPERATOR_ID: 'operator', SPRIBE_LAUNCH_ORIGINS: 'https://game.example' });
  let launched;
  const adapter = {
    ready: true,
    async launch(request) { launched = request; return { url: 'https://game.example/play?session=secret' }; },
    async verifyCallback(raw, headers) { if (headers.signature !== 'test-valid') throw new Error('bad signature'); return JSON.parse(raw); },
    formatResponse(result) { return result; },
    ...override,
  };
  const service = new AviatorService(store, config, adapter);
  return { store, config, service, adapter, event: (changes = {}) => ({
    type: 'debit', playerId: launched.playerId, gameId: 'supplier-game', currency: 'ETB',
    sessionToken: launched.sessionToken, transactionId: 'tx-1', betId: 'bet-1', roundId: 'round-1', amount: 1000, ...changes,
  }) };
}
test('launch stores opaque player mapping and hashed session; launch URLs are not persisted', async t => {
  const { service, store, event } = setup(t);
  const launch = await service.launch('a', 'launch-001');
  assert.equal(launch.launchUrl, 'https://game.example/play?session=secret');
  const session = store.db.prepare('SELECT * FROM aviator_sessions').get();
  assert.equal(session.state, 'active');
  assert.notEqual(session.token_hash, event().sessionToken);
  assert.notEqual(event().playerId, 'a');
  assert.equal(service.readiness().realMoneyReady, false);
  await assert.rejects(service.launch('a', 'launch-001'), /already requested/);
});
test('launch rejects foreign origins and strips supplier error secrets', async t => {
  const { service, store } = setup(t, { async launch() { return { url: 'https://attacker.example/game' }; } });
  await assert.rejects(service.launch('a', 'launch-001'), /not approved/);
  assert.equal(store.db.prepare('SELECT state FROM aviator_sessions').get().state, 'failed');
  service.adapter.launch = async () => { throw new Error('secret-key=do-not-leak'); };
  await assert.rejects(service.launch('a', 'launch-002'), error => !error.message.includes('do-not-leak') && error.status === 502);
});
test('exact HTTPS launch origin validation rejects credentials, schemes and subdomain tricks', () => {
  assert.deepEqual(launchOrigins('https://game.example, https://game.example/'), ['https://game.example']);
  for (const url of ['http://game.example', 'https://user:pass@game.example', 'https://game.example/path']) assert.throws(() => launchOrigins(url));
  for (const url of ['javascript:alert(1)', 'https://game.example.attacker.test/', 'https://u:p@game.example/']) assert.throws(() => validateLaunchUrl(url, ['https://game.example']));
});
test('forged callbacks cannot affect funds; authenticated debits are duplicate-safe', async t => {
  const { service, store, event } = setup(t); await service.launch('a', 'launch-001');
  const raw = Buffer.from(JSON.stringify(event()));
  await assert.rejects(service.callback(raw, {}), /authentication/);
  assert.equal(store.balance('a').available, 10000);
  const first = await service.callback(raw, { signature: 'test-valid' });
  assert.equal(first.balance, 9000);
  assert.deepEqual(await service.callback(raw, { signature: 'test-valid' }), first);
  assert.throws(() => service.applyEvent(event({ amount: 2000 })), /different request/);
});
test('settlements survive session expiry but new debits cannot; replay returns original result', async t => {
  const { service, store, event } = setup(t); await service.launch('a', 'launch-001');
  const first = service.applyEvent(event());
  store.db.prepare('UPDATE aviator_sessions SET expires=0').run();
  assert.deepEqual(service.applyEvent(event()), first);
  assert.throws(() => service.applyEvent(event({ transactionId: 'tx-2', betId: 'bet-2' })), /expired/);
  const credit = event({ type: 'credit', transactionId: 'credit-1', amount: 2500, sessionToken: undefined });
  const result = service.applyEvent(credit);
  assert.equal(store.balance('a').available, 11500);
  assert.deepEqual(service.applyEvent(credit), result);
  assert.throws(() => service.applyEvent({ ...credit, transactionId: 'credit-2' }), /completed/);
});
test('settlements bind player, bet, round, game and currency; multiple bets in a round work', async t => {
  const { service, store, event } = setup(t); await service.launch('a', 'launch-001');
  service.applyEvent(event());
  service.applyEvent(event({ transactionId: 'tx-2', betId: 'bet-2' }));
  const bob = service.player('b');
  const credit = event({ type: 'credit', transactionId: 'credit-1', amount: 0 });
  for (const changes of [{ playerId: bob }, { roundId: 'other' }, { gameId: 'other' }, { currency: 'USD' }]) assert.throws(() => service.applyEvent({ ...credit, ...changes }));
  service.applyEvent(credit);
  assert.equal(service.activity('a').find(bet => bet.bet_id === 'bet-1').status, 'settled');
  assert.equal(store.balance('a').available, 8000);
  assert.equal(store.balance('b').available, 10000);
});
test('refund requires exact original stake and cannot double-credit or follow a settlement', async t => {
  const { service, store, event } = setup(t); await service.launch('a', 'launch-001');
  service.applyEvent(event());
  const refund = event({ type: 'refund', transactionId: 'refund-1' });
  assert.throws(() => service.applyEvent({ ...refund, amount: 999 }), /match/);
  const result = service.applyEvent(refund);
  assert.deepEqual(service.applyEvent(refund), result);
  assert.equal(store.balance('a').available, 10000);
  assert.throws(() => service.applyEvent({ ...refund, transactionId: 'refund-2' }), /completed/);
  assert.equal(store.db.prepare('SELECT SUM(amount) AS total FROM entries').get().total, 0);
});
test('unmatched credit can be retried after its debit; failed overspend leaves no bet', async t => {
  const { service, store, event } = setup(t); await service.launch('a', 'launch-001');
  const credit = event({ type: 'credit', transactionId: 'credit-1', amount: 1500 });
  assert.throws(() => service.applyEvent(credit), /not found/);
  assert.throws(() => service.applyEvent(event({ amount: 11000 })), /Insufficient/);
  assert.equal(service.activity('a').length, 0);
  service.applyEvent(event()); service.applyEvent(credit);
  assert.equal(store.balance('a').available, 10500);
});
test('HTTP bridge stays closed without a real adapter even when all config is supplied', async t => {
  const store = new Store(':memory:');
  const config = readConfig({ ALLOW_LOCAL_LOGIN: 'true', SPRIBE_GAME_ID: 'id', SPRIBE_OPERATOR_ID: 'id', SPRIBE_LAUNCH_ORIGINS: 'https://game.example' });
  const server = createApp(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Idempotency-Key': 'http-test-1' }, body: JSON.stringify(body) });
  const { token } = await (await post('/api/auth/local', {})).json();
  const readiness = await (await fetch(base + '/api/integrations/aviator', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(readiness.launchReady, false);
  assert.equal((await post('/api/games/launch', { gameId: 'aviator' }, token)).status, 503);
  assert.equal((await post('/integrations/spribe/wallet', { type: 'credit', amount: 10000 })).status, 503);
  assert.equal((await post('/api/sandbox/bets', { gameId: 'aviator', amount: 1000 }, token)).status, 409);
});

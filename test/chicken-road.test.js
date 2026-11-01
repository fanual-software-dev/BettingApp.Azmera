import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { AviatorService } from '../src/aviator.js';
import { ChickenRoadService } from '../src/chicken-road.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

// Internal adapter fixture, NOT the INOUT API/signature specification.
function fake(origin) {
  return {
    ready: true, launches: [],
    async launch(request) { this.launches.push(request); return { url: `${origin}/game?session=test-only` }; },
    async verifyCallback(raw, headers) {
      if (headers['x-test-signature'] !== 'fixture') throw new Error('Invalid signature');
      return JSON.parse(raw.toString());
    },
    formatResponse(value) { return { fixtureResponse: value }; },
  };
}
function setup(t) {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.user('a', 'Alice'); store.user('b', 'Bob');
  store.deposit('a', 10000, 'fund-alice');
  const config = readConfig({
    ALLOW_LOCAL_LOGIN: 'true',
    SPRIBE_OPERATOR_ID: 'spribe-operator', SPRIBE_GAME_ID: 'same-game-id', SPRIBE_LAUNCH_ORIGINS: 'https://spribe.example',
    INOUT_OPERATOR_ID: 'inout-operator', INOUT_CHICKEN_ROAD_GAME_ID: 'same-game-id', INOUT_LAUNCH_ORIGINS: 'https://inout.example',
  });
  const inout = fake('https://inout.example'); const spribe = fake('https://spribe.example');
  const chicken = new ChickenRoadService(store, config, inout);
  const aviator = new AviatorService(store, config, spribe);
  return { store, config, inout, spribe, chicken, aviator };
}
function event(adapter, changes = {}) {
  const session = adapter.launches.at(-1);
  return {
    type: 'debit', playerId: session.playerId, sessionToken: session.sessionToken,
    gameId: session.gameId, currency: 'ETB', transactionId: 'shared-tx', betId: 'shared-bet', roundId: 'shared-round', amount: 1000,
    ...changes,
  };
}
test('Chicken Road and Aviator namespace identical transaction and bet IDs independently', async t => {
  const { store, chicken, aviator, inout, spribe } = setup(t);
  await chicken.launch('a', 'launch-001'); await aviator.launch('a', 'launch-001');
  assert.notEqual(inout.launches[0].playerId, spribe.launches[0].playerId);
  chicken.applyEvent(event(inout)); aviator.applyEvent(event(spribe));
  assert.equal(store.balance('a').available, 8000);
  chicken.applyEvent(event(inout, { type: 'credit', transactionId: 'settle-1', amount: 2500 }));
  assert.equal(aviator.activity('a')[0].status, 'open');
  assert.equal(chicken.activity('a')[0].status, 'settled');
  assert.equal(store.balance('a').available, 10500);
  assert.throws(() => chicken.applyEvent(event(spribe, { type: 'credit', transactionId: 'settle-other', amount: 2000 })), /player not found/);
});
test('INOUT cannot use a SPRIBE game-session token or launch origin', async t => {
  const { chicken, aviator, inout, spribe } = setup(t);
  await chicken.launch('a', 'launch-001'); await aviator.launch('a', 'launch-001');
  assert.throws(() => chicken.applyEvent(event(inout, { sessionToken: spribe.launches[0].sessionToken })), /session/);
  inout.launch = async () => ({ url: 'https://spribe.example/game' });
  await assert.rejects(chicken.launch('a', 'launch-002'), /not approved/);
});
test('Chicken Road rejects forged callbacks and settles real-shaped fixture payouts without multiplier calculation', async t => {
  const { store, chicken, inout } = setup(t);
  await chicken.launch('a', 'launch-001');
  const debit = Buffer.from(JSON.stringify(event(inout)));
  await assert.rejects(chicken.callback(debit, {}), /authentication/);
  await chicken.callback(debit, { 'x-test-signature': 'fixture' });
  store.db.exec('UPDATE chicken_road_sessions SET expires=0');
  const credit = Buffer.from(JSON.stringify(event(inout, { type: 'credit', transactionId: 'final-credit', amount: 1737, sessionToken: undefined })));
  const settled = await chicken.callback(credit, { 'x-test-signature': 'fixture' });
  assert.deepEqual(await chicken.callback(credit, { 'x-test-signature': 'fixture' }), settled);
  assert.equal(store.balance('a').available, 10737);
  assert.equal(chicken.activity('b').length, 0);
  assert.throws(() => chicken.applyEvent(event(inout, { type: 'refund', transactionId: 'late-refund' })), /completed/);
});
test('Chicken Road final loss and full refund preserve balanced postings', async t => {
  const { store, chicken, inout } = setup(t); await chicken.launch('a', 'launch-001');
  chicken.applyEvent(event(inout));
  chicken.applyEvent(event(inout, { type: 'credit', transactionId: 'loss', amount: 0 }));
  chicken.applyEvent(event(inout, { transactionId: 'debit-2', betId: 'bet-2' }));
  chicken.applyEvent(event(inout, { type: 'refund', transactionId: 'refund', betId: 'bet-2' }));
  assert.equal(store.balance('a').available, 9000);
  assert.equal(store.db.prepare('SELECT SUM(amount) AS total FROM entries').get().total, 0);
  assert.equal(chicken.activity('a').length, 2);
});
test('Chicken Road HTTP launch/activity routes and callback are isolated and unavailable by default', async t => {
  const { store, config } = setup(t);
  const server = createApp(config, store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data, token) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-key-001', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(data) });
  assert.equal((await fetch(base + '/api/chicken-road/activity')).status, 401);
  const { token } = await (await post('/api/auth/local', {})).json();
  const status = await (await fetch(base + '/api/integrations/chicken-road', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal(status.provider, 'INOUT'); assert.equal(status.launchReady, false); assert.equal(status.realMoneyReady, false);
  assert.equal((await post('/api/games/launch', { gameId: 'chicken-road' }, token)).status, 503);
  assert.equal((await post('/api/sandbox/bets', { gameId: 'chicken-road', amount: 1000 }, token)).status, 409);
  assert.equal((await post('/integrations/inout/wallet', {})).status, 503);
});
test('configured INOUT fixture HTTP callback goes through its verifier and response formatter', async t => {
  const { store, config, inout } = setup(t);
  const server = createApp(config, store, undefined, inout);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, data, headers = {}) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'http-key-001', ...headers }, body: JSON.stringify(data) });
  const { token, user } = await (await post('/api/auth/local', {})).json();
  store.deposit(user.id, 10000, 'fund-local');
  const launch = await (await post('/api/games/launch', { gameId: 'chicken-road' }, { Authorization: `Bearer ${token}` })).json();
  assert.equal(launch.gameId, 'chicken-road'); assert.match(launch.launchUrl, /^https:\/\/inout.example\//);
  assert.equal((await post('/integrations/inout/wallet', event(inout))).status, 401);
  const result = await (await post('/integrations/inout/wallet', event(inout), { 'x-test-signature': 'fixture' })).json();
  assert.equal(result.fixtureResponse.balance, 9000);
  assert.equal((await post('/integrations/spribe/wallet', event(inout), { 'x-test-signature': 'fixture' })).status, 503);
});

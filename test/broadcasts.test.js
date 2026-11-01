import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore } from './helpers/database.js';
import { Broadcasts } from '../src/broadcasts.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const config = () => readConfig({ TELEGRAM_BOT_TOKEN: 'fake-token', TELEGRAM_WEBHOOK_SECRET: 'fixture-secret', PAYMENT_ADMIN_TELEGRAM_IDS: '1' });
const message = (id, text = '/start') => ({ from: { id, first_name: 'Member' }, chat: { id, type: 'private' }, text });
const unlock = store => store.db.prepare("UPDATE broadcast_clock SET next_at=0 WHERE id='global'").run();

test('broadcast drafts snapshot recipients, require owner confirmation, and send once across workers', async t => {
  const store = await openTestStore(); t.after(() => store.close());
  await store.register('tg:1', 'Owner');
  const sent = [];
  const sender = async job => { sent.push(job.subscriber_id); return { ok: true }; };
  const service = new Broadcasts(store, config(), sender);
  const second = new Broadcasts(store, config(), sender);
  await service.initialize();
  await service.track(message(2)); // No registration required.
  await service.track({ ...message(3), chat: { id: -123, type: 'group' } });
  await assert.rejects(service.draft('tg:2', { text: 'Announcement' }, 'broadcast-key-1'), { status: 403 });
  const draft = await service.draft('tg:1', { text: 'Announcement' }, 'broadcast-key-1');
  assert.equal(draft.recipients, 2);
  assert.equal((await service.draft('tg:1', { text: 'Announcement' }, 'broadcast-key-1')).id, draft.id);
  await assert.rejects(service.draft('tg:1', { text: 'Different' }, 'broadcast-key-1'), { status: 409 });
  await service.tick(); assert.deepEqual(sent, []);
  await assert.rejects(service.confirm('tg:1', draft.id, false));
  await service.confirm('tg:1', draft.id, true);
  await service.confirm('tg:1', draft.id, true);
  await service.track(message(4)); // Not part of confirmed snapshot.
  await Promise.all([service.tick(), second.tick()]);
  assert.equal(sent.length, 1);
  await unlock(store); await service.tick();
  await unlock(store); await service.tick();
  assert.deepEqual(sent.sort(), ['tg:1', 'tg:2']);
  const job = (await service.list('tg:1')).jobs[0];
  assert.equal(job.status, 'completed'); assert.equal(job.counts.sent, 2);
  await service.confirm('tg:1', draft.id, true); await unlock(store); await service.tick();
  assert.equal(sent.length, 2);
});

test('broadcasts honor stop, blocked users, rate limits and ambiguous deliveries', async t => {
  const store = await openTestStore(); t.after(() => store.close());
  let calls = 0;
  const service = new Broadcasts(store, config(), async () => {
    calls++;
    return calls === 1 ? { error_code: 429, parameters: { retry_after: 30 } } : { error_code: 403 };
  });
  await service.initialize(); await service.track(message(2)); await service.track(message(3));
  const draft = await service.draft('tg:1', { text: 'Hello' }, 'broadcast-key-2');
  await service.confirm('tg:1', draft.id, true);
  await service.track(message(3, '/stop'));
  await service.tick(); await service.tick(); assert.equal(calls, 1);
  await unlock(store); await service.tick(); assert.equal(calls, 2);
  await unlock(store); await service.tick(); await service.tick();
  const job = (await service.list('tg:1')).jobs[0];
  assert.equal(job.counts.blocked, 1); assert.equal(job.counts.skipped, 1);
  assert.equal((await service.list('tg:1')).recipients, 0);
  await service.initialize(); assert.equal((await service.list('tg:1')).recipients, 0);
  await service.track(message(2));
  const uncertain = await service.draft('tg:1', { text: 'Next' }, 'broadcast-key-3');
  await service.confirm('tg:1', uncertain.id, true);
  service.send = async () => { throw new Error('network timeout'); };
  await unlock(store); await service.tick();
  assert.equal((await store.db.prepare('SELECT status FROM broadcast_deliveries WHERE broadcast_id=?').get(uncertain.id)).status, 'unknown');
  await store.db.prepare("UPDATE broadcast_deliveries SET status='sending',updated=0 WHERE broadcast_id=?").run(uncertain.id);
  await service.tick();
  assert.equal((await store.db.prepare('SELECT status FROM broadcast_deliveries WHERE broadcast_id=?').get(uncertain.id)).status, 'unknown');
});

test('broadcast image limits and HTTP authorization; webhook start/stop tracks guests', async t => {
  const store = await openTestStore();
  await store.register('tg:1', 'Owner'); await store.register('tg:2', 'Customer');
  await store.session('tg:1', 'owner-token'); await store.session('tg:2', 'customer-token');
  const server = await createApp(config(), store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await server.stopBroadcasts(); // No live Telegram messages in tests.
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = (route, token, data, extra = {}) => fetch(base + route, {
    method: data ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-draft-001', ...extra }, ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert.equal((await req('/api/admin/broadcasts', 'customer-token')).status, 403);
  assert.equal((await req('/api/admin/broadcasts', 'wrong-token')).status, 401);
  assert.equal((await req('/api/admin/broadcasts', 'owner-token', { text: 'Hello' }, { Origin: 'https://evil.example' })).status, 403);
  const service = new Broadcasts(store, config());
  await assert.rejects(service.draft('tg:1', { text: 'x'.repeat(4097) }, 'bad-text-001'));
  await assert.rejects(service.draft('tg:1', { text: 'Hello', photo: { type: 'image/svg+xml', base64: 'AAAA' } }, 'bad-image-001'));
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  const photo = { type: 'image/png', base64: png };
  await assert.rejects(service.draft('tg:1', { text: 'x'.repeat(1025), photo }, 'bad-caption-001'));
  const result = await req('/api/admin/broadcasts', 'owner-token', { text: 'Photo caption', photo });
  assert.equal(result.status, 200);
  const draft = await result.json(); assert.deepEqual(draft.photo, photo);
  assert.equal((await req(`/api/admin/broadcasts/${draft.id}/send`, 'customer-token', { confirm: true })).status, 403);
  assert.equal((await req(`/api/admin/broadcasts/${draft.id}/send`, 'owner-token', { confirm: true })).status, 200);
  const webhook = (id, text, secret) => req('/telegram/webhook', '', { update_id: id, message: message(44, text) }, { 'X-Telegram-Bot-Api-Secret-Token': secret });
  assert.equal((await webhook(1, '/start', 'bad')).status, 401);
  assert.equal((await webhook(1, '/start', 'fixture-secret')).status, 200);
  assert.equal((await store.db.prepare('SELECT active FROM bot_subscribers WHERE id=?').get('tg:44')).active, 1);
  await webhook(2, '/stop', 'fixture-secret');
  await webhook(1, '/start', 'fixture-secret'); // Replay must not undo opt-out.
  assert.equal((await store.db.prepare('SELECT active FROM bot_subscribers WHERE id=?').get('tg:44')).active, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore } from './helpers/database.js';
import { createApp } from '../src/server.js';
import { readConfig } from '../src/config.js';

test('phone sharing requires authenticated webhook and own contact; persists and isolates profiles', async t => {
  const store = await openTestStore();
  await store.register('tg:111', 'Alice');
  await store.register('tg:222', 'Bob');
  await store.session('tg:111', 'alice-token');
  await store.session('tg:222', 'bob-token');
  const server = await createApp(readConfig({ TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_WEBHOOK_SECRET: 'secret' }), store);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const contact = { from: { id: 111 }, chat: { type: 'private', id: 111 }, contact: { user_id: 111, phone_number: '251911111111' } };
  const send = (id, message, secret = 'secret') => fetch(base + '/telegram/webhook', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
    body: JSON.stringify({ update_id: id, message }),
  });
  assert.equal((await send(1, contact, 'wrong')).status, 401);
  assert.equal(await store.phone('tg:111'), null);
  await send(2, { ...contact, contact: { ...contact.contact, user_id: 222 } });
  await send(3, { ...contact, forward_origin: { type: 'user' } });
  await send(4, { ...contact, chat: { type: 'group', id: 111 } });
  await send(5, { ...contact, contact: { phone_number: '251911111111' } });
  assert.equal(await store.phone('tg:111'), null);
  assert.equal((await send(6, contact)).status, 200);
  assert.equal(await store.phone('tg:111'), '+251911111111');
  await send(6, { ...contact, contact: { ...contact.contact, phone_number: '251922222222' } });
  assert.equal(await store.phone('tg:111'), '+251911111111');
  await store.db.initialize(); // Idempotent startup preserves saved contacts.
  const me = async token => (await fetch(base + '/api/me', { headers: { Authorization: `Bearer ${token}` } })).json();
  assert.equal((await me('alice-token')).user.phone, '+251911111111');
  assert.equal((await me('bob-token')).user.phone, null);
  assert.equal((await fetch(base + '/api/me')).status, 401);
  await store.logout('alice-token');
  assert.equal(await store.phone('tg:111'), '+251911111111');
  assert.equal(await store.saveTelegramContact({ ...contact, from: { id: 333 }, chat: { type: 'private', id: 333 }, contact: { user_id: 333, phone_number: '251933333333' } }), false);
});

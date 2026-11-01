import { openTestStore } from './helpers/database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { createApp } from '../src/server.js';
import { readConfig } from '../src/config.js';
test('HTTP sandbox flow, competing bets and access boundaries', async (t) => {
    const store = await openTestStore();
    const server = (await createApp(readConfig({ ALLOW_LOCAL_LOGIN: 'true' }), store));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); (await store.close()); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = (url, data, token, key = 'http-key-001', extra = {}) => fetch(base + url, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Idempotency-Key': key, ...extra },
        body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal((await fetch(base)).status, 200);
    assert.equal((await request('/api/me')).status, 401);
    assert.equal((await request('/telegram/webhook', { update_id: 1 })).status, 401);
    assert.equal((await request('/api/auth/local', {}, null, 'test-key-1', { Origin: 'https://attacker.example' })).status, 403);
    const { token } = await (await request('/api/auth/local', {})).json();
    assert.equal((await request('/api/sandbox/deposits', { amount: 10000 }, token)).status, 200);
    assert.equal((await request('/api/sandbox/deposits', { amount: 10000 }, token)).status, 200);
    const wagers = await Promise.all([
        request('/api/sandbox/bets', { gameId: 'jetx', amount: 8000 }, token, 'bet-http-001'),
        request('/api/sandbox/bets', { gameId: 'jetx', amount: 8000 }, token, 'bet-http-002'),
    ]);
    assert.deepEqual(wagers.map(r => r.status).sort(), [200, 409]);
    assert.equal((await request('/api/games/launch', { gameId: 'unknown' }, token)).status, 404);
    const state = await (await request('/api/me', undefined, token)).json();
    assert.equal(state.wallet.available, 2000);
    assert.equal(state.rounds.length, 1);
    const launch = await (await request('/api/games/launch', { gameId: 'jetx' }, token)).json();
    assert.equal(launch.launchUrl, null);
    assert.equal(launch.game.liveAvailable, false);
});
test('Telegram webhook verifies secrets, handles commands and deduplicates updates', async (t) => {
    const store = await openTestStore();
    const config = readConfig({ TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_WEBHOOK_SECRET: 'test-secret', PUBLIC_APP_URL: 'https://example.test' });
    const server = (await createApp(config, store));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { await new Promise(resolve => server.close(resolve)); (await store.close()); });
    const url = `http://127.0.0.1:${server.address().port}/telegram/webhook`;
    const update = { update_id: 42, message: { chat: { id: 123, type: 'private' }, text: '/start' } };
    const post = (secret, data = update) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(data) });
    assert.equal((await post('wrong')).status, 401);
    const reply = await (await post('test-secret')).json();
    assert.equal(reply.method, 'sendMessage');
    assert.equal(reply.reply_markup.inline_keyboard[0][0].web_app.url, 'https://example.test');
    assert.deepEqual(await (await post('test-secret')).json(), { ok: true });
    assert.deepEqual(await (await post('test-secret', { ...update, update_id: 43, message: { ...update.message, chat: { id: 123, type: 'group' } } })).json(), { ok: true });
});

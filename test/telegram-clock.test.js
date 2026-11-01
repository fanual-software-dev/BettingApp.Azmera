import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramClock } from '../src/telegram-clock.js';
import { createHmac } from 'node:crypto';
import { verifyTelegram } from '../src/auth.js';

test('Telegram clock handles a host 282 seconds behind without extending auth lifetime', async () => {
  let tick = 0;
  const date = 'Sun, 01 Nov 2026 10:00:00 GMT';
  const remoteSeconds = Date.parse(date) / 1000;
  const clock = new TelegramClock({ monotonic: () => tick, fetchImpl: async () => ({ ok: true, headers: new Headers({ date }), json: async () => ({ ok: true, result: { is_bot: true } }) }) });
  assert.throws(() => clock.now(), /temporarily unavailable/);
  await clock.sync('fixture-token');
  const user = JSON.stringify({ id: 123, first_name: 'Fixture' });
  const secret = createHmac('sha256', 'WebAppData').update('fixture-token').digest();
  const check = `auth_date=${remoteSeconds}\nuser=${user}`;
  const signed = new URLSearchParams({ auth_date: String(remoteSeconds), user, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
  assert.throws(() => verifyTelegram(signed, 'fixture-token', remoteSeconds - 282), /Expired/);
  assert.equal(verifyTelegram(signed, 'fixture-token', clock.now()).id, '123');
  tick = 301_000;
  assert.throws(() => verifyTelegram(signed, 'fixture-token', clock.now()), /Expired/);
  tick = 600_001;
  assert.throws(() => clock.now(), /temporarily unavailable/);
});

test('Telegram clock rejects unverified/missing dates and does not leak credential URLs', async () => {
  for (const response of [
    { ok: false, headers: new Headers(), json: async () => ({ ok: false }) },
    { ok: true, headers: new Headers(), json: async () => ({ ok: true, result: { is_bot: true } }) },
  ]) {
    const clock = new TelegramClock({ fetchImpl: async () => response });
    await assert.rejects(clock.sync('secret'), /Unable to synchronize/);
    assert.throws(() => clock.now());
  }
  const clock = new TelegramClock({ fetchImpl: async () => { throw new Error('https://example/secret-token'); } });
  await assert.rejects(clock.sync('secret-token'), error => !error.message.includes('secret-token'));
});

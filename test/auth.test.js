import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyTelegram } from '../src/auth.js';
import { readConfig } from '../src/config.js';

function signed(date = 1000) {
  const fields = { auth_date: String(date), query_id: 'sample', user: JSON.stringify({ id: 123, first_name: 'Test' }) };
  const check = Object.entries(fields).sort(([a], [b]) => a.localeCompare(b)).map(([k,v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update('test-token').digest();
  return new URLSearchParams({ ...fields, hash: createHmac('sha256', secret).update(check).digest('hex') }).toString();
}
test('Telegram authentication validates signature, identity and freshness', () => {
  assert.deepEqual(verifyTelegram(signed(), 'test-token', 1100), { id: '123', name: 'Test' });
  assert.throws(() => verifyTelegram(signed(), 'wrong-token', 1100), /signature/);
  assert.throws(() => verifyTelegram(signed(), 'test-token', 1400), /Expired/);
  assert.throws(() => verifyTelegram(signed(1500), 'test-token', 1100), /Expired/);
  assert.throws(() => verifyTelegram(`${signed()}&auth_date=1000`, 'test-token', 1100), /Duplicate/);
});
test('startup rejects live mode and publicly bound developer login', () => {
  assert.throws(() => readConfig({ APP_MODE: 'live' }), /Live mode/);
  assert.throws(() => readConfig({ HOST: '0.0.0.0', ALLOW_LOCAL_LOGIN: 'true' }), /loopback/);
  assert.equal(readConfig({}).localLogin, false);
});

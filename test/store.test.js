import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';

function setup(t) { const store = new Store(':memory:'); t.after(() => store.close()); store.user('a', 'Alice'); store.user('b', 'Bob'); return store; }
test('deposits are double-entry and duplicate requests return the original response', t => {
  const s = setup(t);
  const first = s.deposit('a', 10000, 'deposit-001');
  assert.deepEqual(s.deposit('a', 10000, 'deposit-001'), first);
  assert.equal(s.balance('a').available, 10000);
  assert.equal(s.db.prepare('SELECT SUM(amount) AS sum FROM entries').get().sum, 0);
  assert.throws(() => s.deposit('a', 20000, 'deposit-001'), /different request/);
});
test('failed stake rolls back and same request can be retried after funding', t => {
  const s = setup(t);
  assert.throws(() => s.bet('a', 'aviator', 1000, 'bet-test-1'), /Insufficient/);
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM rounds').get().n, 0);
  s.deposit('a', 1000, 'deposit-001');
  s.bet('a', 'aviator', 1000, 'bet-test-1');
  assert.equal(s.balance('a').available, 0);
  assert.throws(() => s.bet('a', 'jetx', 1, 'bet-test-2'), /Insufficient/);
});
test('settlement enforces ownership, terminal state and idempotency', t => {
  const s = setup(t); s.deposit('a', 10000, 'deposit-001');
  const { roundId } = s.bet('a', 'aviatrix', 1000, 'bet-test-1');
  assert.throws(() => s.settle('b', roundId, 'win', 'settle-001'), /not found/);
  const first = s.settle('a', roundId, 'win', 'settle-001');
  assert.equal(s.balance('a').available, 11000);
  assert.deepEqual(s.settle('a', roundId, 'win', 'settle-001'), first);
  assert.throws(() => s.settle('a', roundId, 'refund', 'settle-002'), /already settled/);
  assert.equal(s.balance('b').available, 0);
});
test('loss and refund settle without manufacturing extra funds', t => {
  const s = setup(t); s.deposit('a', 10000, 'deposit-001');
  const loss = s.bet('a', 'keno', 1000, 'bet-loss-1');
  s.settle('a', loss.roundId, 'loss', 'settle-loss');
  const refund = s.bet('a', 'keno', 1000, 'bet-refund');
  s.settle('a', refund.roundId, 'refund', 'settle-refund');
  assert.equal(s.balance('a').available, 9000);
});
test('withdrawals reserve funds, reject overspend and refund failed payouts once', t => {
  const s = setup(t); s.deposit('a', 10000, 'deposit-001');
  const { withdrawalId } = s.withdraw('a', 8000, 'withdraw-001');
  assert.equal(s.balance('a').available, 2000);
  assert.equal(s.balance('a').reserved, 8000);
  assert.throws(() => s.withdraw('a', 3000, 'withdraw-002'), /Insufficient/);
  assert.throws(() => s.finishWithdrawal('b', withdrawalId, 'paid', 'finish-001'), /not found/);
  s.finishWithdrawal('a', withdrawalId, 'failed', 'finish-001');
  s.finishWithdrawal('a', withdrawalId, 'failed', 'finish-001');
  assert.equal(s.balance('a').available, 10000);
  assert.equal(s.balance('a').reserved, 0);
  assert.throws(() => s.finishWithdrawal('a', withdrawalId, 'paid', 'finish-002'), /already completed/);
});
test('paid withdrawal is balanced and cannot be spent again', t => {
  const s = setup(t); s.deposit('a', 10000, 'deposit-001');
  const { withdrawalId } = s.withdraw('a', 10000, 'withdraw-001');
  s.finishWithdrawal('a', withdrawalId, 'paid', 'finish-001');
  assert.equal(s.balance('a').available, 0); assert.equal(s.balance('a').reserved, 0);
  assert.equal(s.db.prepare('SELECT SUM(balance) AS sum FROM accounts').get().sum, 0);
});
test('malformed monetary inputs and absent idempotency keys cannot change balances', t => {
  const s = setup(t);
  for (const value of [-1, 0, 0.1, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER]) assert.throws(() => s.deposit('a', value, 'deposit-001'));
  assert.throws(() => s.deposit('a', 100, undefined), /Idempotency/);
  assert.equal(s.balance('a').available, 0);
});

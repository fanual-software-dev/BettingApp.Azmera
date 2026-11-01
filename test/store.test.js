import { openTestStore } from './helpers/database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
async function setup(t) { const store = await openTestStore(); t.after(async () => (await store.close())); (await store.user('a', 'Alice')); (await store.user('b', 'Bob')); return store; }
test('deposits are double-entry and duplicate requests return the original response', async (t) => {
    const s = (await setup(t));
    const first = (await s.deposit('a', 10000, 'deposit-001'));
    assert.deepEqual((await s.deposit('a', 10000, 'deposit-001')), first);
    assert.equal((await s.balance('a')).available, 10000);
    assert.equal((await s.db.prepare('SELECT SUM(amount) AS sum FROM entries').get()).sum, 0);
    (await assert.rejects(async () => (await s.deposit('a', 20000, 'deposit-001')), /different request/));
});
test('failed stake rolls back and same request can be retried after funding', async (t) => {
    const s = (await setup(t));
    (await assert.rejects(async () => (await s.bet('a', 'aviator', 1000, 'bet-test-1')), /Insufficient/));
    assert.equal((await s.db.prepare('SELECT COUNT(*) AS n FROM rounds').get()).n, 0);
    (await s.deposit('a', 1000, 'deposit-001'));
    (await s.bet('a', 'aviator', 1000, 'bet-test-1'));
    assert.equal((await s.balance('a')).available, 0);
    (await assert.rejects(async () => (await s.bet('a', 'jetx', 1, 'bet-test-2')), /Insufficient/));
});
test('settlement enforces ownership, terminal state and idempotency', async (t) => {
    const s = (await setup(t));
    (await s.deposit('a', 10000, 'deposit-001'));
    const { roundId } = (await s.bet('a', 'aviatrix', 1000, 'bet-test-1'));
    (await assert.rejects(async () => (await s.settle('b', roundId, 'win', 'settle-001')), /not found/));
    const first = (await s.settle('a', roundId, 'win', 'settle-001'));
    assert.equal((await s.balance('a')).available, 11000);
    assert.deepEqual((await s.settle('a', roundId, 'win', 'settle-001')), first);
    (await assert.rejects(async () => (await s.settle('a', roundId, 'refund', 'settle-002')), /already settled/));
    assert.equal((await s.balance('b')).available, 0);
});
test('loss and refund settle without manufacturing extra funds', async (t) => {
    const s = (await setup(t));
    (await s.deposit('a', 10000, 'deposit-001'));
    const loss = (await s.bet('a', 'keno', 1000, 'bet-loss-1'));
    (await s.settle('a', loss.roundId, 'loss', 'settle-loss'));
    const refund = (await s.bet('a', 'keno', 1000, 'bet-refund'));
    (await s.settle('a', refund.roundId, 'refund', 'settle-refund'));
    assert.equal((await s.balance('a')).available, 9000);
});
test('withdrawals reserve funds, reject overspend and refund failed payouts once', async (t) => {
    const s = (await setup(t));
    (await s.deposit('a', 10000, 'deposit-001'));
    const { withdrawalId } = (await s.withdraw('a', 8000, 'withdraw-001'));
    assert.equal((await s.balance('a')).available, 2000);
    assert.equal((await s.balance('a')).reserved, 8000);
    (await assert.rejects(async () => (await s.withdraw('a', 3000, 'withdraw-002')), /Insufficient/));
    (await assert.rejects(async () => (await s.finishWithdrawal('b', withdrawalId, 'paid', 'finish-001')), /not found/));
    (await s.finishWithdrawal('a', withdrawalId, 'failed', 'finish-001'));
    (await s.finishWithdrawal('a', withdrawalId, 'failed', 'finish-001'));
    assert.equal((await s.balance('a')).available, 10000);
    assert.equal((await s.balance('a')).reserved, 0);
    (await assert.rejects(async () => (await s.finishWithdrawal('a', withdrawalId, 'paid', 'finish-002')), /already completed/));
});
test('paid withdrawal is balanced and cannot be spent again', async (t) => {
    const s = (await setup(t));
    (await s.deposit('a', 10000, 'deposit-001'));
    const { withdrawalId } = (await s.withdraw('a', 10000, 'withdraw-001'));
    (await s.finishWithdrawal('a', withdrawalId, 'paid', 'finish-001'));
    assert.equal((await s.balance('a')).available, 0);
    assert.equal((await s.balance('a')).reserved, 0);
    assert.equal((await s.db.prepare('SELECT SUM(balance) AS sum FROM accounts').get()).sum, 0);
});
test('malformed monetary inputs and absent idempotency keys cannot change balances', async (t) => {
    const s = (await setup(t));
    for (const value of [-1, 0, 0.1, '100', NaN, Infinity, Number.MAX_SAFE_INTEGER])
        (await assert.rejects(async () => (await s.deposit('a', value, 'deposit-001'))));
    (await assert.rejects(async () => (await s.deposit('a', 100, undefined)), /Idempotency/));
    assert.equal((await s.balance('a')).available, 0);
});

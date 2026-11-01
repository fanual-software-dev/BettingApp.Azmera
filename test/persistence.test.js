import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
test('wallet, pending rounds and idempotency survive database reopen', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'azmera-test-'));
    const filename = path.join(directory, 'test.sqlite');
    let store;
    try {
        store = await Store.open(filename);
        (await store.user('a', 'Alice'));
        (await store.deposit('a', 10000, 'deposit-001'));
        (await store.bet('a', 'keno', 1000, 'bet-test-1'));
        (await store.close());
        store = await Store.open(filename);
        (await store.deposit('a', 10000, 'deposit-001'));
        assert.equal((await store.balance('a')).available, 9000);
        assert.equal((await store.pending('a')).rounds.length, 1);
    }
    finally {
        (await store?.close());
        rmSync(directory, { recursive: true, force: true });
    }
});
import { Payments } from '../src/payments.js';
import { readConfig } from '../src/config.js';
test('manual payment snapshots, receipts, cash reservations and idempotency survive restart', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'azmera-payments-'));
    const filename = path.join(directory, 'payments.sqlite');
    const config = readConfig({ MANUAL_PAYMENTS_ENABLED: 'true', PAYMENT_ADMIN_TELEGRAM_IDS: '1', CBE_ACCOUNT_NUMBER: '1000000000001', CBE_ACCOUNT_HOLDER: 'Initial Receiver' });
    const receipt = { type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII=' };
    let store;
    try {
        store = await Store.open(filename);
        (await store.user('tg:1', 'Owner'));
        (await store.user('tg:2', 'Customer'));
        let payments = await Payments.open(store, config);
        const deposit = (await payments.createDeposit('tg:2', { method: 'cbe', amount: 10000 }, 'durable-deposit'));
        (await payments.submitProof('tg:2', deposit.id, { senderName: 'Customer', receipt }, 'durable-proof'));
        (await payments.addAccount('tg:1', { method: 'cbe', account: '1000000000002', holder: 'Next Receiver' }, 'durable-switch'));
        (await store.close());
        store = await Store.open(filename);
        payments = await Payments.open(store, config);
        assert.equal((await payments.row(deposit.id)).receiver_account, '1000000000001');
        assert.equal((await payments.list('tg:2'))[0].hasReceipt, true);
        assert.equal((await payments.receiptFor('tg:1', deposit.id)).bytes.length, Buffer.from(receipt.base64, 'base64').length);
        const next = (await payments.createDeposit('tg:2', { method: 'cbe', amount: 2000 }, 'new-daily-deposit'));
        assert.equal(next.receiver_account, '1000000000002');
        const decision = { action: 'approve', verifiedReference: 'DURABLE123', verifiedAmount: 10000, verifiedRecipient: '1000000000001', verifiedSender: 'Customer', bankConfirmed: true };
        (await payments.review('tg:1', deposit.id, decision, 'durable-approval'));
        const withdrawal = (await payments.createWithdrawal('tg:2', { method: 'cbe', amount: 3000, account: '1000000000003', holder: 'Customer' }, 'durable-withdrawal'));
        (await store.close());
        store = await Store.open(filename);
        payments = await Payments.open(store, config);
        (await payments.review('tg:1', deposit.id, decision, 'durable-approval'));
        assert.equal((await payments.balance('tg:2')).available, 7000);
        assert.equal((await payments.balance('tg:2')).reserved, 3000);
        assert.equal((await payments.row(withdrawal.id)).status, 'pending');
        assert.equal((await payments.auditFor('tg:1', deposit.id)).filter(e => e.action === 'approve').length, 1);
    }
    finally {
        (await store?.close());
        if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir()) || !path.basename(directory).startsWith('azmera-payments-'))
            throw new Error('Unsafe test cleanup path');
        rmSync(directory, { recursive: true, force: true });
    }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('wallet, pending rounds and idempotency survive database reopen', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'azmera-test-'));
  const filename = path.join(directory, 'test.sqlite');
  let store;
  try {
    store = new Store(filename); store.user('a', 'Alice');
    store.deposit('a', 10000, 'deposit-001');
    store.bet('a', 'keno', 1000, 'bet-test-1');
    store.close(); store = new Store(filename);
    store.deposit('a', 10000, 'deposit-001');
    assert.equal(store.balance('a').available, 9000);
    assert.equal(store.pending('a').rounds.length, 1);
  } finally { store?.close(); rmSync(directory, { recursive: true, force: true }); }
});
import { Payments } from '../src/payments.js';
import { readConfig } from '../src/config.js';

test('manual payment snapshots, receipts, cash reservations and idempotency survive restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'azmera-payments-'));
  const filename = path.join(directory, 'payments.sqlite');
  const config = readConfig({MANUAL_PAYMENTS_ENABLED:'true',PAYMENT_ADMIN_TELEGRAM_IDS:'1',CBE_ACCOUNT_NUMBER:'1000000000001',CBE_ACCOUNT_HOLDER:'Initial Receiver'});
  const receipt={type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII='};
  let store;
  try {
    store=new Store(filename);store.user('tg:1','Owner');store.user('tg:2','Customer');let payments=new Payments(store,config);
    const deposit=payments.createDeposit('tg:2',{method:'cbe',amount:10000},'durable-deposit');
    payments.submitProof('tg:2',deposit.id,{senderName:'Customer',receipt},'durable-proof');
    payments.addAccount('tg:1',{method:'cbe',account:'1000000000002',holder:'Next Receiver'},'durable-switch');
    store.close();store=new Store(filename);payments=new Payments(store,config);
    assert.equal(payments.row(deposit.id).receiver_account,'1000000000001');assert.equal(payments.list('tg:2')[0].hasReceipt,true);assert.equal(payments.receiptFor('tg:1',deposit.id).bytes.length,Buffer.from(receipt.base64,'base64').length);
    const next=payments.createDeposit('tg:2',{method:'cbe',amount:2000},'new-daily-deposit');assert.equal(next.receiver_account,'1000000000002');
    const decision={action:'approve',verifiedReference:'DURABLE123',verifiedAmount:10000,verifiedRecipient:'1000000000001',verifiedSender:'Customer',bankConfirmed:true};
    payments.review('tg:1',deposit.id,decision,'durable-approval');
    const withdrawal=payments.createWithdrawal('tg:2',{method:'cbe',amount:3000,account:'1000000000003',holder:'Customer'},'durable-withdrawal');
    store.close();store=new Store(filename);payments=new Payments(store,config);
    payments.review('tg:1',deposit.id,decision,'durable-approval');assert.equal(payments.balance('tg:2').available,7000);assert.equal(payments.balance('tg:2').reserved,3000);assert.equal(payments.row(withdrawal.id).status,'pending');
    assert.equal(payments.auditFor('tg:1',deposit.id).filter(e=>e.action==='approve').length,1);
  } finally {
    store?.close();
    if(path.dirname(path.resolve(directory))!==path.resolve(tmpdir()) || !path.basename(directory).startsWith('azmera-payments-')) throw new Error('Unsafe test cleanup path');
    rmSync(directory,{recursive:true,force:true});
  }
});

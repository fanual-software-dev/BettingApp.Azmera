import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore } from './helpers/database.js';
import { Store } from '../src/store.js';
import { Payments } from '../src/payments.js';
import { readConfig } from '../src/config.js';
import { postgresSql, openDatabase } from '../src/database.js';

const config = readConfig({MANUAL_PAYMENTS_ENABLED:'true', PAYMENT_ADMIN_TELEGRAM_IDS:'1', CBE_ACCOUNT_NUMBER:'1000000000001', CBE_ACCOUNT_HOLDER:'Test Owner'});
const receipt = {type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII='};

test('PostgreSQL configuration rejects missing URLs and insecure remote TLS', async () => {
  assert.throws(()=>readConfig({DATABASE_DRIVER:'postgres'}),/DATABASE_URL is required/);
  assert.throws(()=>readConfig({DATABASE_URL:'https://example.com'}),/PostgreSQL/);
  assert.throws(()=>readConfig({DATABASE_POOL_SIZE:'0'}),/DATABASE_POOL_SIZE/);
  await assert.rejects(()=>openDatabase({databaseUrl:'postgresql://user:secret@example.com/postgres',databaseSsl:false}),/TLS/);
  assert.equal(postgresSql("SELECT '?' AS value WHERE id=? AND name=?"),"SELECT '?' AS value WHERE id=$1 AND name=$2");
});

test('PostgreSQL: concurrent backends cannot double-credit, overspend, or reuse evidence', {skip:!process.env.TEST_DATABASE_URL}, async t => {
  const store=await openTestStore();const second=await Store.open(store.testConnection);
  t.after(async()=>{await second.close();await store.close();});
  for(const [id,name] of [['tg:1','Owner'],['tg:2','Alice'],['tg:3','Bob']])await store.user(id,name);
  const p=await Payments.open(store,config),q=await Payments.open(second,config);
  const make=async(user,ref,key)=>{const d=await p.createDeposit(user,{method:'cbe',amount:10000},key+'-create');await p.submitProof(user,d.id,{reference:ref},key+'-proof');return d;};
  const d=await make('tg:2','BANKFIRST123','first-deposit');
  const results=await Promise.all([p.review('tg:1',d.id,{action:'approve'},'concurrent-approval'),q.review('tg:1',d.id,{action:'approve'},'concurrent-approval')]);
  assert.deepEqual(results[0],results[1]);assert.equal((await p.balance('tg:2')).available,10000);
  const a=await make('tg:2','BANKSHARED123','shared-alice'),b=await make('tg:3','BANKSHARED123','shared-bob');
  const duplicates=await Promise.allSettled([p.review('tg:1',a.id,{action:'approve'},'approve-shared-a'),q.review('tg:1',b.id,{action:'approve'},'approve-shared-b')]);
  assert.equal(duplicates.filter(r=>r.status==='fulfilled').length,1);
  assert.match(duplicates.find(r=>r.status==='rejected').reason.message,/already used/);
  const balance=(await p.balance('tg:2')).available;
  const withdrawal={method:'cbe',amount:balance,account:'1000000000002'};
  const attempts=await Promise.allSettled([p.createWithdrawal('tg:2',withdrawal,'withdraw-race-a'),q.createWithdrawal('tg:2',withdrawal,'withdraw-race-b')]);
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal((await p.balance('tg:2')).available,0);assert.equal((await p.balance('tg:2')).reserved,balance);
  // Different clients racing to decide one payout must not return reserved funds twice.
  const w=attempts.find(r=>r.status==='fulfilled').value;
  const cancelled=await Promise.allSettled([p.cancel('tg:2',w.id,'cancel-race-a'),q.review('tg:1',w.id,{action:'reject',reason:'Test cancellation'},'cancel-race-b')]);
  assert.equal(cancelled.filter(r=>r.status==='fulfilled').length,1);assert.equal((await p.balance('tg:2')).available,balance);assert.equal((await p.balance('tg:2')).reserved,0);
  assert.equal((await store.db.prepare('SELECT SUM(amount) AS total FROM entries').get()).total,0);
  // Errors roll back their operation record and all balance updates.
  const before=await p.balance('tg:2');
  await assert.rejects(()=>store.atomic('rollback','rollback-error-1',{},async op=>{await store.transfer(op,'tg:2:cash_available','cash:clearing:cbe',100);throw new Error('forced rollback');}),/forced rollback/);
  assert.deepEqual(await p.balance('tg:2'),before);assert.equal(await store.db.prepare('SELECT id FROM operations WHERE key=?').get('rollback-error-1'),undefined);
});

test('PostgreSQL: receipts, session expiry, ledger and account settings survive reconnect', {skip:!process.env.TEST_DATABASE_URL}, async t => {
  const original=await openTestStore();t.after(()=>original.close());
  let store=await Store.open(original.testConnection);
  try {
    await store.user('tg:1','Owner');await store.user('tg:2','Alice');await store.session('tg:2','persisted-session-token');
    let payments=await Payments.open(store,config);
    const d=await payments.createDeposit('tg:2',{method:'cbe',amount:5000},'receipt-deposit');
    await payments.submitProof('tg:2',d.id,{receipt},'receipt-proof');
    await payments.review('tg:1',d.id,{action:'approve'},'receipt-approve');
    await payments.addAccount('tg:1',{method:'cbe',account:'1000000000002',holder:'Next Receiver'},'receiver-switch');
    await store.close();store=await Store.open(original.testConnection);payments=await Payments.open(store,config);
    assert.equal((await store.authenticate('persisted-session-token')).id,'tg:2');assert.equal((await payments.balance('tg:2')).available,5000);
    assert.equal((await payments.receiptFor('tg:2',d.id)).bytes.toString('base64'),receipt.base64);assert.equal((await payments.list('tg:2'))[0].hasReceipt,true);
    assert.equal((await payments.settingsFor('tg:1')).accounts.find(a=>a.active).account,'1000000000002');
    await payments.review('tg:1',d.id,{action:'approve'},'receipt-approve');assert.equal((await payments.balance('tg:2')).available,5000);
    await store.logout('persisted-session-token');await assert.rejects(()=>store.authenticate('persisted-session-token'),/Session expired/);
  } finally {await store.close();}
});

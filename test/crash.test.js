import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { openTestStore } from './helpers/database.js';
import { Crash, crashPoint } from '../src/crash.js';
import { Payments } from '../src/payments.js';
import { readConfig } from '../src/config.js';
import { ethiopianDay } from '../src/game-rules.js';

test('crash engine hides outcomes, enforces stakes/slots, and settles each bet once', async t=>{
 const store=await openTestStore();t.after(()=>store.close());await store.user('tg:2','Player');await store.deposit('tg:2',1000000,'fund-crash-demo');
 let now=Date.now();const service=new Crash(store,()=>now);const state=await service.state('tg:2','azmera-flight');
 assert.equal(state.rules.houseEdgeBps,500);assert.equal(state.round.seed,undefined);assert.equal(state.round.crash,undefined);
 const row=await store.db.prepare('SELECT * FROM crash_rounds WHERE id=?').get(state.round.id);
 assert.equal(row.crash,crashPoint(row.seed,row.id));assert.equal(row.commitment,createHash('sha256').update(row.seed).digest('hex'));
 const bet={roundId:row.id,slot:1,amount:400,autoAt:200};
 await assert.rejects(service.place('tg:2','azmera-flight',{...bet,amount:399},'invalid-low'),/4,000/);
 await assert.rejects(service.place('tg:2','azmera-flight',{...bet,amount:400001},'invalid-high'),/4,000/);
 await assert.rejects(service.place('tg:2','azmera-flight',{...bet,slot:3},'invalid-slot'),/two/);
 const placed=await service.place('tg:2','azmera-flight',bet,'first-slot');
 assert.deepEqual(await service.place('tg:2','azmera-flight',bet,'first-slot'),placed);
 await assert.rejects(service.place('tg:2','azmera-flight',bet,'duplicate-slot'),/already/);
 await service.act('tg:2','azmera-flight',placed.id,'cancel');
 assert.equal((await store.balance('tg:2')).available,1000000);
 const next=await service.place('tg:2','azmera-flight',bet,'new-slot');
 const second=await service.place('tg:2','azmera-flight',{...bet,slot:2,autoAt:0},'second-slot');
 // Deterministic test fixture: 3x crash, 2x automatic payout.
 const end=row.starts+Math.ceil(Math.log(3)/.12*1000);
 await store.db.prepare('UPDATE crash_rounds SET crash=300,ends=? WHERE id=?').run(end,row.id);
 now=end+1;await service.advance('azmera-flight');
 assert.equal((await store.db.prepare('SELECT payout FROM crash_bets WHERE id=?').get(next.id)).payout,800);
 assert.equal((await store.db.prepare('SELECT status FROM crash_bets WHERE id=?').get(second.id)).status,'lost');
 const balance=(await store.balance('tg:2')).available;
 await service.act('tg:2','azmera-flight',next.id,'cashout');assert.equal((await store.balance('tg:2')).available,balance);
 assert.equal((await store.db.prepare('SELECT SUM(amount) AS total FROM entries').get()).total,0);
});

test('manual cash-out cannot exceed per-slot cap or pay twice under concurrency', async t=>{
 const store=await openTestStore();t.after(()=>store.close());await store.user('tg:2','Player');await store.deposit('tg:2',1000000,'fund-demo');
 let now=Date.now();const service=new Crash(store,()=>now);const state=await service.state('tg:2','azmera-jet');
 const end=state.round.starts+Math.ceil(Math.log(50)/.12*1000);
 await store.db.prepare('UPDATE crash_rounds SET crash=5000,ends=? WHERE id=?').run(end,state.round.id);
 const bet=await service.place('tg:2','azmera-jet',{roundId:state.round.id,slot:1,amount:400000},'cap-test');
 now=state.round.starts+Math.ceil(Math.log(26)/.12*1000);
 await Promise.all([service.act('tg:2','azmera-jet',bet.id,'cashout'),service.act('tg:2','azmera-jet',bet.id,'cashout')]);
 assert.equal((await store.db.prepare('SELECT payout FROM crash_bets WHERE id=?').get(bet.id)).payout,10000000);
 assert.equal((await store.balance('tg:2')).available,10600000);
 await assert.rejects(service.place('tg:2','azmera-jet',{roundId:state.round.id,slot:2,amount:400},'late-bet'),/closed/);
});

test('payment limits enforce minimum deposit and concurrent daily withdrawal budget',async t=>{
 const store=await openTestStore();t.after(()=>store.close());await store.user('tg:2','Player');
 const config=readConfig({MANUAL_PAYMENTS_ENABLED:'true',PAYMENT_ADMIN_TELEGRAM_IDS:'1',CBE_ACCOUNT_NUMBER:'1000000000001',CBE_ACCOUNT_HOLDER:'Owner'});
 const p=await Payments.open(store,config);await p.ensureAccounts('tg:2');
 await assert.rejects(p.createDeposit('tg:2',{method:'cbe',amount:9999},'too-small'),/100 ETB/);
 await p.createDeposit('tg:2',{method:'cbe',amount:10000},'minimum-deposit');
 // Seed cash for test only, preserving ledger consistency.
 await store.atomic('test','cash-funding',{},async op=>{await store.transfer(op,'cash:clearing:cbe','tg:2:cash_available',10000000);return {ok:true};});
 const request={method:'cbe',amount:1000000,account:'1000000000002'};
 await assert.rejects(p.createWithdrawal('tg:2',{...request,amount:1000001},'large-withdrawal'),/10,000/);
 // Remove unrelated draft through the normal cancel flow to leave all five request slots available.
 const d=(await p.list('tg:2'))[0];await p.cancel('tg:2',d.id,'cancel-test-draft');
 const results=await Promise.allSettled(Array.from({length:6},(_,i)=>p.createWithdrawal('tg:2',request,`limit-test-${i}`)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,5);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/50,000/);
 assert.equal((await p.balance('tg:2')).reserved,5000000);
 assert.equal(ethiopianDay(Date.parse('2026-11-07T21:00:00Z'))[0],'2026-11-07T21:00:00.000Z');
});

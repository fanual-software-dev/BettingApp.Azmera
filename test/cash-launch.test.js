import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore } from './helpers/database.js';
import { Crash } from '../src/crash.js';
import { Payments } from '../src/payments.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

const config=()=>readConfig({MANUAL_PAYMENTS_ENABLED:'true',PAYMENT_ADMIN_TELEGRAM_IDS:'1',CBE_ACCOUNT_NUMBER:'1000000000001',CBE_ACCOUNT_HOLDER:'Owner'});
async function fixture(t, capital=20000000) {
 const store=await openTestStore();t.after(()=>store.close());
 const payments=await Payments.open(store,config());
 for(const id of ['tg:1','tg:2','tg:3']) {await store.user(id,id);await payments.ensureAccounts(id);}
 await store.atomic('fixture','cash-fund-fixture',{},async op=>{
   await store.transfer(op,'cash:clearing:cbe','tg:1:cash_available',capital);
   await store.transfer(op,'cash:clearing:cbe','tg:2:cash_available',1000000);
   await store.transfer(op,'cash:clearing:cbe','tg:3:cash_available',1000000);
   return {ok:true};
 });
 let now=Date.now();const crash=new Crash(store,()=>now,'cash');await crash.initialize();
 return {store,payments,crash,get now(){return now;},set now(value){now=value;},async fund(){await crash.fund('tg:1',capital,'house-funding');await crash.pause('tg:1',false,'enable-cash');},async advanceTo(target,game='azmera-flight'){while(now<target){now=Math.min(target,now+1000);await crash.advance(game);}}};
}
test('cash startup rejects insecure or incomplete deployment configuration',()=>{
 assert.throws(()=>readConfig({CRASH_MODE:'cash'}),/Cash games require/);
 assert.throws(()=>readConfig({CRASH_MODE:'cash',DATABASE_URL:'postgresql://user:secret@example.com/postgres',DATABASE_SSL:'false',TELEGRAM_BOT_TOKEN:'private-token',PUBLIC_APP_URL:'https://example.com'}),error=>error.message.includes('DATABASE_SSL=true')&&error.message.includes('MANUAL_PAYMENTS_ENABLED=true')&&!error.message.includes('secret@example')&&!error.message.includes('private-token'));
 assert.throws(()=>readConfig({CRASH_MODE:'wrong'}),/CRASH_MODE/);
 const c=readConfig({...{DATABASE_URL:'postgresql://user:password@example.com/postgres',PUBLIC_APP_URL:'https://example.com',TELEGRAM_BOT_TOKEN:'fixture',CRASH_MODE:'cash',MANUAL_PAYMENTS_ENABLED:'true',PAYMENT_ADMIN_TELEGRAM_IDS:'1',CBE_ACCOUNT_NUMBER:'1000000000001',CBE_ACCOUNT_HOLDER:'Owner'}});
 assert.equal(c.crashMode,'cash');
});
test('cash bets reserve maximum exposure, never touch demo balances, and refund on outage',async t=>{
 const f=await fixture(t);await f.store.deposit('tg:2',9999,'demo-balance');
 await assert.rejects(f.crash.pause('tg:1',false,'empty-bankroll'),/100,000/);
 await f.fund();await f.crash.fund('tg:1',20000000,'house-funding');
 const state=await f.crash.state('tg:2','azmera-flight');
 const bet={roundId:state.round.id,slot:1,amount:400,acceptCash:true};
 await assert.rejects(f.crash.place('tg:2','azmera-flight',{...bet,acceptCash:false},'no-consent'),/Confirm/);
 await f.crash.place('tg:2','azmera-flight',bet,'cash-slot-one');
 await f.crash.place('tg:2','azmera-flight',{...bet,slot:2},'cash-slot-two');
 assert.equal((await f.crash.bankroll()).reserved,20000000);
 assert.equal((await f.payments.balance('tg:2')).available,999200);
 assert.equal((await f.store.balance('tg:2')).available,9999);
 f.now+=4000;const interrupted=await f.crash.state('tg:2','azmera-flight');
 assert.equal(interrupted.round.phase,'void');
 assert.equal((await f.payments.balance('tg:2')).available,1000000);
 assert.equal((await f.crash.bankroll()).available,20000000);
 assert.equal((await f.crash.bankroll()).reserved,0);
 await f.crash.advance('azmera-flight');assert.equal((await f.payments.balance('tg:2')).available,1000000);
 assert.equal((await f.store.db.prepare('SELECT SUM(amount) AS n FROM entries').get()).n,0);
});
test('concurrent users cannot overbook house capital; pause blocks bets but permits settlement',async t=>{
 const f=await fixture(t,10000000);await f.fund();const state=await f.crash.state('tg:2','azmera-flight');
 const data={roundId:state.round.id,slot:1,amount:400,acceptCash:true};
 const results=await Promise.allSettled(['tg:2','tg:3'].map(u=>f.crash.place(u,'azmera-flight',data,'same-round')));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/capacity/);
 const bet=await f.store.db.prepare("SELECT * FROM crash_bets WHERE status='open'").get();
 await f.store.db.prepare('UPDATE crash_rounds SET crash=1000,ends=? WHERE id=?').run(state.round.starts+20000,state.round.id);
 await f.crash.pause('tg:1',true,'pause-bets');
 await assert.rejects(f.crash.place(bet.user_id,'azmera-flight',{...data,slot:2},'paused-bet'),/paused/);
 await f.advanceTo(state.round.starts+2000);
 const settled=await Promise.all([f.crash.act(bet.user_id,'azmera-flight',bet.id,'cashout'),f.crash.act(bet.user_id,'azmera-flight',bet.id,'cashout')]);
 assert.equal(settled[0].payout,settled[1].payout);assert.ok(settled[0].payout>400);
 assert.equal((await f.crash.bankroll()).reserved,0);
 assert.equal((await f.crash.bankroll()).available,10000000+400-settled[0].payout);
});
test('payout-day reservations include backlog and remain held until failed or paid',async t=>{
 const f=await fixture(t);const p=f.payments;
 // Fixtures emulate backlogged requests already holding customer funds.
 await f.store.atomic('fixture','backlog-funds',{},async op=>{await f.store.transfer(op,'cash:clearing:cbe','tg:2:cash_reserved',6000000);return {ok:true};});
 for(let i=0;i<6;i++)await f.store.db.prepare("INSERT INTO payment_requests(id,user_id,kind,method,amount,status,destination,created_at,updated_at) VALUES(?,'tg:2','withdrawal','cbe',1000000,'pending','1000000000002',?,?)").run(`backlog-${i}`,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z');
 const claims=await Promise.allSettled(Array.from({length:6},(_,i)=>p.review('tg:1',`backlog-${i}`,{action:'claim'},`claim-backlog-${i}`)));
 assert.equal(claims.filter(r=>r.status==='fulfilled').length,5);
 assert.match(claims.find(r=>r.status==='rejected').reason.message,/Payout-day/);
 const paid=claims.find(r=>r.status==='fulfilled').value;
 await p.review('tg:1',paid.id,{action:'paid',verifiedReference:'PAYOUT123456',verifiedAmount:1000000,verifiedRecipient:'1000000000002',bankConfirmed:true},'confirm-paid');
 const denied=claims.findIndex(r=>r.status==='rejected');
 await assert.rejects(p.review('tg:1',`backlog-${denied}`,{action:'claim'},'still-full'),/Payout-day/);
 const other=claims.filter(r=>r.status==='fulfilled')[1].value;
 await p.review('tg:1',other.id,{action:'failed',fundsNotSent:true,reason:'No bank transfer made'},'release-capacity');
 await p.review('tg:1',`backlog-${denied}`,{action:'claim'},'capacity-reused');
});
test('HTTP bankroll controls deny nonowners and game stream returns authenticated snapshots',async t=>{
 const f=await fixture(t);await f.store.session('tg:1','owner-token');await f.store.session('tg:2','player-token');
 const server=await createApp(config(),f.store);await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(async()=>{server.closeEventStreams();await server.stopBroadcasts();await new Promise(r=>server.close(r));});
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/api/admin/crash',{headers:{Authorization:'Bearer player-token'}})).status,403);
 assert.equal((await fetch(base+'/api/admin/crash',{headers:{Authorization:'Bearer owner-token'}})).status,200);
 assert.equal((await fetch(base+'/api/crash/azmera-flight/events')).status,401);
 const controller=new AbortController();const response=await fetch(base+'/api/crash/azmera-flight/events',{headers:{Authorization:'Bearer player-token'},signal:controller.signal});
 assert.equal(response.headers.get('content-type'),'text/event-stream');
 const reader=response.body.getReader();const chunk=new TextDecoder().decode((await reader.read()).value);
 assert.match(chunk,/event: state/);assert.match(chunk,/"commitment"/);assert.ok(!chunk.includes('"seed":'));
 controller.abort();
});

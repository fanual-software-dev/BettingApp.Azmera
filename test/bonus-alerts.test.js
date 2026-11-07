import test from 'node:test';
import assert from 'node:assert/strict';
import {openTestStore} from './helpers/database.js';
import {Payments} from '../src/payments.js';
import {Crash} from '../src/crash.js';
import {PaymentAlerts} from '../src/payment-alerts.js';
import {depositBonus} from '../src/deposit-bonus.js';
import {readConfig} from '../src/config.js';
async function fixture(t){
 const store=await openTestStore();t.after(()=>store.close());
 for(const id of ['tg:1','tg:2'])await store.user(id,id);
 const config=readConfig({MANUAL_PAYMENTS_ENABLED:'true',PAYMENT_ADMIN_TELEGRAM_IDS:'1',CBE_ACCOUNT_NUMBER:'1000000000001',CBE_ACCOUNT_HOLDER:'Owner',DEPOSIT_BONUS_MODE:'after-six-rounds'});
 const p=await Payments.open(store,config);await new Crash(store).initialize();
 return {store,p,config};
}
test('bonus tiers use exact ETB boundary and round down to cents',()=>{
 for(const [amount,rate,bonus] of [[10000,1000,1000],[99900,1000,9990],[99901,1500,14985],[100000,1500,15000]])assert.deepEqual(depositBonus(amount),{rateBps:rate,amount:bonus});
});
test('deposit bonus is funded, credited once with principal and not granted on owner funding',async t=>{
 const {store,p}=await fixture(t);
 const r=await p.createDeposit('tg:2',{method:'cbe',amount:100000},'bonus-create');assert.equal(r.bonus.amount,15000);
 assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM payment_alerts').get()).n,0);
 await p.submitProof('tg:2',r.id,{reference:'FTBONUS12345'},'bonus-proof');
 await p.submitProof('tg:2',r.id,{reference:'FTBONUS12345'},'bonus-proof');
 assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM payment_alerts').get()).n,1);
 await assert.rejects(p.review('tg:1',r.id,{action:'approve'},'bonus-approve'),/house capital/);
 assert.equal((await p.balance('tg:2')).available,0);assert.equal((await p.row(r.id)).status,'pending');
 await store.atomic('fixture','house-bonus-funding',{},async op=>{await store.transfer(op,'cash:clearing:cbe','cash:crash_available',1000000);return {ok:true};});
 p.settings.depositBonusMode='off'; // Existing promised bonus survives a campaign change.
 const approved=await p.review('tg:1',r.id,{action:'approve'},'bonus-approve');assert.equal(approved.bonus.status,'credited');
 await p.review('tg:1',r.id,{action:'approve'},'bonus-approve');assert.equal((await p.balance('tg:2')).available,115000);
 assert.equal((await store.db.prepare("SELECT balance FROM accounts WHERE id='cash:crash_available'").get()).balance,985000);
 p.settings.depositBonusMode='after-six-rounds';
 const owner=await p.createDeposit('tg:1',{method:'cbe',amount:100000},'owner-funding');assert.equal(owner.bonus,null);
 const cancelled=await p.createDeposit('tg:2',{method:'cbe',amount:10000},'bonus-cancel-create');await p.cancel('tg:2',cancelled.id,'bonus-cancel');assert.equal((await p.row(cancelled.id)).bonus.status,'cancelled');
 await p.createWithdrawal('tg:2',{method:'cbe',amount:10000,account:'1000000000002'},'bonus-withdraw');
 assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM payment_alerts').get()).n,2);
 assert.equal((await store.db.prepare('SELECT SUM(amount) AS n FROM entries').get()).n,0);
});
test('bonus stays playable but cannot be withdrawn until six distinct finished cash rounds after approval',async t=>{
 const {store,p}=await fixture(t);
 await store.atomic('fixture','unlock-funding',{},async op=>{await store.transfer(op,'cash:clearing:cbe','cash:crash_available',10000000);return {ok:true};});
 const dep=await p.createDeposit('tg:2',{method:'cbe',amount:10000},'unlock-deposit');await p.submitProof('tg:2',dep.id,{reference:'FTUNLOCK1234'},'unlock-proof');await p.review('tg:1',dep.id,{action:'approve'},'unlock-approve');
 const credit=(await store.db.prepare('SELECT credited_at FROM deposit_bonuses WHERE request_id=?').get(dep.id)).credited_at;
 const start=credit+1;
 const round=async(id,game='azmera-flight:cash',status='finished',opens=start)=>{
   await store.db.prepare('INSERT INTO crash_rounds VALUES(?,?,?,?,?,?,?,?,?)').run(id,game,'seed','commitment',200,opens,opens+100,opens+1000,status);
   for(let slot=1;slot<=2;slot++)await store.db.prepare('INSERT INTO crash_bets VALUES(?,?,?,?,?,?,?,?,?)').run(`${id}-${slot}`,id,'tg:2',slot,400,0,status==='void'?'cancelled':'lost',0,0);
 };
 await round('old','azmera-flight:cash','finished',credit-100);await round('practice','azmera-flight');await round('refunded','azmera-flight:cash','void');
 for(let i=0;i<5;i++)await round(`qualifying-${i}`);
 assert.equal((await p.row(dep.id)).bonus.roundsCompleted,5);
 const wallet=await p.balance('tg:2');assert.equal(wallet.available,11000);assert.equal(wallet.withdrawable,10000);assert.equal(wallet.bonusLocked,1000);
 await assert.rejects(p.createWithdrawal('tg:2',{method:'cbe',amount:11000,account:'1000000000002'},'unlock-too-early'),/locked bonus/);
 await round('sixth','azmera-jet:cash');assert.equal((await p.row(dep.id)).bonus.unlocked,true);
 assert.equal((await p.balance('tg:2')).withdrawable,11000);
 await p.createWithdrawal('tg:2',{method:'cbe',amount:11000,account:'1000000000002'},'unlock-withdraw');
 assert.equal((await p.balance('tg:2')).reserved,11000);
});
test('payment emails retry after failure without blocking requests; concurrent workers claim once',async t=>{
 const {store,p,config}=await fixture(t);const r=await p.createDeposit('tg:2',{method:'cbe',amount:10000},'alert-create');await p.submitProof('tg:2',r.id,{reference:'FTALERT12345'},'alert-proof');
 config.smtp.from='sender@example.com';let calls=0;let message;
 const mailer={async sendMail(mail){calls++;message=mail;if(calls===1)throw new Error('secret smtp error');return {accepted:['asfawfanual2003@gmail.com']};}};
 const alerts=new PaymentAlerts(store,config,mailer);
 await alerts.tick();assert.equal((await p.row(r.id)).status,'pending');
 let event=await store.db.prepare('SELECT * FROM payment_alerts').get();assert.equal(event.status,'pending');assert.equal(event.attempts,1);
 await store.db.prepare('UPDATE payment_alerts SET retry_at=0').run();
 await Promise.all([alerts.tick(),new PaymentAlerts(store,config,mailer).tick()]);
 assert.equal(calls,2);assert.equal(message.to,'asfawfanual2003@gmail.com');assert.match(message.text,/100.00 ETB/);assert.match(message.text,/not payment verification/);
 assert.equal((await store.db.prepare('SELECT status FROM payment_alerts').get()).status,'sent');
 await alerts.tick();assert.equal(calls,2);
});

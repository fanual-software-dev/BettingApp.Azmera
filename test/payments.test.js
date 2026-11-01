import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Payments } from '../src/payments.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
const receiver='1000509487627';
const image={type:'image/png',base64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRz8AAAAASUVORK5CYII='};
function fixture(t){const store=new Store(':memory:');for(const [id,name]of [['tg:1','Owner'],['tg:2','Alice'],['tg:3','Agent'],['tg:4','Bob']])store.user(id,name);const config=readConfig({MANUAL_PAYMENTS_ENABLED:'true',PAYMENT_ADMIN_TELEGRAM_IDS:'1',CBE_ACCOUNT_NUMBER:receiver,CBE_ACCOUNT_HOLDER:'Test Receiver',TELEBIRR_NUMBER:'0940646657',TELEBIRR_ACCOUNT_HOLDER:'Test Receiver'});const payments=new Payments(store,config);t.after(()=>store.close());return {store,payments,config};}
function pending(p,user='tg:2',suffix='0001',receipt=null){const r=p.createDeposit(user,{method:'cbe',amount:10000},'create-'+suffix);p.submitProof(user,r.id,{reference:receipt?'':'FT'+suffix+'ABC',senderName:'Alice Bank Name',receipt},'proof-'+suffix);return r;}
function approval(ref='FT0001ABC'){return {action:'approve',verifiedReference:ref,verifiedAmount:10000,verifiedRecipient:receiver,verifiedSender:'Alice Bank Name',bankConfirmed:true};}

test('deposit needs independent review, credits once, and never mixes with test credits',t=>{
 const {store,payments:p}=fixture(t);store.deposit('tg:2',500000,'test-credits');const r=pending(p);
 assert.equal(p.balance('tg:2').available,0);assert.throws(()=>p.review('tg:2',r.id,approval(),'unauthorized'),/access required/);
 assert.throws(()=>p.review('tg:1',r.id,{...approval(),bankConfirmed:false},'unconfirmed'),/Confirm receipt/);
 assert.throws(()=>p.review('tg:1',r.id,{...approval(),verifiedAmount:9999},'wrong-amount'),/exact amount/);
 assert.throws(()=>p.review('tg:1',r.id,{...approval(),verifiedRecipient:'1000000000000'},'wrong-receiver'),/receiving account/);
 const approved=p.review('tg:1',r.id,approval(),'approve-0001');assert.equal(approved.status,'approved');assert.equal(p.balance('tg:2').available,10000);
 assert.deepEqual(p.review('tg:1',r.id,approval(),'approve-0001'),approved);assert.throws(()=>p.review('tg:1',r.id,approval(),'approve-again'),/current request status/);
 assert.equal(store.balance('tg:2').available,500000);assert.equal(p.balance('tg:2').available,10000);
 assert.equal(store.db.prepare('SELECT SUM(amount) AS n FROM entries').get().n,0);
});

test('screenshot-only proof stays pending, receipts are private and verified references cannot be reused',t=>{
 const {payments:p}=fixture(t);const a=pending(p,'tg:2','0001',image);assert.equal(p.row(a.id).status,'pending');assert.equal(p.receiptFor('tg:2',a.id).type,'image/png');assert.throws(()=>p.receiptFor('tg:4',a.id),/not found/);
 p.review('tg:1',a.id,approval(),'approve-first');const b=pending(p,'tg:4','0002',image);
 assert.throws(()=>p.review('tg:1',b.id,approval(),'duplicate-bank'),/already used/);assert.equal(p.balance('tg:4').available,0);assert.equal(p.row(b.id).status,'pending');
 const bad=p.createDeposit('tg:2',{method:'cbe',amount:100},'invalid-file');assert.throws(()=>p.submitProof('tg:2',bad.id,{senderName:'Alice',receipt:{type:'image/svg+xml',base64:'PHN2Zz4='}},'invalid-proof'),/PNG or JPEG/);
 assert.throws(()=>p.submitProof('tg:2',bad.id,{senderName:'Alice'},'missing-proof'),/transaction ID or/);
});

test('daily account switching preserves old recipient snapshots and assigned-agent access',t=>{
 const {payments:p}=fixture(t);p.setAgent('tg:1',{telegramId:'3',enabled:true},'enable-agent');assert.throws(()=>p.settingsFor('tg:3'),/Owner access/);assert.ok(p.settingsFor('tg:1').users.some(u=>u.id==='tg:4'));
 const old=pending(p);p.addAccount('tg:1',{method:'cbe',account:'1000000000000',holder:'Agent Receiver',agentId:'3'},'switch-account');
 const next=p.createDeposit('tg:4',{method:'cbe',amount:10000},'new-deposit');assert.equal(next.receiver_account,'1000000000000');assert.equal(p.row(old.id).receiver_account,receiver);
 assert.throws(()=>p.review('tg:3',old.id,approval(),'agent-not-assigned'),/assigned to another/);
 p.submitProof('tg:4',next.id,{reference:'NEWREF123',senderName:'Bob'},'next-proof');assert.equal(p.queue('tg:3').length,1);
 p.review('tg:3',next.id,{...approval('NEWREF123'),verifiedRecipient:'1000000000000'},'agent-approval');assert.equal(p.balance('tg:4').available,10000);
 assert.throws(()=>p.addAccount('tg:3',{method:'cbe',account:receiver,holder:'No'},'not-owner'),/Owner access/);
 p.setAgent('tg:1',{telegramId:'3',enabled:false},'disable-agent');assert.equal(p.role('tg:3'),null);assert.throws(()=>p.queue('tg:3'),/access required/);
 assert.equal(p.methods().methods.find(m=>m.id==='cbe').available,false);
});

test('withdrawals reserve cash only, claims are exclusive, paid and failed transitions are balanced',t=>{
 const {store,payments:p}=fixture(t);store.deposit('tg:2',500000,'sandbox-funds');assert.throws(()=>p.createWithdrawal('tg:2',{method:'telebirr',amount:100,account:'0940646657',holder:'Alice'},'test-cannot-withdraw'),/Insufficient balance/);
 const d=pending(p);p.review('tg:1',d.id,approval(),'fund-wallet');
 const w=p.createWithdrawal('tg:2',{method:'telebirr',amount:6000,account:'0940646657',holder:'Alice'},'withdraw-request');assert.equal(p.balance('tg:2').available,4000);assert.equal(p.balance('tg:2').reserved,6000);
 assert.equal(p.createWithdrawal('tg:2',{method:'telebirr',amount:6000,account:'0940646657',holder:'Alice'},'withdraw-request').id,w.id);
 assert.throws(()=>p.createWithdrawal('tg:2',{method:'cbe',amount:5000,account:receiver,holder:'Alice'},'overdraft'),/Insufficient/);
 p.review('tg:1',w.id,{action:'claim'},'claim-withdrawal');p.setAgent('tg:1',{telegramId:'3',enabled:true},'second-reviewer');
 assert.throws(()=>p.review('tg:3',w.id,{action:'claim'},'other-claim'),/current request/);assert.throws(()=>p.cancel('tg:2',w.id,'cancel-processing'),/no longer/);
 const paid={action:'paid',verifiedReference:'PAYOUT123',verifiedAmount:6000,verifiedRecipient:'0940646657',bankConfirmed:true};assert.throws(()=>p.review('tg:3',w.id,paid,'other-payout'),/assigned reviewer/);
 p.review('tg:1',w.id,paid,'confirm-payout');assert.equal(p.balance('tg:2').reserved,0);assert.equal(p.balance('tg:2').available,4000);assert.throws(()=>p.review('tg:1',w.id,paid,'payout-twice'),/current request/);
 const failed=p.createWithdrawal('tg:2',{method:'cbe',amount:1000,account:receiver,holder:'Alice'},'withdraw-failure');p.review('tg:3',failed.id,{action:'claim'},'claim-failure');assert.throws(()=>p.setAgent('tg:1',{telegramId:'3',enabled:false},'disable-busy'),/Resolve/);
 assert.throws(()=>p.review('tg:3',failed.id,{action:'failed',reason:'Unknown result',fundsNotSent:false},'uncertain-payout'),/no funds were sent/);assert.equal(p.balance('tg:2').reserved,1000);
 p.review('tg:3',failed.id,{action:'failed',reason:'Transfer was declined',fundsNotSent:true},'failed-payout');assert.equal(p.balance('tg:2').available,4000);assert.equal(p.balance('tg:2').reserved,0);
 assert.equal(store.db.prepare('SELECT SUM(amount) AS n FROM entries').get().n,0);
});

test('cancellation and rejection release reserved funds once and disallow self review',t=>{
 const {payments:p}=fixture(t);const d=pending(p);p.review('tg:1',d.id,approval(),'fund-wallet');
 const make=key=>p.createWithdrawal('tg:2',{method:'cbe',amount:2000,account:receiver,holder:'Alice'},key);
 const a=make('cancel-me');p.cancel('tg:2',a.id,'cancel-first');assert.equal(p.balance('tg:2').available,10000);assert.throws(()=>p.cancel('tg:2',a.id,'cancel-again'),/no longer/);
 const b=make('reject-me');p.review('tg:1',b.id,{action:'reject',reason:'Incorrect account details'},'reject-first');assert.equal(p.balance('tg:2').available,10000);
 const self=pending(p,'tg:1','9999');assert.throws(()=>p.review('tg:1',self.id,approval('FT9999ABC'),'self-approval'),/own payment/);
});

test('HTTP payment routes enforce authentication, reviewer roles, receipt privacy and request size',async t=>{
 const {store,config}=fixture(t);const server=createApp(config,store);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const base=`http://127.0.0.1:${server.address().port}`;
 store.session('tg:2','alice-token');store.session('tg:4','bob-token');store.session('tg:1','owner-token');
 const send=(path,data,token='alice-token',key='http-request')=>fetch(base+path,{method:data===undefined?'GET':'POST',headers:{Authorization:`Bearer ${token}`,...(data===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},body:data===undefined?undefined:JSON.stringify(data)});
 assert.equal((await fetch(base+'/api/payments')).status,401);assert.equal((await send('/api/admin/payments')).status,403);
 const d=await(await send('/api/payments/deposits',{method:'cbe',amount:10000})).json();assert.equal(d.receiver_account,receiver);
 assert.equal((await send(`/api/payments/${d.id}/proof`,{senderName:'Alice',receipt:image},'alice-token','http-proof')).status,200);
 assert.equal((await send(`/api/payments/${d.id}/receipt`)).status,200);assert.equal((await send(`/api/payments/${d.id}/receipt`,undefined,'bob-token')).status,404);
 assert.equal((await send(`/api/admin/payments/${d.id}/review`,approval(),'alice-token','illegal-review')).status,403);
 assert.equal((await send(`/api/admin/payments/${d.id}/review`,approval(),'owner-token','valid-review')).status,200);
 assert.equal((await(await send('/api/payments')).json()).wallet.available,10000);
 assert.equal((await send('/api/payments/deposits',{method:'cbe',amount:100,extra:'x'.repeat(17000)},'alice-token','large-request')).status,413);
});

test('simple deposit decisions use stored details, support screenshots and remain duplicate-safe',t=>{
 const {payments:p}=fixture(t);const a=pending(p);
 const approved=p.review('tg:1',a.id,{action:'approve'},'simple-approve');assert.equal(approved.status,'approved');assert.equal(p.balance('tg:2').available,10000);
 assert.deepEqual(p.review('tg:1',a.id,{action:'approve'},'simple-approve'),approved);
 assert.throws(()=>p.review('tg:1',a.id,{action:'approve'},'second-approve'),/current request/);
 const screenshot=pending(p,'tg:4','shot1',image);p.review('tg:1',screenshot.id,{action:'approve'},'approve-shot');assert.equal(p.row(screenshot.id).reference,null);assert.equal(p.balance('tg:4').available,10000);
 const duplicate=pending(p,'tg:2','shot2',image);assert.throws(()=>p.review('tg:1',duplicate.id,{action:'approve'},'approve-duplicate'),/receipt was already used/);
 const rejected=p.review('tg:1',duplicate.id,{action:'reject'},'simple-reject');assert.equal(rejected.status,'rejected');assert.equal(p.balance('tg:2').available,10000);
 const repeated=pending(p,'tg:4','0001');assert.throws(()=>p.review('tg:1',repeated.id,{action:'approve'},'duplicate-ref'),/already used/);
 assert.throws(()=>p.review('tg:4',repeated.id,{action:'approve'},'unauthorized-simple'),/access required/);
 assert.equal(p.auditFor('tg:1',screenshot.id).at(-1).details.confirmation,'Reviewer approved receipt of funds');
});

test('withdrawal needs a valid destination but no account-holder name',t=>{
 const {payments:p}=fixture(t);const d=pending(p);p.review('tg:1',d.id,{action:'approve'},'fund-no-name');
 assert.throws(()=>p.createWithdrawal('tg:2',{method:'cbe',amount:2000,account:''},'missing-destination'),/account|number/i);
 const w=p.createWithdrawal('tg:2',{method:'telebirr',amount:2000,account:'0940646657'},'no-name-request');assert.equal(w.holder,null);assert.equal(w.destination,'+251940646657');assert.equal(p.balance('tg:2').reserved,2000);assert.equal(p.balance('tg:2').available,8000);
 assert.equal(p.createWithdrawal('tg:2',{method:'telebirr',amount:2000,account:'0940646657'},'no-name-request').id,w.id);
});

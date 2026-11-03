import test from 'node:test';
import assert from 'node:assert/strict';
import { openTestStore } from './helpers/database.js';
import { Dashboard, dashboardPeriods } from '../src/dashboard.js';
import { Broadcasts } from '../src/broadcasts.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
const config = readConfig({ PAYMENT_ADMIN_TELEGRAM_IDS:'1' });

test('Ethiopian calendar boundaries handle midnight, Monday, year and leap month', () => {
 const p = dashboardPeriods(new Date('2026-11-02T21:05:00Z'));
 assert.equal(p.daily.start,'2026-11-02T21:00:00.000Z');
 assert.equal(p.weekly.start,'2026-11-01T21:00:00.000Z');
 assert.equal(p.monthly.start,'2026-10-31T21:00:00.000Z');
 assert.equal(dashboardPeriods(new Date('2026-12-31T22:00:00Z')).yearly.start,'2026-12-31T21:00:00.000Z');
 assert.equal(dashboardPeriods(new Date('2024-02-29T12:00:00Z')).monthly.end,'2024-02-29T21:00:00.000Z');
});

test('dashboard deduplicates audience, maps payment states, totals wagers and enforces owner access', async t => {
 const store = await openTestStore(); t.after(() => store.close());
 await store.register('tg:1','Owner'); await store.register('tg:2','Alice');
 await store.user('tg:3','Legacy');
 const broadcasts = new Broadcasts(store,config); await broadcasts.initialize();
 await broadcasts.track({from:{id:4,first_name:'Guest'},chat:{id:4,type:'private'},text:'/start'});
 await store.db.prepare('UPDATE audience_join_dates SET joined_at=? WHERE user_id=?').run('2026-11-02T21:00:00.000Z','tg:2');
 await store.db.prepare('UPDATE audience_join_dates SET joined_at=? WHERE user_id=?').run('2026-10-31T20:59:59.000Z','tg:1');
 await store.db.prepare('UPDATE audience_join_dates SET joined_at=? WHERE user_id=?').run('2026-11-02T20:59:59.000Z','tg:4');
 await store.saveTelegramContact({from:{id:2},chat:{id:2,type:'private'},contact:{user_id:2,phone_number:'251911111111'}});
 for (const [i,status] of ['draft','pending','processing','approved','paid','rejected','cancelled','failed'].entries()) {
  for (const kind of ['deposit','withdrawal']) await store.db.prepare('INSERT INTO payment_requests(id,user_id,kind,method,amount,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(`${kind}-${i}`,'tg:2',kind,'cbe',100,status,'2026-11-03T01:00:00.000Z','2026-11-03T01:00:00.000Z');
 }
 await store.db.prepare("INSERT INTO rounds VALUES('round1','tg:2','keno',300,'loss',0)").run();
 await store.db.prepare("INSERT INTO rounds VALUES('round2','tg:2','keno',700,'refund',700)").run();
 await store.db.prepare("INSERT INTO aviator_bets(bet_id,user_id,round_id,stake,status) VALUES('bet1','tg:2','r',400,'settled')").run();
 await store.db.prepare("INSERT INTO chicken_road_bets(bet_id,user_id,round_id,stake,status) VALUES('bet2','tg:2','r',500,'open')").run();
 const service = new Dashboard(store,config);
 await assert.rejects(service.read('tg:2'),{status:403});
 const result = await service.read('tg:1',{},new Date('2026-11-03T12:00:00Z'));
 assert.equal(result.totals.users,4); assert.equal(result.totals.unknown,1);
 assert.equal(result.periods.daily.joined,1); assert.equal(result.periods.weekly.joined,2);
 assert.equal(result.periods.yearly.joined,3);
 assert.deepEqual(result.periods.daily.deposits,{total:8,completed:2,pending:3,canceled:3});
 assert.deepEqual(result.periods.daily.withdrawals,result.periods.daily.deposits);
 const alice=result.users.find(u=>u.id==='tg:2'); assert.equal(alice.total_wager,1200); assert.equal(alice.phone,'+251911111111');
 assert.equal((await service.read('tg:1',{query:'911111111'})).matched,1);
 assert.equal((await service.read('tg:1',{query:'%'})).matched,0);
 assert.equal((await service.read('tg:1',{page:2})).users.length,0);
 const joined=(await store.db.prepare('SELECT joined_at FROM audience_join_dates WHERE user_id=?').get('tg:4')).joined_at;
 await broadcasts.track({from:{id:4},chat:{id:4,type:'private'},text:'/start'});
 assert.equal((await store.db.prepare('SELECT joined_at FROM audience_join_dates WHERE user_id=?').get('tg:4')).joined_at,joined);
});

test('dashboard HTTP denies guests, customers and payment agents', async t => {
 const store=await openTestStore();
 for(const id of ['1','2','3']) {await store.register(`tg:${id}`,id);await store.session(`tg:${id}`,`token-${id}`);}
 await store.db.prepare('INSERT INTO payment_agents VALUES(?,?,?,?)').run('tg:3',1,'tg:1',new Date().toISOString());
 const server=await createApp(config,store);await new Promise(r=>server.listen(0,'127.0.0.1',r));await server.stopBroadcasts();
 t.after(async()=>{await new Promise(r=>server.close(r));await store.close();});
 const url=`http://127.0.0.1:${server.address().port}/api/admin/dashboard`;
 assert.equal((await fetch(url)).status,401);
 for(const id of ['2','3'])assert.equal((await fetch(url,{headers:{Authorization:`Bearer token-${id}`}})).status,403);
 assert.equal((await fetch(url,{headers:{Authorization:'Bearer token-1'}})).status,200);
 assert.equal((await fetch(url+'?page=-1',{headers:{Authorization:'Bearer token-1'}})).status,400);
});

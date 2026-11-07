import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {Store} from '../src/store.js';
import {Crash} from '../src/crash.js';

test('history colors include exact multiplier boundaries',async()=>{
 const scope={};vm.runInNewContext(await readFile(new URL('../public/crash.js',import.meta.url),'utf8'),scope);
 for(const [n,color] of [[100,'red'],[199,'red'],[200,'yellow'],[499,'yellow'],[500,'green'],[999,'green'],[1000,'magenta'],[2221,'magenta']])assert.equal(scope.resultColor(n),`result-${color}`);
});
test('recent wins show only profitable cash payouts, exclude private identity and old or test results',async t=>{
 const store=await Store.open(':memory:');t.after(()=>store.close());await store.user('tg:123','Private Name');
 const now=Date.now();const crash=new Crash(store,()=>now,'cash');
 const fixtures=[['flight','azmera-flight:cash',now,100000,'paid',400],['jet','azmera-jet:cash',now,150000,'paid',400],['test','azmera-flight',now,200000,'paid',400],['small','azmera-jet:cash',now,99999,'paid',400],['refund','azmera-jet:cash',now,200000,'cancelled',400],['old','azmera-flight:cash',now-86400001,200000,'paid',400],['no-profit','azmera-jet:cash',now,200000,'paid',200000]];
 for(const [id,game,time,payout,status,stake] of fixtures){
  await store.db.prepare('INSERT INTO crash_rounds VALUES(?,?,?,?,?,?,?,?,?)').run(id,game,'seed','commitment',200,time,time,time+1000,'finished');
  await store.db.prepare('INSERT INTO crash_bets VALUES(?,?,?,?,?,?,?,?,?)').run(id,id,'tg:123',1,stake,0,status,payout,2221);
 }
 const wins=await crash.recentWins();assert.deepEqual(wins.map(w=>w.id).sort(),['flight','jet']);
 assert.ok(wins.every(w=>!w.gameId.includes(':cash')));assert.ok(!JSON.stringify(wins).includes('Private Name'));assert.ok(!JSON.stringify(wins).includes('tg:123'));
});

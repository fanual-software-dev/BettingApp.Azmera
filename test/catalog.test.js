import test from 'node:test';
import assert from 'node:assert/strict';
import { games } from '../src/providers.js';
import { Store } from '../src/store.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';

test('catalog has 30 unique games and unconnected titles cannot launch or accept a bet', async t => {
 assert.equal(games.length, 30); assert.equal(new Set(games.map(g=>g.id)).size,30);
 assert.ok(games.some(g=>g.name==='Safari Simba'));
 const store=new Store(':memory:');const server=createApp(readConfig({ALLOW_LOCAL_LOGIN:'true'}),store);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));store.close();});
 const base=`http://127.0.0.1:${server.address().port}`;
 store.user('qa','QA');store.session('qa','qa-session');store.deposit('qa',1000,'initial-funds');
 for(const route of ['/api/games/launch','/api/sandbox/bets']){
  const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer qa-session','Idempotency-Key':'unconnected-bet'},body:JSON.stringify({gameId:'safari-simba',amount:100})});
  assert.equal(response.status,503);
 }
 assert.equal(store.balance('qa').available,1000);
 for(const game of games.filter(g=>g.artwork)){
  const response=await fetch(base+game.artwork);assert.equal(response.status,200,game.artwork);assert.match(response.headers.get('content-type'),/^image\//);
 }
});

import { openTestStore } from './helpers/database.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { games } from '../src/providers.js';
import { Store } from '../src/store.js';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/server.js';
test('catalog includes originals, guest viewing is private, and betting still requires authentication', async (t) => {
    assert.equal(games.length, 32);
    assert.equal(new Set(games.map(g => g.id)).size, 32);
    assert.ok(games.some(g => g.name === 'Safari Simba'));
    const store = await openTestStore();
    const server = (await createApp(readConfig({ ALLOW_LOCAL_LOGIN: 'true' }), store));
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    t.after(async () => { server.closeEventStreams(); await server.stopBroadcasts(); await new Promise(r => server.close(r)); (await store.close()); });
    const base = `http://127.0.0.1:${server.address().port}`;
    (await store.user('qa', 'QA'));
    (await store.session('qa', 'qa-session'));
    (await store.deposit('qa', 1000, 'initial-funds'));
    const catalog=await (await fetch(base+'/api/config')).json();
    assert.deepEqual(catalog.gameBadges.games['azmera-flight'],['new','hot']);
    for(const id of ['azmera-flight','azmera-jet']) {
        const response=await fetch(base+`/api/watch/${id}`);
        assert.equal(response.status,200);
        const state=await response.json();
        assert.equal(state.wallet,null);
        assert.deepEqual(state.bets,[]);
        assert.ok(state.round.commitment);
        assert.equal(state.round.seed,undefined);
        const bet=await fetch(base+`/api/crash/${id}/bet`,{method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':'guest-attempt'},body:JSON.stringify({roundId:state.round.id,amount:400,slot:1})});
        assert.equal(bet.status,401);
    }
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM users').get()).n,1);
    assert.equal((await store.db.prepare('SELECT COUNT(*) AS n FROM crash_bets').get()).n,0);
    for (const route of ['/api/games/launch', '/api/sandbox/bets']) {
        const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer qa-session', 'Idempotency-Key': 'unconnected-bet' }, body: JSON.stringify({ gameId: 'safari-simba', amount: 100 }) });
        assert.equal(response.status, 503);
    }
    assert.equal((await store.balance('qa')).available, 1000);
    for (const game of games.filter(g => g.artwork)) {
        const response = await fetch(base + game.artwork);
        assert.equal(response.status, 200, game.artwork);
        assert.match(response.headers.get('content-type'), /^image\//);
    }
});

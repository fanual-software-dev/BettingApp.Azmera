import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fail } from './store.js';
import { crashRules as rules } from './game-rules.js';
const hash = value => createHash('sha256').update(value).digest('hex');
export function crashPoint(seed, id) {
  const value = BigInt('0x' + hash(`${seed}:${id}:azmera-crash-v1`).slice(0,13));
  const space = 1n << 52n;
  return Math.max(100, Math.min(10000000, Number(9500n * space / (100n * (space-value)))));
}
export class Crash {
  constructor(store, clock = () => Date.now(), mode = 'demo') { this.store=store; this.db=store.db; this.clock=clock; this.mode=mode; }
  game(id) { if (!['azmera-flight','azmera-jet'].includes(id)) fail('Unknown original game',404); return this.mode==='cash'?`${id}:cash`:id; }
  async initialize() {
    for(const kind of ['available','reserved']) await this.db.prepare("INSERT OR IGNORE INTO accounts(id,kind) VALUES(?,'house')").run(`cash:crash_${kind}`);
    await this.db.prepare("INSERT OR IGNORE INTO crash_controls VALUES('cash',1)").run();
  }
  async bankroll() {
    const rows=await this.db.prepare("SELECT id,balance FROM accounts WHERE id IN ('cash:crash_available','cash:crash_reserved')").all();
    const values=Object.fromEntries(rows.map(r=>[r.id.split('_').at(-1),r.balance]));
    return {...values,paused:Boolean((await this.db.prepare("SELECT paused FROM crash_controls WHERE id='cash'").get())?.paused ?? 1)};
  }
  async fund(owner,amount,key) {
    return this.store.atomic(`crash-funding:${owner}`,key,{amount},async op=>{
      await this.store.transfer(op,`${owner}:cash_available`,'cash:crash_available',amount);
      return this.bankroll();
    });
  }
  async pause(owner,paused,key) {
    if(typeof paused!=='boolean')fail('Choose pause or resume');
    return this.store.atomic(`crash-control:${owner}`,key,{paused},async()=>{
      if(!paused&&(await this.bankroll()).available<rules.maxPayout)fail('Fund at least 100,000 ETB of house bankroll before resuming',409);
      await this.db.prepare("UPDATE crash_controls SET paused=? WHERE id='cash'").run(paused?1:0);
      return this.bankroll();
    });
  }
  multiplier(round, now=this.clock()) { return Math.max(100,Math.floor(100*Math.exp(rules.growth*Math.max(0,now-round.starts)/1000))); }
  async recentWins() {
    const rows=await this.db.prepare("SELECT b.id,b.payout,b.multiplier,r.game,r.starts FROM crash_bets b JOIN crash_rounds r ON r.id=b.round_id WHERE b.status='paid' AND b.payout>b.stake AND b.payout>=100000 AND r.game IN ('azmera-flight:cash','azmera-jet:cash') AND r.starts>=? ORDER BY r.starts DESC,b.id DESC LIMIT 12").all(this.clock()-86400000);
    return rows.map(row=>({id:row.id,gameId:row.game.replace(':cash',''),payout:row.payout,multiplier:row.multiplier,roundStartedAt:row.starts}));
  }
  async advance(game) {
    game=this.game(game);
    return this.db.transaction(async()=>{
      const now=this.clock();
      let round=await this.db.prepare("SELECT * FROM crash_rounds WHERE game=? AND status='active'").get(game);
      if(round&&this.mode==='cash') {
        const heartbeat=await this.db.prepare('SELECT touched FROM crash_heartbeat WHERE round_id=?').get(round.id);
        if(!heartbeat||now-heartbeat.touched>3000||now<heartbeat.touched) {
          for(const bet of await this.db.prepare("SELECT * FROM crash_bets WHERE round_id=? AND status='open'").all(round.id)) await this.finish(bet,'cancelled',0);
          await this.db.prepare("UPDATE crash_rounds SET status='void',ends=? WHERE id=?").run(now,round.id);
          return {...round,status:'void',ends:now};
        }
        await this.db.prepare('UPDATE crash_heartbeat SET touched=? WHERE round_id=?').run(now,round.id);
      }
      if (round && now>=round.starts) {
        const bets=await this.db.prepare("SELECT * FROM crash_bets WHERE round_id=? AND status='open'").all(round.id);
        for (const bet of bets) {
          const cap=Math.ceil(rules.maxPayout*100/bet.stake);
          const target=bet.auto_at ? Math.min(cap,bet.auto_at) : cap;
          if (target<round.crash && target<=this.multiplier(round,now)) await this.finish(bet,'paid',target);
          else if (now>=round.ends) await this.finish(bet,'lost',0);
        }
        if (now>=round.ends) {await this.db.prepare("UPDATE crash_rounds SET status='finished' WHERE id=?").run(round.id);round.status='finished';}
      }
      if (!round) {
        const previous=await this.db.prepare('SELECT * FROM crash_rounds WHERE game=? ORDER BY opens DESC LIMIT 1').get(game);
        if(previous && now<previous.ends+4000) return previous;
        const id=randomUUID(),seed=randomBytes(32).toString('hex'),crash=crashPoint(seed,id),starts=now+rules.waitingMs;
        round={id,game,seed,commitment:hash(seed),crash,opens:now,starts,ends:starts+Math.ceil(Math.log(crash/100)/rules.growth*1000),status:'active'};
        await this.db.prepare('INSERT INTO crash_rounds VALUES(?,?,?,?,?,?,?,?,?)').run(id,game,seed,round.commitment,crash,now,starts,round.ends,'active');
        if(this.mode==='cash')await this.db.prepare('INSERT INTO crash_heartbeat VALUES(?,?)').run(id,now);
      }
      return round;
    });
  }
  async finish(bet,status,multiplier) {
    const payout=status==='paid'?Math.min(rules.maxPayout,Math.floor(bet.stake*multiplier/100)):status==='cancelled'?bet.stake:0;
    return this.store.atomic('crash-settlement',`settle-${bet.id}`,{id:bet.id,status,multiplier},async op=>{
      const current=await this.db.prepare('SELECT status FROM crash_bets WHERE id=?').get(bet.id);
      if(current.status!=='open') fail('This bet is already settled',409);
      const reserve=await this.db.prepare('SELECT amount FROM crash_reserves WHERE bet_id=?').get(bet.id);
      if(reserve) {
        if(payout) await this.store.transfer(op,'cash:crash_reserved',`${bet.user_id}:cash_available`,payout);
        if(reserve.amount>payout) await this.store.transfer(op,'cash:crash_reserved','cash:crash_available',reserve.amount-payout);
        await this.db.prepare('DELETE FROM crash_reserves WHERE bet_id=?').run(bet.id);
      } else {
        const round=await this.db.prepare('SELECT game FROM crash_rounds WHERE id=?').get(bet.round_id);
        if(round.game.endsWith(':cash'))throw new Error('Cash payout reservation missing');
        if(payout) await this.store.transfer(op,'sandbox:house',`${bet.user_id}:available`,payout);
      }
      await this.db.prepare('UPDATE crash_bets SET status=?,payout=?,multiplier=? WHERE id=?').run(status,payout,multiplier,bet.id);
      return {id:bet.id,status,payout,multiplier};
    });
  }
  async state(user,game) {
    const round=await this.advance(game),now=this.clock();
    const finished=round.status!=='active';
    const history=await this.db.prepare("SELECT id,crash,seed,commitment,status FROM crash_rounds WHERE game=? AND status<>'active' ORDER BY opens DESC LIMIT 20").all(this.game(game));
    const bets=user?await this.db.prepare('SELECT id,slot,stake,status,payout,multiplier,auto_at FROM crash_bets WHERE round_id=? AND user_id=? ORDER BY slot').all(round.id,user):[];
    const participants=await this.db.prepare("SELECT stake,status,payout,multiplier FROM crash_bets WHERE round_id=? AND status<>'cancelled' ORDER BY id LIMIT 100").all(round.id);
    const cash=this.mode==='cash';
    const wallet=!user?null:cash?{available:(await this.db.prepare("SELECT balance FROM accounts WHERE id=?").get(`${user}:cash_available`))?.balance||0}:await this.store.balance(user);
    return {mode:this.mode,paused:cash?(await this.bankroll()).paused:false,rules,now,round:{id:round.id,starts:round.starts,phase:round.status==='void'?'void':finished?'crashed':now<round.starts?'waiting':'flying',multiplier:round.status==='void'?100:finished?round.crash:this.multiplier(round,now),commitment:round.commitment,...(finished?{seed:round.seed}: {})},bets,participants,history,wallet};
  }
  async place(user,game,data,key) {
    if(this.mode==='cash'&&data.acceptCash!==true)fail('Confirm that this bet uses real ETB from your cash wallet');
    await this.advance(game);
    if(!Number.isSafeInteger(data.amount)||data.amount<rules.minStake||data.amount>rules.maxStake) fail('Stake must be between 4 and 4,000 ETB');
    if(![1,2].includes(data.slot)) fail('Only two bet slots are available');
    const auto=data.autoAt||0;
    if(!Number.isSafeInteger(auto)||(auto!==0&&(auto<101||auto>10000000))) fail('Auto cash-out must be at least 1.01x');
    return this.store.atomic(`crash:${user}`,key,{game,round:data.roundId,slot:data.slot,amount:data.amount,auto},async op=>{
      if(this.mode==='cash'&&(await this.bankroll()).paused)fail('Cash betting is paused',503);
      const round=await this.db.prepare("SELECT * FROM crash_rounds WHERE id=? AND game=? AND status='active'").get(data.roundId,this.game(game));
      if(!round||this.clock()>=round.starts) fail('Betting has closed for this round',409);
      if(await this.db.prepare("SELECT id FROM crash_bets WHERE round_id=? AND user_id=? AND slot=? AND status<>'cancelled'").get(round.id,user,data.slot)) fail('This slot already has a bet',409);
      if(this.mode==='cash') {
        await this.store.transfer(op,`${user}:cash_available`,'cash:crash_available',data.amount);
        const bankroll=await this.bankroll();
        if(bankroll.available<rules.maxPayout)fail('House payout capacity is full; try a later round',409);
        await this.store.transfer(op,'cash:crash_available','cash:crash_reserved',rules.maxPayout);
      } else await this.store.transfer(op,`${user}:available`,'sandbox:house',data.amount);
      const id=randomUUID();
      await this.db.prepare("INSERT INTO crash_bets(id,round_id,user_id,slot,stake,auto_at,status) VALUES(?,?,?,?,?,?,'open')").run(id,round.id,user,data.slot,data.amount,auto);
      if(this.mode==='cash')await this.db.prepare('INSERT INTO crash_reserves VALUES(?,?)').run(id,rules.maxPayout);
      return {id,status:'open'};
    });
  }
  async act(user,game,id,action) {
    await this.advance(game);
    return this.db.transaction(async()=>{
      const bet=await this.db.prepare('SELECT * FROM crash_bets WHERE id=? AND user_id=?').get(id,user);
      if(!bet) fail('Bet not found',404);
      const round=await this.db.prepare('SELECT * FROM crash_rounds WHERE id=? AND game=?').get(bet.round_id,this.game(game));
      if(!round) fail('Bet not found',404);
      if(bet.status!=='open') return {id:bet.id,status:bet.status,payout:bet.payout};
      const now=this.clock();
      if(action==='cancel'&&now<round.starts) return this.finish(bet,'cancelled',0);
      if(action==='cashout'&&now>=round.starts&&now<round.ends) return this.finish(bet,'paid',this.multiplier(round,now));
      fail('This action is unavailable for the current round',409);
    });
  }
}

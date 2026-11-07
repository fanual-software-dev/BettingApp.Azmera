import test from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import {Store} from '../src/store.js';
import {Feedback} from '../src/feedback.js';
import {createApp} from '../src/server.js';
import {readConfig} from '../src/config.js';
const input={subject:'Game suggestion',message:'Please add more game history.',email:'player@example.com'};
test('feedback delivers through Nodemailer to fixed owner inbox, deduplicates and limits sending',async t=>{
 const store=await Store.open(':memory:');t.after(()=>store.close());const user=await store.user('tg:1','Player');
 const mailer=nodemailer.createTransport({streamTransport:true,buffer:true,newline:'unix'});const sent=[];
 const feedback=new Feedback(store,{from:'sender@example.com'},{async sendMail(mail){sent.push(await mailer.sendMail(mail));return {accepted:['asfawfanual2003@gmail.com']};}});
 const result=await feedback.send(user,{...input,to:'attacker@example.com'},'feedback-one');assert.equal(result.status,'sent');
 const raw=sent[0].message.toString();assert.match(raw,/To: asfawfanual2003@gmail.com/);assert.match(raw,/Reply-To: player@example.com/);assert.match(raw,/Please add more game history/);assert.ok(!raw.includes('attacker@example.com'));
 await feedback.send(user,input,'feedback-one');assert.equal(sent.length,1);
 await assert.rejects(feedback.send(user,{...input,subject:'different'},'feedback-one'),/already used/);
 await assert.rejects(feedback.send(user,{...input,subject:'bad\r\nBcc: test@example.com'},'bad-subject'),/subject/);
 for(let i=0;i<4;i++)await feedback.send(user,input,`feedback-more-${i}`);
 await assert.rejects(feedback.send(user,input,'feedback-over-limit'),/five feedback/);
});
test('feedback failure is persisted without leaking SMTP credentials or claiming success',async t=>{
 const store=await Store.open(':memory:');t.after(()=>store.close());const user=await store.user('tg:1','Player');
 await assert.rejects(new Feedback(store,{}).send(user,input,'not-configured'),/not configured/);
 const feedback=new Feedback(store,{from:'sender@example.com'},{async sendMail(){throw new Error('smtp-password-secret');}});
 await assert.rejects(feedback.send(user,input,'failed-message'),error=>error.status===503&&!error.message.includes('secret'));
 assert.equal((await store.db.prepare('SELECT status FROM feedback_messages').get()).status,'failed');
});
test('game rules require owner role and feedback requires a session',async t=>{
 const store=await Store.open(':memory:');const server=await createApp(readConfig({PAYMENT_ADMIN_TELEGRAM_IDS:'1'}),store);
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await server.stopBroadcasts();await new Promise(r=>server.close(r));await store.close();});
 for(const id of ['1','2']){await store.user(`tg:${id}`,'User');await store.session(`tg:${id}`,`token-${id}`);}
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/api/admin/game-rules')).status,401);
 assert.equal((await fetch(base+'/api/admin/game-rules',{headers:{Authorization:'Bearer token-2'}})).status,403);
 const result=await fetch(base+'/api/admin/game-rules',{headers:{Authorization:'Bearer token-1'}});assert.equal(result.status,200);assert.match((await result.json()).text,/100,000 ETB/);
 assert.equal((await fetch(base+'/api/feedback',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)})).status,401);
});

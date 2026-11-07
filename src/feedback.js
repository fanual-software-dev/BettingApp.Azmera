import { smtpTransport } from './email.js';
import { randomUUID } from 'node:crypto';
import { fail } from './store.js';

export class Feedback {
  constructor(store, settings, transport) {
    this.db=store.db;this.settings=settings;
    this.transport=transport || smtpTransport(settings);
  }
  async send(user,data,key) {
    if(!this.transport)fail('Feedback email is not configured yet. Please try again later.',503);
    if(typeof key!=='string'||! /^[A-Za-z0-9_-]{8,100}$/.test(key))fail('Invalid feedback request ID');
    const subject=typeof data.subject==='string'?data.subject.trim():'';
    const message=typeof data.message==='string'?data.message.trim():'';
    const email=typeof data.email==='string'?data.email.trim():'';
    if(subject.length<3||subject.length>120||/[\r\n]/.test(subject))fail('Enter a subject of 3–120 characters');
    if(message.length<10||message.length>5000)fail('Enter a message of 10–5,000 characters');
    if(email&&(email.length>254||! /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)))fail('Enter a valid reply email');
    const claim=await this.db.transaction(async()=>{
      const old=await this.db.prepare('SELECT * FROM feedback_messages WHERE user_id=? AND request_key=?').get(user.id,key);
      if(old){if(old.subject!==subject||old.message!==message||old.email!==email)fail('This request ID was already used',409);return {row:old,send:false};}
      const count=await this.db.prepare('SELECT COUNT(*) AS n FROM feedback_messages WHERE user_id=? AND created_at>?').get(user.id,Date.now()-3600000);
      if(count.n>=5)fail('You can send up to five feedback messages per hour.',429);
      const row={id:randomUUID(),status:'sending'};
      await this.db.prepare('INSERT INTO feedback_messages VALUES(?,?,?,?,?,?,?,?,?)').run(row.id,user.id,key,subject,message,email,row.status,Date.now(),'');
      return {row,send:true};
    });
    if(!claim.send){if(claim.row.status==='failed')fail('Email was not confirmed. Please submit a new request to try again.',503);return {id:claim.row.id,status:claim.row.status};}
    try {
      const result=await this.transport.sendMail({from:this.settings.from,to:'asfawfanual2003@gmail.com',...(email?{replyTo:email}:{}),subject:`Azmera feedback: ${subject}`,messageId:`<${claim.row.id}@feedback.azmera>`,text:`Azmera Bet feedback\nReference: ${claim.row.id}\nUser: ${user.name} (${user.id})\nReply email: ${email||'Not provided'}\n\n${message}`});
      if(!result.accepted?.some(address=>String(address).toLowerCase()==='asfawfanual2003@gmail.com'))throw new Error('Recipient not accepted');
    }catch{
      await this.db.prepare("UPDATE feedback_messages SET status='failed' WHERE id=?").run(claim.row.id);
      fail('Email delivery could not be confirmed. Your message is saved; please try again later.',503);
    }
    await this.db.prepare("UPDATE feedback_messages SET status='sent',sent_at=? WHERE id=?").run(new Date().toISOString(),claim.row.id);
    return {id:claim.row.id,status:'sent'};
  }
}

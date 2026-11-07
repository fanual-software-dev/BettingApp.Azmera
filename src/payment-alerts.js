import { smtpTransport, ownerInbox } from './email.js';
export async function queuePaymentAlert(db,row) {
  const user=await db.prepare('SELECT name FROM users WHERE id=?').get(row.user_id);
  const payload={requestId:row.id,kind:row.kind,amount:row.amount,method:row.method,userId:row.user_id,name:user?.name||'Player',submittedAt:new Date().toISOString()};
  await db.prepare("INSERT OR IGNORE INTO payment_alerts(request_id,payload,status,attempts,retry_at,lease_until) VALUES(?,?,'pending',0,0,0)").run(row.id,JSON.stringify(payload));
}
export class PaymentAlerts {
  constructor(store,config,transport) {this.db=store.db;this.config=config;this.transport=transport||smtpTransport(config.smtp);}
  async tick() {
    if(!this.transport||this.config.paymentEmailAlerts===false)return;
    const row=await this.db.transaction(async()=>{
      const now=Date.now();
      const item=await this.db.prepare("SELECT * FROM payment_alerts WHERE (status='pending' AND retry_at<=?) OR (status='sending' AND lease_until<?) ORDER BY retry_at,request_id LIMIT 1").get(now,now);
      if(!item)return null;
      await this.db.prepare("UPDATE payment_alerts SET status='sending',attempts=attempts+1,lease_until=? WHERE request_id=?").run(now+120000,item.request_id);
      return {...item,attempts:item.attempts+1};
    });
    if(!row)return;
    try{
      const p=JSON.parse(row.payload),amount=(p.amount/100).toFixed(2),kind=p.kind==='deposit'?'Deposit':'Withdrawal';
      const result=await this.transport.sendMail({from:this.config.smtp.from,to:ownerInbox,messageId:`<payment-${row.request_id}@alerts.azmera>`,subject:`Azmera: ${kind} request — ${amount} ETB`,text:`New ${kind.toLowerCase()} request\n\nPlayer: ${p.name} (${p.userId})\nAmount: ${amount} ETB\nMethod: ${p.method.toUpperCase()}\nSubmitted: ${p.submittedAt}\nRequest ID: ${p.requestId}\n\nOpen Payment review in Azmera: ${this.config.publicUrl}\n\nThis is a submission alert, not payment verification. Check the current request status before acting.`});
      if(!result.accepted?.some(a=>String(a).toLowerCase()===ownerInbox))throw new Error('Recipient not accepted');
      await this.db.prepare("UPDATE payment_alerts SET status='sent',lease_until=0 WHERE request_id=?").run(row.request_id);
    }catch{
      await this.db.prepare('UPDATE payment_alerts SET status=?,retry_at=?,lease_until=0 WHERE request_id=?').run(row.attempts>=10?'failed':'pending',Date.now()+Math.min(900000,5000*2**Math.min(row.attempts,8)),row.request_id);
    }
  }
}

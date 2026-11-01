import { randomUUID, createHash } from 'node:crypto';
import { fail, money } from './store.js';

const now = () => new Date().toISOString();
const summaryColumns = 'id,user_id,kind,method,amount,status,receiver_id,receiver_account,receiver_holder,agent_id,destination,holder,reference,reviewer_id,reason,created_at,updated_at,receipt IS NOT NULL AS hasReceipt';
function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) fail(`${label} is required (maximum ${max} characters)`);
  return value.trim();
}
function reference(value) {
  const raw = text(value, 'Transaction reference', 100);
  if (!/^[a-zA-Z0-9 -]+$/.test(raw)) fail('Use the transaction ID, not a URL or message');
  const normalized = raw.toUpperCase().replace(/[ -]/g, '');
  if (normalized.length < 6 || normalized.length > 80) fail('Transaction ID must contain 6 to 80 letters or digits');
  return normalized;
}
function destination(method, value) {
  const raw = text(value, 'Account or phone number', 24).replace(/[ -]/g, '');
  if (method === 'cbe' && /^\d{10,16}$/.test(raw)) return raw;
  if (method === 'telebirr' && /^(?:0[79]\d{8}|(?:\+?251)[79]\d{8})$/.test(raw)) return raw.startsWith('0') ? '+251' + raw.slice(1) : '+' + raw.replace(/^\+/, '');
  fail('Enter a valid CBE account or Ethiopian Telebirr number');
}
function receipt(value) {
  if (!value) return null;
  if (!['image/png', 'image/jpeg'].includes(value.type) || typeof value.base64 !== 'string' || value.base64.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64)) fail('Upload a PNG or JPEG receipt up to 2 MB');
  const bytes = Buffer.from(value.base64, 'base64');
  if (bytes.length < 24 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== value.base64) fail('Invalid receipt or file larger than 2 MB');
  if (value.type === 'image/png') {
    if (!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) || bytes.toString('ascii',12,16) !== 'IHDR') fail('Invalid PNG receipt');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 16_000_000) fail('Receipt image is too large');
  } else if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) fail('Invalid JPEG receipt');
  return { bytes, type: value.type, hash: createHash('sha256').update(bytes).digest('hex') };
}

export class Payments {
  constructor(store, config) {
    this.store = store; this.db = store.db; this.settings = config.payments || { enabled: false, admins: [], methods: [] };
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS payment_agents(user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receiving_accounts(id TEXT PRIMARY KEY, method TEXT NOT NULL, account TEXT NOT NULL, holder TEXT NOT NULL, agent_id TEXT, active INTEGER NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_receiver ON receiving_accounts(method) WHERE active=1;
      CREATE TABLE IF NOT EXISTS payment_requests(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, method TEXT NOT NULL, amount INTEGER NOT NULL CHECK(amount>0), status TEXT NOT NULL, receiver_id TEXT, receiver_account TEXT, receiver_holder TEXT, agent_id TEXT, destination TEXT, holder TEXT, reference TEXT, receipt BLOB, receipt_type TEXT, receipt_hash TEXT, reviewer_id TEXT, reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS payment_user_history ON payment_requests(user_id,created_at);
      CREATE TABLE IF NOT EXISTS verified_payment_references(method TEXT NOT NULL, direction TEXT NOT NULL, reference TEXT NOT NULL, request_id TEXT NOT NULL REFERENCES payment_requests(id), PRIMARY KEY(method,direction,reference));
      CREATE TABLE IF NOT EXISTS payment_audit(id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, actor_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL);
    `);
    for (const method of this.settings.methods) {
      if (method.account && method.holder && !this.db.prepare('SELECT id FROM receiving_accounts WHERE method=? LIMIT 1').get(method.id)) {
        this.db.prepare('INSERT INTO receiving_accounts VALUES(?,?,?,?,?,1,?,?)').run(randomUUID(), method.id, destination(method.id,method.account), method.holder, null, 'configuration', now());
      }
    }
    for (const method of ['cbe','telebirr']) this.db.prepare('INSERT OR IGNORE INTO accounts(id,kind) VALUES(?,?)').run(`cash:clearing:${method}`, 'system');
  }
  role(id) {
    if (this.settings.admins.includes(id)) return 'owner';
    return this.db.prepare('SELECT user_id FROM payment_agents WHERE user_id=? AND enabled=1').get(id) ? 'agent' : null;
  }
  requireAdmin(id) { if (!this.role(id)) fail('Payment review access required',403); }
  requireOwner(id) { if (this.role(id) !== 'owner') fail('Owner access required',403); }
  method(id) { if (!['cbe','telebirr'].includes(id)) fail('Select CBE or Telebirr'); return id; }
  ensureEnabled() { if (!this.settings.enabled) fail('Deposits and withdrawals are not enabled yet',503); }
  ensureAccounts(id) {
    for (const kind of ['cash_available','cash_reserved']) this.db.prepare('INSERT OR IGNORE INTO accounts(id,user_id,kind) VALUES(?,?,?)').run(`${id}:${kind}`,id,kind);
  }
  balance(id) {
    const rows = this.db.prepare("SELECT kind,balance FROM accounts WHERE user_id=? AND kind IN ('cash_available','cash_reserved')").all(id);
    const values = Object.fromEntries(rows.map(r=>[r.kind,r.balance]));
    return {currency:'ETB', available:values.cash_available || 0, reserved:values.cash_reserved || 0};
  }
  methods() {
    return { enabled:this.settings.enabled, methods:['cbe','telebirr'].map(id=>({id,name:id==='cbe'?'Commercial Bank of Ethiopia':'Telebirr',available:this.settings.enabled && Boolean(this.db.prepare('SELECT id FROM receiving_accounts WHERE method=? AND active=1').get(id))})) };
  }
  row(id) { const row=this.db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id); if (!row) fail('Payment request not found',404); return row; }
  view(row) { const {receipt,receipt_type,receipt_hash,...rest}=row; return {...rest,hasReceipt:Boolean(receipt || row.hasReceipt)}; }
  own(id,user) { const row=this.row(id); if(row.user_id!==user) fail('Payment request not found',404); return row; }
  canReview(user,row) { return this.role(user)==='owner' || (this.role(user)==='agent' && (row.kind==='withdrawal' || row.agent_id===user)); }
  audit(id,actor,action,details={}) { this.db.prepare('INSERT INTO payment_audit(request_id,actor_id,action,details,created_at) VALUES(?,?,?,?,?)').run(id,actor,action,JSON.stringify(details),now()); }
  cap(id) {
    if (this.db.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE user_id=? AND status IN ('draft','pending','processing')").get(id).n>=5) fail('Please wait for your pending requests to be reviewed',429);
    if (this.db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE user_id=? AND created_at>?').get(id,new Date(Date.now()-86400000).toISOString()).n>=20) fail('Daily request limit reached',429);
  }
  list(id) { return this.db.prepare(`SELECT ${summaryColumns} FROM payment_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).all(id).map(r=>this.view(r)); }
  createDeposit(user,data,key) {
    this.ensureEnabled(); const method=this.method(data.method), amount=money(data.amount);
    return this.store.atomic(`payments:${user}`,key,{action:'deposit',method,amount},()=>{
      this.cap(user);
      const receiver=this.db.prepare('SELECT * FROM receiving_accounts WHERE method=? AND active=1').get(method);
      if(!receiver || (receiver.agent_id && !this.role(receiver.agent_id))) fail('This receiving account is unavailable',503);
      const id=randomUUID();
      this.db.prepare(`INSERT INTO payment_requests(id,user_id,kind,method,amount,status,receiver_id,receiver_account,receiver_holder,agent_id,created_at,updated_at) VALUES(?,?,'deposit',?,?,'draft',?,?,?,?,?,?)`).run(id,user,method,amount,receiver.id,receiver.account,receiver.holder,receiver.agent_id,now(),now());
      this.audit(id,user,'deposit_created'); return this.view(this.row(id));
    });
  }
  submitProof(user,id,data,key) {
    const ref=data.reference?.trim()?reference(data.reference):null, image=receipt(data.receipt), holder=data.senderName===undefined||data.senderName===''?null:text(data.senderName,'Sender account-holder name');
    if(!ref&&!image) fail('Provide a transaction ID or a receipt screenshot');
    return this.store.atomic(`payments:${user}`,key,{action:'proof',id,ref,holder,receiptHash:image?.hash||null},()=>{
      const row=this.own(id,user); if(row.kind!=='deposit'||row.status!=='draft') fail('This deposit has already been submitted or closed',409);
      if(ref&&this.db.prepare("SELECT id FROM payment_requests WHERE user_id=? AND method=? AND reference=? AND status IN ('pending','approved')").get(user,row.method,ref)) fail('You already submitted this transaction ID',409);
      this.db.prepare("UPDATE payment_requests SET reference=?,receipt=?,receipt_type=?,receipt_hash=?,holder=?,status='pending',updated_at=? WHERE id=?").run(ref,image?.bytes||null,image?.type||null,image?.hash||null,holder,now(),id);
      this.audit(id,user,'proof_submitted',{reference:ref,receiptHash:image?.hash||null}); return this.view(this.row(id));
    });
  }
  createWithdrawal(user,data,key) {
    this.ensureEnabled();const method=this.method(data.method),amount=money(data.amount),account=destination(method,data.account),holder=data.holder===undefined||data.holder===''?null:text(data.holder,'Account-holder name');
    return this.store.atomic(`payments:${user}`,key,{action:'withdrawal',method,amount,account,holder},op=>{
      this.cap(user);this.ensureAccounts(user);this.store.transfer(op,`${user}:cash_available`,`${user}:cash_reserved`,amount);
      const id=randomUUID();this.db.prepare(`INSERT INTO payment_requests(id,user_id,kind,method,amount,status,destination,holder,created_at,updated_at) VALUES(?,?,'withdrawal',?,?,'pending',?,?,?,?)`).run(id,user,method,amount,account,holder,now(),now());
      this.audit(id,user,'withdrawal_requested');return this.view(this.row(id));
    });
  }
  cancel(user,id,key) {
    return this.store.atomic(`payments:${user}`,key,{action:'cancel',id},op=>{
      const row=this.own(id,user);
      if(!(row.kind==='deposit'&&row.status==='draft') && !(row.kind==='withdrawal'&&row.status==='pending')) fail('This request can no longer be cancelled',409);
      if(row.kind==='withdrawal') this.store.transfer(op,`${user}:cash_reserved`,`${user}:cash_available`,row.amount);
      this.db.prepare("UPDATE payment_requests SET status='cancelled',updated_at=? WHERE id=?").run(now(),id);this.audit(id,user,'cancelled');return this.view(this.row(id));
    });
  }
  reserveReference(row,direction,ref) {
    if(this.db.prepare('SELECT request_id FROM verified_payment_references WHERE method=? AND direction=? AND reference=?').get(row.method,direction,ref)) fail('This verified transaction ID was already used',409);
    this.db.prepare('INSERT INTO verified_payment_references VALUES(?,?,?,?)').run(row.method,direction,ref,row.id);
  }
  review(actor,id,data,key) {
    this.requireAdmin(actor); const action=text(data.action,'Review action',20);
    return this.store.atomic(`payment-review:${actor}`,key,{id,...data},op=>{
      const row=this.row(id);if(!this.canReview(actor,row)) fail('This deposit is assigned to another reviewer',403);
      if(row.user_id===actor) fail('You cannot review your own payment request',403);
      let status, details={};
      if(action==='approve' && row.kind==='deposit' && row.status==='pending') {
        const ref=data.verifiedReference?reference(data.verifiedReference):row.reference;
        const recipient=row.receiver_account,sender=row.holder;
        if((data.bankConfirmed!==undefined&&data.bankConfirmed!==true)||(data.verifiedAmount!==undefined&&data.verifiedAmount!==row.amount)||(data.verifiedRecipient!==undefined&&destination(row.method,data.verifiedRecipient)!==recipient)) fail('Confirm receipt in the bank account and match the exact amount and receiving account');
        if(row.reference && row.reference!==ref) fail('Verified transaction ID does not match the submitted ID');
        if(row.receipt_hash && this.db.prepare("SELECT id FROM payment_requests WHERE kind='deposit' AND status='approved' AND receipt_hash=? AND id<>?").get(row.receipt_hash,row.id)) fail('This receipt was already used for an approved deposit',409);
        if(ref)this.reserveReference(row,'incoming',ref);
        this.ensureAccounts(row.user_id);this.store.transfer(op,`cash:clearing:${row.method}`,`${row.user_id}:cash_available`,row.amount);status='approved';details={reference:ref||null,recipient,sender,amount:row.amount,receiptHash:row.receipt_hash||null,confirmation:'Reviewer approved receipt of funds'};
      } else if(action==='claim' && row.kind==='withdrawal' && row.status==='pending') { status='processing'; }
      else if(action==='paid' && row.kind==='withdrawal' && row.status==='processing') {
        if(row.reviewer_id!==actor) fail('Only the assigned reviewer can finish this payout',403);
        const ref=reference(data.verifiedReference);
        if(data.bankConfirmed!==true || data.verifiedAmount!==row.amount || destination(row.method,data.verifiedRecipient)!==row.destination) fail('Confirm the transfer succeeded with the exact destination and amount');
        this.reserveReference(row,'outgoing',ref);this.store.transfer(op,`${row.user_id}:cash_reserved`,`cash:clearing:${row.method}`,row.amount);status='paid';details={reference:ref,amount:row.amount,recipient:row.destination};
      } else if(action==='reject' && row.status==='pending') {
        details={reason:row.kind==='deposit'&&!data.reason?'Deposit rejected by reviewer':text(data.reason,'Reason',300)};status='rejected';
        if(row.kind==='withdrawal')this.store.transfer(op,`${row.user_id}:cash_reserved`,`${row.user_id}:cash_available`,row.amount);
      } else if(action==='failed' && row.kind==='withdrawal' && row.status==='processing') {
        if(row.reviewer_id!==actor || data.fundsNotSent!==true) fail('Only the assigned reviewer can confirm that no funds were sent',403);
        details={reason:text(data.reason,'Failure reason',300),fundsNotSent:true};status='failed';this.store.transfer(op,`${row.user_id}:cash_reserved`,`${row.user_id}:cash_available`,row.amount);
      } else fail('This action is not valid for the current request status',409);
      this.db.prepare('UPDATE payment_requests SET status=?,reviewer_id=?,reason=?,reference=COALESCE(?,reference),updated_at=? WHERE id=?').run(status,actor,details.reason||null,details.reference||null,now(),id);this.audit(id,actor,action,details);return this.view(this.row(id));
    });
  }
  receiptFor(user,id) {const row=this.row(id);if(row.user_id!==user&&!this.canReview(user,row)) fail('Receipt not found',404);if(!row.receipt)fail('Receipt not found',404);return {bytes:row.receipt,type:row.receipt_type};}
  queue(user) {
    this.requireAdmin(user);
    const rows=this.role(user)==='owner'
      ?this.db.prepare(`SELECT ${summaryColumns} FROM payment_requests WHERE status IN ('pending','processing') ORDER BY created_at LIMIT 100`).all()
      :this.db.prepare(`SELECT ${summaryColumns} FROM payment_requests WHERE status IN ('pending','processing') AND (kind='withdrawal' OR agent_id=?) ORDER BY created_at LIMIT 100`).all(user);
    return rows.map(r=>this.view(r));
  }
  auditFor(user,id) {const row=this.row(id);if(!this.canReview(user,row))fail('Review access required',403);return this.db.prepare('SELECT * FROM payment_audit WHERE request_id=? ORDER BY id').all(id).map(r=>({...r,details:JSON.parse(r.details)}));}
  settingsFor(user) {this.requireOwner(user);return {accounts:this.db.prepare('SELECT * FROM receiving_accounts ORDER BY created_at DESC').all(),agents:this.db.prepare('SELECT a.*,u.name FROM payment_agents a JOIN users u ON u.id=a.user_id').all(),users:this.db.prepare("SELECT id,name FROM users WHERE id LIKE 'tg:%' ORDER BY name,id").all().filter(u=>!this.settings.admins.includes(u.id))};}
  setAgent(actor,data,key) {
    this.requireOwner(actor);const id=`tg:${text(data.telegramId,'Telegram user ID',16)}`;
    if(!/^tg:[1-9]\d{0,15}$/.test(id)||!this.db.prepare('SELECT id FROM users WHERE id=?').get(id))fail('The agent must first register in Azmera using Telegram');
    if(this.settings.admins.includes(id))fail('Owner access is managed in server configuration');
    if(typeof data.enabled!=='boolean')fail('Specify whether this agent is enabled');
    return this.store.atomic(`payment-settings:${actor}`,key,{action:'agent',id,enabled:data.enabled},()=>{
      if(!data.enabled && this.db.prepare("SELECT id FROM payment_requests WHERE reviewer_id=? AND status='processing'").get(id))fail('Resolve this agent\'s processing withdrawals before disabling access',409);
      this.db.prepare('INSERT INTO payment_agents VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(id,Number(data.enabled),actor,now());
      if(!data.enabled)this.db.prepare('UPDATE receiving_accounts SET active=0 WHERE agent_id=?').run(id);
      this.audit(id,actor,'agent_access_changed',{enabled:data.enabled});return {ok:true};
    });
  }
  addAccount(actor,data,key) {
    this.requireOwner(actor);const method=this.method(data.method),account=destination(method,data.account),holder=text(data.holder,'Account-holder name');
    const agent=data.agentId?.trim()?`tg:${data.agentId.trim()}`:null;
    if(agent&&!this.role(agent))fail('Assign an enabled agent or leave blank for owner review');
    return this.store.atomic(`payment-settings:${actor}`,key,{action:'receiver',method,account,holder,agent},()=>{
      this.db.prepare('UPDATE receiving_accounts SET active=0 WHERE method=?').run(method);const id=randomUUID();
      this.db.prepare('INSERT INTO receiving_accounts VALUES(?,?,?,?,?,1,?,?)').run(id,method,account,holder,agent,actor,now());this.audit(id,actor,'receiving_account_activated',{method,account,holder,agent});return {ok:true,id};
    });
  }
}

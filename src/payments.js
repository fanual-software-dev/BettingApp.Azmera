import { randomUUID, createHash } from 'node:crypto';
import { fail, money } from './store.js';
import { paymentLimits, ethiopianDay } from './game-rules.js';
import { queuePaymentAlert } from './payment-alerts.js';
import { depositBonus } from './deposit-bonus.js';
const now = () => new Date().toISOString();
const summaryColumns = 'id,user_id,kind,method,amount,status,receiver_id,receiver_account,receiver_holder,agent_id,destination,holder,reference,reviewer_id,reason,created_at,updated_at,receipt IS NOT NULL AS "hasReceipt"';
function text(value, label, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > max)
        fail(`${label} is required (maximum ${max} characters)`);
    return value.trim();
}
function reference(value) {
    const raw = text(value, 'Transaction reference', 100);
    if (!/^[a-zA-Z0-9 -]+$/.test(raw))
        fail('Use the transaction ID, not a URL or message');
    const normalized = raw.toUpperCase().replace(/[ -]/g, '');
    if (normalized.length < 6 || normalized.length > 80)
        fail('Transaction ID must contain 6 to 80 letters or digits');
    return normalized;
}
function destination(method, value) {
    const raw = text(value, 'Account or phone number', 24).replace(/[ -]/g, '');
    if (method === 'cbe' && /^\d{10,16}$/.test(raw))
        return raw;
    if (method === 'telebirr' && /^(?:0[79]\d{8}|(?:\+?251)[79]\d{8})$/.test(raw))
        return raw.startsWith('0') ? '+251' + raw.slice(1) : '+' + raw.replace(/^\+/, '');
    fail('Enter a valid CBE account or Ethiopian Telebirr number');
}
function receipt(value) {
    if (!value)
        return null;
    if (!['image/png', 'image/jpeg'].includes(value.type) || typeof value.base64 !== 'string' || value.base64.length > 2800000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.base64))
        fail('Upload a PNG or JPEG receipt up to 2 MB');
    const bytes = Buffer.from(value.base64, 'base64');
    if (bytes.length < 24 || bytes.length > 2 * 1024 * 1024 || bytes.toString('base64') !== value.base64)
        fail('Invalid receipt or file larger than 2 MB');
    if (value.type === 'image/png') {
        if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.toString('ascii', 12, 16) !== 'IHDR')
            fail('Invalid PNG receipt');
        const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
        if (!width || !height || width * height > 16000000)
            fail('Receipt image is too large');
    }
    else if (bytes[0] !== 255 || bytes[1] !== 216 || bytes[2] !== 255 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217)
        fail('Invalid JPEG receipt');
    return { bytes, type: value.type, hash: createHash('sha256').update(bytes).digest('hex') };
}
export class Payments {
    constructor(store, config) {
        this.store = store;
        this.db = store.db;
        this.settings = config.payments || { enabled: false, admins: [], methods: [] };
    }
    static async open(store, config) {
        const service = new Payments(store, config);
        await store.db.transaction(async () => (await service.initialize()));
        return service;
    }
    async initialize() {
        // Preserve older in-progress payouts as reservations; do not silently free their capacity.
        await this.db.prepare("INSERT OR IGNORE INTO payout_allowances(request_id,user_id,amount,day,status) SELECT id,user_id,amount,updated_at,'reserved' FROM payment_requests WHERE kind='withdrawal' AND status='processing'").run();
        await this.db.prepare("INSERT OR IGNORE INTO payout_allowances(request_id,user_id,amount,day,status) SELECT id,user_id,amount,updated_at,'paid' FROM payment_requests WHERE kind='withdrawal' AND status='paid'").run();
        for (const method of this.settings.methods) {
            if (method.account && method.holder && !(await this.db.prepare('SELECT id FROM receiving_accounts WHERE method=? LIMIT 1').get(method.id))) {
                (await this.db.prepare('INSERT INTO receiving_accounts VALUES(?,?,?,?,?,1,?,?)').run(randomUUID(), method.id, destination(method.id, method.account), method.holder, null, 'configuration', now()));
            }
        }
        for (const method of ['cbe', 'telebirr'])
            (await this.db.prepare('INSERT OR IGNORE INTO accounts(id,kind) VALUES(?,?)').run(`cash:clearing:${method}`, 'system'));
    }
    async role(id) {
        if (this.settings.admins.includes(id))
            return 'owner';
        return (await this.db.prepare('SELECT user_id FROM payment_agents WHERE user_id=? AND enabled=1').get(id)) ? 'agent' : null;
    }
    async requireAdmin(id) {
        if (!(await this.role(id)))
            fail('Payment review access required', 403);
    }
    async requireOwner(id) {
        if ((await this.role(id)) !== 'owner')
            fail('Owner access required', 403);
    }
    method(id) {
        if (!['cbe', 'telebirr'].includes(id))
            fail('Select CBE or Telebirr');
        return id;
    }
    ensureEnabled() {
        if (!this.settings.enabled)
            fail('Deposits and withdrawals are not enabled yet', 503);
    }
    async ensureAccounts(id) {
        for (const kind of ['cash_available', 'cash_reserved'])
            (await this.db.prepare('INSERT OR IGNORE INTO accounts(id,user_id,kind) VALUES(?,?,?)').run(`${id}:${kind}`, id, kind));
    }
    async balance(id) {
        const rows = (await this.db.prepare("SELECT kind,balance FROM accounts WHERE user_id=? AND kind IN ('cash_available','cash_reserved')").all(id));
        const values = Object.fromEntries(rows.map(r => [r.kind, r.balance]));
        const available=values.cash_available||0;
        const locked=await this.lockedBonus(id);
        return { currency: 'ETB', available, reserved: values.cash_reserved || 0,bonusLocked:Math.min(available,locked),withdrawable:Math.max(0,available-locked) };
    }
    async bonusDetails(id) {
        const bonus=await this.db.prepare('SELECT b.*,p.user_id FROM deposit_bonuses b JOIN payment_requests p ON p.id=b.request_id WHERE b.request_id=?').get(id);
        if(!bonus)return null;
        let completed=0;
        if(bonus.status==='credited')completed=(await this.db.prepare("SELECT COUNT(DISTINCT r.id) AS n FROM crash_rounds r JOIN crash_bets b ON b.round_id=r.id WHERE b.user_id=? AND b.status IN ('paid','lost') AND r.status='finished' AND r.game IN ('azmera-flight:cash','azmera-jet:cash') AND r.opens>=?").get(bonus.user_id,bonus.credited_at)).n;
        return {amount:bonus.amount,rate_bps:bonus.rate_bps,mode:bonus.mode,status:bonus.status,roundsCompleted:Math.min(6,completed),roundsRequired:6,unlocked:bonus.status==='credited'&&completed>=6};
    }
    async lockedBonus(user) {
        const bonuses=await this.db.prepare("SELECT b.request_id FROM deposit_bonuses b JOIN payment_requests p ON p.id=b.request_id WHERE p.user_id=? AND b.status='credited'").all(user);
        let total=0;for(const row of bonuses){const bonus=await this.bonusDetails(row.request_id);if(!bonus.unlocked)total+=bonus.amount;}return total;
    }
    async methods() {
        const active = await this.db.prepare('SELECT method FROM receiving_accounts WHERE active=1').all();
        return { enabled: this.settings.enabled, methods: ['cbe','telebirr'].map(id => ({ id, name: id === 'cbe' ? 'Commercial Bank of Ethiopia' : 'Telebirr', available: this.settings.enabled && active.some(row => row.method === id) })) };
    }
    async row(id) {
        const row = (await this.db.prepare('SELECT * FROM payment_requests WHERE id=?').get(id));
        if (!row)
            fail('Payment request not found', 404);
        return {...row,bonus:await this.bonusDetails(id)};
    }
    view(row) { const { receipt, receipt_type, receipt_hash, ...rest } = row; return { ...rest, hasReceipt: Boolean(receipt || row.hasReceipt) }; }
    async own(id, user) {
        const row = (await this.row(id));
        if (row.user_id !== user)
            fail('Payment request not found', 404);
        return row;
    }
    async canReview(user, row) { return (await this.role(user)) === 'owner' || ((await this.role(user)) === 'agent' && (row.kind === 'withdrawal' || row.agent_id === user)); }
    async audit(id, actor, action, details = {}) { (await this.db.prepare('INSERT INTO payment_audit(request_id,actor_id,action,details,created_at) VALUES(?,?,?,?,?)').run(id, actor, action, JSON.stringify(details), now())); }
    async cap(id) {
        if ((await this.db.prepare("SELECT COUNT(*) AS n FROM payment_requests WHERE user_id=? AND status IN ('draft','pending','processing')").get(id)).n >= 5)
            fail('Please wait for your pending requests to be reviewed', 429);
        if ((await this.db.prepare('SELECT COUNT(*) AS n FROM payment_requests WHERE user_id=? AND created_at>?').get(id, new Date(Date.now() - 86400000).toISOString())).n >= 20)
            fail('Daily request limit reached', 429);
    }
    async list(id) {
        const rows=await this.db.prepare(`SELECT ${summaryColumns} FROM payment_requests WHERE user_id=? ORDER BY created_at DESC LIMIT 50`).all(id);
        return Promise.all(rows.map(async r=>this.view({...r,bonus:await this.bonusDetails(r.id)})));
    }
    async createDeposit(user, data, key) {
        this.ensureEnabled();
        const method = this.method(data.method), amount = money(data.amount);
        if (amount < paymentLimits.minDeposit) fail('Minimum deposit is 100 ETB');
        return (await this.store.atomic(`payments:${user}`, key, { action: 'deposit', method, amount }, async () => {
            (await this.cap(user));
            const receiver = (await this.db.prepare('SELECT * FROM receiving_accounts WHERE method=? AND active=1').get(method));
            if (!receiver || (receiver.agent_id && !(await this.role(receiver.agent_id))))
                fail('This receiving account is unavailable', 503);
            const id = randomUUID();
            (await this.db.prepare(`INSERT INTO payment_requests(id,user_id,kind,method,amount,status,receiver_id,receiver_account,receiver_holder,agent_id,created_at,updated_at) VALUES(?,?,'deposit',?,?,'draft',?,?,?,?,?,?)`).run(id, user, method, amount, receiver.id, receiver.account, receiver.holder, receiver.agent_id, now(), now()));
            (await this.audit(id, user, 'deposit_created'));
            if(this.settings.depositBonusMode==='after-six-rounds' && !(await this.role(user))) {
                const bonus=depositBonus(amount);
                await this.db.prepare("INSERT INTO deposit_bonuses(request_id,amount,rate_bps,mode,status) VALUES(?,?,?,'after-six-rounds','pending')").run(id,bonus.amount,bonus.rateBps);
            }
            return this.view((await this.row(id)));
        }));
    }
    async submitProof(user, id, data, key) {
        const ref = data.reference?.trim() ? reference(data.reference) : null, image = receipt(data.receipt), holder = data.senderName === undefined || data.senderName === '' ? null : text(data.senderName, 'Sender account-holder name');
        if (!ref && !image)
            fail('Provide a transaction ID or a receipt screenshot');
        return (await this.store.atomic(`payments:${user}`, key, { action: 'proof', id, ref, holder, receiptHash: image?.hash || null }, async () => {
            const row = (await this.own(id, user));
            if (row.kind !== 'deposit' || row.status !== 'draft')
                fail('This deposit has already been submitted or closed', 409);
            if (ref && (await this.db.prepare("SELECT id FROM payment_requests WHERE user_id=? AND method=? AND reference=? AND status IN ('pending','approved')").get(user, row.method, ref)))
                fail('You already submitted this transaction ID', 409);
            (await this.db.prepare("UPDATE payment_requests SET reference=?,receipt=?,receipt_type=?,receipt_hash=?,holder=?,status='pending',updated_at=? WHERE id=?").run(ref, image?.bytes || null, image?.type || null, image?.hash || null, holder, now(), id));
            (await this.audit(id, user, 'proof_submitted', { reference: ref, receiptHash: image?.hash || null }));
            await queuePaymentAlert(this.db,await this.row(id));
            return this.view((await this.row(id)));
        }));
    }
    async createWithdrawal(user, data, key) {
        this.ensureEnabled();
        if (data.amount > paymentLimits.maxWithdrawal) fail('Maximum withdrawal is 10,000 ETB per request');
        const method = this.method(data.method), amount = money(data.amount), account = destination(method, data.account), holder = data.holder === undefined || data.holder === '' ? null : text(data.holder, 'Account-holder name');
        return (await this.store.atomic(`payments:${user}`, key, { action: 'withdrawal', method, amount, account, holder }, async (op) => {
            const [start,end] = ethiopianDay();
            const used = (await this.db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payment_requests WHERE user_id=? AND kind='withdrawal' AND status IN ('pending','processing','paid') AND created_at>=? AND created_at<?").get(user,start,end)).total;
            if (used + amount > paymentLimits.dailyWithdrawal) fail('Daily withdrawal limit is 50,000 ETB (Ethiopian time)', 409);
            (await this.cap(user));
            (await this.ensureAccounts(user));
            const wallet=await this.balance(user);
            if(wallet.bonusLocked&&amount>wallet.withdrawable)fail('This amount includes a locked bonus. Complete six cash rounds after the deposit to unlock it.',409);
            (await this.store.transfer(op, `${user}:cash_available`, `${user}:cash_reserved`, amount));
            const id = randomUUID();
            (await this.db.prepare(`INSERT INTO payment_requests(id,user_id,kind,method,amount,status,destination,holder,created_at,updated_at) VALUES(?,?,'withdrawal',?,?,'pending',?,?,?,?)`).run(id, user, method, amount, account, holder, now(), now()));
            (await this.audit(id, user, 'withdrawal_requested'));
            await queuePaymentAlert(this.db,await this.row(id));
            return this.view((await this.row(id)));
        }));
    }
    async cancel(user, id, key) {
        return (await this.store.atomic(`payments:${user}`, key, { action: 'cancel', id }, async (op) => {
            const row = (await this.own(id, user));
            if (!(row.kind === 'deposit' && row.status === 'draft') && !(row.kind === 'withdrawal' && row.status === 'pending'))
                fail('This request can no longer be cancelled', 409);
            if (row.kind === 'withdrawal')
                (await this.store.transfer(op, `${user}:cash_reserved`, `${user}:cash_available`, row.amount));
            (await this.db.prepare("UPDATE payment_requests SET status='cancelled',updated_at=? WHERE id=?").run(now(), id));
            (await this.audit(id, user, 'cancelled'));
            await this.db.prepare("UPDATE deposit_bonuses SET status='cancelled' WHERE request_id=? AND status='pending'").run(id);
            return this.view((await this.row(id)));
        }));
    }
    async reserveReference(row, direction, ref) {
        if ((await this.db.prepare('SELECT request_id FROM verified_payment_references WHERE method=? AND direction=? AND reference=?').get(row.method, direction, ref)))
            fail('This verified transaction ID was already used', 409);
        (await this.db.prepare('INSERT INTO verified_payment_references VALUES(?,?,?,?)').run(row.method, direction, ref, row.id));
    }
    async review(actor, id, data, key) {
        (await this.requireAdmin(actor));
        const action = text(data.action, 'Review action', 20);
        return (await this.store.atomic(`payment-review:${actor}`, key, { id, ...data }, async (op) => {
            const row = (await this.row(id));
            if (!(await this.canReview(actor, row)))
                fail('This deposit is assigned to another reviewer', 403);
            if (row.user_id === actor)
                fail('You cannot review your own payment request', 403);
            let status, details = {};
            if (action === 'approve' && row.kind === 'deposit' && row.status === 'pending') {
                const ref = data.verifiedReference ? reference(data.verifiedReference) : row.reference;
                const recipient = row.receiver_account, sender = row.holder;
                if ((data.bankConfirmed !== undefined && data.bankConfirmed !== true) || (data.verifiedAmount !== undefined && data.verifiedAmount !== row.amount) || (data.verifiedRecipient !== undefined && destination(row.method, data.verifiedRecipient) !== recipient))
                    fail('Confirm receipt in the bank account and match the exact amount and receiving account');
                if (row.reference && row.reference !== ref)
                    fail('Verified transaction ID does not match the submitted ID');
                if (row.receipt_hash && (await this.db.prepare("SELECT id FROM payment_requests WHERE kind='deposit' AND status='approved' AND receipt_hash=? AND id<>?").get(row.receipt_hash, row.id)))
                    fail('This receipt was already used for an approved deposit', 409);
                if (ref)
                    (await this.reserveReference(row, 'incoming', ref));
                (await this.ensureAccounts(row.user_id));
                (await this.store.transfer(op, `cash:clearing:${row.method}`, `${row.user_id}:cash_available`, row.amount));
                if(row.bonus?.status==='pending') {
                    const capital=await this.db.prepare("SELECT balance FROM accounts WHERE id='cash:crash_available'").get();
                    if(!capital||capital.balance<row.bonus.amount)fail('Insufficient house capital for this deposit bonus. Fund the bankroll before approval.',409);
                    await this.store.transfer(op,'cash:crash_available',`${row.user_id}:cash_available`,row.bonus.amount);
                    await this.db.prepare("UPDATE deposit_bonuses SET status='credited',credited_at=? WHERE request_id=?").run(Date.now(),row.id);
                }
                status = 'approved';
                details = { reference: ref || null, recipient, sender, amount: row.amount, bonus:row.bonus?.amount||0, receiptHash: row.receipt_hash || null, confirmation: 'Reviewer approved receipt of funds' };
            }
            else if (action === 'claim' && row.kind === 'withdrawal' && row.status === 'pending') {
                await this.reservePayout(row);
                status = 'processing';
            }
            else if (action === 'paid' && row.kind === 'withdrawal' && row.status === 'processing') {
                if (row.reviewer_id !== actor)
                    fail('Only the assigned reviewer can finish this payout', 403);
                const ref = reference(data.verifiedReference);
                if (data.bankConfirmed !== true || data.verifiedAmount !== row.amount || destination(row.method, data.verifiedRecipient) !== row.destination)
                    fail('Confirm the transfer succeeded with the exact destination and amount');
                const allowance=await this.db.prepare("SELECT * FROM payout_allowances WHERE request_id=? AND status='reserved'").get(row.id);
                if(!allowance)fail('Payout allowance must be reserved before sending money',409);
                await this.checkPayoutCapacity(row);
                (await this.reserveReference(row, 'outgoing', ref));
                (await this.store.transfer(op, `${row.user_id}:cash_reserved`, `cash:clearing:${row.method}`, row.amount));
                status = 'paid';
                await this.db.prepare("UPDATE payout_allowances SET status='paid',day=? WHERE request_id=?").run(now(),row.id);
                details = { reference: ref, amount: row.amount, recipient: row.destination };
            }
            else if (action === 'reject' && row.status === 'pending') {
                details = { reason: row.kind === 'deposit' && !data.reason ? 'Deposit rejected by reviewer' : text(data.reason, 'Reason', 300) };
                status = 'rejected';
                if (row.kind === 'withdrawal')
                    (await this.store.transfer(op, `${row.user_id}:cash_reserved`, `${row.user_id}:cash_available`, row.amount));
            }
            else if (action === 'failed' && row.kind === 'withdrawal' && row.status === 'processing') {
                if (row.reviewer_id !== actor || data.fundsNotSent !== true)
                    fail('Only the assigned reviewer can confirm that no funds were sent', 403);
                details = { reason: text(data.reason, 'Failure reason', 300), fundsNotSent: true };
                status = 'failed';
                await this.db.prepare("UPDATE payout_allowances SET status='released' WHERE request_id=?").run(row.id);
                (await this.store.transfer(op, `${row.user_id}:cash_reserved`, `${row.user_id}:cash_available`, row.amount));
            }
            else
                fail('This action is not valid for the current request status', 409);
            (await this.db.prepare('UPDATE payment_requests SET status=?,reviewer_id=?,reason=?,reference=COALESCE(?,reference),updated_at=? WHERE id=?').run(status, actor, details.reason || null, details.reference || null, now(), id));
            (await this.audit(id, actor, action, details));
            if(status==='rejected')await this.db.prepare("UPDATE deposit_bonuses SET status='cancelled' WHERE request_id=? AND status='pending'").run(id);
            return this.view((await this.row(id)));
        }));
    }
    async checkPayoutCapacity(row) {
        const [start,end]=ethiopianDay();
        const used=(await this.db.prepare("SELECT COALESCE(SUM(amount),0) AS total FROM payout_allowances WHERE user_id=? AND request_id<>? AND (status='reserved' OR (status='paid' AND day>=? AND day<?))").get(row.user_id,row.id,start,end)).total;
        if(row.amount>paymentLimits.maxWithdrawal||used+row.amount>paymentLimits.dailyWithdrawal)fail('Payout-day limit reached. Do not send this transfer; wait until capacity is available.',409);
    }
    async reservePayout(row) {
        await this.checkPayoutCapacity(row);
        await this.db.prepare("INSERT INTO payout_allowances VALUES(?,?,?,?,'reserved')").run(row.id,row.user_id,row.amount,now());
    }
    async receiptFor(user, id) {
        const row = (await this.row(id));
        if (row.user_id !== user && !(await this.canReview(user, row)))
            fail('Receipt not found', 404);
        if (!row.receipt)
            fail('Receipt not found', 404);
        return { bytes: row.receipt, type: row.receipt_type };
    }
    async queue(user) {
        (await this.requireAdmin(user));
        const rows = (await this.role(user)) === 'owner'
            ? (await this.db.prepare(`SELECT ${summaryColumns} FROM payment_requests WHERE status IN ('pending','processing') ORDER BY created_at LIMIT 100`).all()) : (await this.db.prepare(`SELECT ${summaryColumns} FROM payment_requests WHERE status IN ('pending','processing') AND (kind='withdrawal' OR agent_id=?) ORDER BY created_at LIMIT 100`).all(user));
        return rows.map(r => this.view(r));
    }
    async auditFor(user, id) {
        const row = (await this.row(id));
        if (!(await this.canReview(user, row)))
            fail('Review access required', 403);
        return (await this.db.prepare('SELECT * FROM payment_audit WHERE request_id=? ORDER BY id').all(id)).map(r => ({ ...r, details: JSON.parse(r.details) }));
    }
    async settingsFor(user) { (await this.requireOwner(user)); return { accounts: (await this.db.prepare('SELECT * FROM receiving_accounts ORDER BY created_at DESC').all()), agents: (await this.db.prepare('SELECT a.*,u.name FROM payment_agents a JOIN users u ON u.id=a.user_id').all()), users: (await this.db.prepare("SELECT id,name FROM users WHERE id LIKE 'tg:%' ORDER BY name,id").all()).filter(u => !this.settings.admins.includes(u.id)) }; }
    async setAgent(actor, data, key) {
        (await this.requireOwner(actor));
        const id = `tg:${text(data.telegramId, 'Telegram user ID', 16)}`;
        if (!/^tg:[1-9]\d{0,15}$/.test(id) || !(await this.db.prepare('SELECT id FROM users WHERE id=?').get(id)))
            fail('The agent must first register in Azmera using Telegram');
        if (this.settings.admins.includes(id))
            fail('Owner access is managed in server configuration');
        if (typeof data.enabled !== 'boolean')
            fail('Specify whether this agent is enabled');
        return (await this.store.atomic(`payment-settings:${actor}`, key, { action: 'agent', id, enabled: data.enabled }, async () => {
            if (!data.enabled && (await this.db.prepare("SELECT id FROM payment_requests WHERE reviewer_id=? AND status='processing'").get(id)))
                fail('Resolve this agent\'s processing withdrawals before disabling access', 409);
            (await this.db.prepare('INSERT INTO payment_agents VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled').run(id, Number(data.enabled), actor, now()));
            if (!data.enabled)
                (await this.db.prepare('UPDATE receiving_accounts SET active=0 WHERE agent_id=?').run(id));
            (await this.audit(id, actor, 'agent_access_changed', { enabled: data.enabled }));
            return { ok: true };
        }));
    }
    async addAccount(actor, data, key) {
        (await this.requireOwner(actor));
        const method = this.method(data.method), account = destination(method, data.account), holder = text(data.holder, 'Account-holder name');
        const agent = data.agentId?.trim() ? `tg:${data.agentId.trim()}` : null;
        if (agent && !(await this.role(agent)))
            fail('Assign an enabled agent or leave blank for owner review');
        return (await this.store.atomic(`payment-settings:${actor}`, key, { action: 'receiver', method, account, holder, agent }, async () => {
            (await this.db.prepare('UPDATE receiving_accounts SET active=0 WHERE method=?').run(method));
            const id = randomUUID();
            (await this.db.prepare('INSERT INTO receiving_accounts VALUES(?,?,?,?,?,1,?,?)').run(id, method, account, holder, agent, actor, now()));
            (await this.audit(id, actor, 'receiving_account_activated', { method, account, holder, agent }));
            return { ok: true, id };
        }));
    }
}

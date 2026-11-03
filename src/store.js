import { openDatabase } from './database.js';
import { randomUUID } from 'node:crypto';
import { tokenHash } from './auth.js';
export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export function money(value) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 100000000)
        fail('Amount must be integer minor units between 1 and 100000000');
    return value;
}
export function operationKey(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value))
        fail('An 8–100 character Idempotency-Key is required');
    return value;
}
export class Store {
    constructor(db) { this.db = db; }
    static async open(connection) {
        const db = await openDatabase(connection);
        try {
            await db.initialize();
            const store = new Store(db);
            for (const id of ['sandbox:clearing', 'sandbox:house'])
                await db.prepare('INSERT OR IGNORE INTO accounts(id,kind) VALUES(?,?)').run(id, 'system');
            return store;
        }
        catch (error) {
            await db.close();
            throw error;
        }
    }
    async close() { (await this.db.close()); }
    async phone(id) {
        return (await this.db.prepare('SELECT phone FROM user_contacts WHERE user_id=?').get(id))?.phone || null;
    }
    async saveTelegramContact(message) {
        const sender = message?.from?.id;
        const contact = message?.contact;
        if (message?.chat?.type !== 'private' || !Number.isSafeInteger(sender) || sender <= 0 ||
            message.chat.id !== sender || contact?.user_id !== sender || message.from.is_bot || message.forward_origin)
            return false;
        const raw = String(contact.phone_number || '').trim();
        if (!/^\+?[1-9][0-9]{6,14}$/.test(raw)) return false;
        const id = `tg:${sender}`;
        if (!await this.db.prepare('SELECT id FROM users WHERE id=?').get(id)) return false;
        await this.db.prepare('INSERT INTO user_contacts(user_id,phone,shared_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,shared_at=excluded.shared_at')
            .run(id, `+${raw.replace(/^\+/, '')}`, new Date().toISOString());
        return true;
    }
    async user(id, name) {
        (await this.db.prepare('INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, name));
        for (const kind of ['available', 'reserved'])
            (await this.db.prepare('INSERT OR IGNORE INTO accounts(id,user_id,kind) VALUES(?,?,?)').run(`${id}:${kind}`, id, kind));
        return { id, name };
    }
    async session(id, token) {
        (await this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now()));
        (await this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), id, Date.now() + SESSION_SECONDS * 1000));
    }
    async register(id, name) {
        return (await this.db.transaction(async () => {
            if ((await this.db.prepare('SELECT id FROM users WHERE id=?').get(id)))
                fail('An account already exists. Please log in.', 409);
            const user = (await this.user(id, name));
            (await this.db.prepare('INSERT INTO registration_consents VALUES(?,?,?)').run(id, 'telegram-registration-v1', new Date().toISOString()));
            if (id.startsWith('tg:')) await this.db.prepare('INSERT OR IGNORE INTO audience_join_dates VALUES(?,?)').run(id, new Date().toISOString());
            return user;
        }));
    }
    async existingUser(id) {
        const user = (await this.db.prepare('SELECT * FROM users WHERE id=?').get(id));
        if (!user)
            fail('No account found. Please register first.', 404);
        return user;
    }
    async logout(token) { (await this.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(token))); }
    async authenticate(token) {
        if (!token)
            fail('Sign in required', 401);
        const user = (await this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE hash=? AND expires>?').get(tokenHash(token), Date.now()));
        if (!user)
            fail('Session expired; sign in again', 401);
        return user;
    }
    async balance(id) {
        const rows = (await this.db.prepare("SELECT kind,balance FROM accounts WHERE user_id=? AND kind IN ('available','reserved')").all(id));
        return { currency: 'ETB', mode: 'sandbox', ...Object.fromEntries(rows.map(r => [r.kind, r.balance])) };
    }
    async history(id) {
        return (await this.db.prepare(`SELECT o.id,o.created,o.result,e.amount,a.kind FROM entries e JOIN accounts a ON a.id=e.account_id JOIN operations o ON o.id=e.operation_id WHERE a.user_id=? AND a.kind IN ('available','reserved') ORDER BY e.id DESC LIMIT 100`).all(id)).map(r => ({ ...r, result: JSON.parse(r.result) }));
    }
    async atomic(scope, key, request, perform) {
        operationKey(key);
        const encoded = JSON.stringify(request);
        return (await this.db.transaction(async () => {
            const existing = (await this.db.prepare('SELECT request,result FROM operations WHERE scope=? AND key=?').get(scope, key));
            if (existing) {
                if (existing.request !== encoded)
                    fail('Idempotency key already used for a different request', 409);
                return JSON.parse(existing.result);
            }
            const operation = randomUUID();
            // Temporary result stays inside the transaction until the posting succeeds.
            (await this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(operation, scope, key, encoded, '{}', new Date().toISOString()));
            const result = await perform(operation);
            const sum = (await this.db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM entries WHERE operation_id=?').get(operation)).total;
            if (sum !== 0)
                throw new Error('Unbalanced ledger transaction');
            (await this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), operation));
            return result;
        }));
    }
    async transfer(operation, from, to, amount) {
        money(amount);
        const source = (await this.db.prepare('SELECT * FROM accounts WHERE id=?').get(from));
        if (!source || (source.kind !== 'system' && source.balance < amount))
            fail('Insufficient balance', 409);
        const destination = (await this.db.prepare('SELECT balance FROM accounts WHERE id=?').get(to));
        if (!destination || !Number.isSafeInteger(destination.balance + amount) || !Number.isSafeInteger(source.balance - amount))
            fail('Account balance limit exceeded', 409);
        (await this.db.prepare('UPDATE accounts SET balance=balance-? WHERE id=?').run(amount, from));
        (await this.db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(amount, to));
        (await this.db.prepare('INSERT INTO entries(operation_id,account_id,amount) VALUES(?,?,?)').run(operation, from, -amount));
        (await this.db.prepare('INSERT INTO entries(operation_id,account_id,amount) VALUES(?,?,?)').run(operation, to, amount));
    }
    async deposit(id, amount, key) {
        money(amount);
        return (await this.atomic(id, key, { action: 'deposit', amount }, async (op) => {
            (await this.transfer(op, 'sandbox:clearing', `${id}:available`, amount));
            return { type: 'sandbox_deposit', amount, wallet: (await this.balance(id)) };
        }));
    }
    async bet(id, gameId, amount, key) {
        money(amount);
        if (amount > 50000000)
            fail('Sandbox stake exceeds maximum');
        return (await this.atomic(id, key, { action: 'bet', gameId, amount }, async (op) => {
            (await this.transfer(op, `${id}:available`, 'sandbox:house', amount));
            const roundId = randomUUID();
            (await this.db.prepare('INSERT INTO rounds VALUES(?,?,?,?,?,?)').run(roundId, id, gameId, amount, 'open', 0));
            return { type: 'sandbox_bet', roundId, gameId, amount, wallet: (await this.balance(id)) };
        }));
    }
    async settle(id, roundId, outcome, key) {
        if (!['win', 'loss', 'refund'].includes(outcome))
            fail('Invalid outcome');
        return (await this.atomic(id, key, { action: 'settle', roundId, outcome }, async (op) => {
            const round = (await this.db.prepare('SELECT * FROM rounds WHERE id=? AND user_id=?').get(roundId, id));
            if (!round)
                fail('Round not found', 404);
            if (round.status !== 'open')
                fail('Round already settled', 409);
            const payout = outcome === 'win' ? round.stake * 2 : outcome === 'refund' ? round.stake : 0;
            if (payout)
                (await this.transfer(op, 'sandbox:house', `${id}:available`, payout));
            (await this.db.prepare('UPDATE rounds SET status=?,payout=? WHERE id=?').run(outcome, payout, roundId));
            return { type: 'sandbox_settlement', roundId, outcome, payout, wallet: (await this.balance(id)) };
        }));
    }
    async withdraw(id, amount, key) {
        money(amount);
        return (await this.atomic(id, key, { action: 'withdraw', amount }, async (op) => {
            (await this.transfer(op, `${id}:available`, `${id}:reserved`, amount));
            const withdrawalId = randomUUID();
            (await this.db.prepare('INSERT INTO withdrawals VALUES(?,?,?,?)').run(withdrawalId, id, amount, 'pending'));
            return { type: 'sandbox_withdrawal', withdrawalId, amount, status: 'pending', wallet: (await this.balance(id)) };
        }));
    }
    async finishWithdrawal(id, withdrawalId, outcome, key) {
        if (!['paid', 'failed'].includes(outcome))
            fail('Invalid withdrawal outcome');
        return (await this.atomic(id, key, { action: 'withdrawal_result', withdrawalId, outcome }, async (op) => {
            const row = (await this.db.prepare('SELECT * FROM withdrawals WHERE id=? AND user_id=?').get(withdrawalId, id));
            if (!row)
                fail('Withdrawal not found', 404);
            if (row.status !== 'pending')
                fail('Withdrawal already completed', 409);
            (await this.transfer(op, `${id}:reserved`, outcome === 'paid' ? 'sandbox:clearing' : `${id}:available`, row.amount));
            (await this.db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(outcome, withdrawalId));
            return { type: 'sandbox_withdrawal_result', withdrawalId, status: outcome, wallet: (await this.balance(id)) };
        }));
    }
    async pending(id) {
        return {
            rounds: (await this.db.prepare("SELECT * FROM rounds WHERE user_id=? AND status='open'").all(id)),
            withdrawals: (await this.db.prepare("SELECT * FROM withdrawals WHERE user_id=? AND status='pending'").all(id)),
        };
    }
}

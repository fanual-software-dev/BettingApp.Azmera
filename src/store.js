import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tokenHash } from './auth.js';

export function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export const SESSION_SECONDS = 30 * 24 * 60 * 60;
export function money(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000_000) fail('Amount must be integer minor units between 1 and 100000000');
  return value;
}
export function operationKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{8,100}$/.test(value)) fail('An 8–100 character Idempotency-Key is required');
  return value;
}

export class Store {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS registration_consents(user_id TEXT PRIMARY KEY REFERENCES users(id), version TEXT NOT NULL, accepted_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), kind TEXT NOT NULL, balance INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, scope TEXT NOT NULL, key TEXT NOT NULL, request TEXT NOT NULL, result TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(scope,key));
      CREATE TABLE IF NOT EXISTS entries(id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL REFERENCES operations(id), account_id TEXT NOT NULL REFERENCES accounts(id), amount INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rounds(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), game_id TEXT NOT NULL, stake INTEGER NOT NULL, status TEXT NOT NULL, payout INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS withdrawals(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_updates(id INTEGER PRIMARY KEY, created INTEGER NOT NULL);
    `);
    for (const id of ['sandbox:clearing', 'sandbox:house']) this.db.prepare('INSERT OR IGNORE INTO accounts(id,kind) VALUES(?,?)').run(id, 'system');
  }
  close() { this.db.close(); }
  user(id, name) {
    this.db.prepare('INSERT INTO users(id,name) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name').run(id, name);
    for (const kind of ['available', 'reserved']) this.db.prepare('INSERT OR IGNORE INTO accounts(id,user_id,kind) VALUES(?,?,?)').run(`${id}:${kind}`, id, kind);
    return { id, name };
  }
  session(id, token) {
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
    this.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(tokenHash(token), id, Date.now() + SESSION_SECONDS * 1000);
  }
  register(id, name) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.db.prepare('SELECT id FROM users WHERE id=?').get(id)) fail('An account already exists. Please log in.', 409);
      const user = this.user(id, name);
      this.db.prepare('INSERT INTO registration_consents VALUES(?,?,?)').run(id, 'telegram-registration-v1', new Date().toISOString());
      this.db.exec('COMMIT');
      return user;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  existingUser(id) {
    const user = this.db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!user) fail('No account found. Please register first.', 404);
    return user;
  }
  logout(token) { this.db.prepare('DELETE FROM sessions WHERE hash=?').run(tokenHash(token)); }
  authenticate(token) {
    if (!token) fail('Sign in required', 401);
    const user = this.db.prepare('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE hash=? AND expires>?').get(tokenHash(token), Date.now());
    if (!user) fail('Session expired; sign in again', 401);
    return user;
  }
  balance(id) {
    const rows = this.db.prepare("SELECT kind,balance FROM accounts WHERE user_id=? AND kind IN ('available','reserved')").all(id);
    return { currency: 'ETB', mode: 'sandbox', ...Object.fromEntries(rows.map(r => [r.kind, r.balance])) };
  }
  history(id) {
    return this.db.prepare(`SELECT o.id,o.created,o.result,e.amount,a.kind FROM entries e JOIN accounts a ON a.id=e.account_id JOIN operations o ON o.id=e.operation_id WHERE a.user_id=? AND a.kind IN ('available','reserved') ORDER BY e.id DESC LIMIT 100`).all(id).map(r => ({ ...r, result: JSON.parse(r.result) }));
  }
  atomic(scope, key, request, perform) {
    operationKey(key);
    const encoded = JSON.stringify(request);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT request,result FROM operations WHERE scope=? AND key=?').get(scope, key);
      if (existing) {
        if (existing.request !== encoded) fail('Idempotency key already used for a different request', 409);
        this.db.exec('COMMIT');
        return JSON.parse(existing.result);
      }
      const operation = randomUUID();
      // Temporary result stays inside the transaction until the posting succeeds.
      this.db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(operation, scope, key, encoded, '{}', new Date().toISOString());
      const result = perform(operation);
      const sum = this.db.prepare('SELECT COALESCE(SUM(amount),0) AS total FROM entries WHERE operation_id=?').get(operation).total;
      if (sum !== 0) throw new Error('Unbalanced ledger transaction');
      this.db.prepare('UPDATE operations SET result=? WHERE id=?').run(JSON.stringify(result), operation);
      this.db.exec('COMMIT');
      return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  transfer(operation, from, to, amount) {
    money(amount);
    const source = this.db.prepare('SELECT * FROM accounts WHERE id=?').get(from);
    if (!source || (source.kind !== 'system' && source.balance < amount)) fail('Insufficient balance', 409);
    const destination = this.db.prepare('SELECT balance FROM accounts WHERE id=?').get(to);
    if (!destination || !Number.isSafeInteger(destination.balance + amount) || !Number.isSafeInteger(source.balance - amount)) fail('Account balance limit exceeded', 409);
    this.db.prepare('UPDATE accounts SET balance=balance-? WHERE id=?').run(amount, from);
    this.db.prepare('UPDATE accounts SET balance=balance+? WHERE id=?').run(amount, to);
    this.db.prepare('INSERT INTO entries(operation_id,account_id,amount) VALUES(?,?,?)').run(operation, from, -amount);
    this.db.prepare('INSERT INTO entries(operation_id,account_id,amount) VALUES(?,?,?)').run(operation, to, amount);
  }
  deposit(id, amount, key) {
    money(amount);
    return this.atomic(id, key, { action: 'deposit', amount }, op => {
      this.transfer(op, 'sandbox:clearing', `${id}:available`, amount);
      return { type: 'sandbox_deposit', amount, wallet: this.balance(id) };
    });
  }
  bet(id, gameId, amount, key) {
    money(amount);
    if (amount > 50_000_000) fail('Sandbox stake exceeds maximum');
    return this.atomic(id, key, { action: 'bet', gameId, amount }, op => {
      this.transfer(op, `${id}:available`, 'sandbox:house', amount);
      const roundId = randomUUID();
      this.db.prepare('INSERT INTO rounds VALUES(?,?,?,?,?,?)').run(roundId, id, gameId, amount, 'open', 0);
      return { type: 'sandbox_bet', roundId, gameId, amount, wallet: this.balance(id) };
    });
  }
  settle(id, roundId, outcome, key) {
    if (!['win', 'loss', 'refund'].includes(outcome)) fail('Invalid outcome');
    return this.atomic(id, key, { action: 'settle', roundId, outcome }, op => {
      const round = this.db.prepare('SELECT * FROM rounds WHERE id=? AND user_id=?').get(roundId, id);
      if (!round) fail('Round not found', 404);
      if (round.status !== 'open') fail('Round already settled', 409);
      const payout = outcome === 'win' ? round.stake * 2 : outcome === 'refund' ? round.stake : 0;
      if (payout) this.transfer(op, 'sandbox:house', `${id}:available`, payout);
      this.db.prepare('UPDATE rounds SET status=?,payout=? WHERE id=?').run(outcome, payout, roundId);
      return { type: 'sandbox_settlement', roundId, outcome, payout, wallet: this.balance(id) };
    });
  }
  withdraw(id, amount, key) {
    money(amount);
    return this.atomic(id, key, { action: 'withdraw', amount }, op => {
      this.transfer(op, `${id}:available`, `${id}:reserved`, amount);
      const withdrawalId = randomUUID();
      this.db.prepare('INSERT INTO withdrawals VALUES(?,?,?,?)').run(withdrawalId, id, amount, 'pending');
      return { type: 'sandbox_withdrawal', withdrawalId, amount, status: 'pending', wallet: this.balance(id) };
    });
  }
  finishWithdrawal(id, withdrawalId, outcome, key) {
    if (!['paid', 'failed'].includes(outcome)) fail('Invalid withdrawal outcome');
    return this.atomic(id, key, { action: 'withdrawal_result', withdrawalId, outcome }, op => {
      const row = this.db.prepare('SELECT * FROM withdrawals WHERE id=? AND user_id=?').get(withdrawalId, id);
      if (!row) fail('Withdrawal not found', 404);
      if (row.status !== 'pending') fail('Withdrawal already completed', 409);
      this.transfer(op, `${id}:reserved`, outcome === 'paid' ? 'sandbox:clearing' : `${id}:available`, row.amount);
      this.db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(outcome, withdrawalId);
      return { type: 'sandbox_withdrawal_result', withdrawalId, status: outcome, wallet: this.balance(id) };
    });
  }
  pending(id) {
    return {
      rounds: this.db.prepare("SELECT * FROM rounds WHERE user_id=? AND status='open'").all(id),
      withdrawals: this.db.prepare("SELECT * FROM withdrawals WHERE user_id=? AND status='pending'").all(id),
    };
  }
}

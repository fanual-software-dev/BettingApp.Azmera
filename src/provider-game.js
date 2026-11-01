import { randomUUID } from 'node:crypto';
import { fail, money, operationKey } from './store.js';
import { newToken, tokenHash } from './auth.js';
// Internal wallet/session contract; supplier wire protocols remain separate adapters.
function reference(value, name) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 200 || /[\x00-\x1f]/.test(value))
        fail(`Invalid ${name}`);
    return value;
}
export function launchOrigins(value = '') {
    return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean).map(item => {
            const url = new URL(item);
            if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
                throw new Error('Launch origin settings must contain HTTPS origins only');
            return url.origin;
        }))];
}
export function validateLaunchUrl(value, origins) {
    let url;
    try {
        url = new URL(value);
    }
    catch {
        fail('Provider returned an invalid game URL', 502);
    }
    if (url.protocol !== 'https:' || url.username || url.password || !origins.includes(url.origin))
        fail('Provider game URL is not approved', 502);
    return url.href;
}
export class ProviderGameService {
    constructor(store, config, adapter, definition) {
        // Definitions are code-owned, never derived from HTTP input or environment SQL.
        if (!['aviator', 'chicken_road'].includes(definition.prefix))
            throw new Error('Unknown provider table namespace');
        this.definition = definition;
        this.prefix = definition.prefix;
        this.settings = config[definition.configKey] || {};
        this.store = store;
        this.config = config;
        this.adapter = adapter;
        this.db = store.db;
    }
    readiness() {
        const settings = this.settings;
        const checks = [
            { id: 'protocol', label: 'Supplier API adapter implemented and verified', ready: this.adapter.ready === true && ['launch', 'verifyCallback', 'formatResponse'].every(name => typeof this.adapter[name] === 'function') },
            { id: 'operator', label: 'Operator identifier configured', ready: Boolean(settings.operatorId) },
            { id: 'game', label: `Supplier ${this.definition.name} game ID configured`, ready: Boolean(settings.gameId) },
            { id: 'origins', label: 'Approved game launch origins configured', ready: Boolean(settings.origins?.length) },
        ];
        return { provider: this.definition.provider, game: this.definition.gameId, mode: 'sandbox', launchReady: checks.every(c => c.ready), realMoneyReady: false, checks };
    }
    ensureReady() {
        if (!this.readiness().launchReady)
            fail(`${this.definition.name} is not connected yet. Please try another game demo.`, 503);
    }
    async player(userId) {
        (await this.db.prepare(`INSERT OR IGNORE INTO ${this.prefix}_players VALUES(?,?)`).run(userId, randomUUID()));
        return (await this.db.prepare(`SELECT external_id FROM ${this.prefix}_players WHERE user_id=?`).get(userId)).external_id;
    }
    async launch(userId, key) {
        this.ensureReady();
        operationKey(key);
        const sessionId = randomUUID();
        const sessionToken = newToken();
        const playerId = await this.db.transaction(async () => {
            const existing = await this.db.prepare(`SELECT id,state FROM ${this.prefix}_sessions WHERE user_id=? AND request_key=?`).get(userId, key);
            if (existing) fail('Launch already requested; refresh the lobby before launching again', 409);
            const player = await this.player(userId);
            await this.db.prepare(`INSERT INTO ${this.prefix}_sessions VALUES(?,?,?,?,?,?)`).run(sessionId, userId, tokenHash(sessionToken), Date.now() + 3600000, 'creating', key);
            return player;
        });
        const controller = new AbortController();
        let timeout;
        try {
            const launched = await Promise.race([
                this.adapter.launch({
                    requestId: sessionId, sessionToken, playerId, currency: 'ETB',
                    gameId: this.settings.gameId, operatorId: this.settings.operatorId,
                    returnUrl: this.config.publicUrl, environment: 'sandbox', signal: controller.signal,
                }),
                new Promise((_, reject) => { timeout = setTimeout(() => { controller.abort(); reject(new Error('Launch timed out')); }, 8000); }),
            ]);
            const launchUrl = validateLaunchUrl(launched.url, this.settings.origins);
            (await this.db.prepare(`UPDATE ${this.prefix}_sessions SET state='active' WHERE id=?`).run(sessionId));
            // Do not persist the launch URL: it may contain supplier session credentials.
            return { gameId: this.definition.gameId, mode: 'sandbox', sessionId, launchUrl };
        }
        catch (error) {
            (await this.db.prepare(`UPDATE ${this.prefix}_sessions SET state='failed' WHERE id=?`).run(sessionId));
            // Never return a supplier exception that might include credentials or a URL.
            fail(error.status === 502 ? error.message : 'Provider launch failed; return to the lobby and try again', 502);
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async callback(rawBody, headers) {
        this.ensureReady();
        let event;
        try {
            event = await this.adapter.verifyCallback(rawBody, headers);
        }
        catch {
            fail('Provider callback authentication failed', 401);
        }
        // Only the verified adapter may invoke this normalised wallet contract.
        return (await this.applyEvent(event));
    }
    async applyEvent(input) {
        if (!input || typeof input !== 'object')
            fail('Invalid provider event');
        const { type, playerId, currency, gameId } = input;
        if (!['balance', 'debit', 'credit', 'refund'].includes(type))
            fail('Unsupported provider event');
        reference(playerId, 'provider player');
        if (currency !== 'ETB' || gameId !== this.settings.gameId)
            fail('Provider currency or game mismatch', 409);
        const player = (await this.db.prepare(`SELECT user_id FROM ${this.prefix}_players WHERE external_id=?`).get(playerId));
        if (!player)
            fail('Provider player not found', 404);
        const userId = player.user_id;
        const activeSession = async () => {
            if (typeof input.sessionToken !== 'string' || input.sessionToken.length > 200)
                fail('Invalid provider session', 401);
            const row = (await this.db.prepare(`SELECT id FROM ${this.prefix}_sessions WHERE user_id=? AND token_hash=? AND state='active' AND expires>?`).get(userId, tokenHash(input.sessionToken), Date.now()));
            if (!row)
                fail('Provider session expired or invalid', 401);
        };
        if (type === 'balance') {
            (await activeSession());
            return { currency, balance: (await this.store.balance(userId)).available };
        }
        const transactionId = reference(input.transactionId, 'transaction ID');
        const betId = reference(input.betId, 'bet ID');
        const roundId = reference(input.roundId, 'round ID');
        const amount = input.amount;
        if (type === 'credit' && amount === 0) { /* losses are terminal zero-credit events */ }
        else
            money(amount);
        const event = { type, playerId, currency, gameId, transactionId, betId, roundId, amount };
        // Exclude session/auth timestamps from idempotency: valid financial retries
        // must return their original result even after a session expires.
        return (await this.store.atomic(`${this.definition.scope}:sandbox`, tokenHash(transactionId), event, async (op) => {
            if (type === 'debit') {
                (await activeSession());
                if ((await this.db.prepare(`SELECT 1 FROM ${this.prefix}_bets WHERE bet_id=?`).get(betId)))
                    fail('Provider bet already exists', 409);
                (await this.store.transfer(op, `${userId}:available`, 'sandbox:house', amount));
                (await this.db.prepare(`INSERT INTO ${this.prefix}_bets(bet_id,user_id,round_id,stake,status,payout) VALUES(?,?,?,?,?,?)`).run(betId, userId, roundId, amount, 'open', 0));
            }
            else {
                const bet = (await this.db.prepare(`SELECT * FROM ${this.prefix}_bets WHERE bet_id=? AND user_id=? AND round_id=?`).get(betId, userId, roundId));
                if (!bet)
                    fail('Referenced provider bet not found', 409);
                if (bet.status !== 'open')
                    fail('Provider bet already completed', 409);
                if (type === 'refund' && amount !== bet.stake)
                    fail('Refund must match the original stake', 409);
                if (amount > 0)
                    (await this.store.transfer(op, 'sandbox:house', `${userId}:available`, amount));
                (await this.db.prepare(`UPDATE ${this.prefix}_bets SET status=?,payout=? WHERE bet_id=?`).run(type === 'refund' ? 'refunded' : 'settled', amount, betId));
            }
            return { type: `provider_${type}`, transactionId, betId, roundId, currency, amount, balance: (await this.store.balance(userId)).available };
        }));
    }
    async activity(userId) {
        return (await this.db.prepare(`SELECT bet_id,round_id,stake,status,payout FROM ${this.prefix}_bets WHERE user_id=? ORDER BY sequence DESC LIMIT 50`).all(userId));
    }
}

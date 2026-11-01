import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { readConfig } from './config.js';
import { Store, fail, SESSION_SECONDS } from './store.js';
import { verifyTelegram, constantEqual, newToken } from './auth.js';
import { games, getGame, providerStatus } from './providers.js';
import { AviatorService } from './aviator.js';
import { ChickenRoadService } from './chicken-road.js';
import { TelegramClock } from './telegram-clock.js';
import { Payments } from './payments.js';
const publicDirectory = new URL('../public/', import.meta.url);
const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/payments.js', ['payments.js', 'text/javascript; charset=utf-8']],
    ['/assets/payments/cbe.png', ['assets/payments/cbe.png', 'image/png']],
    ['/assets/payments/telebirr.png', ['assets/payments/telebirr.png', 'image/png']],
    ['/assets/brand/azmera-telegram.png', ['assets/brand/azmera-telegram.png', 'image/png']],
    ['/assets/brand/azmera-wordmark.png', ['assets/brand/azmera-wordmark.png', 'image/png']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/assets/games/aviator.svg', ['assets/games/aviator.svg', 'image/svg+xml']],
    ['/assets/games/jetx.svg', ['assets/games/jetx.svg', 'image/svg+xml']],
    ['/assets/games/aviatrix.png', ['assets/games/aviatrix.png', 'image/png']],
    ['/assets/games/chicken-road.png', ['assets/games/chicken-road.png', 'image/png']],
    ['/assets/games/keno.png', ['assets/games/keno.png', 'image/png']],
]);
// Only explicitly catalogued local artwork is served; never accept a filesystem path from a request.
for (const game of games) {
    if (!game.artwork)
        continue;
    const extension = game.artwork.split('.').pop();
    const types = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
    staticFiles.set(game.artwork, [game.artwork.slice(1), types[extension]]);
}
async function rawBody(req, limit = 16384) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit)
            fail('Request too large', 413);
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
async function body(req, limit) {
    if (!(req.headers['content-type'] || '').startsWith('application/json'))
        fail('JSON content type required', 415);
    const raw = await rawBody(req, limit);
    try {
        const parsed = JSON.parse(raw.toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            fail('JSON object required');
        return parsed;
    }
    catch {
        fail('Invalid JSON');
    }
}
export async function createApp(config, store, adapter, inoutAdapter, authClock = { now: () => Math.floor(Date.now() / 1000) }) {
    const aviator = new AviatorService(store, config, adapter);
    const chickenRoad = new ChickenRoadService(store, config, inoutAdapter);
    const payments = await Payments.open(store, config);
    const providerGames = new Map([['aviator', aviator], ['chicken-road', chickenRoad]]);
    const callbacks = new Map([['/integrations/spribe/wallet', aviator], ['/integrations/inout/wallet', chickenRoad]]);
    const rateLimits = new Map();
    const server = http.createServer(async (req, res) => {
        const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
        const sessionCookie = (value, maxAge = SESSION_SECONDS) => {
            const secure = config.publicUrl.startsWith('https://');
            res.setHeader('Set-Cookie', `azmera_session=${value}; Path=/; HttpOnly; Max-Age=${maxAge}; SameSite=${secure ? 'None; Secure' : 'Lax'}`);
        };
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        const frames = [...new Set([...providerGames.values()].filter(service => service.readiness().launchReady).flatMap(service => service.settings.origins))].join(' ') || "'none'";
        res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self' https://telegram.org; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src ${frames}; object-src 'none'; base-uri 'none'; form-action 'none'`);
        try {
            const url = new URL(req.url, 'http://localhost');
            const route = url.pathname;
            if (req.method === 'GET' && staticFiles.has(route)) {
                const [filename, type] = staticFiles.get(route);
                const content = await readFile(new URL(filename, publicDirectory));
                res.writeHead(200, { 'Content-Type': type });
                res.end(content);
                return;
            }
            if (req.method === 'GET' && route === '/health') {
                (await store.db.prepare('SELECT 1').get());
                return json(200, { ok: true, mode: 'sandbox', liveReady: false, manualPayments: payments.settings.enabled, database: store.db.kind });
            }
            if (req.method === 'GET' && route === '/api/config')
                return json(200, { mode: 'sandbox', manualPayments: payments.settings.enabled, localLogin: config.localLogin, telegramConfigured: Boolean(config.botToken), botUrl: config.botUsername ? `https://t.me/${config.botUsername}` : null, games, providers: providerStatus() });
            const ip = req.socket.remoteAddress;
            const now = Date.now();
            if (rateLimits.size > 10000)
                for (const [key, val] of rateLimits)
                    if (val.until < now)
                        rateLimits.delete(key);
            const bucket = rateLimits.get(ip);
            if (bucket && bucket.until > now) {
                if (++bucket.count > 120)
                    fail('Too many requests; try again shortly', 429);
            }
            else
                rateLimits.set(ip, { until: now + 60000, count: 1 });
            if (callbacks.has(route) && req.method === 'POST') {
                const service = callbacks.get(route);
                service.ensureReady();
                // Exact response formatting and error codes belong to the future adapter.
                // Never expose our internal event schema as a guessed supplier API.
                if (typeof service.adapter.formatResponse !== 'function')
                    fail('Supplier response protocol is not implemented', 503);
                const result = await service.callback(await rawBody(req), req.headers);
                return json(200, service.adapter.formatResponse(result));
            }
            if (route === '/telegram/webhook' && req.method === 'POST') {
                if (!config.botToken || !config.webhookSecret || !constantEqual(req.headers['x-telegram-bot-api-secret-token'] || '', config.webhookSecret))
                    fail('Invalid webhook authentication', 401);
                const update = await body(req);
                if (!Number.isSafeInteger(update.update_id))
                    fail('Invalid update');
                const inserted = (await store.db.prepare('INSERT OR IGNORE INTO telegram_updates VALUES(?,?)').run(update.update_id, Date.now()));
                if (!inserted.changes)
                    return json(200, { ok: true });
                const message = update.message;
                if (message?.chat?.type !== 'private' || !Number.isSafeInteger(message.chat.id))
                    return json(200, { ok: true });
                const command = String(message.text || '').split(/\s/)[0].split('@')[0];
                if (!['/start', '/help', '/wallet', '/games'].includes(command))
                    return json(200, { ok: true });
                if (!config.publicUrl.startsWith('https://'))
                    return json(200, { method: 'sendMessage', chat_id: message.chat.id, text: 'The sandbox Mini App needs its public HTTPS URL configured.' });
                return json(200, {
                    method: 'sendMessage', chat_id: message.chat.id,
                    text: payments.settings.enabled ? 'Welcome to Azmera Bet. Open your wallet to request a CBE or Telebirr deposit or withdrawal. Payments are manually reviewed. Provider games are not connected yet.' : 'Welcome to Azmera Bet sandbox. Explore our game catalog and test wallet. All balances are test credits; no real deposits, games or payouts are connected.',
                    reply_markup: { inline_keyboard: [[{ text: 'Open sandbox', web_app: { url: config.publicUrl } }]] },
                });
            }
            if (req.method === 'POST') {
                if (req.headers.origin && req.headers.origin !== config.publicUrl)
                    fail('Origin not allowed', 403);
                if (req.headers['sec-fetch-site'] === 'cross-site')
                    fail('Cross-site request rejected', 403);
            }
            if (route === '/api/auth/local' && req.method === 'POST') {
                if (!config.localLogin || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(ip))
                    fail('Local login disabled', 403);
                await body(req);
                const user = (await store.user('local-developer', 'Developer'));
                const token = newToken();
                (await store.session(user.id, token));
                sessionCookie(token);
                return json(200, { token, user });
            }
            if (route === '/api/auth/telegram' && req.method === 'POST')
                fail('Choose Register or Log in to continue.', 410);
            if (['/api/auth/register', '/api/auth/login'].includes(route) && req.method === 'POST') {
                const data = await body(req);
                if (data.consent !== true)
                    fail('Your explicit consent is required to continue.');
                const authNow = authClock.now();
                let identity;
                try {
                    identity = verifyTelegram(data.initData, config.botToken, authNow);
                }
                catch {
                    fail('Telegram sign-in failed or expired. Close this Mini App and reopen it from the bot.', 401);
                }
                const user = route === '/api/auth/register'
                    ? (await store.register(`tg:${identity.id}`, identity.name)) : (await store.existingUser(`tg:${identity.id}`));
                const token = newToken();
                (await store.session(user.id, token));
                sessionCookie(token);
                return json(200, { token, user });
            }
            const cookieToken = /(?:^|;\s*)azmera_session=([A-Za-z0-9_-]+)(?:;|$)/.exec(req.headers.cookie || '')?.[1];
            const token = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1] || cookieToken;
            if (route === '/api/auth/logout' && req.method === 'POST') {
                await body(req);
                if (token)
                    (await store.logout(token));
                sessionCookie('', 0);
                return json(200, { ok: true });
            }
            const user = (await store.authenticate(token));
            if (!config.localLogin && user.id === 'local-developer')
                fail('Developer sign-in is disabled. Open the app through Telegram.', 401);
            const paymentPath = /^\/api\/payments\/([a-f0-9-]{36})\/(proof|cancel|receipt)$/.exec(route);
            const reviewPath = /^\/api\/admin\/payments\/([a-f0-9-]{36})\/(review|audit)$/.exec(route);
            if (req.method === 'GET' && route === '/api/payments')
                return json(200, { ...(await payments.methods()), wallet: (await payments.balance(user.id)), role: (await payments.role(user.id)), requests: (await payments.list(user.id)) });
            if (req.method === 'GET' && paymentPath?.[2] === 'receipt') {
                const receipt = (await payments.receiptFor(user.id, paymentPath[1]));
                res.writeHead(200, { 'Content-Type': receipt.type, 'Content-Disposition': `inline; filename="receipt.${receipt.type === 'image/png' ? 'png' : 'jpg'}"`, 'Content-Security-Policy': "default-src 'none'; sandbox" });
                res.end(Buffer.from(receipt.bytes));
                return;
            }
            if (req.method === 'GET' && route === '/api/admin/payments')
                return json(200, { requests: (await payments.queue(user.id)) });
            if (req.method === 'GET' && route === '/api/admin/payments/settings')
                return json(200, (await payments.settingsFor(user.id)));
            if (req.method === 'GET' && reviewPath?.[2] === 'audit')
                return json(200, { events: (await payments.auditFor(user.id, reviewPath[1])) });
            if (req.method === 'GET' && route === '/api/integrations/aviator')
                return json(200, aviator.readiness());
            if (req.method === 'GET' && route === '/api/aviator/activity')
                return json(200, { bets: (await aviator.activity(user.id)) });
            if (req.method === 'GET' && route === '/api/integrations/chicken-road')
                return json(200, chickenRoad.readiness());
            if (req.method === 'GET' && route === '/api/chicken-road/activity')
                return json(200, { bets: await chickenRoad.activity(user.id) });
            if (req.method === 'GET' && route === '/api/me')
                return json(200, { user, wallet: (await store.balance(user.id)), ...(await store.pending(user.id)), history: (await store.history(user.id)), cashWallet: (await payments.balance(user.id)), paymentRole: (await payments.role(user.id)) });
            if (req.method !== 'POST')
                fail('Route not found', 404);
            if (route.startsWith('/api/admin/payments'))
                (await payments.requireAdmin(user.id));
            const data = await body(req, paymentPath?.[2] === 'proof' ? 2850000 : 16384);
            const key = req.headers['idempotency-key'];
            if (route === '/api/payments/deposits')
                return json(200, (await payments.createDeposit(user.id, data, key)));
            if (route === '/api/payments/withdrawals')
                return json(200, (await payments.createWithdrawal(user.id, data, key)));
            if (paymentPath?.[2] === 'proof')
                return json(200, (await payments.submitProof(user.id, paymentPath[1], data, key)));
            if (paymentPath?.[2] === 'cancel')
                return json(200, (await payments.cancel(user.id, paymentPath[1], key)));
            if (reviewPath?.[2] === 'review')
                return json(200, (await payments.review(user.id, reviewPath[1], data, key)));
            if (route === '/api/admin/payments/agents')
                return json(200, (await payments.setAgent(user.id, data, key)));
            if (route === '/api/admin/payments/accounts')
                return json(200, (await payments.addAccount(user.id, data, key)));
            if (route === '/api/games/launch') {
                const game = getGame(data.gameId);
                if (game.status === 'coming-soon')
                    fail('This game is coming soon. Its provider integration is not connected.', 503);
                if (providerGames.has(game.id))
                    return json(200, { game, ...await providerGames.get(game.id).launch(user.id, key) });
                return json(200, { game, mode: 'sandbox', launchUrl: null, message: 'Use the sandbox transaction simulator. Supplier-hosted gameplay is not connected.' });
            }
            // Sandbox-only financial mutations. Live mode is rejected at startup.
            if (route === '/api/sandbox/deposits')
                return json(200, (await store.deposit(user.id, data.amount, key)));
            if (route === '/api/sandbox/bets') {
                if (getGame(data.gameId).status === 'coming-soon')
                    fail('This game is not connected and cannot accept bets.', 503);
                if (providerGames.has(data.gameId))
                    fail('Bets for this game must originate from the connected supplier game', 409);
                return json(200, (await store.bet(user.id, data.gameId, data.amount, key)));
            }
            if (route === '/api/sandbox/settlements')
                return json(200, (await store.settle(user.id, data.roundId, data.outcome, key)));
            if (route === '/api/sandbox/withdrawals')
                return json(200, (await store.withdraw(user.id, data.amount, key)));
            if (route === '/api/sandbox/withdrawal-results')
                return json(200, (await store.finishWithdrawal(user.id, data.withdrawalId, data.outcome, key)));
            fail('Route not found', 404);
        }
        catch (error) {
            if (!res.headersSent)
                json(error.status || 500, { error: error.status ? error.message : 'Unexpected server error' });
            else
                res.end();
            if (!error.status)
                console.error('Request failed:', error.message);
        }
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const config = readConfig();
    const store = await Store.open(config);
    const clock = config.botToken ? new TelegramClock() : undefined;
    const synchronize = async () => {
        if (!clock)
            return;
        try {
            await clock.sync(config.botToken);
            console.log('Telegram authentication clock synchronized');
        }
        catch {
            console.error('Telegram authentication clock unavailable; sign-in will wait for a trusted time reference.');
        }
    };
    await synchronize();
    const clockTimer = clock ? setInterval(synchronize, 300000) : null;
    clockTimer?.unref();
    const server = (await createApp(config, store, undefined, undefined, clock));
    server.listen(config.port, config.host, () => console.log(`Azmera sandbox: ${config.publicUrl} (local sign-in ${config.localLogin ? 'enabled' : 'disabled'})`));
    const shutdown = () => { clearInterval(clockTimer); server.close(async () => { (await store.close()); process.exit(0); }); };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

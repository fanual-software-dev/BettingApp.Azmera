# Azmera Bet

A runnable Telegram Mini App and bot foundation for a provider-backed betting product. **Provider gameplay remains sandbox-only.** A separate manual CBE/Telebirr payment workflow can record verified deposits and manage withdrawal reservations when enabled; bank verification and payout execution happen outside the app. Supplier games are not connected yet, and the UI is an original starter design, not a verified replica of Cassaplay. Aviator now has a dedicated integration layer and availability screen; see [SPRIBE onboarding](docs/SPRIBE-ONBOARDING.md).

Chicken Road now has the same integration foundation with an independent INOUT namespace. See [INOUT onboarding and email draft](docs/INOUT-ONBOARDING.md). Both games await official supplier access; their UI shows availability rather than a fake playable version.

## Run locally

Requires Node.js 22.13+ (tested with 22.17). No npm packages or build step are required. Node's built-in SQLite currently emits an experimental warning.

```powershell
Copy-Item .env.example .env
npm start
```

Visit `http://localhost:3000` and select **Enter local sandbox** when developer login is enabled. Add test credits, select JetX, Aviatrix or Keno, create a test stake, and choose a simulated win, loss or refund. Aviator and Chicken Road show supplier availability and do not use the generic simulator. Withdrawals reserve the amount until you simulate success or failure. Open rounds and pending payouts survive page refresh and server restart.

```powershell
npm test
```

Balances are persistent in `data/azmera.sqlite`. Money is stored as integer minor units: 100 means ETB 1.00. Simulator accounts and fixture outcomes are sandbox-only. Manual cash balances and method-specific clearing accounts are separate. `APP_MODE=live` is rejected at startup.

## Implemented

- Searchable 30-game mobile lobby, with five original integration entries and additional coming-soon titles.
- Manual CBE/Telebirr deposits and withdrawals, private receipt upload, reviewer queue, owner/agent access, receiving-account rotation and payment audit history.
- Telegram Mini App HMAC authentication and expiring bearer sessions (stored hashed on the server).
- Optional loopback-only developer login, disabled unless explicitly configured.
- Private-chat bot commands `/start`, `/help`, `/wallet`, `/games`; secret-authenticated webhook and update deduplication.
- SQLite double-entry ledger, atomic balance checks, request idempotency and conflicting-request rejection.
- Test deposit, stake, settlement, refund, withdrawal reservation and payout-result flows.
- User ownership checks, pending-operation recovery, activity history, basic rate limits and restrictive browser policy.

## Telegram setup

1. Create your bot with BotFather. Store its token in `.env`, never in source control or the Mini App.
2. Host this sandbox at a public HTTPS origin. Set `PUBLIC_APP_URL` to that origin, `ALLOW_LOCAL_LOGIN=false`, and the appropriate `HOST` for your hosting environment. Configure a TLS reverse proxy; the Node server itself serves HTTP.
3. Configure a strong `TELEGRAM_WEBHOOK_SECRET` containing Telegram-supported characters. Register `https://YOUR_HOST/telegram/webhook` through Telegram's `setWebhook` method with the same `secret_token` and `allowed_updates=["message"]`.
4. Configure the Mini App/menu button in BotFather to the public app URL. Start the bot privately and open the sandbox.

Use `npm run telegram:status` to inspect the configured bot/menu/webhook without displaying secrets. Run `npm run telegram:setup` to configure the menu and webhook for `PUBLIC_APP_URL`, save the bot username, generate a webhook secret if needed, and disable local developer login. Restart the app afterward. This registers the bot's configuration; it does not send messages on your behalf.

To test sign-in, open your bot privately in Telegram and tap **Open Azmera**. The Mini App verifies Telegram's signed launch data and shows **Signed in as [name]** and your Telegram ID. Opening the HTTPS link in an ordinary browser does not supply Telegram login data; use the **Open in Telegram** link there. No phone number or login code is needed.

The server synchronizes its authentication clock against the HTTPS response from Telegram's authenticated `getMe` endpoint at startup and every five minutes. This handles development PCs with inaccurate system time while preserving the five-minute launch-data lifetime. The reference expires after ten minutes without a successful sync; new Telegram sign-ins then return 503 until sync succeeds. No bot token or raw sign-in payload is logged. Inside Telegram, the recovery link closes the Mini App so it can be reopened from the bot with fresh launch data.

The webhook uses Telegram's supported JSON-response method invocation to send its reply. Delivery retries/outbox and monitoring need implementing before production; see the gaps document.

## API

All API bodies are JSON. Authenticated requests use `Authorization: Bearer <session>`. The browser authenticates using a persistent HttpOnly cookie; bearer authentication remains supported for integration tests and API clients. Every financial POST requires an `Idempotency-Key` (8–100 letters, digits, underscores or hyphens). Reuse that key and identical payload on retry; a changed payload gets 409. The current UI does not automatically retry uncertain requests: refresh the history before repeating a submission.

| Method | Path | Input / purpose |
|---|---|---|
| GET | `/health` | Database health and sandbox status |
| GET | `/api/config` | Game catalogue and missing-adapter status |
| POST | `/api/auth/local` | `{}`; loopback developer sign-in |
| POST | `/api/auth/register` | `{ "initData": "...", "consent": true }`; explicit account creation using verified Telegram identity |
| POST | `/api/auth/login` | `{ "initData": "...", "consent": true }`; existing account only |
| POST | `/api/auth/logout` | `{}`; revokes the current bearer session |
| GET | `/api/me` | Wallet, pending transactions and last 100 ledger entries |
| GET | `/api/integrations/aviator` | Authenticated supplier readiness; no secrets |
| GET | `/api/aviator/activity` | Authenticated Aviator bet history |
| GET | `/api/integrations/chicken-road` | Authenticated INOUT readiness; no secrets |
| GET | `/api/chicken-road/activity` | Authenticated Chicken Road bet history |
| POST | `/api/games/launch` | `{ "gameId": "aviator" }`; requires configured supplier adapter; currently 503. Other games return simulator metadata. |
| POST | `/api/sandbox/deposits` | `{ "amount": 10000 }` |
| POST | `/api/sandbox/bets` | `{ "gameId": "jetx", "amount": 1000 }`; Aviator and Chicken Road excluded |
| POST | `/api/sandbox/settlements` | `{ "roundId": "...", "outcome": "win" }`; win/loss/refund |
| POST | `/api/sandbox/withdrawals` | `{ "amount": 1000 }` |
| POST | `/api/sandbox/withdrawal-results` | `{ "withdrawalId": "...", "outcome": "paid" }`; paid/failed |
| POST | `/telegram/webhook` | Telegram update with secret-token header |

The transaction simulator uses a fixed **test fixture** of 2× stake for a win. It implements none of the suppliers' real game mathematics, random outcomes, cash-out timing or certified rules.

## Project map

- `src/server.js`: HTTP routes, webhook, authentication boundaries, static serving.
- `src/store.js`: schema, ledger and transaction state transitions.
- `src/auth.js`: Telegram verification and session-token helpers.
- `src/providers.js`: catalogue and explicit unimplemented adapter status.
- `src/provider-game.js`: shared sessions, approved launch URLs and wallet event bridge with per-provider namespaces.
- `src/aviator.js`, `src/chicken-road.js`: supplier-specific service definitions; both wire adapters still missing.
- `public/`: Mini App UI, no frontend dependencies.
- `test/`: ledger, ownership, concurrency requests, authentication and persistence checks.
- [Integration gaps](docs/INTEGRATION-GAPS.md): exact remaining dependencies and work.
- [Implementation plan](docs/IMPLEMENTATION-PLAN.md): next milestones and release criteria.

## Scope limits

Not production ready. SQLite is a single-node prototype store; production migrations, operational controls, provider adapters, payment integrations, real account verification, administrative tools and reconciliation are outstanding. Credentials alone will not unlock live mode. Keep the sandbox database separate from any future real-money ledger; never convert test credits to withdrawable funds.

### Account consent and lobby

First-time visitors see the guest lobby. Loading Telegram launch data alone never registers or logs in a visitor. After explicit login, reload or reopening restores an existing login from a persistent HttpOnly cookie and validates it against the server. Register requires the account-creation checkbox; Log in requires a deliberate button press. Existing Telegram accounts created by earlier builds can use Log in without losing wallet history. Registration consent is recorded in SQLite. New sessions last up to 30 days and survive closing and reopening the browser or Mini App when its persistent cookies are retained. Cookies use HttpOnly and Secure/SameSite=None on HTTPS (SameSite=Lax for local HTTP tests). The database stores only token hashes. Logout revokes the session and expires the cookie, including when the session has already expired. Legacy tab-only credentials are removed; users need one explicit login after this upgrade. Clearing browser data or changing the app hostname requires logging in again. The retired `/api/auth/telegram` endpoint returns 410.

The responsive lobby follows the supplied recording: dark sidebar, green navigation, promo tiles, category filters, game search and modal account screens. Azmera artwork replaces reference branding. The catalog contains 30 titles, with case-insensitive multiword search, punctuation normalization, category filters, result counts and an empty state. Provider names are omitted from card captions. Official artwork is bundled where sourced; see public/assets/games/SOURCES.md. Remaining artwork uses clearly documented title placeholders. The 25 added catalog entries are unavailable for launch and betting until integrated. Live win feeds, rewards, sports and support contacts remain unavailable; placeholders do not claim live activity.


### Manual CBE and Telebirr payments

See [manual payment operations](docs/MANUAL-PAYMENTS.md) for customer flow, reviewer access, agent assignment, daily receiving-account changes and remaining production work. Manual payment handling is separate from provider game mode. `APP_MODE=sandbox` continues to prevent live supplier gameplay; `MANUAL_PAYMENTS_ENABLED=true` enables actual manually reviewed payment requests on a separate cash ledger. Existing test credits cannot fund cash withdrawals or be converted to cash. The app does not contact CBE or Telebirr to verify or send money.

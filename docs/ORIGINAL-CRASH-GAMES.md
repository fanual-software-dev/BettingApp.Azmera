# Azmera Flight and Azmera Jet

These are original flight/jet-themed crash games, separate from the licensed Aviator and JetX catalog entries. They share the same engine and odds, with separate rounds and visual themes. No supplier affiliation is implied. The base house edge is 5%. This build includes cash support; it does not certify a production launch.

## Implemented rules

Round history uses red for 1.00–1.99x, yellow for 2.00–4.99x, green for 5.00–9.99x and magenta for 10.00x or more. Interrupted rounds remain neutral. Recent big wins refresh every 15 seconds and show up to 12 profitable, settled cash payouts of at least 1,000 ETB from rounds started within the last 24 hours. Demo balances, refunds and player identities are excluded. The displayed amount is the total payout, not net profit. When there are no qualifying payouts, the lobby shows an empty-state message rather than fabricated wins.

- 4 ETB minimum, 4,000 ETB maximum stake per slot.
- Two slots per player per round. Pending bets can be canceled before takeoff.
- 100,000 ETB maximum **total payout including stake per slot**. At the threshold, server settlement automatically cashes out if the threshold precedes the crash.
- 5% base house edge. This is the distribution parameter, not a guaranteed operator margin. Integer multiplier/payout rounding and payout caps affect realized/effective return.
- Eight-second betting phase; exponential multiplier `exp(0.12 * seconds)`, displayed in hundredths. Cash-out is determined at server processing time, never a client-supplied multiplier. A bet loses at the crash point; auto targets must be strictly below it.
- Server auto cash-out survives a closed browser. If cash-round processing stops for more than three seconds, or the clock moves backward, still-open bets are refunded and the round is marked void. Previously settled bets stand. Manual cash-outs require timely server processing.
- No fake participants, auto-repeat betting, or instant-cash claims.

Demo credits are in existing `available` accounts; customer deposits are in distinct `cash_available` accounts. A daily demo-credit action grants 1,000 test ETB idempotently in demo mode only. These credits cannot be withdrawn. `CRASH_MODE=cash` uses verified cash balances for original games; `APP_MODE=sandbox` continues to guard supplier integrations.

## Bankroll and operating controls

Before accepting each cash bet, the server debits the stake and reserves 100,000 ETB of house capital for that slot. Insufficient capacity rolls back the entire transaction. Settlement pays the user and returns the unused reserve to the house. Cash and demo ledgers remain separate. Monetary writes are serialized, balanced and idempotent; house accounts cannot go negative.

The owner's Dashboard includes **Game bankroll & controls**, showing house available/reserved balances, funding and pause/resume. Funding transfers existing verified owner cash into the house ledger; it does not create money. The owner can open the deposit flow there. Another authorized reviewer must verify that deposit because self-review is prohibited. There is no house-capital withdrawal UI.

Cash starts paused on a new database. Resuming requires at least 100,000 ETB of available capital. Pausing blocks new bets while existing bets settle. Pause state persists across restarts. The recovery worker also processes cash rounds when the service restarts in demo mode. Players explicitly acknowledge cash use each time they open a cash game.

## Verifiable round record

Before betting opens, a cryptographically random 32-byte server seed is generated. Its SHA-256 commitment is published. After settlement, the seed is revealed. Compute SHA-256 of the UTF-8 string `seed:roundId:azmera-crash-v1`; interpret the first 13 hex characters as integer h. Let N=2^52. Multiplier hundredths = max(100, min(10,000,000, floor(9500*N / (100*(N-h))))). The upper limit is 100,000x. The seed commitment is SHA-256 of the seed's lowercase hex string, not its decoded bytes.

This allows reproduction of a recorded outcome. It is not an independent RNG certification and does not prevent a malicious operator from selecting seeds before commitment. Independent entropy/seed protocol review is still required for a production fairness claim.

## Payment limits

New manual deposit requests require at least 100 ETB. A withdrawal request cannot exceed 10,000 ETB. Daily requested withdrawals are capped at 50,000 ETB per user using Ethiopian midnight (UTC+3), counting pending, processing and paid requests created that day. Canceled/rejected/failed requests release that request allowance. Transactions serialize the limit check and fund reservation to prevent concurrent bypasses. Existing smaller deposit requests retain their previous terms.

There is also a payout-day allowance. An agent must successfully **reserve payout allowance before transfer**. Claiming reserves capacity atomically, including backlogged requests. Processing claims hold capacity across midnight until paid or confirmed failed. Paid transfers count for the day their completion is recorded, so agents must record completion promptly and reconcile late bank confirmations manually. Failed transfers release capacity only after confirmation that no money was sent. Startup backfills allowances for existing processing/paid requests; reconcile legacy processing requests before launch.

The application does not execute or independently verify CBE/Telebirr transfers. Agents must verify bank records and never send money before a successful claim.

## Configuration and deployment

Render settings for original cash games:

```dotenv
APP_MODE=sandbox
CRASH_MODE=cash
DATABASE_DRIVER=postgres
DATABASE_SSL=true
ALLOW_LOCAL_LOGIN=false
MANUAL_PAYMENTS_ENABLED=true
PUBLIC_APP_URL=https://azmerabet.vercel.app
```

Keep existing secret DATABASE_URL, valid TLS CA if required, Telegram credentials, owner IDs and receiving accounts. Never put database or bot credentials in frontend code. The example environment defaults to `CRASH_MODE=demo`. Cash startup rejects SQLite, disabled TLS, local login, missing bot credentials, disabled payments and non-HTTPS public URLs.

Deploy frontend and backend together. Startup adds tables without deleting existing balances. Start paused, verify accounts and permissions, fund the house through independently reviewed deposits, and resume only after deployment checks and external launch requirements are satisfied. Use an always-running backend; sleeping services cause interruption refunds.

Authenticated server-sent events publish snapshots every second, with reconnect and polling fallback. Each user can open two streams; each instance permits 100 streams. These are protective limits, not certified capacity. Verify the deployed Vercel-to-Render path, latency and target traffic before public cash play.

## Remaining work before real-money launch

Independent math/RNG/security review, applicable operator permissions and game approvals, production capacity/network testing, backup/restore rehearsal and bank reconciliation procedures remain outstanding. The single-writer database has not been benchmarked at production crash-game traffic. The seed commitment permits reproduction but does not prevent operator seed selection before commitment. Do not describe this build as independently certified or audited. `/health` retains `liveReady: false`.

Automated tests cover cash/demo isolation, exposure limits, duplicate cash-out, concurrent payout reservations, interruption refunds, owner-only controls, authenticated streams and PostgreSQL compatibility. Mobile browser checks cover betting, cash-out and layout. Tests use disposable databases and fake identities. No real bets, payments, broadcasts or deployments are performed; local/live cash configuration is not changed by this implementation.

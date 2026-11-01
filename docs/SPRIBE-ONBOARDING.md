# Aviator / SPRIBE onboarding and integration handoff

Updated 2026-11-01. This is an operator integration, not a player account signup.

## Where to start

Go to [SPRIBE's official website](https://spribe.co/) and use its **Contact Us** commercial enquiry route. No verified public self-service developer signup, instant token generator or public game-ID catalogue was found during this research. Ask sales to provision your operator integration or refer you to a distributor they authorise for your intended market.

SPRIBE has published `sales@spribe.co` in [an official announcement](https://spribe.co/news/meet-us-at-ICE-London-2020), but that announcement is from 2019. Confirm that address through the current official website before relying on it for onboarding or sending sensitive company documents. We have not contacted sales, submitted an application or created an account on your behalf.

SPRIBE previously announced distribution with [Slotegrator](https://spribe.co/news/spribe-unites-with-slotegrator-in-distribution-deal) and [Relax Gaming](https://spribe.co/news/spribe-joins-the-powered-by-relax-partnership-program). These historical announcements do not establish today's catalogue, pricing or acceptance of your business. Request current confirmation from SPRIBE. A distributor integration uses the distributor's API, not necessarily SPRIBE's direct API.

## Message you can send

> Subject: Aviator B2B integration enquiry — Azmera Bet / Telegram Mini App
>
> We are developing Azmera Bet, a Telegram Mini App with a server-side ETB wallet. We want to integrate the original SPRIBE Aviator for real-money operation, subject to your onboarding and approval requirements.
>
> Our intended market is Ethiopia. Please confirm whether you can supply this market and support Telegram Android/iOS webviews and ETB, and whether you recommend direct integration or an authorised distributor.
>
> Please send your operator onboarding requirements, commercial terms, sandbox access procedure, API documentation and certification checklist. We need the game-launch protocol, operator/brand IDs, Aviator game identifier, authentication/signing rules, wallet callbacks, cancellation/rollback behaviour, and reconciliation APIs.
>
> We have a working Mini App and a tested internal wallet integration layer. The live provider protocol and payment integration are not yet connected. Please advise the company and operating-authorisation documents you require, along with setup fees, minimum commitments, revenue-share calculation and settlement terms.
>
> Company/legal entity: [fill in accurately]
> Contact name and business email: [fill in]
> Bot username: [fill in]
> Test app URL: [current HTTPS URL]
> Production domain: [planned permanent HTTPS domain]
> Authorisation status: [fill in accurately]

## What to obtain

| Item | What to ask | Where it belongs |
|---|---|---|
| Operator / brand / tenant ID | Exact identifiers assigned to your environment | `SPRIBE_OPERATOR_ID`; expand configuration if multiple IDs are required |
| Game ID | Exact Aviator identifier from their assigned catalogue; do not guess `aviator`, `1` or another site's ID | `SPRIBE_GAME_ID` |
| API base URL | Separate sandbox and production endpoints; launch method, path and response schema | `SPRIBE_API_BASE_URL` once the adapter exists |
| API credentials | Authentication method and credentials; may be keys, certificates or signed requests rather than a bearer token | Server secret store; `.env` for development |
| Signing specification | Exact signed bytes, headers, timestamp/replay rules, key rotation and sample signatures | Adapter implementation; secret material stays server-side |
| Game launch domains | Exact HTTPS origins, redirect destinations, iframe policy and Telegram webview support | `SPRIBE_LAUNCH_ORIGINS` and reviewed CSP |
| Wallet model | Seamless/operator wallet vs transfer wallet; balance semantics and minor units | Design confirmation before connecting |
| Callback schema | Authentication, balance, bet, win, loss, cancel, rollback, bonus and round-close messages | Supplier adapter and contract tests |
| Event ordering | Retry schedule, duplicate IDs, settlement finality, multiple bets, partial payouts, refunds before debit | State-machine changes and test fixtures |
| Currency | ETB support, amount precision, maximum stakes/payouts and settlement currency | Server validation and accounting configuration |
| Reports | Transaction/round lookup, unsettled rounds, end-of-day reports and dispute tools | Reconciliation jobs and admin tools |
| Certification | Required sandbox cases, domain/IP registration and production acceptance | Release checklist |
| Production access | Separately provisioned production secrets and approved domains | Separate production deployment/database |

The **Telegram bot token is unrelated** to any SPRIBE credential. Game session tokens are also different: our server issues a short-lived opaque session identity, and the adapter will translate that into the provider's required launch flow. There is no verified universal Aviator token or game ID.

## Code now implemented

Implementation update: shared session/wallet mechanics now reside in `src/provider-game.js`, with the SPRIBE definition in `src/aviator.js`. Chicken Road uses separate tables and transaction scope. Existing Aviator tables are unchanged.

- `src/aviator.js`: persistent opaque player mappings, hashed sessions, launch state, eight-second launch timeout, exact HTTPS origin allowlist and secret-safe launch errors.
- Internal wallet events: balance, debit, final credit (including zero-credit losses) and exact full-stake refund.
- Events bind to supplier player, game, currency, bet and round. Multiple bet IDs can share one round.
- Supplier transaction IDs are scoped and deduplicated atomically. Changed payloads conflict. Retry responses retain their original balance.
- New bets require an active game session; verified settlements for existing bets can arrive after expiry. Unknown credits are rejected without consuming their ID, allowing later retry after the debit.
- Callback entry point preserves raw request bytes for the future signature verifier; default adapter refuses all callbacks.
- `GET /api/integrations/aviator`: authenticated readiness summary; no keys or credentials exposed.
- `GET /api/aviator/activity`: player-scoped bet history, including zero-credit losses.
- `POST /api/games/launch` with `gameId=aviator`: supplier launch path, currently 503 until adapter exists.
- `POST /integrations/spribe/wallet`: provisional local route only. It is **not** a published SPRIBE protocol or a ready-to-register supplier callback. Exact routes and success/error responses may change after onboarding.
- Mini App: dedicated Aviator availability panel, provider frame container, return-to-lobby refresh and separate Aviator history. Generic user-selected simulator bets are blocked for Aviator.

Run `npm run check:aviator` for a secret-free readiness report. Exit code 1 means dependencies remain. All protocol tests currently use an explicit in-process fake adapter, not a SPRIBE sandbox or genuine provider signatures.

## Code still blocked by the supplier contract

The `UnconfiguredSpribeAdapter` deliberately does not invent an HTTP API. After we receive the actual docs we must implement:

1. Authenticated launch requests and response parsing; pass the abort signal to network requests, validate redirects and avoid logging secrets.
2. Callback signature verification against raw bytes, timestamp/replay rules and normalisation to the internal wallet event schema.
3. The supplier's exact success/error responses, retry semantics and health-check requirements. The provisional route currently uses our HTTP error handling; it is not certification-ready.
4. Any events beyond one debit and one final settlement/refund per bet: partial/multiple payouts, bonus funding, re-settlement and rollback-before-debit tombstones are not implemented.
5. Provider-specific expiry, launch recovery and idempotency rules. A repeated launch key currently returns 409; credential-bearing launch URLs are not persisted or replayed.
6. Reconciliation against supplier reports, durable event processing, operational alerts, load limits and supplier acceptance tests.

The current provider ledger intentionally uses **sandbox accounts only**. It cannot be switched to real money with environment values. A separate live deployment/ledger, verified deposits and payout processing, operating controls, account eligibility, and supplier/payment approvals remain necessary. Test credits must never become withdrawable money.

## What to share back

Share the provider's documentation files or accessible documentation URL, chosen direct/distributor route, sandbox environment details and non-secret game/operator identifiers. Put secrets directly in `.env` or the designated secret manager; do not paste them into chat. Keep `APP_MODE=sandbox` until integration acceptance and the separate production work are complete.

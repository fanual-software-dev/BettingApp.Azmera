# Chicken Road / INOUT onboarding

Updated 2026-11-01. The owner has not yet obtained an INOUT partner account or API documentation. The intended integration is the **original Chicken Road**, not Chicken Road 2.0 or another edition. Confirm the exact catalogue entry with INOUT before configuring a game ID.

## Contact

Use **partners@inout.global**, listed on [INOUT's official website](https://inout.games/en) and its [Chicken Road product page](https://inout.games/en/game/chicken-road). Request B2B/operator onboarding, not a player account. INOUT advertises a documented API and partner onboarding, but we have not obtained the private API contract or verified an instant self-service key-generation portal.

Do not use a public demo or a “Play for real” link as an operator API. Those do not connect to the Azmera ledger. INOUT must confirm that it can supply your business, intended territory, currency and Telegram distribution channel.

## Email draft

To: partners@inout.global

Subject: Chicken Road B2B Integration Enquiry — Azmera Bet / Telegram Mini App

Dear INOUT Partnerships Team,

My name is [Your Name], and I am developing Azmera Bet, a Telegram Mini App intended for the Ethiopian market. We would like to integrate your original Chicken Road game for real-money operation, subject to your onboarding and approval requirements.

We have a working development application with Telegram authentication, a mobile interface, a server-side test wallet, and an internal game-session and transaction-processing layer. We are now seeking your official API documentation and sandbox access to implement the INOUT-specific integration. The provider game and real-money payment services are not yet connected.

Could you please advise on:

- Whether you can supply our intended market and support Ethiopian Birr (ETB), including any settlement-currency requirements.
- Support for Telegram Mini Apps on Android, iOS and desktop, including approved launch methods and iframe/webview restrictions.
- Your company verification and operating-authorisation requirements, and whether direct integration or an authorised distributor is appropriate.
- Sandbox onboarding, operator/brand identifiers, the original Chicken Road game ID, API credentials and request/callback signing documentation.
- Seamless-wallet support and the protocols for authentication, balance, bets, final cash-out payouts, losses, refunds, interrupted rounds and reconciliation.
- Setup fees, minimum commitments, revenue share, settlement terms, and production certification requirements.

Please also confirm whether the original Chicken Road is the appropriate current version for a new integration, or whether you recommend a different edition. We would appreciate the next steps and an introductory call with your commercial or integration team.

Kind regards,

[Your Full Name]
[Role / Registered Company, if applicable]
Azmera Bet
[Business Email]
[Business Phone]
[Telegram Bot Username]
[Permanent Website or current development URL]

This is a draft only. No email has been sent on your behalf.

## Integration package to request

| Input | Purpose / handling |
|---|---|
| Operator / brand identifiers | Assigned by INOUT; `INOUT_OPERATOR_ID` is our initial configuration name, not a claim about their field names. |
| Original Chicken Road game ID | Store in `INOUT_CHICKEN_ROAD_GAME_ID`; do not copy a third-party site's ID. |
| Sandbox API base URL and API specification | Required to implement launch and report requests. `INOUT_API_BASE_URL` is a placeholder until the protocol is implemented. |
| Authentication credentials | Ask whether keys, secrets, signed requests or certificates are required. `INOUT_API_KEY` and `INOUT_SIGNING_SECRET` are proposed secret placeholders, not verified API requirements. |
| Signing examples | Exact raw bytes, algorithm, headers, timestamps, replay prevention and key rotation for every callback. |
| Game launch origins | Configure approved exact HTTPS origins in `INOUT_LAUNCH_ORIGINS`; ask about redirects, mobile webviews, cookies and frame restrictions. |
| Wallet lifecycle | Balance, debit, credit, cash-out, loss, cancellation, bonus, rollback and round closure messages, including intermediate step events if any. |
| Retry/finality rules | Unique transaction scope, concurrent rounds, late settlements, duplicate events, unknown bet refunds and partial/multiple payouts. |
| Currency and limits | ETB availability, amount units/precision, stake and payout limits, account restrictions and settlement currency. |
| Round recovery and reporting | Resume/close abandoned games, query unresolved bets, reconcile daily transactions and investigate disputes. |
| Acceptance and production access | Test cases, approval documents, permanent domains, uptime/network requirements and separately issued production credentials. |

A Telegram bot token cannot be used for INOUT. Supplier API credentials and short-lived player/game-session tokens serve different purposes. Never paste either kind of secret into chat or frontend files.

## Code delivered

- `src/chicken-road.js`: INOUT-specific service definition and explicitly unconfigured adapter.
- `src/provider-game.js`: shared internal session, launch-validation and ledger-event logic, used by both Aviator and Chicken Road.
- Chicken Road uses its own `chicken_road_*` player/session/bet tables and `inout:chicken-road:sandbox` transaction namespace. Aviator's existing tables/data remain intact.
- Opaque supplier player mapping, hashed game-session tokens, timeout/abort support and exact HTTPS launch-origin allowlist.
- Raw callback body preservation before future supplier signature verification.
- Authenticated event-to-ledger path supporting one debit, one final credit (including zero-credit losses), or a full-stake refund per bet. No game outcomes or cash-out multipliers are calculated by our browser.
- Ownership, currency and game matching; duplicate-request protection; active sessions for new bets and late settlement support for accepted bets.
- Independent player activity including losing bets. The UI opens the supplier frame only when an adapter is ready and the launch URL is approved.
- Browser-submitted generic simulator bets are rejected for Chicken Road and Aviator. Older simulator records remain test records and are not migrated into supplier bets.

| Route | Current behaviour |
|---|---|
| `GET /api/integrations/chicken-road` | Signed-in readiness status without secrets |
| `GET /api/chicken-road/activity` | Signed-in player's latest 50 supplier-layer bets |
| `POST /api/games/launch` with `gameId: chicken-road` | 503 until the official adapter and required configuration exist |
| `POST /integrations/inout/wallet` | Provisional local callback route; 503 by default. Not a confirmed INOUT protocol or ready-to-register endpoint. |

Run `npm run check:chicken-road`. Exit code 1 means the dependency checks are incomplete. Environment values cannot make the missing adapter ready.

## Still required before actual real-money gameplay

1. **INOUT protocol implementation:** use their docs to implement launch authentication, callback cryptographic verification, event mapping, success/error responses and report endpoints. Current automated tests use an internal fake adapter, not INOUT's service or signature algorithm.
2. **Chicken Road round semantics:** confirm how steps, cash-out, losses, reconnection, abandoned rounds and refunds are represented. We must not credit an intermediate multiplier or let a browser choose a final outcome. Partial credits, corrections and rollback-before-debit tombstones are not supported by the current internal model.
3. **Sandbox certification:** provider-hosted original game, valid signatures, duplicate/out-of-order/late events, disconnect/reconnect, insufficient funds, refunds and reporting reconciliation.
4. **Real payments:** approved merchant deposit and payout APIs; signed/independently verified payment confirmations, beneficiary checks, durable retries and payout reconciliation. These have not been connected for any game.
5. **Production release:** a separate live ledger/database, permanent HTTPS hosting, secret management, account eligibility, administrative controls, limits, monitoring, backups and supplier/payment acceptance. The current app is still sandbox-only and refuses `APP_MODE=live`.

No live funds have been collected, placed as stakes or paid out. Test credits must never be converted to real balances. This work prepares the integration; it does not complete a real-money Chicken Road deployment.

## When INOUT replies

Share the non-secret documentation link/files, chosen integration route, assigned game version and sandbox details. Store credentials directly in `.env` for development or in a managed secret store for hosting. Their reply determines the remaining adapter and state-machine changes.

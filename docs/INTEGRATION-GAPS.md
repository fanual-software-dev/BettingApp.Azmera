# Integration gap register

Updated 2026-11-01. Intended product: a real-money Telegram bot for Ethiopia, featuring Aviator, JetX, Chicken Road, Aviatrix and Keno. Current delivery: provider sandbox plus a separate manual CBE/Telebirr payment workflow. Bank verification and payouts are performed manually outside the app. No live provider or bank/payment API has been connected.

**Aviator priority update:** the supplier-independent launch/session and wallet-event layer is now implemented and tested with an internal fake adapter. Actual SPRIBE launch requests, cryptographic callback verification, response/error protocol, reconciliation and provider acceptance remain blocked on supplier documentation/access. See [SPRIBE onboarding and detailed remaining work](SPRIBE-ONBOARDING.md). Ngrok now exposes the local sandbox for Telegram testing; permanent hosting is still outstanding.

**Chicken Road update:** INOUT now has a separate service, session/player/bet namespace, callback entry point, readiness command and Mini App availability/history flow. Shared internal wallet logic lives in `src/provider-game.js`; existing Aviator data is preserved. The owner has no INOUT account/docs yet. Its actual wire adapter and cash-wallet gameplay remain unimplemented. See [INOUT onboarding and email draft](INOUT-ONBOARDING.md).

## Critical distinction

The public profile of `@Cassaplay_bot` was verified, but its authenticated application, game versions and backend suppliers were not inspected. The similarly branded `playcassa.com` points to another bot. None of its integration choices are treated as confirmed requirements. The owner subsequently supplied videos used for lobby and manual-payment layouts; those videos do not establish backend integration contracts.

## Credentials and supplier dependencies

Placeholders in `.env.example` are our proposed configuration names, not promises that a supplier authenticates with one API key. The negotiated API may use brand identifiers, signing secrets, certificates or additional credentials. All provider placeholders are currently unused; the adapters must be implemented first.

| Integration | Missing input / owner | Missing engineering | Completion evidence |
|---|---|---|---|
| Telegram | Owner: BotFather token, public HTTPS origin, webhook secret | Hosted setup, webhook registration, delivery monitoring, durable reply outbox | Real Telegram sign-in on Android/iOS/desktop; verified private-chat command replies |
| Aviator / SPRIBE | Owner + supplier: agreement, approved distribution/territory, exact game ID, sandbox/production credentials, wallet and launch docs | Direct or aggregator adapter; signatures, launch, debit/credit/refund and reconciliation | Supplier sandbox test suite and production acceptance |
| JetX / SmartSoft | Owner + supplier: agreement, JetX version, game ID, API contract and credentials | Adapter, wallet mapping, round history and settlement handling | Supplier acceptance and device compatibility tests |
| Chicken Road / INOUT | Owner + supplier: original edition targeted, agreement, game ID, API docs, credentials | Internal wallet/session layer complete; INOUT wire adapter, exact round lifecycle, cancellation and reporting outstanding | Correct version displayed; provider outcomes reconcile and supplier tests pass |
| Aviatrix | Owner + supplier: brand ID, signing secret, allowed endpoints, selected wallet model, product ID, credentials | Game launch, request signing/verification, seamless wallet callbacks, promotion and round reconciliation | Signed sandbox callbacks, duplicate/late/cancel tests accepted |
| Keno | SPRIBE Keno 80 selected; supplier game ID, credentials and rules still needed | Launch and settlement adapter | Verified supplier/version, paytable and draw timing |
| Deposits | Owner + payment provider: merchant approval, API docs, sandbox/production keys, signing material, supported ETB rails | Manual intent, proof and approval workflow implemented; bank/API verification, automated reconciliation and reversals remain | Sandbox and approved live deposit trace agrees with bank/provider records |
| Withdrawals | Owner + payment provider: payout access, beneficiary requirements, settlement limits, credentials | Manual approval/claim/reservation workflow implemented; beneficiary verification, automated payout submission and bank reconciliation remain | Success/failure/timeout cases reconcile without double payouts |
| Identity / eligibility | Owner + selected service: requirements, vendor agreement and API access | Identity checks, age/region controls, account restrictions and protected document handling | Approved checks and audit evidence |

No provider contracts, keys, fees, territory acceptance or minimum commitments have been obtained. ETB support must be confirmed for every selected integration. Do not assume that a deposit API supports withdrawals, or that an aggregator includes all five titles.

## Verified documentation versus assumptions

- [Telegram Mini Apps](https://core.telegram.org/bots/webapps): server validation of launch data and embedded web UI.
- [Telegram Bot API](https://core.telegram.org/bots/api): webhook secret header and webhook-response method calls. Register the webhook only after deployment.
- [SPRIBE](https://spribe.co/about): Aviator supplier identity. Private integration specifications still required.
- [SmartSoft JetX](https://www.smartsoftgaming.com/games/jetx): product identity; no exact wallet API contract has been acquired.
- [INOUT Chicken Road](https://www.inout.games/en/game/chicken-road): original product identity. [INOUT](https://inout.games/en) advertises a documented API; its partner specification has not been acquired.
- [Aviatrix backend](https://docs.aviatrix.bet/en/backend-integration-intro/), [wallet contract](https://docs.aviatrix.bet/en/backend-integration-wallet-api/), [frontend](https://docs.aviatrix.bet/en/frontend-integration/): public documentation exists. Seamless and transfer wallets are alternative models. This release implements neither live adapter.

Aviatrix-specific future work: validate `X-Auth-Signature`; implement `/playerInfo`, `/bet`, `/win`, promotion callbacks and required health behaviour; deduplicate by supplier transaction ID; accept valid late settlements after session expiry; handle cancellation as specified by `CancelBet`. Do not copy this protocol to other suppliers without their contract. The simulator endpoints in this repository are **not** Aviatrix-compatible endpoints.

## Engineering gaps beyond API keys

| Priority | Gap | Required work |
|---|---|---|
| P0 | Real games absent | Provider-hosted game launch, approved embedded origins, origin-checked messaging, per-device QA. No original game assets or game engines have been copied. |
| P0 | Real money absent | Separate live ledger, verified external events, provider-backed transactions, merchant reconciliation. Sandbox funding and user-chosen outcomes must not exist in the live application. |
| P0 | Live switch deliberately blocked | Implement and review a separate live configuration and routes. Never merely remove the startup guard. |
| P0 | Settlement state machine | Supplier-specific partial payouts, multiple bets, voids, duplicate/conflicting/out-of-order callbacks, delayed wins, reporting and repair tools. |
| P0 | Financial operations | Administrative roles and MFA, withdrawal review, immutable external audit records, suspicious activity handling and reconciled payout approvals. |
| P0 | Launch authorisations | Confirm current permission and provider/payment eligibility for the operator, territory and products. This is an external dependency, not enforced or resolved by code. |
| P1 | Database production design | Supabase PostgreSQL support and initial schema initialization are implemented, with concurrent multi-connection ledger tests and reconnect tests. Remaining: versioned upgrade migrations, load testing/finer-grained locking, retention and backup/restore drills. PostgreSQL currently serializes ledger writers with a transaction-scoped advisory lock. |
| P1 | Session lifecycle | Explicit Register/Log in/Log out and current-session revocation are implemented. Remaining: session/device management, key rotation, robust replay controls and recovery flows. New sessions expire after 30 days. Persistent HttpOnly cookies survive closing/reopening on the same hostname; logout revokes them. |
| P1 | Bot reliability | Durable update inbox and reply outbox, retry/backoff, retention and operational alerts. Current update IDs deduplicate, but a lost webhook reply may lose a message. |
| P1 | Browser retry UX | Persist operation keys across uncertain submissions and recover by operation lookup. Current UI generates a key per click and does not auto-retry. |
| P1 | Abuse controls | Distributed rate limits, trusted-proxy policy, per-user controls, deposit limits and automated fraud review. Current limiter is in-memory per remote IP. |
| P1 | Reporting | Searchable/paginated history, provider reconciliation jobs, unresolved round queues, accounting exports and required business reports. Zero-value losses currently appear in pending/operation state but not as ledger-entry history. |
| P1 | Operational deployment | TLS hosting, managed secrets, CI, dependency/runtime update policy, monitoring, alerting and incident procedures. |
| P1 | Player protection | Limits, self-exclusion, support and dispute handling, terms/privacy consent and product-specific requirements. |
| P2 | Reference parity | Capture exact bot navigation/screens, design spec, English/Amharic localisation, accessible UI and approved branding. Current UI is an original English prototype. |
| P2 | Commercial features | Promotions, referral accounting, VIP features and support console only after core financial correctness. |

## Never store in this document

Actual API keys, bot tokens, Telegram login codes, passwords, session URLs or personal identity documents. Use local `.env` for development and a managed secret store in hosted environments. Do not reuse the personal phone number supplied in chat as a development credential.


Catalog expansion: 30 visible titles; 25 new entries are catalog-only and reject launches and bets. Official provider artwork still needs to be supplied for entries whose `artwork` field is null in `src/providers.js`. Book of Abyssinia and Addis Air were transcribed from the owner video; supplier and exact commercial game IDs are unconfirmed. Their title cards are placeholders.


Manual payments are documented in [MANUAL-PAYMENTS.md](MANUAL-PAYMENTS.md). Only independently verified transfers should be credited. The manual cash ledger cannot be spent through sandbox game endpoints.

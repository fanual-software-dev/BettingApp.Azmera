# Implementation plan

## Milestone 1 — runnable foundation (this delivery)

Delivered: minimal Node HTTP backend, SQLite ledger, bot webhook, Telegram sign-in, mobile lobby, test transactions for all five game entries, automated correctness tests, setup guide and gap register. No third-party npm dependencies. Provider adapters are intentionally unimplemented.

## Milestone 2 — first supplier end to end

Progress: shared internal wallet/session logic now supports separate Aviator (SPRIBE) and Chicken Road (INOUT) namespaces. Both have launch/readiness/history routes and Mini App availability views. Neither official wire adapter has been implemented; partner documentation and access are outstanding. No real payment service is connected.

1. Obtain direct or aggregator access and confirm the exact catalogue. Choose the first supplier based on actual access; Aviatrix has public documentation suitable for advance design.
2. Add an explicit adapter interface: launch, authenticate callback, translate transactions and fetch round results. Keep wallet invariants in the shared ledger service.
3. Store launch sessions, provider/player mappings, external transaction IDs and raw redacted event references. Keep secrets on the backend.
4. Implement signatures, freshness rules and exact supplier response/error semantics.
5. Run supplier sandbox certification: insufficient balance, concurrent bets, duplicate and reordered events, expired sessions, cancelled rounds and uncertain responses.
6. Embed the actual hosted game and verify Telegram Android, iOS and desktop behaviour.

Acceptance: one original supplier game launches and its sandbox balance/round totals reconcile against our ledger. A genuine signed result determines winnings; users cannot select outcomes.

## Milestone 3 — payments and remaining games

1. Implement approved deposit and payout providers against sandboxes.
2. Add verified payment webhooks, durable inbox/outbox, reconciliation and beneficiary checks.
3. Preserve reservations for ambiguous payout results until independently reconciled.
4. Implement remaining supplier adapters and choose the Keno variant.
5. Add operating controls, administrative roles/MFA and review tools.

Acceptance: all five games and payment sandbox flows reconcile; no API secret reaches a browser; missing dependencies fail closed.

## Milestone 4 — production readiness

1. Build a separate production database and configuration; never promote sandbox balances.
2. Complete migrations, backups, recovery, logging, monitoring and load tests.
3. Implement account eligibility, player limits, support processes and business reporting.
4. Obtain provider and payment production approvals and resolve launch authorisation dependencies.
5. Conduct independent security and financial correctness review, then a controlled rollout with transaction limits.

Acceptance: financial reconciliation and recovery drills pass; every required external dependency has an owner and evidence of completion. Live mode is enabled only after these implementation gates are satisfied.

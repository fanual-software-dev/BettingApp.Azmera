# Manual payment operations

The deposit flow follows the supplied recording: choose CBE or Telebirr and an ETB amount, view receiving details, then choose either the Transaction ID tab or the Screenshot tab (PNG/JPEG, up to 2 MB). Only the selected proof type is required and sent; a transaction ID does not require a screenshot. The receiving account-holder name and account number are snapshotted when the request is created. Deposits remain pending until a reviewer independently verifies actual receipt of funds. No screenshot, OCR result or submitted transaction ID automatically credits a balance.

## Owner setup and agents

Set `MANUAL_PAYMENTS_ENABLED=true`, `PAYMENT_ADMIN_TELEGRAM_IDS`, and at least one complete receiving-account pair in `.env`. Owner IDs are verified Telegram user IDs, not telephone numbers. The owner registers/logs in through Telegram, opens **Wallet > Payment review**, and sees the review queue and receiving-account/agent controls.

To recruit an agent, have them register in Azmera first, then use Agents > Add an agent to search registered Telegram users by name or ID. This directory is available only to the owner. The owner can add a new CBE or Telebirr receiving account and assign that registered agent. One account is active per method. Switching accounts is transactional and affects only newly created deposits. Requests retain their original account, holder and agent, even across restarts. Environment receiving-account settings only seed initial accounts; they do not overwrite subsequent owner changes.

Agents can review their assigned deposits and claim withdrawals. Owners can review all requests. No reviewer can approve their own payment request. Disabling an agent also deactivates their receiving accounts; another receiving account must be activated for that method. An agent with processing withdrawals cannot be disabled until those payouts are resolved. Owner roles are managed in server configuration.

## Deposit review

1. Match the claimed sender, recipient and amount against the actual bank/Telebirr account history. A screenshot is supporting evidence, not confirmation.
2. Click **Approve** or **Reject**. No re-entry or confirmation checkbox is required. Clicking Approve is the reviewer's confirmation that the funds arrived; the server uses the stored amount, receiving account, sender and submitted reference.
3. Approval credits the cash wallet once and records the reviewer, decision and stored evidence in the audit trail. Submitted transaction IDs are reserved uniquely per payment method and incoming direction. Repeated requests cannot credit the same deposit again.
4. Reject leaves the balance unchanged and shows "Deposit rejected by reviewer" to the customer. The API also accepts an optional custom reason for deposits.

Screenshot-only deposits can be approved without typing a transaction ID. No bank reference is fabricated; the audit records the receipt hash. Reusing the exact image of an already approved deposit is blocked, but cropped or altered images and the same transfer submitted once as text and once as an image cannot be reliably deduplicated without a bank reference. Reviewers must reconcile against actual bank history.

Claimed transaction IDs are normalized for whitespace, hyphens and case. Screenshots are private and served only to their owner and authorized reviewers, with no-store responses. Only PNG/JPEG uploads up to 2 MB are accepted. They are stored as database BLOBs; file validation does not prove authenticity.

Cancelling an unpaid draft only closes the app request. It does not reverse a bank transfer. A cancelled/rejected request must not be treated as evidence that no external funds arrived: reconcile bank records and investigate any transfer before asking the customer to pay again.

## Withdrawal review

The customer chooses CBE or Telebirr, an amount and a receiving account/phone number. Account-holder name is no longer requested; new UI requests store it as null. Existing records keep their submitted name.

1. The user requests an amount and provides a CBE or Telebirr destination and registered name. Available cash moves to reserved cash atomically.
2. An agent claims the request. The status becomes processing, and only that reviewer can finalize it. The user can cancel before it is claimed; cancellation returns reserved funds.
3. The reviewer sends the payout manually outside this app. This code never initiates a bank transfer.
4. After confirming success, record the actual outgoing transaction ID, amount and destination and mark paid. Reserved funds are posted to the method's clearing account once.
5. Reject a pending request with a reason, or mark a processing payout failed only after independently confirming no funds were sent. Funds return to the user's cash wallet. If the payout result is uncertain, keep it processing and investigate; do not refund or send it again.

## Ledger, storage and limits

Cash balances use `cash_available` and `cash_reserved` accounts; simulator balances remain `available` and `reserved`. Provider adapters still operate only in their sandbox, and cash is not currently connected to gameplay. The two ledgers do not share spendable balances. Manual clearing accounts are split by CBE and Telebirr. All transitions use the existing balanced, idempotent SQLite transactions. Payment requests, verified reference uniqueness, agent access, account snapshots, receipt images and append-only audit events persist in the configured SQLite database.

There is a maximum of five open requests per user and twenty new requests per rolling 24 hours. Each amount must be a positive integer minor-unit value, up to the existing 1,000,000 ETB transaction ceiling. The user interface accepts two decimal places. User history shows the latest 50 requests and reviewer queues show up to 100 pending/processing requests, oldest first.

## Routes

- `GET /api/payments`: current payment-method availability, own cash balance, own requests and own review role.
- `POST /api/payments/deposits`: create a draft and snapshot the receiving account.
- `POST /api/payments/:id/proof`: submit reference and/or receipt with an optional sender name (not requested by the UI).
- `POST /api/payments/withdrawals`: reserve cash and create a payout request.
- `POST /api/payments/:id/cancel`: cancel a deposit draft or unclaimed withdrawal.
- `GET /api/payments/:id/receipt`: private authenticated receipt.
- `GET /api/admin/payments`: authorized reviewer queue.
- `POST /api/admin/payments/:id/review`: approve/reject deposits; claim/paid/failed/reject withdrawals.
- `GET /api/admin/payments/:id/audit`: authorized request audit trail.
- `GET /api/admin/payments/settings`: owner account and agent management data.
- `POST /api/admin/payments/accounts`: owner switches the active receiving account.
- `POST /api/admin/payments/agents`: owner enables/disables agent access.

All mutations require the existing idempotency header. UI retries of the same in-flight submission reuse the same key. If a response is uncertain, inspect history before creating a different request. Outgoing bank transfers themselves cannot be made idempotent by this app because they happen outside it.

## Remaining production work

There is no CBE/Telebirr API integration, automatic statement reconciliation, OCR authenticity verification, chargeback/refund automation, payment-provider notification, bank balance monitoring or treasury reconciliation. Receipts currently live in SQLite and need a private object-storage/retention policy before scaling. PostgreSQL migration, managed backups and restore drills, durable hosting instead of ngrok, reviewer step-up authentication, operational access reviews, and a recovery process for an unavailable reviewer with a processing withdrawal remain outstanding. Do not treat the test suite as verification of an actual external transfer. No money is moved during automated tests.

Daily receiving accounts: choose method and assigned agent, then search the saved account number or holder dropdown. Both selectors stay paired to the same saved account record. Use Save a new receiving account for bank details that have not been saved yet; that action also activates the account. Existing deposit requests retain their original account snapshot.

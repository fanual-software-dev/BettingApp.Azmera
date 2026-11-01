# Owner announcements

Deploy the backend to Render and frontend to Vercel. No new environment variables are required. Owners are the Telegram IDs configured in `PAYMENT_ADMIN_TELEGRAM_IDS`; payment agents and ordinary users cannot access broadcast endpoints. Keep the Telegram webhook pointing to Render.

Open Profile/Wallet → Announcements. Enter plain text (including Amharic), optionally choose a PNG/JPEG up to 2 MB, and select Preview announcement. The server saves an immutable draft and snapshots its recipients. Review the image, text and recipient count, then press Confirm and send. Creating or previewing a draft sends nothing. Delivery history refreshes every five seconds while the dialog is open. Saved drafts can be reopened. A new announcement creates a new draft; repeated confirmation cannot requeue an existing campaign.

Text limits: 4096 UTF-16 code units without an image, 1024 with an image. Images are sent as Telegram photos, not stickers. Telegram may reject unsupported image dimensions/content; such deliveries appear as failed. HTML/Markdown is not interpreted.

## Audience

Existing registered Telegram users are initially included. Going forward, authenticated private bot messages also add subscribers without requiring Mini App registration. Old unregistered visitors cannot be recovered from Telegram automatically: they must interact again. `/stop` opts out, `/start` opts back in. Blocked recipients are disabled after Telegram returns 403. Re-registering/login and restarting the app do not override an existing opt-out. Some registered Mini App users may never have granted the bot permission to message them; those attempts can fail.

## Persistence and delivery

`bot_subscribers`, `broadcasts`, `broadcast_deliveries`, and `broadcast_clock` live in the backend database (`azmera` schema on Supabase). Images persist in the draft. The backend worker processes one recipient about every 1.2 seconds, with database-coordinated claims and a global pacing clock across instances. Telegram 429 responses postpone sending according to `retry_after`, with at most five retries. No paid broadcasts are enabled.

Queue processing continues after closing the admin UI, while the backend is running. A sleeping Render service pauses delivery until it wakes; an always-running service is needed for uninterrupted delivery. Pending recipients resume after a restart. Completed means all recipients reached a final state, not that all succeeded.

Delivery counts:
- `pending`: waiting or rate limited.
- `sending`: request in progress.
- `sent`: Telegram accepted the message, not a read receipt.
- `blocked`: Telegram denied access (403); recipient disabled.
- `failed`: Telegram rejected the message or rate-limit retries were exhausted.
- `skipped`: recipient opted out before their send was claimed.
- `unknown`: timeout, server failure, or interrupted in-flight request. Telegram does not provide idempotency keys for sending, so these are not automatically retried to avoid duplicate announcements. A send already in progress cannot be recalled by `/stop`.

Tests use mock delivery; no production broadcast was sent during implementation. After deploying, review your first real announcement and confirm it yourself in the panel.

Reference: https://core.telegram.org/bots/faq#my-bot-is-hitting-limits-how-do-i-avoid-this

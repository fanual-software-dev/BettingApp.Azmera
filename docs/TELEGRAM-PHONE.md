# Telegram phone numbers

Telegram login does not contain a phone number. After explicit registration/login, accounts without a saved number see a sharing prompt. Users may decline and retry from Profile. Existing sessions can use Profile directly. Telegram 6.9 or newer is required.

The browser requests contact sharing; the number itself arrives through the authenticated Telegram webhook. Only a private, non-forwarded contact whose user ID matches its sender and chat is accepted, for an already registered account. The client cannot submit an arbitrary number. Numbers and sharing timestamps persist in `azmera.user_contacts` on PostgreSQL (or `user_contacts` on SQLite). Startup creates this table without resetting existing data. `/api/me` returns the current user's number; no public contact directory is added.

## Deployment

Deploy both frontend and backend changes. In Render set:

```text
PUBLIC_APP_URL=https://azmerabet.vercel.app
TELEGRAM_WEBHOOK_URL=https://azmerabet.onrender.com/telegram/webhook
```

Keep `TELEGRAM_BOT_TOKEN` and set a strong random `TELEGRAM_WEBHOOK_SECRET` (letters, digits, underscore or hyphen; 1–256 characters). The running backend and setup command must use the same secret. Save/redeploy, then in the Render shell run:

```sh
npm run telegram:setup -- --no-save
```

This registers the webhook on Render and keeps the menu button pointing to Vercel. It does not write a local .env file. `npm run telegram:status` shows the registered URL and whether Telegram reported a delivery error, without printing credentials. Do not register a local development webhook on the same bot afterward.

Test with your Telegram account: log in, choose Share Telegram number, approve Telegram's prompt, confirm the number appears in Profile, and reopen the app to confirm persistence. Declining must leave the account usable without a number. A pending callback or delivery failure is not treated as successful storage.

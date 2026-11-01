# Supabase PostgreSQL deployment

This is a fresh database setup. Existing SQLite users, sessions, balances, payment requests, receipts and agents are **not copied or deleted**. Every user (including the owner) must register again after cutover. Keep the old database as an archive; do not run both backends accepting payments simultaneously.

## Supabase

1. Open the existing project and select **Connect**.
2. Copy the **Session pooler** connection string (port **5432**). Use the exact host from that dialog; the hostname and username differ from direct connections. Session mode works over IPv4 and fits the persistent Render backend.
3. Replace the password placeholder with the project's database password (URL-encode special characters in it). This is not the anon key or service-role key.
4. If needed, download the database root certificate from Supabase Database Settings. Keep TLS verification enabled. The app supports a PEM certificate in `DATABASE_CA_CERT` (real newlines or literal `\n` sequences). Do not disable TLS to work around a certificate error.
5. Use a project without existing Azmera data. Startup creates the `azmera` schema and tables if absent; it never wipes existing rows. The schema is backend-only. Do not add it to Supabase's exposed Data API schemas or grant `anon`/`authenticated` access.

Official connection documentation: https://supabase.com/docs/guides/database/connecting-to-postgres
TLS documentation: https://supabase.com/docs/guides/database/psql

## Render environment

Keep the existing Telegram credentials, owner ID, public frontend URL and payment account settings. Add:

```dotenv
DATABASE_DRIVER=postgres
DATABASE_URL=postgresql://postgres.PROJECT_REF:URL_ENCODED_DATABASE_PASSWORD@EXACT_SESSION_POOLER_HOST:5432/postgres
DATABASE_SSL=true
DATABASE_POOL_SIZE=5
```

Add `DATABASE_CA_CERT` only if the certificate chain requires the Supabase root certificate. Use the certificate issued for your database, not a guessed certificate.

Remove `DATABASE_PATH` from Render. It is not used when `DATABASE_URL` is set. A Render persistent disk is no longer needed for this app's database or receipts: receipts are stored as PostgreSQL `bytea`. An old disk can remain attached while you retain the SQLite archive.

Do not put `DATABASE_URL`, the password, or a Supabase service-role key in Vercel or frontend JavaScript. The frontend continues using `/api/*` through the existing Vercel rewrite. Supabase Auth is not used: existing Telegram consent/sign-in behavior remains, with sessions now stored in PostgreSQL.

Build command: `npm ci`
Start command: `npm start`
Root directory: repository root (blank)
Node: `22.x` (pinned in package.json)
Health check: `/health`

Keep `HOST=0.0.0.0`, `PUBLIC_APP_URL=https://azmerabet.vercel.app`, `ALLOW_LOCAL_LOGIN=false`, and `APP_MODE=sandbox`. Game supplier integrations remain unchanged. Once receiving accounts and the owner ID are configured, `MANUAL_PAYMENTS_ENABLED=true` enables the manual review flow.

## Deploy and check

1. Commit and push the migration code, including package-lock.json. Disable the old deployment's payment intake before the cutover.
2. Set the environment variables above in Render, then deploy that commit. Startup initializes an empty database and seeds configured receiving accounts. It does not create user accounts or grant any starting balances.
3. Check `https://azmerabet.onrender.com/health`: it should contain `"database":"postgres"` and `"ok":true`.
4. Optionally run `npm run db:check` in the Render shell. This checks connectivity without changing application data and never prints credentials.
5. Reopen Telegram. Old SQLite sessions won't exist in the new database. Register your owner account, then confirm Payment review > Agents shows the configured receiving accounts. Re-add agents as they register.
6. Test proof upload, deposit approval, withdrawal reservation/cancellation and reconnect behavior before accepting customer transfers. Confirm the health check still reports PostgreSQL after a redeploy.

If startup fails, it does not fall back to SQLite when `DATABASE_DRIVER=postgres`. A missing/incorrect connection string, missing TLS root certificate or unreachable Supabase project must be fixed first.

## Data and concurrency design

- A small `pg` pool is used; each transaction uses exactly one checked-out connection via AsyncLocalStorage.
- Money remains integer minor units. PostgreSQL `bigint` and numeric aggregate results are checked before conversion to JavaScript numbers.
- Transactions acquire a PostgreSQL transaction-scoped advisory lock. This deliberately retains the original single-writer semantics across backend instances, protecting idempotency, balance transfers, duplicate references and state transitions. Reads remain pooled. Higher write throughput would require a reviewed move to finer-grained locking.
- PostgreSQL stores receipt bytes, consent records, session hashes, balances, audit records and provider sandbox state. The SQLite path remains available for local development.
- Application mutations and schema initialization are transactional. Existing data is never automatically truncated or reset.
- Configure Supabase backups appropriate to the project plan and test recovery. Keep database credentials backend-only.

## Local tests

`npm test` runs the ordinary suite against SQLite; PostgreSQL-specific tests are skipped unless a local test URL is provided.

To run the suite against a disposable local PostgreSQL server, set:

```dotenv
TEST_DATABASE_URL=postgresql://LOCAL_TEST_ROLE@127.0.0.1:55432/postgres
```

Then run `npm test`. The test role needs CREATE DATABASE permission. The helper creates uniquely named test databases and drops only those databases after each test. It refuses non-loopback hosts. Never use a production URL for tests. SQLite file-persistence tests continue exercising SQLite; PostgreSQL reconnect and concurrent-writer tests exercise PostgreSQL.

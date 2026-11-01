import path from 'node:path';
import { launchOrigins } from './provider-game.js';

export function readConfig(env = process.env) {
  const mode = env.APP_MODE || 'sandbox';
  if (mode !== 'sandbox') throw new Error('Live mode is not implemented. See docs/INTEGRATION-GAPS.md.');
  const host = env.HOST || '127.0.0.1';
  const localLogin = env.ALLOW_LOCAL_LOGIN === 'true';
  if (localLogin && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Local login requires a loopback HOST. Disable it before exposing the app.');
  }
  const port = Number(env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  const publicUrl = new URL(env.PUBLIC_APP_URL || `http://localhost:${port}`);
  if (!['http:', 'https:'].includes(publicUrl.protocol)) throw new Error('Invalid PUBLIC_APP_URL');
  const paymentAdmins = (env.PAYMENT_ADMIN_TELEGRAM_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (paymentAdmins.some(id => !/^[1-9]\d{0,15}$/.test(id))) throw new Error('Payment admin IDs must be numeric Telegram user IDs');
  const paymentMethods = [
    { id: 'cbe', name: 'Commercial Bank of Ethiopia', account: (env.CBE_ACCOUNT_NUMBER || '').trim(), holder: (env.CBE_ACCOUNT_HOLDER || '').trim() },
    { id: 'telebirr', name: 'Telebirr', account: (env.TELEBIRR_NUMBER || '').trim(), holder: (env.TELEBIRR_ACCOUNT_HOLDER || '').trim() },
  ];
  for (const method of paymentMethods) {
    if (Boolean(method.account) !== Boolean(method.holder)) throw new Error(`${method.id}: configure both account and holder`);
    if (method.account && !/^\+?[0-9]{9,16}$/.test(method.account)) throw new Error(`${method.id}: invalid payment account`);
    if (method.holder.length > 120) throw new Error('Payment account-holder name is too long');
  }
  const manualPaymentsEnabled = env.MANUAL_PAYMENTS_ENABLED === 'true';
  if (manualPaymentsEnabled && (!paymentAdmins.length || !paymentMethods.some(m => m.account))) throw new Error('Manual payments require a receiving account and at least one payment reviewer');
  const databaseUrl = (env.DATABASE_URL || '').trim();
  if (databaseUrl) {
    try { if (!['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) throw new Error(); }
    catch { throw new Error('DATABASE_URL must be a PostgreSQL connection URL'); }
  }
  const databaseDriver = env.DATABASE_DRIVER || (databaseUrl ? 'postgres' : 'sqlite');
  if (!['postgres', 'sqlite'].includes(databaseDriver)) throw new Error('DATABASE_DRIVER must be postgres or sqlite');
  if (databaseDriver === 'postgres' && !databaseUrl) throw new Error('DATABASE_URL is required for PostgreSQL');
  if (databaseDriver === 'sqlite' && databaseUrl) throw new Error('Remove DATABASE_URL to use SQLite');
  const databasePoolSize = Number(env.DATABASE_POOL_SIZE || 5);
  if (!Number.isInteger(databasePoolSize) || databasePoolSize < 1 || databasePoolSize > 20) throw new Error('DATABASE_POOL_SIZE must be between 1 and 20');
  if (env.DATABASE_SSL && !['true', 'false'].includes(env.DATABASE_SSL)) throw new Error('DATABASE_SSL must be true or false');
  return {
    databaseDriver, databaseUrl, databaseSsl: env.DATABASE_SSL !== 'false', databaseCa: env.DATABASE_CA_CERT || '', databasePoolSize,
    mode, host, port, localLogin, publicUrl: publicUrl.origin,
    databasePath: path.resolve(env.DATABASE_PATH || './data/azmera.sqlite'),
    payments: { enabled: manualPaymentsEnabled, admins: paymentAdmins.map(id => `tg:${id}`), methods: paymentMethods },
    botToken: env.TELEGRAM_BOT_TOKEN || '', webhookSecret: env.TELEGRAM_WEBHOOK_SECRET || '',
    botUsername: /^[A-Za-z0-9_]{5,32}$/.test(env.TELEGRAM_BOT_USERNAME || '') ? env.TELEGRAM_BOT_USERNAME : '',
    spribe: {
      operatorId: env.SPRIBE_OPERATOR_ID || '', gameId: env.SPRIBE_GAME_ID || '',
      origins: launchOrigins(env.SPRIBE_LAUNCH_ORIGINS || ''),
    },
    inout: {
      operatorId: env.INOUT_OPERATOR_ID || '', gameId: env.INOUT_CHICKEN_ROAD_GAME_ID || '',
      origins: launchOrigins(env.INOUT_LAUNCH_ORIGINS || ''),
    },
  };
}

import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Store } from '../../src/store.js';

// PostgreSQL test databases are created and dropped only on a loopback test server.
// Never point this helper at Supabase or a production database.
export async function openTestStore() {
  if (!process.env.TEST_DATABASE_URL) return Store.open(':memory:');
  const base = new URL(process.env.TEST_DATABASE_URL);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error('TEST_DATABASE_URL must use a local disposable PostgreSQL server');
  const admin = new pg.Client({ connectionString: base.href, ssl: false });
  await admin.connect();
  const name = 'azmera_test_' + randomUUID().replaceAll('-', '');
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(base); url.pathname = '/' + name;
    const config = { databaseUrl: url.href, databaseSsl: false, databasePoolSize: 5 };
    const store = await Store.open(config);
    store.testConnection = config;
    const close = store.close.bind(store);
    store.close = async () => {
      await close();
      try { await admin.query(`DROP DATABASE "${name}"`); } finally { await admin.end(); }
    };
    return store;
  } catch(error) { await admin.query(`DROP DATABASE IF EXISTS "${name}"`).catch(()=>{}); await admin.end(); throw error; }
}

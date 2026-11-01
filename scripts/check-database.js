import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/database.js';
let database;
try {
  const config = readConfig();
  database = await openDatabase(config);
  await database.prepare('SELECT 1 AS connected').get();
  console.log(`Database connection OK (${database.kind}). No application data was changed.`);
} catch(error) {
  console.error(`Database connection failed (${error.code || 'configuration/TLS error'}). Check DATABASE_URL, the Supabase connection mode and DATABASE_CA_CERT. Credentials are not printed.`);
  process.exitCode = 1;
} finally { if(database)await database.close(); }

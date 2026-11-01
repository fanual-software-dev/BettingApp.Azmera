import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { ChickenRoadService } from '../src/chicken-road.js';

const store = new Store(':memory:');
try {
  const status = new ChickenRoadService(store, readConfig()).readiness();
  console.log('Chicken Road integration readiness (no secrets displayed)');
  for (const item of status.checks) console.log(`${item.ready ? 'OK' : 'MISSING'}: ${item.label}`);
  console.log('Real money: NOT READY — INOUT API contract, verified payments and production acceptance remain.');
  if (!status.launchReady) process.exitCode = 1;
} finally { store.close(); }

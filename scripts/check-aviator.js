import { readConfig } from '../src/config.js';
import { Store } from '../src/store.js';
import { AviatorService } from '../src/aviator.js';
const store = await Store.open(':memory:');
try {
    const status = new AviatorService(store, readConfig()).readiness();
    console.log('Aviator integration readiness (no secret values displayed)');
    for (const item of status.checks)
        console.log(`${item.ready ? 'OK' : 'MISSING'}: ${item.label}`);
    console.log('Real-money readiness: NOT READY — supplier protocol, payments and production release work remain.');
    if (!status.launchReady)
        process.exitCode = 1;
}
finally {
    (await store.close());
}

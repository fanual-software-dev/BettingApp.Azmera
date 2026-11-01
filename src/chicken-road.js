import { ProviderGameService } from './provider-game.js';
import { fail } from './store.js';

// INOUT's endpoint names, signatures and response formats must come from its
// partner documentation. No fake HTTP protocol or embedded demo-money game.
export class UnconfiguredInoutAdapter {
  ready = false;
  async launch() { fail('Chicken Road supplier integration is not connected', 503); }
  async verifyCallback() { fail('INOUT callback protocol is not configured', 503); }
}

export class ChickenRoadService extends ProviderGameService {
  constructor(store, config, adapter = new UnconfiguredInoutAdapter()) {
    super(store, config, adapter, {
      prefix: 'chicken_road', configKey: 'inout', provider: 'INOUT',
      name: 'Chicken Road', gameId: 'chicken-road', scope: 'inout:chicken-road',
    });
  }
}

import { ProviderGameService } from './provider-game.js';
import { fail } from './store.js';
export { launchOrigins, validateLaunchUrl } from './provider-game.js';

export class UnconfiguredSpribeAdapter {
  ready = false;
  async launch() { fail('Aviator supplier integration is not connected', 503); }
  async verifyCallback() { fail('SPRIBE callback protocol is not configured', 503); }
}

export class AviatorService extends ProviderGameService {
  constructor(store, config, adapter = new UnconfiguredSpribeAdapter()) {
    super(store, config, adapter, {
      prefix: 'aviator', configKey: 'spribe', provider: 'SPRIBE',
      name: 'Aviator', gameId: 'aviator', scope: 'spribe',
    });
  }
}

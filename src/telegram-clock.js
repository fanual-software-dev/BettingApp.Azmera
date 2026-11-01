import { performance } from 'node:perf_hooks';

// Sign-in timestamps must be compared to a trusted clock. Development hosts can
// have a stopped Windows Time service. Anchor to authenticated Telegram HTTPS
// response time and advance with a monotonic clock (not the host wall clock).
export class TelegramClock {
  constructor({ fetchImpl = fetch, monotonic = () => performance.now(), maxAgeMs = 600_000 } = {}) {
    this.fetchImpl = fetchImpl;
    this.monotonic = monotonic;
    this.maxAgeMs = maxAgeMs;
    this.anchor = null;
  }
  async sync(botToken) {
    const started = this.monotonic();
    try {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${botToken}/getMe`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
      });
      const result = await response.json();
      const received = this.monotonic();
      const remote = Date.parse(response.headers.get('date'));
      const elapsed = received - started;
      if (!response.ok || !result.ok || !result.result?.is_bot || !Number.isFinite(remote) || elapsed < 0 || elapsed > 5000) throw new Error();
      this.anchor = { utcMs: remote + elapsed / 2, tick: received };
    } catch {
      // Never include network errors: they may contain the credential-bearing URL.
      throw new Error('Unable to synchronize Telegram authentication time');
    }
  }
  now() {
    const elapsed = this.anchor ? this.monotonic() - this.anchor.tick : Infinity;
    if (elapsed < 0 || elapsed > this.maxAgeMs) {
      throw Object.assign(new Error('Telegram sign-in is temporarily unavailable. Please try again shortly.'), { status: 503 });
    }
    return Math.floor((this.anchor.utcMs + elapsed) / 1000);
  }
}

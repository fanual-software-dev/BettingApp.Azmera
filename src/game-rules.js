export const crashRules = Object.freeze({ minStake: 400, maxStake: 400000, maxPayout: 10000000, slots: 2, houseEdgeBps: 500, waitingMs: 8000, growth: 0.12 });
export const paymentLimits = Object.freeze({ minDeposit: 10000, maxWithdrawal: 1000000, dailyWithdrawal: 5000000 });
export function ethiopianDay(now = Date.now()) {
  const start = Math.floor((now + 10800000) / 86400000) * 86400000 - 10800000;
  return [new Date(start).toISOString(), new Date(start + 86400000).toISOString()];
}

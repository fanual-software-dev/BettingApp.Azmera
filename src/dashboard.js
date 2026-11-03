import { fail } from './store.js';

// Ethiopia uses UTC+3 throughout the year. Weeks begin on Monday.
export function dashboardPeriods(now = new Date()) {
  const local = new Date(now.getTime() + 3 * 3600000);
  const y = local.getUTCFullYear(), m = local.getUTCMonth(), d = local.getUTCDate();
  const monday = d - (local.getUTCDay() + 6) % 7;
  const utc = (year, month, day) => new Date(Date.UTC(year, month, day) - 3 * 3600000).toISOString();
  return {
    daily: { start: utc(y,m,d), end: utc(y,m,d+1) },
    weekly: { start: utc(y,m,monday), end: utc(y,m,monday+7) },
    monthly: { start: utc(y,m,1), end: utc(y,m+1,1) },
    yearly: { start: utc(y,0,1), end: utc(y+1,0,1) },
  };
}
const audience = `WITH audience AS (
 SELECT id FROM users WHERE id LIKE 'tg:%' UNION SELECT id FROM bot_subscribers WHERE id LIKE 'tg:%'
), people AS (
 SELECT a.id,COALESCE(u.name,s.name,'Telegram user') AS name,c.phone,j.joined_at,
 CASE WHEN u.id IS NULL THEN 0 ELSE 1 END AS registered
 FROM audience a LEFT JOIN users u ON u.id=a.id LEFT JOIN bot_subscribers s ON s.id=a.id
 LEFT JOIN user_contacts c ON c.user_id=a.id LEFT JOIN audience_join_dates j ON j.user_id=a.id
)`;

export class Dashboard {
  constructor(store, config) { this.db = store.db; this.config = config; }
  async read(owner, { query = '', page = 1 } = {}, now = new Date()) {
    if (!this.config.payments.admins.includes(owner)) fail('Owner access required', 403);
    if (typeof query !== 'string' || query.length > 100 || !Number.isSafeInteger(page) || page < 1 || page > 100000) fail('Invalid dashboard search or page');
    const periods = dashboardPeriods(now);
    for (const range of Object.values(periods)) {
      const end = new Date(Math.min(new Date(range.end).getTime(), now.getTime() + 1)).toISOString();
      range.joined = (await this.db.prepare(`${audience} SELECT COUNT(*) AS n FROM people WHERE joined_at>=? AND joined_at<?`).get(range.start,end)).n;
      range.deposits = { total: 0, completed: 0, pending: 0, canceled: 0 };
      range.withdrawals = { total: 0, completed: 0, pending: 0, canceled: 0 };
      const rows = await this.db.prepare('SELECT kind,status,COUNT(*) AS n FROM payment_requests WHERE created_at>=? AND created_at<? GROUP BY kind,status').all(range.start,end);
      for (const row of rows) {
        const group = row.kind === 'deposit' ? range.deposits : range.withdrawals;
        const status = ['approved','paid'].includes(row.status) ? 'completed' : ['rejected','cancelled','failed'].includes(row.status) ? 'canceled' : 'pending';
        group.total += row.n; group[status] += row.n;
      }
    }
    const totals = await this.db.prepare(`${audience} SELECT COUNT(*) AS users,COALESCE(SUM(registered),0) AS registered,COALESCE(SUM(CASE WHEN joined_at IS NULL THEN 1 ELSE 0 END),0) AS unknown FROM people`).get();
    const term = '%' + query.trim().toLowerCase().replace(/[!%_]/g, c => '!' + c) + '%';
    const filter = "WHERE LOWER(name) LIKE ? ESCAPE '!' OR COALESCE(phone,'') LIKE ? ESCAPE '!' OR id LIKE ? ESCAPE '!'";
    const matched = (await this.db.prepare(`${audience} SELECT COUNT(*) AS n FROM people ${filter}`).get(term,term,term)).n;
    const users = await this.db.prepare(`${audience}, wagers AS (
      SELECT user_id,stake FROM rounds WHERE status<>'refund'
      UNION ALL SELECT user_id,stake FROM aviator_bets WHERE status<>'refunded'
      UNION ALL SELECT user_id,stake FROM chicken_road_bets WHERE status<>'refunded'
    ), wager_totals AS (SELECT user_id,SUM(stake) AS total FROM wagers GROUP BY user_id)
    SELECT people.*,COALESCE(w.total,0) AS total_wager FROM people LEFT JOIN wager_totals w ON w.user_id=people.id
    ${filter} ORDER BY LOWER(name),id LIMIT 50 OFFSET ?`).all(term,term,term,(page-1)*50);
    return { periods, totals, users, matched, page, pageSize: 50, timezone: 'Africa/Addis_Ababa', currency: 'ETB', wagerMode: 'sandbox', generatedAt: now.toISOString() };
  }
}

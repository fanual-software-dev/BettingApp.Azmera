import { createHmac, timingSafeEqual, randomBytes, createHash } from 'node:crypto';

export function constantEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

export function verifyTelegram(initData, botToken, now = Math.floor(Date.now() / 1000)) {
  if (!botToken || typeof initData !== 'string') throw new Error('Telegram authentication unavailable');
  const params = new URLSearchParams(initData);
  if (new Set(params.keys()).size !== [...params.keys()].length) throw new Error('Duplicate authentication fields');
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid Telegram signature');
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest('hex');
  if (!constantEqual(hash.toLowerCase(), expected)) throw new Error('Invalid Telegram signature');
  const date = Number(params.get('auth_date'));
  if (!Number.isSafeInteger(date) || now - date > 300 || date > now + 30) throw new Error('Expired Telegram authentication');
  const user = JSON.parse(params.get('user') || 'null');
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('Invalid Telegram user');
  return { id: String(user.id), name: String(user.first_name || 'Player').slice(0, 100) };
}

export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token) => createHash('sha256').update(token).digest('hex');

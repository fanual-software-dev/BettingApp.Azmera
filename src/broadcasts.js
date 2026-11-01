import { randomUUID } from 'node:crypto';
import { fail, operationKey } from './store.js';

export class Broadcasts {
  constructor(store, config, send) {
    this.db = store.db;
    this.config = config;
    this.send = send || (job => this.telegram(job));
  }
  async initialize() {
    await this.db.prepare("INSERT OR IGNORE INTO bot_subscribers(id,name,active,updated) SELECT id,name,1,0 FROM users WHERE id LIKE 'tg:%'").run();
    await this.db.prepare("INSERT OR IGNORE INTO broadcast_clock VALUES('global',0)").run();
  }
  owner(id) {
    if (!this.config.payments.admins.includes(id)) fail('Owner access required', 403);
  }
  async track(message) {
    const id = message?.from?.id;
    if (message?.chat?.type !== 'private' || !Number.isSafeInteger(id) || id <= 0 || message.chat.id !== id || message.from.is_bot) return;
    const command = String(message.text || '').split(/\s/)[0].split('@')[0];
    const userId = `tg:${id}`;
    const name = String(message.from.first_name || 'Telegram user').slice(0, 120);
    await this.db.prepare('INSERT OR IGNORE INTO bot_subscribers VALUES(?,?,1,?)').run(userId, name, Date.now());
    if (['/start', '/stop'].includes(command))
      await this.db.prepare('UPDATE bot_subscribers SET active=?,name=?,updated=? WHERE id=?').run(command === '/start' ? 1 : 0, name, Date.now(), userId);
  }
  async list(owner) {
    this.owner(owner);
    const recipients = (await this.db.prepare('SELECT COUNT(*) AS n FROM bot_subscribers WHERE active=1').get()).n;
    const jobs = await this.db.prepare('SELECT id,content,status,created FROM broadcasts ORDER BY created DESC LIMIT 30').all();
    for (const job of jobs) job.counts = Object.fromEntries((await this.db.prepare('SELECT status,COUNT(*) AS n FROM broadcast_deliveries WHERE broadcast_id=? GROUP BY status').all(job.id)).map(r => [r.status, r.n]));
    return { recipients, jobs };
  }
  async draft(owner, data, key) {
    this.owner(owner);
    if (!this.config.botToken) fail('Telegram bot is not configured', 503);
    operationKey(key);
    const content = typeof data.text === 'string' ? data.text.trim() : '';
    if (!content || content.length > (data.photo ? 1024 : 4096)) fail('Use 1–4096 characters, or up to 1024 with an image');
    let photo = null, type = null;
    if (data.photo) {
      type = data.photo.type;
      const encoded = data.photo.base64;
      if (!['image/png', 'image/jpeg'].includes(type) || typeof encoded !== 'string' || encoded.length > 2800000) fail('Use a PNG or JPEG image up to 2 MB');
      photo = Buffer.from(encoded, 'base64');
      if (photo.length < 24 || photo.length > 2 * 1024 * 1024 || photo.toString('base64') !== encoded) fail('Invalid image');
      if (type === 'image/png' ? !photo.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) : !(photo[0] === 255 && photo[1] === 216 && photo.at(-2) === 255 && photo.at(-1) === 217)) fail('Invalid image');
    }
    return this.db.transaction(async () => {
      const old = await this.db.prepare('SELECT * FROM broadcasts WHERE request_key=?').get(key);
      if (old) {
        if (old.owner_id !== owner || old.content !== content || old.photo_type !== type || !Buffer.from(old.photo || []).equals(photo || Buffer.alloc(0))) fail('Request key already used', 409);
        return this.preview(owner, old.id);
      }
      const id = randomUUID();
      await this.db.prepare("INSERT INTO broadcasts VALUES(?,?,?,?,?,?,'draft',?)").run(id, owner, key, content, photo, type, Date.now());
      await this.db.prepare("INSERT INTO broadcast_deliveries(broadcast_id,subscriber_id,status,updated) SELECT ?,id,'pending',? FROM bot_subscribers WHERE active=1").run(id, Date.now());
      return this.preview(owner, id);
    });
  }
  async preview(owner, id) {
    this.owner(owner);
    const row = await this.db.prepare('SELECT * FROM broadcasts WHERE id=?').get(id);
    if (!row) fail('Broadcast not found', 404);
    return { id, text: row.content, status: row.status, photo: row.photo ? { type: row.photo_type, base64: Buffer.from(row.photo).toString('base64') } : null,
      recipients: (await this.db.prepare('SELECT COUNT(*) AS n FROM broadcast_deliveries WHERE broadcast_id=?').get(id)).n };
  }
  async confirm(owner, id, consent) {
    this.owner(owner);
    if (consent !== true) fail('Confirm sending first');
    return this.db.transaction(async () => {
      const preview = await this.preview(owner, id);
      if (!preview.recipients) fail('No recipients available');
      await this.db.prepare("UPDATE broadcasts SET status='queued' WHERE id=? AND status='draft'").run(id);
      return { ok: true };
    });
  }
  async telegram(job) {
    const photo = Boolean(job.photo);
    let body, headers;
    if (photo) {
      body = new FormData();
      body.set('chat_id', job.subscriber_id.slice(3));
      body.set('caption', job.content);
      body.set('photo', new Blob([job.photo], { type: job.photo_type }), job.photo_type === 'image/png' ? 'announcement.png' : 'announcement.jpg');
    } else {
      headers = { 'Content-Type': 'application/json' };
      body = JSON.stringify({ chat_id: job.subscriber_id.slice(3), text: job.content });
    }
    try {
      const response = await fetch(`https://api.telegram.org/bot${this.config.botToken}/${photo ? 'sendPhoto' : 'sendMessage'}`, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
      return await response.json();
    } catch { return { unknown: true }; }
  }
  async tick() {
    if (!this.config.botToken) return;
    const job = await this.db.transaction(async () => {
      const now = Date.now();
      // Ambiguous sends are never automatically repeated: Telegram has no send idempotency key.
      await this.db.prepare("UPDATE broadcast_deliveries SET status='unknown' WHERE status='sending' AND updated<?").run(now - 60000);
      await this.db.prepare("UPDATE broadcasts SET status='completed' WHERE status='queued' AND NOT EXISTS(SELECT 1 FROM broadcast_deliveries d WHERE d.broadcast_id=broadcasts.id AND d.status IN ('pending','sending'))").run();
      const clock = await this.db.prepare("SELECT next_at FROM broadcast_clock WHERE id='global'").get();
      if (clock.next_at > now) return null;
      const row = await this.db.prepare("SELECT b.*,d.subscriber_id,d.attempts,s.active FROM broadcast_deliveries d JOIN broadcasts b ON b.id=d.broadcast_id JOIN bot_subscribers s ON s.id=d.subscriber_id WHERE b.status='queued' AND d.status='pending' ORDER BY b.created,d.subscriber_id LIMIT 1").get();
      if (!row) return null;
      await this.db.prepare("UPDATE broadcast_deliveries SET status=?,updated=?,attempts=attempts+1 WHERE broadcast_id=? AND subscriber_id=?").run(row.active ? 'sending' : 'skipped', now, row.id, row.subscriber_id);
      await this.db.prepare("UPDATE broadcast_clock SET next_at=? WHERE id='global'").run(now + 1100);
      return row.active ? row : null;
    });
    if (!job) return;
    let result;
    try { result = await this.send(job); } catch { result = { unknown: true }; }
    await this.db.transaction(async () => {
      let status = result.ok ? 'sent' : result.error_code === 403 ? 'blocked' : result.unknown || result.error_code >= 500 ? 'unknown' : 'failed';
      if (result.error_code === 429 && job.attempts < 5) {
        status = 'pending';
        const retry = Number(result.parameters?.retry_after);
        await this.db.prepare("UPDATE broadcast_clock SET next_at=? WHERE id='global'").run(Date.now() + (Number.isFinite(retry) ? Math.max(1, retry) : 60) * 1000);
      }
      if (status === 'blocked') await this.db.prepare('UPDATE bot_subscribers SET active=0,updated=? WHERE id=?').run(Date.now(), job.subscriber_id);
      await this.db.prepare('UPDATE broadcast_deliveries SET status=?,updated=? WHERE broadcast_id=? AND subscriber_id=?').run(status, Date.now(), job.id, job.subscriber_id);
    });
  }
}

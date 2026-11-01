import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

// Configure only this bot. Never log the token, webhook secret, or API URLs.
async function telegram(method, data = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error(`${method}: Telegram could not be reached`); }
  const result = await response.json();
  if (!result.ok) throw new Error(`${method}: Telegram rejected the request (HTTP ${response.status})`);
  return result.result;
}

function saveSettings(settings) {
  let contents = readFileSync('.env', 'utf8');
  for (const [key, value] of Object.entries(settings)) {
    const pattern = new RegExp(`^${key}=.*$`, 'm');
    const line = `${key}=${value}`;
    contents = pattern.test(contents) ? contents.replace(pattern, () => line) : `${contents.trimEnd()}\n${line}\n`;
  }
  writeFileSync('.env', contents);
}

try {
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing from .env');
  const bot = await telegram('getMe');
  console.log(`Bot: @${bot.username}`);
  if (process.argv.includes('--description')) {
    await telegram('setMyDescription', { description: 'Welcome to Azmera Bet! Explore our game catalog and manage your account in Telegram. Open Azmera to get started. 18+ only.' });
    await telegram('setMyShortDescription', { short_description: 'Azmera Bet | Your gaming hub on Telegram. Explore the catalog and manage your account. 18+.' });
    console.log('Bot description and About text updated.');
  }
  if (process.argv.includes('--apply')) {
    const url = new URL(process.env.PUBLIC_APP_URL);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('A public HTTPS app URL is required');
    const webhook = new URL(process.env.TELEGRAM_WEBHOOK_URL || `${url.origin}/telegram/webhook`);
    if (webhook.protocol !== 'https:' || webhook.username || webhook.password) throw new Error('A public HTTPS webhook URL is required');
    const noSave = process.argv.includes('--no-save');
    if (noSave && !process.env.TELEGRAM_WEBHOOK_SECRET) throw new Error('Set TELEGRAM_WEBHOOK_SECRET before configuring the deployed bot');
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET || randomBytes(32).toString('hex');
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) throw new Error('Invalid webhook secret format');
    if (!noSave) saveSettings({ TELEGRAM_BOT_USERNAME: bot.username, TELEGRAM_WEBHOOK_SECRET: secret, ALLOW_LOCAL_LOGIN: 'false' });
    await telegram('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open Azmera', web_app: { url: url.origin } } });
    await telegram('setWebhook', { url: webhook.href, secret_token: secret, allowed_updates: ['message'], drop_pending_updates: false });
    console.log(noSave ? 'Menu button and webhook configured.' : 'Menu button and webhook configured. Restart the app to load local settings.');
  }
  const menu = await telegram('getChatMenuButton');
  const hook = await telegram('getWebhookInfo');
  console.log(JSON.stringify({ botUrl: `https://t.me/${bot.username}`, menuType: menu.type, menuUrl: menu.web_app?.url || null, webhookUrl: hook.url, pendingUpdates: hook.pending_update_count, webhookHasError: Boolean(hook.last_error_date) }, null, 2));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}

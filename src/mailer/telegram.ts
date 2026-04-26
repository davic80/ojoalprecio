export interface TelegramAlertOptions {
  chatId: string;
  productName: string;
  productUrl: string;
  currentPrice: number;
  thresholdLabel: string;
  currency?: string;
  siteUrl?: string;
}

export async function sendTelegramAlert(opts: TelegramAlertOptions): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[telegram] TELEGRAM_BOT_TOKEN not set, skipping.');
    return;
  }

  const cur = `${opts.currentPrice.toFixed(2)} ${opts.currency === 'EUR' ? '€' : (opts.currency ?? '€')}`;
  const siteUrl = opts.siteUrl ?? process.env.SITE_URL ?? 'http://localhost:3000';

  const text = [
    '🔔 <b>OjoAlPrecio — Alerta de precio</b>',
    '',
    `📦 ${opts.productName}`,
    `💰 Precio actual: <b>${cur}</b>`,
    `🎯 Umbral: ${opts.thresholdLabel}`,
    '',
    `<a href="${opts.productUrl}">Ver en Amazon.es</a> · <a href="${siteUrl}">Ver historial</a>`,
  ].join('\n');

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: opts.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }

  console.log(`[telegram] Alert sent to chat ${opts.chatId} for "${opts.productName}"`);
}

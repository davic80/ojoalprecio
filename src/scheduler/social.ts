import cron from 'node-cron';
import { db } from '../db/client';
import { sql } from 'drizzle-orm';
import { affiliateUrl } from '../scraper/amazon';
import { getSetting } from '../db/settings';

const SITE_URL = process.env.SITE_URL ?? 'https://ojoalprecio.com';

async function getTelegramChannel(): Promise<string> {
  return String(await getSetting('telegram_public_channel', process.env.TELEGRAM_PUBLIC_CHANNEL ?? ''));
}

async function telegramEnabled(): Promise<boolean> {
  return !!(process.env.TELEGRAM_BOT_TOKEN && await getTelegramChannel());
}

async function sendTelegramPost(text: string): Promise<string | null> {
  const token   = process.env.TELEGRAM_BOT_TOKEN;
  const channel = await getTelegramChannel();
  if (!token || !channel) return null;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: channel, text, parse_mode: 'HTML', disable_web_page_preview: false }),
  });
  const data = await res.json() as any;
  return data.ok ? String(data.result.message_id) : null;
}

export async function getBestUnpostedDeal(): Promise<any | null> {
  const rows = await db.execute(sql`
    SELECT
      p.id, p.asin, p.name, p.url,
      ph_last.price::float       AS "currentPrice",
      ph_min.min_price::float    AS "minPrice",
      ph_med.median_price::float AS "medianPrice",
      ROUND(((1 - ph_last.price::numeric / NULLIF(ph_med.median_price::numeric, 0)) * 100)::numeric, 1) AS "pctOffMedian",
      ROUND(((1 - ph_last.price::numeric / NULLIF(ph_min.min_price::numeric, 0)) * 100)::numeric, 1)   AS "pctOffMin"
    FROM products p
    JOIN LATERAL (
      SELECT price FROM price_history WHERE product_id = p.id ORDER BY scraped_at DESC LIMIT 1
    ) ph_last ON true
    JOIN LATERAL (
      SELECT MIN(price) AS min_price FROM price_history WHERE product_id = p.id
    ) ph_min ON true
    JOIN LATERAL (
      SELECT PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY price::numeric) AS median_price
      FROM price_history WHERE product_id = p.id AND scraped_at >= NOW() - INTERVAL '30 days'
    ) ph_med ON true
    WHERE p.is_public = TRUE AND p.is_available = TRUE AND p.is_on_sale = TRUE
      AND p.id NOT IN (
        SELECT product_id FROM social_post_log
        WHERE posted_at >= NOW() - INTERVAL '7 days'
          AND product_id IS NOT NULL
      )
    ORDER BY "pctOffMedian" DESC
    LIMIT 1
  `);
  return (rows.rows as any[])[0] ?? null;
}

function buildTelegramText(deal: any): string {
  const pct   = parseFloat(deal.pctOffMedian);
  const price = parseFloat(deal.currentPrice).toFixed(2);
  const name  = deal.name ? (deal.name.length > 120 ? deal.name.slice(0, 120) + '…' : deal.name) : deal.asin;
  const amzUrl = affiliateUrl(deal.url);
  const histUrl = `${SITE_URL}/p/${deal.asin}?utm_source=telegram`;

  return [
    `👁 <b>Oferta del día</b>`,
    ``,
    `<b>${name}</b>`,
    ``,
    `💰 <b>${price} €</b>  📉 <b>−${pct.toFixed(1)}%</b> vs precio habitual`,
    ``,
    `🛒 <a href="${amzUrl}">Ver en Amazon</a>  |  📊 <a href="${histUrl}">Historial de precio</a>`,
    ``,
    `#chollos #amazon #ofertas`,
  ].join('\n');
}

export async function postDailyDeal(): Promise<void> {
  const deal = await getBestUnpostedDeal();
  if (!deal) {
    console.log('[social] No hay chollos disponibles para publicar hoy.');
    return;
  }

  const tgText = buildTelegramText(deal);

  // Telegram
  if (await telegramEnabled()) {
    try {
      const msgId = await sendTelegramPost(tgText);
      if (msgId) {
        await db.execute(sql`
          INSERT INTO social_post_log (product_id, platform, post_id, content)
          VALUES (${deal.id}, 'telegram', ${msgId}, ${tgText})
        `);
        console.log(`[social] Telegram publicado: ${msgId}`);
      }
    } catch (err) {
      console.error('[social] Error al publicar en Telegram:', err);
    }
  }
}

export const POST_HOURS = [9, 13, 21];

export function startSocialScheduler(): void {
  // Telegram enablement is checked per-run from DB; always start the cron.
  // sendDeal() will skip posting if neither token nor channel is set.
  const tz = 'Europe/Madrid';
  console.log(`[social] Scheduler activado — publica a las ${POST_HOURS.map(h => h + ':00').join(', ')} hora Madrid.`);
  cron.schedule('0 9 * * *',  () => { postDailyDeal(); }, { timezone: tz });
  cron.schedule('0 13 * * *', () => { postDailyDeal(); }, { timezone: tz });
  cron.schedule('0 21 * * *', () => { postDailyDeal(); }, { timezone: tz });
}

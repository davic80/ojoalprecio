import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';

vi.mock('../../src/scraper/amazon', async (orig) => {
  const actual = await orig<typeof import('../../src/scraper/amazon')>();
  return { ...actual, scrapeProduct: vi.fn(), affiliateUrl: (url: string) => url };
});
vi.mock('../../src/mailer',          () => ({ sendPriceAlert: vi.fn(), sendBackInStockAlert: vi.fn(), sendProductRemovedEmail: vi.fn() }));
vi.mock('../../src/mailer/telegram', () => ({ sendTelegramAlert: vi.fn(), sendTelegramBackInStock: vi.fn() }));
vi.mock('../../src/lib/product-events', () => ({ emitScrapeUpdate: vi.fn() }));

const { sendPriceAlert } = await import('../../src/mailer');
const { checkProduct } = await import('../../src/scheduler');

const result = (asin: string, price: number) => ({
  asin, name: 'Puma St Runner NL Zapatillas', price, currency: 'EUR', imageUrl: null, extraImages: [],
  url: `https://www.amazon.es/dp/${asin}`, wasPrice: null, variants: [], parentAsin: null,
  bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null, brand: null,
});

describe('price alert names the option (size / colour) it is about', () => {
  beforeEach(async () => { await resetDb(); vi.mocked(sendPriceAlert).mockClear(); });

  async function setup(label: string | null) {
    const u = (await pool.query(`INSERT INTO users (email, password_hash) VALUES ('ana@test.local','x') RETURNING id`)).rows[0].id;
    const p = (await pool.query(
      `INSERT INTO products (created_by_user_id, asin, url, name, variant_label) VALUES ($1,'B0DJC3WYTP','https://www.amazon.es/dp/B0DJC3WYTP','Puma St Runner NL Zapatillas',$2) RETURNING id`,
      [u, label])).rows[0].id;
    await pool.query(`INSERT INTO user_products (user_id, product_id) VALUES ($1,$2)`, [u, p]);
    await pool.query(`INSERT INTO alerts (product_id, user_id, alert_type, threshold_price, notification_email, notification_channel, is_active, is_default) VALUES ($1,$2,'price',40,'ana@test.local','email',TRUE,FALSE)`, [p, u]);
    return p;
  }

  it('the email carries "— <option>" in the product name', async () => {
    const id = await setup('Lona Azul Persa Puma Blanca · 43 EU');
    await checkProduct(id, 'https://www.amazon.es/dp/B0DJC3WYTP', 'Puma St Runner NL Zapatillas', 30, async () => result('B0DJC3WYTP', 33.42) as any);
    expect(sendPriceAlert).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendPriceAlert).mock.calls[0][0].productName).toBe('Puma St Runner NL Zapatillas — Lona Azul Persa Puma Blanca · 43 EU');
  });

  it('a product without option name keeps the plain name', async () => {
    const id = await setup(null);
    await checkProduct(id, 'https://www.amazon.es/dp/B0DJC3WYTP', 'Puma St Runner NL Zapatillas', 30, async () => result('B0DJC3WYTP', 33.42) as any);
    expect(vi.mocked(sendPriceAlert).mock.calls[0][0].productName).toBe('Puma St Runner NL Zapatillas');
  });
});

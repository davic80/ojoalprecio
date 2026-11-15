import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetDb } from '../helpers/db';
import { pool } from '../../src/db/client';

process.env.TZ = 'UTC';                      // the DB stores timestamps without zone; the server runs in UTC (so does CI)
process.env.SCRAPER_TIME_SCALE = '0.002';   // every wait of the loop 500x shorter

const scrape = vi.fn();
vi.mock('../../src/scraper/amazon', async (orig) => {
  const actual = await orig<typeof import('../../src/scraper/amazon')>();
  return { ...actual, scrapeProduct: (...a: unknown[]) => scrape(...a), affiliateUrl: (url: string) => url, restartBrowser: vi.fn() };
});
vi.mock('../../src/mailer',          () => ({ sendPriceAlert: vi.fn(), sendBackInStockAlert: vi.fn(), sendProductRemovedEmail: vi.fn() }));
vi.mock('../../src/mailer/telegram', () => ({ sendTelegramAlert: vi.fn(), sendTelegramBackInStock: vi.fn() }));
vi.mock('../../src/lib/product-events', () => ({ emitScrapeUpdate: vi.fn() }));
vi.mock('../../src/lib/ops-alert', () => ({ sendOpsAlert: vi.fn(async () => {}) }));

const { startScraping, stopScrapingForTests, triggerScrape, getScraperHealth } = await import('../../src/scheduler');

const asinOf = (n: number) => `B0TEST${String(n).padStart(4, '0')}`;
const result = (asin: string) => ({
  asin, name: `Producto ${asin}`, price: 20, currency: 'EUR', imageUrl: null, extraImages: [],
  url: `https://www.amazon.es/dp/${asin}`, wasPrice: null, variants: [], parentAsin: null,
  bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null, brand: null,
});
async function addProduct(n: number, lastChecked: string | null = null) {
  return (await pool.query(
    `INSERT INTO products (asin, url, name, last_checked_at) VALUES ($1,$2,$3,${lastChecked ? `NOW() - interval '${lastChecked}'` : 'NULL'}) RETURNING id`,
    [asinOf(n), `https://www.amazon.es/dp/${asinOf(n)}`, `Producto ${asinOf(n)}`])).rows[0].id as number;
}
const readings = async () => (await pool.query(`SELECT COUNT(*)::int n FROM price_history`)).rows[0].n as number;
async function until(cond: () => Promise<boolean>, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await cond()) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timeout waiting for condition');
}

describe('continuous scraping (no hourly cycles)', () => {
  beforeEach(async () => {
    await resetDb(); scrape.mockReset();
    scrape.mockImplementation(async (url: string) => { await new Promise(r => setTimeout(r, 10)); return result(url.match(/B0TEST\d{4}/)![0]); });
    await pool.query(`INSERT INTO app_settings (key, value) VALUES ('scraper_concurrency','2') ON CONFLICT (key) DO UPDATE SET value='2'`);
  });
  afterEach(() => stopScrapingForTests());

  it('reads every due product exactly once and then keeps waiting (it does not loop on fresh ones)', async () => {
    for (let i = 1; i <= 6; i++) await addProduct(i);
    startScraping();
    await until(async () => (await readings()) === 6);
    await new Promise(r => setTimeout(r, 400));          // plenty of loop turns with nothing due
    expect(scrape).toHaveBeenCalledTimes(6);
    expect(await readings()).toBe(6);
    expect(getScraperHealth().isRunning).toBe(true);     // the supervisor is still alive, just idle
    expect(getScraperHealth().stuck).toBe(false);
  });

  it('does not touch products checked recently', async () => {
    await addProduct(1, '5 minutes');   // checked 5 min ago: not due (min age 59 min)
    await addProduct(2);                // never checked
    startScraping();
    await until(async () => (await readings()) === 1);
    await new Promise(r => setTimeout(r, 300));
    expect(scrape).toHaveBeenCalledTimes(1);
    expect(scrape.mock.calls[0][0]).toContain(asinOf(2));
  });

  it('serves the oldest checked first', async () => {
    await addProduct(1, '3 hours'); await addProduct(2, '9 hours'); await addProduct(3, '5 hours');
    await pool.query(`UPDATE app_settings SET value='1' WHERE key='scraper_concurrency'`);
    startScraping();
    await until(async () => (await readings()) === 3);
    expect(scrape.mock.calls.map(c => (c[0] as string).match(/B0TEST\d{4}/)![0])).toEqual([asinOf(2), asinOf(3), asinOf(1)]);
  });

  it('picks up a product added while it is running when the queue is rebuilt', async () => {
    await addProduct(1);
    startScraping();
    await until(async () => (await readings()) === 1);
    await addProduct(2);
    triggerScrape();                                      // "update queue now"
    await until(async () => (await readings()) === 2);
    expect(scrape).toHaveBeenCalledTimes(2);
  });

  it('one failing product does not stop the others', async () => {
    for (let i = 1; i <= 4; i++) await addProduct(i);
    scrape.mockImplementation(async (url: string) => {
      if (url.includes(asinOf(2))) throw new Error('page.goto: Timeout 19200ms exceeded.');
      await new Promise(r => setTimeout(r, 5)); return result(url.match(/B0TEST\d{4}/)![0]);
    });
    startScraping();
    await until(async () => (await readings()) === 3);
    await new Promise(r => setTimeout(r, 300));
    expect(await readings()).toBe(3);
    expect(scrape).toHaveBeenCalledTimes(4);              // the broken one was tried once, not in a loop
  });

  it('starting twice does not start a second supervisor', async () => {
    for (let i = 1; i <= 3; i++) await addProduct(i);
    expect(startScraping()).toBe(true);
    expect(startScraping()).toBe(false);
    await until(async () => (await readings()) === 3);
    await new Promise(r => setTimeout(r, 200));
    expect(scrape).toHaveBeenCalledTimes(3);
  });
});

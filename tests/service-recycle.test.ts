import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import type { ScrapeResult } from '../src/scraper/amazon';
import { remoteScrape, ExecutorUnavailableError, ExecutorRecyclingError } from '../src/scraper/remote';
import { createService } from '../src/scraper/service';

const TOKEN = 'x'.repeat(32);
const URL_OK = 'https://www.amazon.es/dp/B0F7TM92ZM?th=1&psc=1';
const result = (): ScrapeResult => ({
  asin: 'B0F7TM92ZM', name: 'Mancuernas', price: 30.33, currency: 'EUR', imageUrl: null, extraImages: [],
  url: URL_OK, wasPrice: null, variants: [], bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null, brand: null,
} as ScrapeResult);

describe('the scrape service recycles itself instead of waiting for the kernel to kill it', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>(r => { server ? server.close(() => r()) : r(); server = null; }));

  async function start(recycle: Parameters<typeof createService>[0]['recycle'], scrape = async () => result(), concurrency = 1) {
    server = http.createServer(createService({ token: TOKEN, scrape, concurrency, recycle }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return { name: 't', baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, token: TOKEN };
  }

  it('after the memory limit: finishes that scrape, exits once, and turns new work away as "recycling"', async () => {
    let rss = 100; const whys: string[] = [];
    const cfg = await start({ maxRssMb: 700, getRssMb: () => rss, onRecycle: w => whys.push(w) });
    expect((await remoteScrape(cfg, URL_OK, 30)).price).toBe(30.33);
    expect(whys).toEqual([]);
    rss = 750;
    expect((await remoteScrape(cfg, URL_OK, 30)).price).toBe(30.33);   // the one that crossed the limit still answers
    expect(whys).toHaveLength(1);
    expect(whys[0]).toContain('memoria 750');
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorRecyclingError);
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorUnavailableError);   // still an executor problem for old callers
    expect(whys).toHaveLength(1);                                                                    // never fires twice
  });

  it('as a safety net it also recycles after N scrapes', async () => {
    const whys: string[] = [];
    const cfg = await start({ maxServed: 3, getRssMb: () => 50, onRecycle: w => whys.push(w) });
    for (let i = 0; i < 3; i++) await remoteScrape(cfg, URL_OK, 30);
    expect(whys).toHaveLength(1);
    expect(whys[0]).toContain('3 consultas');
  });

  it('waits for scrapes still running before exiting', async () => {
    let rss = 800; const whys: string[] = []; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    const cfg = await start({ maxRssMb: 700, getRssMb: () => rss, onRecycle: w => whys.push(w) }, async () => { n++; if (n === 1) await gate; return result(); }, 2);
    const slow = remoteScrape(cfg, URL_OK, 30);   // 1st scrape: held open
    await new Promise(r => setTimeout(r, 50));
    await remoteScrape(cfg, URL_OK, 30);          // 2nd finishes and crosses the limit while the 1st is still running
    await new Promise(r => setTimeout(r, 100));
    expect(whys).toEqual([]);                      // not yet: one scrape in flight
    release(); await slow;
    expect(whys).toHaveLength(1);
  });

  it('gives up waiting after the drain time (a stuck scrape cannot keep a leaking process alive forever)', async () => {
    const whys: string[] = []; let n = 0;
    const cfg = await start({ maxRssMb: 1, getRssMb: () => 500, drainMs: 60, onRecycle: w => whys.push(w) },
      async () => { n++; if (n === 1) await new Promise(r => setTimeout(r, 400)); return result(); }, 2);
    const stuck = remoteScrape(cfg, URL_OK, 30);
    await new Promise(r => setTimeout(r, 30));
    await remoteScrape(cfg, URL_OK, 30);           // finishes fast, crosses the limit, the first is still running
    expect(whys).toEqual([]);
    await new Promise(r => setTimeout(r, 120));
    expect(whys).toHaveLength(1);
    expect(whys[0]).toContain('drenaje agotado');
    await stuck;
    expect(whys).toHaveLength(1);
  });

  it('is off when no limits are configured', async () => {
    const whys: string[] = [];
    const cfg = await start({ maxRssMb: 0, maxServed: 0, getRssMb: () => 99999, onRecycle: w => whys.push(w) });
    for (let i = 0; i < 3; i++) await remoteScrape(cfg, URL_OK, 30);
    expect(whys).toEqual([]);
  });
});

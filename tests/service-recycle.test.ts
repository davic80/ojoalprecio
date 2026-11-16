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
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('the scrape service recycles itself (flag → finish the running work → restart) instead of waiting for the kernel to kill it', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>(r => { server ? server.close(() => r()) : r(); server = null; }));

  async function start(recycle: Parameters<typeof createService>[0]['recycle'], scrape = async () => result(), concurrency = 1) {
    server = http.createServer(createService({ token: TOKEN, scrape, concurrency, recycle }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    return { name: 't', baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, token: TOKEN };
  }

  it('over the memory limit: the scrape that crossed it still answers, then the service says "recycling" and exits once, after the grace', async () => {
    let rss = 100; const whys: string[] = []; let n = 0;
    const cfg = await start({ maxRssMb: 700, graceMs: 120, getRssMb: () => rss, onRecycle: w => whys.push(w) },
      async () => { n++; if (n === 2) rss = 750; return result(); });      // memory grows DURING the 2nd scrape
    expect((await remoteScrape(cfg, URL_OK, 30)).price).toBe(30.33);
    expect(whys).toEqual([]);
    expect((await remoteScrape(cfg, URL_OK, 30)).price).toBe(30.33);   // this one is not lost: it was already being served
    expect(whys).toEqual([]);                                          // idle, but still in the grace period: the port answers
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorRecyclingError);   // quiet "restarting", not a failure
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorUnavailableError);  // still an executor problem for old callers
    await wait(250);
    expect(whys).toHaveLength(1);
    expect(whys[0]).toContain('memoria 750');
    await wait(150);
    expect(whys).toHaveLength(1);                                      // never fires twice
  });

  it('the flag is raised when a request ARRIVES over the limit: that request is turned away (not started and then killed)', async () => {
    let rss = 100; const whys: string[] = []; let n = 0;
    const cfg = await start({ maxRssMb: 700, graceMs: 20, getRssMb: () => rss, onRecycle: w => whys.push(w) }, async () => { n++; return result(); });
    await remoteScrape(cfg, URL_OK, 30);
    rss = 900;                                                         // grew while idle / between scrapes
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorRecyclingError);
    expect(n).toBe(1);                                                 // the scrape did not start
    await wait(80);
    expect(whys).toHaveLength(1);
  });

  it('as a safety net it also recycles after N scrapes', async () => {
    const whys: string[] = [];
    const cfg = await start({ maxServed: 3, graceMs: 10, getRssMb: () => 50, onRecycle: w => whys.push(w) });
    for (let i = 0; i < 3; i++) await remoteScrape(cfg, URL_OK, 30);
    await wait(60);
    expect(whys).toHaveLength(1);
    expect(whys[0]).toContain('3 consultas');
  });

  it('never exits with a scrape half done: it waits for the running ones', async () => {
    let rss = 100; const whys: string[] = []; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    let n = 0;
    const cfg = await start({ maxRssMb: 700, graceMs: 10, getRssMb: () => rss, onRecycle: w => whys.push(w) }, async () => { n++; if (n === 1) await gate; return result(); }, 2);
    const slow = remoteScrape(cfg, URL_OK, 30);   // 1st scrape: held open
    await wait(50);
    rss = 800;                                     // memory crosses the limit while it runs
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorRecyclingError);   // the next one is turned away
    await wait(150);
    expect(whys).toEqual([]);                      // not yet: one scrape in flight
    release();
    expect((await slow).price).toBe(30.33);        // the held one is delivered, not lost
    await wait(60);
    expect(whys).toHaveLength(1);
  });

  it('gives up waiting after the drain time (a stuck scrape cannot keep a leaking process alive forever)', async () => {
    let rss = 100; const whys: string[] = []; let n = 0;
    const cfg = await start({ maxRssMb: 700, getRssMb: () => rss, drainMs: 60, graceMs: 10, onRecycle: w => whys.push(w) },
      async () => { n++; if (n === 1) await wait(400); return result(); }, 2);
    const stuck = remoteScrape(cfg, URL_OK, 30);
    await wait(30);
    rss = 900;
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorRecyclingError);   // flagged on arrival; the first is still running
    expect(whys).toEqual([]);
    await wait(120);
    expect(whys).toHaveLength(1);
    expect(whys[0]).toContain('drenaje agotado');
    await stuck;
    expect(whys).toHaveLength(1);
  });

  it('drain() (what SIGTERM calls): turns new work away, lets the running scrape finish, then exits once', async () => {
    const whys: string[] = []; let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const svc = createService({ token: TOKEN, scrape: async () => { await gate; return result(); }, concurrency: 1,
      recycle: { maxRssMb: 0, maxServed: 0, graceMs: 10, getRssMb: () => 50, onRecycle: w => whys.push(w) } });
    server = http.createServer(svc);
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const cfg = { name: 't', baseUrl: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, token: TOKEN };
    const running = remoteScrape(cfg, URL_OK, 30);
    await wait(40);
    svc.drain('SIGTERM'); svc.drain('SIGTERM');                      // twice: harmless
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorRecyclingError);
    await wait(100);
    expect(whys).toEqual([]);                                        // a scrape is still running: do not exit
    release();
    expect((await running).price).toBe(30.33);                       // and it is delivered, not cut
    await wait(60);
    expect(whys).toEqual(['SIGTERM']);
  });

  it('is off when no limits are configured', async () => {
    const whys: string[] = [];
    const cfg = await start({ maxRssMb: 0, maxServed: 0, graceMs: 10, getRssMb: () => 99999, onRecycle: w => whys.push(w) });
    for (let i = 0; i < 3; i++) await remoteScrape(cfg, URL_OK, 30);
    await wait(60);
    expect(whys).toEqual([]);
  });
});

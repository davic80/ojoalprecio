import { describe, it, expect, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { ProductUnavailableError, CaptchaDetectedError, WrongLocationError, type ScrapeResult } from '../src/scraper/amazon';
import { serializeError, rebuildError } from '../src/scraper/wire';
import { remoteScrape, parseRemotes, ExecutorUnavailableError } from '../src/scraper/remote';
import { createService, tokensMatch } from '../src/scraper/service';
import { Breaker } from '../src/scheduler/executors';

const TOKEN = 'x'.repeat(32);
const result = (o: Partial<ScrapeResult> = {}): ScrapeResult => ({
  asin: 'B0F7TM92ZM', name: 'Mancuernas', price: 30.33, currency: 'EUR', imageUrl: null, extraImages: [],
  url: 'https://www.amazon.es/dp/B0F7TM92ZM', wasPrice: 33.7, variants: [], bsrValue: null, bsrCategory: null,
  reviewCount: null, boughtLastMonth: null, brand: null, ...o,
});

describe('wire: errors survive the trip with their class and fields', () => {
  it('ProductUnavailableError keeps reason, snippet and product name', () => {
    const back = rebuildError(serializeError(new ProductUnavailableError('no existe', 'gone', 'snip', 'Sonos'))) as ProductUnavailableError;
    expect(back).toBeInstanceOf(ProductUnavailableError);
    expect([back.message, back.reason, back.snippet, back.productName]).toEqual(['no existe', 'gone', 'snip', 'Sonos']);
  });
  it('captcha, wrong-location and generic errors map to their own classes', () => {
    expect(rebuildError(serializeError(new CaptchaDetectedError('bloqueo')))).toBeInstanceOf(CaptchaDetectedError);
    expect(rebuildError(serializeError(new WrongLocationError('Alemania')))).toBeInstanceOf(WrongLocationError);
    const g = rebuildError(serializeError(new Error('Título no encontrado')));
    expect(g.constructor).toBe(Error);
    expect(g.message).toBe('Título no encontrado');
    expect(rebuildError(serializeError('texto suelto')).message).toBe('texto suelto');
  });
  it('an unknown reason from a newer/foreign service is dropped, not trusted', () => {
    const back = rebuildError({ name: 'ProductUnavailableError', message: 'x', reason: 'hacked' }) as ProductUnavailableError;
    expect(back.reason).toBeUndefined();
  });
});

describe('parseRemotes', () => {
  it('parses name|url pairs and needs a token', () => {
    expect(parseRemotes('pi|http://100.99.209.115:8890/', 'tok')).toEqual([{ name: 'pi', baseUrl: 'http://100.99.209.115:8890', token: 'tok' }]);
    expect(parseRemotes('pi|http://a:1, b|http://b:2', 't').map(r => r.name)).toEqual(['pi', 'b']);
    expect(parseRemotes('pi|http://a:1', undefined)).toEqual([]);
    expect(parseRemotes(undefined, 't')).toEqual([]);
    expect(parseRemotes('pi|ftp://nope', 't')).toEqual([]);
  });
});

describe('breaker', () => {
  it('opens after 3 consecutive failures, closes after the pause or on success', () => {
    const b = new Breaker(3, 1000);
    expect(b.failure(0)).toBe(false); expect(b.failure(1)).toBe(false);
    expect(b.isOpen(2)).toBe(false);
    expect(b.failure(2)).toBe(true);
    expect(b.isOpen(500)).toBe(true);
    expect(b.isOpen(1002)).toBe(false);
    b.failure(3000); b.success();
    expect(b.failure(3001)).toBe(false);   // counter was reset by the success
  });
});

describe('scrape service + remote client over real HTTP', () => {
  let server: http.Server | null = null;
  afterEach(() => new Promise<void>(r => { server ? server.close(() => r()) : r(); server = null; }));

  async function start(scrape: (u: string, t: number) => Promise<ScrapeResult>, concurrency = 1, maxQueue?: number) {
    server = http.createServer(createService({ token: TOKEN, scrape, concurrency, maxQueue }));
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r));
    const baseUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    return { name: 'test', baseUrl, token: TOKEN };
  }
  const URL_OK = 'https://www.amazon.es/dp/B0F7TM92ZM?th=1&psc=1';

  it('returns a scrape result', async () => {
    const cfg = await start(async () => result());
    const r = await remoteScrape(cfg, URL_OK, 30);
    expect(r.price).toBe(30.33);
  });

  it('forwards product-level errors with their class so the scheduler logic is unchanged', async () => {
    const cfg = await start(async () => { throw new ProductUnavailableError('No disponible', 'used', 'snip', 'X'); });
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toMatchObject({ name: 'ProductUnavailableError', reason: 'used', productName: 'X' });
    const cfg2 = await start(async () => { throw new CaptchaDetectedError('Bloqueo'); });
    await expect(remoteScrape(cfg2, URL_OK, 30)).rejects.toBeInstanceOf(CaptchaDetectedError);
  });

  it('rejects a wrong token (ExecutorUnavailable, never a product verdict)', async () => {
    const cfg = await start(async () => result());
    await expect(remoteScrape({ ...cfg, token: 'y'.repeat(32) }, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorUnavailableError);
  });

  it('is not an open proxy: only amazon.es product URLs', async () => {
    let called = 0;
    const cfg = await start(async () => { called++; return result(); });
    for (const bad of ['http://evil.test/', 'https://www.amazon.es/gp/cart', 'https://www.amazon.es.evil.test/dp/B0F7TM92ZM', 'file:///etc/passwd', 'https://www.amazon.es/dp/SHORT']) {
      const res = await fetch(`${cfg.baseUrl}/scrape`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ url: bad }) });
      expect(res.status).toBe(400);
    }
    expect(called).toBe(0);
  });

  it('answers 503 (ExecutorUnavailable) when concurrency and queue are full, then serves the queue in order', async () => {
    let release!: () => void; const gate = new Promise<void>(r => { release = r; });
    const cfg = await start(async () => { await gate; return result(); }, 1, 1);
    const a = remoteScrape(cfg, URL_OK, 30);      // runs
    const b = remoteScrape(cfg, URL_OK, 30);      // queued
    await new Promise(r => setTimeout(r, 50));
    await expect(remoteScrape(cfg, URL_OK, 30)).rejects.toBeInstanceOf(ExecutorUnavailableError);   // queue full
    release();
    expect((await a).price).toBe(30.33);
    expect((await b).price).toBe(30.33);
  });

  it('unreachable host and garbled replies are ExecutorUnavailable', async () => {
    await expect(remoteScrape({ name: 'dead', baseUrl: 'http://127.0.0.1:1', token: TOKEN }, URL_OK, 15)).rejects.toBeInstanceOf(ExecutorUnavailableError);
    const fake = async () => new Response('not json', { status: 200 });
    await expect(remoteScrape({ name: 'f', baseUrl: 'http://x', token: TOKEN }, URL_OK, 15, fake as any)).rejects.toBeInstanceOf(ExecutorUnavailableError);
    const bad = async () => new Response(JSON.stringify({ ok: true, result: { asin: 1 } }), { status: 200 });
    await expect(remoteScrape({ name: 'f', baseUrl: 'http://x', token: TOKEN }, URL_OK, 15, bad as any)).rejects.toBeInstanceOf(ExecutorUnavailableError);
  });

  it('tokensMatch compares in constant time and rejects different lengths', () => {
    expect(tokensMatch('a'.repeat(30), 'a'.repeat(30))).toBe(true);
    expect(tokensMatch('a'.repeat(30), 'a'.repeat(31))).toBe(false);
    expect(tokensMatch('', 'a')).toBe(false);
  });
});

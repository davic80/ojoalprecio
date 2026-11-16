// Entry point of the remote scrape service (same Docker image, different command):
//   node dist/scraper-service.js
//
// Env: SCRAPER_SERVICE_TOKEN (required, ≥ 24 chars), SCRAPER_SERVICE_PORT (8890),
//      SCRAPER_SERVICE_BIND (0.0.0.0 inside the container), SCRAPER_SERVICE_CONCURRENCY (1),
//      AMAZON_ZIP, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
import http from 'http';
import { scrapeProduct, closeBrowser } from './scraper/amazon';
import { createService } from './scraper/service';
import { MetricsSampler, formatSample } from './scraper/metrics';

const token = process.env.SCRAPER_SERVICE_TOKEN ?? '';
if (token.length < 24) {
  console.error('[scraper-service] SCRAPER_SERVICE_TOKEN missing or shorter than 24 characters — refusing to start.');
  process.exit(1);
}
const port = parseInt(process.env.SCRAPER_SERVICE_PORT ?? '8890', 10);
const bind = process.env.SCRAPER_SERVICE_BIND ?? '0.0.0.0';
const concurrency = Math.max(1, Math.min(4, parseInt(process.env.SCRAPER_SERVICE_CONCURRENCY ?? '1', 10)));

// Resource monitoring starts with the process: CPU/memory/swap/temperature every 10 s.
const sampler = new MetricsSampler();
sampler.start();
let served = 0;
const mb = (n: number) => Math.round(n / 1048576);
setInterval(() => {
  const s = sampler.latest(); if (s) console.log(`[metrics] ${formatSample(s)}`);
  // Where the Node process memory goes (JS heap vs Buffers vs native), to find the slow growth.
  const m = process.memoryUsage();
  console.log(`[mem] node rss=${mb(m.rss)}MB heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB external=${mb(m.external)}MB buffers=${mb(m.arrayBuffers)}MB consultas=${served}`);
}, 5 * 60 * 1000).unref();

// Recycle the process before the kernel kills it: by Node memory (what actually grows) or, as a safety net, by number of scrapes. 0 = off.
const recycleRssMb = parseInt(process.env.SCRAPER_RECYCLE_RSS_MB ?? '850', 10);
const recycleGraceMs = parseInt(process.env.SCRAPER_RECYCLE_GRACE_MS ?? '8000', 10);
const recycleAfter = parseInt(process.env.SCRAPER_RECYCLE_AFTER ?? '400', 10);
let shuttingDown = false;
function shutdown(code: number) {
  if (shuttingDown) return; shuttingDown = true;
  sampler.stop(); server.close();
  const t = setTimeout(() => process.exit(code), 15_000); t.unref();
  closeBrowser().finally(() => process.exit(code));
}

/** Planned restart: the port stays open (answering "recycling") while Chromium is closed, and only then the process exits. */
function recycleExit() {
  if (shuttingDown) return; shuttingDown = true;
  sampler.stop();
  const t = setTimeout(() => process.exit(0), 15_000); t.unref();
  closeBrowser().finally(() => { server.close(); process.exit(0); });
}

const server = http.createServer(createService({
  token,
  scrape: async (url, timeout) => { try { return await scrapeProduct(url, timeout); } finally { served++; } },
  concurrency,
  version: process.env.APP_VERSION,
  getSystem: () => sampler.latest(),
  getHistory: (n) => sampler.history(n),
  minFreeMemMb: parseInt(process.env.SCRAPER_SERVICE_MIN_FREE_MB ?? '500', 10),
  recycle: {
    maxRssMb: recycleRssMb, maxServed: recycleAfter, graceMs: recycleGraceMs,
    getRssMb: () => process.memoryUsage().rss / 1048576,
    onRecycle: (why) => { console.log(`[scraper-service] reciclando el proceso: ${why}`); recycleExit(); },
  },
}));
server.requestTimeout = 180_000;
server.listen(port, bind, () => {
  void sampler.probeDns();
  const s0 = sampler.latest();
  if (s0) console.log(`[metrics] arranque: ${formatSample(s0)}`);
  console.log(`[scraper-service] listening on ${bind}:${port} (concurrency ${concurrency}, v${process.env.APP_VERSION ?? 'dev'})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => shutdown(0));
}

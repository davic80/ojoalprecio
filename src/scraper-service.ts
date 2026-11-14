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
setInterval(() => { const s = sampler.latest(); if (s) console.log(`[metrics] ${formatSample(s)}`); }, 5 * 60 * 1000).unref();

const server = http.createServer(createService({
  token,
  scrape: (url, timeout) => scrapeProduct(url, timeout),
  concurrency,
  version: process.env.APP_VERSION,
  getSystem: () => sampler.latest(),
  getHistory: (n) => sampler.history(n),
  minFreeMemMb: parseInt(process.env.SCRAPER_SERVICE_MIN_FREE_MB ?? '500', 10),
}));
server.requestTimeout = 180_000;
server.listen(port, bind, () => {
  void sampler.probeDns();
  const s0 = sampler.latest();
  if (s0) console.log(`[metrics] arranque: ${formatSample(s0)}`);
  console.log(`[scraper-service] listening on ${bind}:${port} (concurrency ${concurrency}, v${process.env.APP_VERSION ?? 'dev'})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { sampler.stop(); server.close(); closeBrowser().finally(() => process.exit(0)); });
}

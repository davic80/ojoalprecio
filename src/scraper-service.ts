// Entry point of the remote scrape service (same Docker image, different command):
//   node dist/scraper-service.js
//
// Env: SCRAPER_SERVICE_TOKEN (required, ≥ 24 chars), SCRAPER_SERVICE_PORT (8890),
//      SCRAPER_SERVICE_BIND (0.0.0.0 inside the container), SCRAPER_SERVICE_CONCURRENCY (1),
//      AMAZON_ZIP, PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.
import http from 'http';
import { scrapeProduct, closeBrowser } from './scraper/amazon';
import { createService } from './scraper/service';

const token = process.env.SCRAPER_SERVICE_TOKEN ?? '';
if (token.length < 24) {
  console.error('[scraper-service] SCRAPER_SERVICE_TOKEN missing or shorter than 24 characters — refusing to start.');
  process.exit(1);
}
const port = parseInt(process.env.SCRAPER_SERVICE_PORT ?? '8890', 10);
const bind = process.env.SCRAPER_SERVICE_BIND ?? '0.0.0.0';
const concurrency = Math.max(1, Math.min(4, parseInt(process.env.SCRAPER_SERVICE_CONCURRENCY ?? '1', 10)));

const server = http.createServer(createService({
  token,
  scrape: (url, timeout) => scrapeProduct(url, timeout),
  concurrency,
  version: process.env.APP_VERSION,
}));
server.requestTimeout = 180_000;
server.listen(port, bind, () => {
  console.log(`[scraper-service] listening on ${bind}:${port} (concurrency ${concurrency}, v${process.env.APP_VERSION ?? 'dev'})`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { server.close(); closeBrowser().finally(() => process.exit(0)); });
}

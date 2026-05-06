import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export class ProductUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductUnavailableError';
  }
}

export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaDetectedError';
  }
}

export interface ScrapeResult {
  asin: string;
  name: string;
  price: number;
  currency: string;
  imageUrl: string | null;
  extraImages: string[];
  url: string;
}

// ── Gestión Global de Captcha ────────────────────────────────────────────────
let captchaDetectedAt: number | null = null;
const CAPTCHA_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutos de pausa si hay bloqueo

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
];

function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

export function extractAsin(url: string): string | null {
  const patterns = [
    /\/dp\/([A-Z0-9]{10})/i,
    /\/gp\/product\/([A-Z0-9]{10})/i,
    /\/exec\/obidos\/ASIN\/([A-Z0-9]{10})/i,
    /\/product\/([A-Z0-9]{10})/i,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return null;
}

export function normaliseAmazonUrl(asin: string): string {
  return `https://www.amazon.es/dp/${asin}`;
}

const AFFILIATE_TAG = 'canidrone-21';

export function affiliateUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('tag');
    u.searchParams.set('tag', AFFILIATE_TAG);
    return u.toString();
  } catch {
    return url;
  }
}

function parseSpanishPrice(raw: string): number {
  const cleaned = raw.replace(/[€$\s]/g, '').trim();
  const normalised = cleaned.replace(/\./g, '').replace(',', '.');
  return parseFloat(normalised);
}

// ── Configuración de Timeouts ────────────────────────────────────────────────
const SCRAPER_TIMEOUT_SECONDS = Math.max(15, parseInt(process.env.SCRAPER_TIMEOUT_SECONDS ?? '30', 10));
const HARD_TIMEOUT_MS         = SCRAPER_TIMEOUT_SECONDS * 1000;
const PAGE_LOAD_TIMEOUT_MS    = Math.round(HARD_TIMEOUT_MS * 0.8);
const LOCATOR_TIMEOUT_MS      = 10_000; // Aumentado para evitar fallos bajo carga
const PRICE_SELECTOR_WAIT_MS  = 4_000;
const PRICE_LOCATOR_TIMEOUT_MS = 2_000;

// ── Chromium Args optimizados para evitar saturación de CPU ──────────────────
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--disable-gpu-compositing',
  '--disable-software-rasterizer',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--disable-features=IsolateOrigins,site-per-process', 
  '--disable-site-isolation-trials',
  '--mute-audio',
  '--js-flags=--max-old-space-size=256',
];

// image y font se permiten — bloquearlos es señal de bot para Amazon
const BLOCKED_TYPES = new Set(['media', 'other', 'ping', 'beacon']);
const BLOCKED_DOMAINS = [
  'amazon-adsystem', 'fls-eu.amazon', 'telemetry', 'unagi-eu.amazon',
  'csm.amazon', 'advertising.amazon', 'analytics.amazon', 'ue.amazon.es',
];

async function optimizePageForScraping(page: Page) {
  await page.route('**/*', (route) => {
    const type = route.request().resourceType();
    const url = route.request().url();
    if (BLOCKED_TYPES.has(type) || type === 'ping' || type === 'beacon' || BLOCKED_DOMAINS.some(d => url.includes(d))) {
      return route.abort('aborted');
    }
    return route.continue();
  });
}

// ── Singleton browser ──────────────────────────────────────────────────────
const BROWSER_RECYCLE_AFTER = 500;
let _browser: Browser | null = null;
let _browserUses = 0;
let _browserLaunchPromise: Promise<Browser> | null = null;
let _storageStatePromise: Promise<any> | null = null;

function getBrowser(): Promise<Browser> {
  if (captchaDetectedAt && (Date.now() - captchaDetectedAt < CAPTCHA_COOLDOWN_MS)) {
    const remaining = Math.round((CAPTCHA_COOLDOWN_MS - (Date.now() - captchaDetectedAt)) / 1000);
    throw new CaptchaDetectedError(`[PAUSA] Amazon bloqueado. Esperando ${remaining}s`);
  }

  if (_browser?.isConnected() && _browserUses < BROWSER_RECYCLE_AFTER) {
    _browserUses++;
    return Promise.resolve(_browser);
  }
  if (!_browserLaunchPromise) {
    _browserLaunchPromise = (async () => {
      if (_browser) { try { await _browser.close(); } catch {} }
      _storageStatePromise = null;
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      _browser = await chromium.launch({
        headless: true,
        executablePath: executablePath || undefined,
        args: CHROMIUM_ARGS,
      });
      _browserUses = 1;
      return _browser;
    })().finally(() => { _browserLaunchPromise = null; });
  }
  return _browserLaunchPromise;
}

function getAmazonStorageState(): Promise<any> {
  if (!_storageStatePromise) {
    _storageStatePromise = (async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext({ userAgent: randomUserAgent(), locale: 'es-ES' });
      const page = await ctx.newPage();
      try {
        await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await randomDelay(1000, 2000);
        return await ctx.storageState();
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    })();
  }
  return _storageStatePromise;
}

async function createNewContext(browser: Browser): Promise<BrowserContext> {
  const storageState = await getAmazonStorageState();
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: { width: 1366, height: 768 },
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    storageState,
    extraHTTPHeaders: { 'Accept-Language': 'es-ES,es;q=0.9', 'Cache-Control': 'max-age=0' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  return context;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
}

// ── SCRAPE PRODUCT (LÓGICA COMPLETA) ─────────────────────────────────────────

export async function scrapeProduct(url: string): Promise<ScrapeResult> {
  const asin = extractAsin(url);
  if (!asin) throw new Error(`ASIN inválido: ${url}`);

  const canonicalUrl = normaliseAmazonUrl(asin);
  const browser = await getBrowser();
  const context = await createNewContext(browser);
  const page = await context.newPage();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const hardTimeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`[hard_timeout] ${SCRAPER_TIMEOUT_SECONDS}s`)), HARD_TIMEOUT_MS);
  });

  try {
    const result = await Promise.race([
      (async (): Promise<ScrapeResult> => {
        await optimizePageForScraping(page);
        await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: PAGE_LOAD_TIMEOUT_MS });

        const pageTitle = await page.title();

        // Detectar bloqueo por título (Amazon cambia el mensaje periódicamente)
        const isTitleBlock =
          pageTitle.includes('Robot Check') ||
          pageTitle.toLowerCase().includes('sorry') ||
          pageTitle.includes('503') ||
          pageTitle.includes('CAPTCHA');

        // Verificación rápida de estructura: toda página de producto tiene #dp
        const hasProductStructure = await page.locator('#dp, #dp-container').first()
          .isVisible({ timeout: 2_000 }).catch(() => false);

        if (isTitleBlock || !hasProductStructure) {
          captchaDetectedAt = Date.now();
          _storageStatePromise = null; // invalidar cookies envenenadas
          const bodySnippet = (await page.textContent('body') ?? '').slice(0, 120).replace(/\s+/g, ' ');
          throw new CaptchaDetectedError(`Bloqueo Amazon (título: "${pageTitle}" | body: "${bodySnippet}")`);
        }

        const name = await page.locator('#productTitle').first().textContent({ timeout: LOCATOR_TIMEOUT_MS }).then(t => t?.trim() ?? '');
        if (!name) throw new Error('Título no encontrado');

        const availabilityText = await page.locator('#availability').first().textContent({ timeout: 5000 }).catch(() => '');
        if (availabilityText?.toLowerCase().includes('no disponible')) throw new ProductUnavailableError('Producto no disponible');

        await page.waitForSelector('.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice', { timeout: PRICE_SELECTOR_WAIT_MS }).catch(() => {});

        const priceSelectors = [
          '.a-price.aok-align-center .a-offscreen',
          '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
          '#corePrice_desktop .a-price .a-offscreen',
          '#priceblock_ourprice',
          '#priceblock_dealprice',
          '.a-price .a-offscreen'
        ];
        let rawPrice = '';
        for (const selector of priceSelectors) {
          try {
            rawPrice = await page.locator(selector).first().textContent({ timeout: PRICE_LOCATOR_TIMEOUT_MS }).then(t => t?.trim() ?? '');
            if (rawPrice) break;
          } catch {}
        }

        if (!rawPrice) throw new Error('Precio no encontrado');
        const price = parseSpanishPrice(rawPrice);

        const imageUrl = await page.locator('#imgTagWrappingLink img, #landingImage').first().getAttribute('src', { timeout: 5000 }).catch(() => null);

        // EXTRA IMAGES: Restaurada lógica original
        const extraImages: string[] = await page.evaluate((mainSrc: string | null): string[] => {
          const normalize = (s: string) => s.replace(/\._[^.]+_\./, '.').split('/I/')[1] ?? '';
          const mainKey = normalize(mainSrc ?? '');
          return Array.from(document.querySelectorAll('#altImages .imageThumbnail img, #altImages li img'))
            .map((el: any) => String(el.src).replace(/\._[^.]+_\./, '._SL500_.'))
            .filter((src: string) => src.startsWith('https://') && !src.includes('transparent-pixel') && normalize(src) !== mainKey)
            .slice(0, 2);
        }, imageUrl);

        return { asin, name, price, currency: 'EUR', imageUrl, extraImages, url: canonicalUrl };
      })(),
      hardTimeout,
    ]);
    return result;
  } finally {
    clearTimeout(timeoutHandle);
    await page.close({ runBeforeUnload: false }).catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── SCRAPE WISHLIST (SCROLL COMPLETO) ────────────────────────────────────────

export async function scrapeWishlist(url: string): Promise<string[]> {
  const browser = await getBrowser();
  const context = await createNewContext(browser);
  const page = await context.newPage();
  try {
    await optimizePageForScraping(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    let previousCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(1000, 1500);
      const currentCount = await page.$$eval('a[href*="/dp/"]', els => els.length);
      if (currentCount === previousCount) break;
      previousCount = currentCount;
    }

    const hrefs: string[] = await page.$$eval('a[href*="/dp/"]', els => (els as any).map((el: any) => el.href));
    const seen = new Set<string>();
    const results: string[] = [];
    for (const href of hrefs) {
      const match = href.match(/\/dp\/([A-Z0-9]{10})/i);
      if (match) {
        const a = match[1].toUpperCase();
        if (!seen.has(a)) { seen.add(a); results.push(`https://www.amazon.es/dp/${a}`); }
      }
    }
    return results;
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── SCRAPE URL FOR ASINS / CATEGORY ──────────────────────────────────────────

export async function scrapeUrlForAsins(url: string, limit = 200): Promise<string[]> {
  const browser = await getBrowser();
  const context = await createNewContext(browser);
  const page = await context.newPage();
  try {
    await optimizePageForScraping(page);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1000, 2000);
    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(800, 1200);
    }
    const rawAsins: string[] = await page.evaluate(() => {
      const seen = new Set<string>();
      document.querySelectorAll('a[href]').forEach((el: any) => {
        const m = el.href.match(/\/dp\/([A-Z0-9]{10})/i);
        if (m) seen.add(m[1].toUpperCase());
      });
      document.querySelectorAll('[data-asin]').forEach((el: any) => {
        const a = (el as HTMLElement).dataset.asin?.toUpperCase();
        if (a && a.length === 10) seen.add(a);
      });
      return Array.from(seen);
    });
    return rawAsins.slice(0, limit).map(asin => `https://www.amazon.es/dp/${asin}`);
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => {});
    await context.close().catch(() => {});
  }
}

export async function scrapeAmazonCategory(categoryUrl: string, limit = 40): Promise<string[]> {
  const browser = await getBrowser();
  const context = await createNewContext(browser);
  const page = await context.newPage();
  try {
    await optimizePageForScraping(page);
    await page.goto(categoryUrl, { waitUntil: 'load', timeout: 30000 });
    await randomDelay(1500, 2500);
    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(1000, 1500);
    }
    const hrefs: string[] = await page.$$eval('a[href*="/dp/"]', els => (els as any).map((el: any) => el.href));
    const seen = new Set<string>();
    const results: string[] = [];
    for (const href of hrefs) {
      const match = href.match(/\/dp\/([A-Z0-9]{10})/i);
      if (match) {
        const asin = match[1].toUpperCase();
        if (!seen.has(asin) && results.length < limit) {
          seen.add(asin);
          results.push(`https://www.amazon.es/dp/${asin}`);
        }
      }
    }
    return results;
  } finally {
    await page.close({ runBeforeUnload: false }).catch(() => {});
    await context.close().catch(() => {});
  }
}

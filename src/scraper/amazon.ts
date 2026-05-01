import { chromium, type Browser, type BrowserContext } from 'playwright';

export class ProductUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProductUnavailableError';
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

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.7; rv:132.0) Gecko/20100101 Firefox/132.0',
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

// ── Shared Chromium args ──────────────────────────────────────────────────────
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--disable-gpu',
  '--no-first-run',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
];

// Resources we never need — blocks download, src attrs still readable from DOM
const BLOCKED_TYPES = new Set(['image', 'font', 'media', 'stylesheet']);

// ── Singleton browser — launched once, reused across all products in a cycle ──
// High enough that we never recycle mid-cycle (430 products × 2 workers = max ~215 uses each)
const BROWSER_RECYCLE_AFTER = 500;

let _browser: Browser | null = null;
let _browserUses = 0;
// Promise mutex: prevents race condition when 2 workers call getBrowser() simultaneously
let _browserLaunchPromise: Promise<Browser> | null = null;
// Storage state (Amazon session cookies) — fetched once per browser lifecycle
let _storageStatePromise: Promise<any> | null = null;

function getBrowser(): Promise<Browser> {
  // Fast path: browser alive and not due for recycle (synchronous check — no race possible)
  if (_browser?.isConnected() && _browserUses < BROWSER_RECYCLE_AFTER) {
    _browserUses++;
    return Promise.resolve(_browser);
  }
  // Slow path: serialize launch so concurrent workers share the same browser instance
  if (!_browserLaunchPromise) {
    _browserLaunchPromise = (async () => {
      if (_browser) {
        try { await _browser.close(); } catch {}
        _browser = null;
      }
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

// Visit amazon.es once per browser lifecycle and cache the session cookies.
// All product contexts reuse these cookies — avoids a homepage visit per product.
function getAmazonStorageState(): Promise<any> {
  if (!_storageStatePromise) {
    _storageStatePromise = (async () => {
      const browser = await getBrowser();
      const ctx = await browser.newContext({
        userAgent: randomUserAgent(),
        locale: 'es-ES',
        timezoneId: 'Europe/Madrid',
        extraHTTPHeaders: { 'Accept-Language': 'es-ES,es;q=0.9' },
      });
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });
      const page = await ctx.newPage();
      try {
        await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 20000 });
        await randomDelay(600, 1200);
        return await ctx.storageState();
      } finally {
        await page.close().catch(() => {});
        await ctx.close().catch(() => {});
      }
    })();
  }
  return _storageStatePromise;
}

async function newContext(browser: Browser): Promise<BrowserContext> {
  const storageState = await getAmazonStorageState();
  const context = await browser.newContext({
    userAgent: randomUserAgent(),
    viewport: { width: 1366, height: 768 },
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    storageState,
    extraHTTPHeaders: {
      'Accept-Language': 'es-ES,es;q=0.9',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Cache-Control': 'max-age=0',
    },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en-US', 'en'] });
    Object.defineProperty(navigator, 'plugins', {
      get: () => Object.assign([], {
        0: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1 },
        1: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 0 },
        length: 2,
      }),
    });
    // @ts-ignore — browser context
    window.chrome = { runtime: {}, app: { isInstalled: false } };
  });
  return context;
}

/** Close the shared browser. Call on process exit. */
export async function closeBrowser(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch {}
    _browser = null;
  }
}

// ── scrapeProduct ─────────────────────────────────────────────────────────────

export async function scrapeProduct(url: string): Promise<ScrapeResult> {
  const asin = extractAsin(url);
  if (!asin) throw new Error(`No se pudo extraer el ASIN de la URL: ${url}`);

  const canonicalUrl = normaliseAmazonUrl(asin);
  const browser = await getBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  // Hard 45s timeout — if exceeded the product is logged as error, process keeps running
  let timeoutHandle: ReturnType<typeof setTimeout>;
  const hardTimeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('Timeout: scrapeProduct exceeded 45s')), 45000);
  });

  try {
    const result = await Promise.race([
      (async (): Promise<ScrapeResult> => {
        // Block heavy resources — src attributes are still readable from the DOM
        await page.route('**/*', (route) => {
          BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue();
        });

        await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

        const pageTitle = await page.title();
        const currentUrl = page.url();
        const bodyText = await page.textContent('body') ?? '';

        if (
          pageTitle.includes('Robot Check') ||
          pageTitle.includes('Documento no encontrado') ||
          pageTitle.includes('Page Not Found') ||
          pageTitle.includes('503') ||
          pageTitle.includes('Service Unavailable')
        ) {
          throw new Error(`Amazon bloqueó la petición (${pageTitle})`);
        }

        if (
          currentUrl.includes('validateCaptcha') ||
          currentUrl.includes('ap/signin') ||
          bodyText.includes('Enter the characters you see below') ||
          bodyText.includes('Introduce los caracteres que ves a continuación') ||
          bodyText.includes('validateCaptcha')
        ) {
          throw new Error(currentUrl.includes('ap/signin')
            ? 'Amazon redirigió al login (sesión expirada)'
            : 'CAPTCHA detectado en Amazon');
        }

        const name = await page
          .locator('#productTitle').first()
          .textContent({ timeout: 10000 })
          .then((t) => t?.trim() ?? '')
          .catch(() => '');

        if (!name) throw new Error(`Título no encontrado (url: ${page.url().split('?')[0]})`);

        const availabilityText = await page
          .locator('#availability').first()
          .textContent({ timeout: 3000 })
          .catch(() => '');
        const normalizedAvail = (availabilityText ?? '').toLowerCase().trim();
        const unavailableKeywords = [
          'no disponible', 'actualmente no disponible', 'currently unavailable',
          'not available', 'agotado', 'out of stock',
        ];
        if (unavailableKeywords.some((kw) => normalizedAvail.includes(kw))) {
          throw new ProductUnavailableError('Producto no disponible');
        }

        await page
          .waitForSelector('.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, .a-price-whole', { timeout: 5000 })
          .catch(() => {});

        const priceSelectors = [
          '.a-price.aok-align-center .a-offscreen',
          '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
          '#corePrice_desktop .a-price .a-offscreen',
          '#priceblock_ourprice',
          '#priceblock_dealprice',
          '.a-price .a-offscreen',
          '#sns-base-price',
        ];

        let rawPrice = '';
        for (const selector of priceSelectors) {
          try {
            rawPrice = await page.locator(selector).first()
              .textContent({ timeout: 1000 })
              .then((t) => t?.trim() ?? '');
            if (rawPrice) break;
          } catch { /* try next */ }
        }

        if (!rawPrice) throw new Error('No se encontró el precio del producto');

        const price = parseSpanishPrice(rawPrice);
        if (isNaN(price) || price <= 0) throw new Error(`Precio inválido extraído: "${rawPrice}"`);

        // Image src attrs are in the DOM even with images blocked
        const imageUrl = await page
          .locator('#imgTagWrappingLink img, #landingImage').first()
          .getAttribute('src', { timeout: 5000 })
          .catch(() => null);

        const extraImages: string[] = await page.evaluate((mainSrc: string | null): string[] => {
          const win = globalThis as any;
          const normalize = (s: string) => s.replace(/\._[^.]+_\./, '.').split('/I/')[1] ?? '';
          const mainKey = normalize(mainSrc ?? '');
          return Array.from(
            win.document.querySelectorAll('#altImages .imageThumbnail img, #altImages li img') as any[]
          )
            .map((el: any) => String(el.src).replace(/\._[^.]+_\./, '._SL500_.'))
            .filter((src: string) =>
              src.startsWith('https://') &&
              !src.includes('transparent-pixel') &&
              normalize(src) !== mainKey
            )
            .slice(0, 2);
        }, imageUrl);

        return { asin, name, price, currency: 'EUR', imageUrl, extraImages, url: canonicalUrl };
      })(),
      hardTimeout,
    ]);

    return result;
  } finally {
    clearTimeout(timeoutHandle!);
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── scrapeWishlist ────────────────────────────────────────────────────────────

export async function scrapeWishlist(url: string): Promise<string[]> {
  const browser = await getBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await page.route('**/*', (route) => {
      BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const pageTitle = await page.title();
    const bodyText = await page.textContent('body') ?? '';
    if (
      pageTitle.includes('Documento no encontrado') ||
      pageTitle.includes('Page Not Found') ||
      pageTitle.includes('Robot Check') ||
      page.url().includes('validateCaptcha') ||
      bodyText.includes('validateCaptcha') ||
      bodyText.includes('Enter the characters you see below') ||
      bodyText.includes('Introduce los caracteres que ves a continuación')
    ) {
      throw new Error('Amazon bloqueó la petición o la wishlist es privada');
    }

    let previousCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(900, 1200);
      const currentCount = await page.$$eval('a[href*="/dp/"]', els => els.length);
      if (currentCount === previousCount) break;
      previousCount = currentCount;
    }

    const hrefs: string[] = await page.$$eval('a[href*="/dp/"]', els =>
      (els as { href: string }[]).map(el => el.href),
    );

    const asinPattern = /\/dp\/([A-Z0-9]{10})/i;
    const seen = new Set<string>();
    const results: string[] = [];

    for (const href of hrefs) {
      const match = href.match(asinPattern);
      if (match) {
        const a = match[1].toUpperCase();
        if (!seen.has(a)) { seen.add(a); results.push(`https://www.amazon.es/dp/${a}`); }
      }
    }

    if (results.length === 0) {
      throw new Error('La wishlist está vacía o es privada. Asegúrate de que la wishlist es pública en Amazon.');
    }

    return results;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── scrapeUrlForAsins ─────────────────────────────────────────────────────────

export async function scrapeUrlForAsins(url: string, limit = 200): Promise<string[]> {
  const browser = await getBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await page.route('**/*', (route) => {
      BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue();
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(800, 1500);

    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(600, 1000);
    }

    const rawAsins: string[] = await page.evaluate(() => {
      const win = globalThis as any;
      const asinRe = /\/dp\/([A-Z0-9]{10})/i;
      const seen = new Set<string>();
      (win.document.querySelectorAll('a[href]') as any[]).forEach((el: any) => {
        const m = (el.href as string).match(asinRe);
        if (m) seen.add(m[1].toUpperCase());
      });
      (win.document.querySelectorAll('[data-asin]') as any[]).forEach((el: any) => {
        const a = (el.dataset.asin as string ?? '').toUpperCase();
        if (a && a.length === 10) seen.add(a);
      });
      return Array.from(seen);
    });

    return rawAsins.slice(0, limit).map(asin => `https://www.amazon.es/dp/${asin}`);
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

// ── scrapeAmazonCategory ──────────────────────────────────────────────────────

export async function scrapeAmazonCategory(categoryUrl: string, limit = 40): Promise<string[]> {
  const browser = await getBrowser();
  const context = await newContext(browser);
  const page = await context.newPage();

  try {
    await page.route('**/*', (route) => {
      BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue();
    });

    await page.goto(categoryUrl, { waitUntil: 'load', timeout: 30000 });
    await randomDelay(1000, 2000);

    const pageTitle = await page.title();
    const currentUrl = page.url();
    if (
      pageTitle.includes('Robot Check') || pageTitle.includes('503') ||
      currentUrl.includes('validateCaptcha') || currentUrl.includes('ap/signin')
    ) {
      throw new Error(`Amazon bloqueó la petición de categoría (${pageTitle})`);
    }

    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(800, 1200);
    }

    const asinPattern = /\/dp\/([A-Z0-9]{10})/i;
    const seen = new Set<string>();
    const results: string[] = [];

    const addAsin = (asin: string) => {
      const up = asin.toUpperCase();
      if (!seen.has(up) && results.length < limit) { seen.add(up); results.push(`https://www.amazon.es/dp/${up}`); }
    };

    const hrefs: string[] = await page.$$eval('a[href*="/dp/"]', els =>
      (els as { href: string }[]).map(el => el.href),
    );
    for (const href of hrefs) {
      const match = href.match(asinPattern);
      if (match) addAsin(match[1]);
    }

    if (results.length < 5) {
      const dataAsins: string[] = await page.$$eval('[data-asin]', els =>
        (els as { dataset: { asin: string } }[])
          .map(el => el.dataset.asin)
          .filter(a => a && /^[A-Z0-9]{10}$/i.test(a)),
      );
      for (const asin of dataAsins) addAsin(asin);
    }

    return results;
  } finally {
    await page.close().catch(() => {});
    await context.close().catch(() => {});
  }
}

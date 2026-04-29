import { chromium, type Browser } from 'playwright';

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

// Random user agents to rotate
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
  const ms = minMs + Math.random() * (maxMs - minMs);
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Extract ASIN from an Amazon URL.
 * Supports formats:
 *   /dp/ASIN
 *   /gp/product/ASIN
 *   /exec/obidos/ASIN/ASIN
 */
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

/**
 * Normalise an Amazon.es URL to the canonical form (no affiliate tag — used for scraping).
 */
export function normaliseAmazonUrl(asin: string): string {
  return `https://www.amazon.es/dp/${asin}`;
}

const AFFILIATE_TAG = 'canidrone-21';

/**
 * Return the URL with the affiliate tag applied (replaces any existing tag).
 * Use this for all links shown to the user or sent in emails.
 */
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

/**
 * Parse a price string like "23,99" or "1.299,99" → number.
 */
function parseSpanishPrice(raw: string): number {
  // Remove currency symbols and whitespace
  const cleaned = raw.replace(/[€$\s]/g, '').trim();
  // Spanish format: "1.299,99" → thousands separator is dot, decimal is comma
  const normalised = cleaned.replace(/\./g, '').replace(',', '.');
  return parseFloat(normalised);
}

/**
 * Scrape a single Amazon.es product page.
 */
export async function scrapeProduct(url: string): Promise<ScrapeResult> {
  const asin = extractAsin(url);
  if (!asin) throw new Error(`No se pudo extraer el ASIN de la URL: ${url}`);

  const canonicalUrl = normaliseAmazonUrl(asin);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      // Remove automation markers detected by Amazon
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1366, height: 768 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cache-Control': 'max-age=0',
      },
    });

    // Patch navigator.webdriver and other automation fingerprints before any page loads
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
      // @ts-ignore — runs in browser context, not Node
      window.chrome = { runtime: {}, app: { isInstalled: false } };
    });

    const page = await context.newPage();

    // Block fonts and media to speed up loading
    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['font', 'media'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Visit Amazon homepage first to get real session cookies before hitting the product page
    await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(800, 1800);

    await page.goto(canonicalUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    // Check for bot detection / redirects before anything else
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
      currentUrl.includes('errors/validateCaptcha') ||
      bodyText.includes('Enter the characters you see below') ||
      bodyText.includes('Introduce los caracteres que ves a continuación') ||
      bodyText.includes('validateCaptcha')
    ) {
      throw new Error(currentUrl.includes('ap/signin') ? 'Amazon redirigió al login (sesión expirada)' : 'CAPTCHA detectado en Amazon');
    }

    // ── Extract product title ────────────────────────────────────────────────
    const name = await page
      .locator('#productTitle')
      .first()
      .textContent({ timeout: 10000 })
      .then((t) => t?.trim() ?? '')
      .catch(() => '');

    if (!name) throw new Error(`Título no encontrado (url: ${page.url().split('?')[0]})`);

    // ── Check availability ───────────────────────────────────────────────────
    const availabilityText = await page
      .locator('#availability')
      .first()
      .textContent({ timeout: 3000 })
      .catch(() => '');
    const normalizedAvail = (availabilityText ?? '').toLowerCase().trim();
    const unavailableKeywords = [
      'no disponible',
      'actualmente no disponible',
      'currently unavailable',
      'not available',
      'agotado',
      'out of stock',
    ];
    if (unavailableKeywords.some((kw) => normalizedAvail.includes(kw))) {
      throw new ProductUnavailableError(`Producto no disponible`);
    }

    // ── Extract price ────────────────────────────────────────────────────────
    // Wait up to 5 seconds for JS-rendered price elements to appear.
    // Amazon renders prices client-side; waiting longer risks triggering bot detection.
    await page
      .waitForSelector('.a-price .a-offscreen, #priceblock_ourprice, #priceblock_dealprice, .a-price-whole', {
        timeout: 5000,
      })
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
        rawPrice = await page
          .locator(selector)
          .first()
          .textContent({ timeout: 1000 })
          .then((t) => t?.trim() ?? '');
        if (rawPrice) break;
      } catch {
        // try next selector
      }
    }

    if (!rawPrice) throw new Error('No se encontró el precio del producto');

    const price = parseSpanishPrice(rawPrice);
    if (isNaN(price) || price <= 0) {
      throw new Error(`Precio inválido extraído: "${rawPrice}"`);
    }

    // ── Extract images ───────────────────────────────────────────────────────
    const imageUrl = await page
      .locator('#imgTagWrappingLink img, #landingImage')
      .first()
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
  } finally {
    await browser.close();
  }
}

/**
 * Scrape all product ASINs from a public Amazon.es wishlist URL.
 * Returns an array of canonical product URLs (one per unique ASIN).
 */
export async function scrapeWishlist(url: string): Promise<string[]> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--no-first-run',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1366, height: 768 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
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
      // @ts-ignore — runs in browser context, not Node
      window.chrome = { runtime: {}, app: { isInstalled: false } };
    });

    const page = await context.newPage();

    await page.route('**/*', (route) => {
      const resourceType = route.request().resourceType();
      if (['font', 'media'].includes(resourceType)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    // Visit homepage first to get a real session
    await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(800, 1500);

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Check for bot detection / private wishlist
    const pageTitle = await page.title();
    if (
      pageTitle.includes('Documento no encontrado') ||
      pageTitle.includes('Page Not Found') ||
      pageTitle.includes('Robot Check')
    ) {
      throw new Error('Amazon bloqueó la petición (bot detection)');
    }

    const bodyText = await page.textContent('body') ?? '';
    if (
      page.url().includes('validateCaptcha') ||
      bodyText.includes('validateCaptcha') ||
      bodyText.includes('Enter the characters you see below') ||
      bodyText.includes('Introduce los caracteres que ves a continuación')
    ) {
      throw new Error('CAPTCHA detectado en Amazon');
    }

    // Scroll to bottom in a loop to lazy-load all wishlist items
    let previousCount = 0;
    for (let i = 0; i < 20; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(900, 1200);
      const currentCount = await page.$$eval('a[href*="/dp/"]', els => els.length);
      if (currentCount === previousCount) break;
      previousCount = currentCount;
    }

    // Extract all hrefs with /dp/ASIN pattern
    const hrefs: string[] = await page.$$eval('a[href*="/dp/"]', els =>
      (els as { href: string }[]).map(el => el.href),
    );

    const asinPattern = /\/dp\/([A-Z0-9]{10})/i;
    const seen = new Set<string>();
    const results: string[] = [];

    for (const href of hrefs) {
      const match = href.match(asinPattern);
      if (match) {
        const asin = match[1].toUpperCase();
        if (!seen.has(asin)) {
          seen.add(asin);
          results.push(`https://www.amazon.es/dp/${asin}`);
        }
      }
    }

    if (results.length === 0) {
      throw new Error(
        'La wishlist está vacía o es privada. Asegúrate de que la wishlist es pública en Amazon.',
      );
    }

    return results;
  } finally {
    await browser.close();
  }
}

/**
 * Scrape up to `limit` product ASINs from an Amazon.es category / bestsellers page.
 * Returns canonical product URLs.
 */
export async function scrapeAmazonCategory(categoryUrl: string, limit = 40): Promise<string[]> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

  const browser: Browser = await chromium.launch({
    headless: true,
    executablePath: executablePath || undefined,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas', '--disable-gpu', '--no-first-run',
      '--disable-blink-features=AutomationControlled', '--disable-infobars',
    ],
  });

  try {
    const context = await browser.newContext({
      userAgent: randomUserAgent(),
      viewport: { width: 1366, height: 768 },
      locale: 'es-ES',
      timezoneId: 'Europe/Madrid',
      extraHTTPHeaders: {
        'Accept-Language': 'es-ES,es;q=0.9',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // @ts-ignore — browser context
      window.chrome = { runtime: {}, app: { isInstalled: false } };
    });

    const page = await context.newPage();

    await page.route('**/*', route => {
      if (['font', 'media'].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await randomDelay(800, 1500);
    await page.goto(categoryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await randomDelay(1000, 2000);

    const pageTitle = await page.title();
    const currentUrl = page.url();
    if (
      pageTitle.includes('Robot Check') || pageTitle.includes('503') ||
      currentUrl.includes('validateCaptcha') || currentUrl.includes('ap/signin')
    ) {
      throw new Error(`Amazon bloqueó la petición de categoría (${pageTitle})`);
    }

    // Scroll to trigger lazy-load (bestsellers pages paginate via scroll)
    for (let i = 0; i < 3; i++) {
      await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
      await randomDelay(800, 1200);
    }

    const hrefs: string[] = await page.$$eval('a[href*="/dp/"]', els =>
      (els as { href: string }[]).map(el => el.href),
    );

    const asinPattern = /\/dp\/([A-Z0-9]{10})/i;
    const seen = new Set<string>();
    const results: string[] = [];

    for (const href of hrefs) {
      if (results.length >= limit) break;
      const match = href.match(asinPattern);
      if (match) {
        const asin = match[1].toUpperCase();
        if (!seen.has(asin)) {
          seen.add(asin);
          results.push(`https://www.amazon.es/dp/${asin}`);
        }
      }
    }

    return results;
  } finally {
    await browser.close();
  }
}

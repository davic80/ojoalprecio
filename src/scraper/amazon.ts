import { chromium, type Browser } from 'playwright';

export interface ScrapeResult {
  asin: string;
  name: string;
  price: number;
  currency: string;
  imageUrl: string | null;
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

    // Check for bot detection before anything else
    const pageTitle = await page.title();
    if (
      pageTitle.includes('Documento no encontrado') ||
      pageTitle.includes('Page Not Found') ||
      pageTitle.includes('Robot Check')
    ) {
      throw new Error('Amazon bloqueó la petición (bot detection)');
    }

    // Check for CAPTCHA — use URL pattern and specific strings, not generic words
    // ("robot" appears in normal Amazon.es page content and causes false positives)
    const currentUrl = page.url();
    const bodyText = await page.textContent('body') ?? '';
    if (
      currentUrl.includes('validateCaptcha') ||
      bodyText.includes('Enter the characters you see below') ||
      bodyText.includes('Introduce los caracteres que ves a continuación') ||
      bodyText.includes('validateCaptcha')
    ) {
      throw new Error('CAPTCHA detectado en Amazon');
    }

    // ── Extract product title ────────────────────────────────────────────────
    const name = await page
      .locator('#productTitle')
      .first()
      .textContent({ timeout: 10000 })
      .then((t) => t?.trim() ?? '')
      .catch(() => '');

    if (!name) throw new Error('No se encontró el título del producto');

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

    // ── Extract image ────────────────────────────────────────────────────────
    const imageUrl = await page
      .locator('#imgTagWrappingLink img, #landingImage')
      .first()
      .getAttribute('src', { timeout: 5000 })
      .catch(() => null);

    return { asin, name, price, currency: 'EUR', imageUrl, url: canonicalUrl };
  } finally {
    await browser.close();
  }
}

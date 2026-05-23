import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

export class ProductUnavailableError extends Error {
  // Optional structured reason so the scheduler can route this into the
  // anomaly review queue (used / unqualified buybox cases).
  reason?: 'used' | 'unqualified';
  snippet?: string;
  constructor(message: string, reason?: 'used' | 'unqualified', snippet?: string) {
    super(message);
    this.name = 'ProductUnavailableError';
    this.reason = reason;
    this.snippet = snippet;
  }
}

export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaDetectedError';
  }
}

export interface VariantRef {
  asin: string;
  label: string;
  selectable: boolean;  // swatch isn't disabled (NOT a stock guarantee)
}

export interface ScrapeResult {
  asin: string;
  name: string;
  price: number;
  currency: string;
  imageUrl: string | null;
  extraImages: string[];
  url: string;
  wasPrice: number | null;
  variants: VariantRef[];
  /** Best Seller Rank — null if Amazon doesn't show one for this product. */
  bsrValue: number | null;
  bsrCategory: string | null;
  /** Total customer review count; null when not present. */
  reviewCount: number | null;
  /** "Comprado +X veces el último mes" badge count; null when no badge. */
  boughtLastMonth: number | null;
}

// ── Gestión Global de Captcha ────────────────────────────────────────────────
let captchaDetectedAt: number | null = null;
const CAPTCHA_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutos de pausa si hay bloqueo

export function isCaptchaBlocked(): boolean {
  return captchaDetectedAt !== null && (Date.now() - captchaDetectedAt < CAPTCHA_COOLDOWN_MS);
}
export function captchaRemainingMs(): number {
  if (!captchaDetectedAt) return 0;
  return Math.max(0, CAPTCHA_COOLDOWN_MS - (Date.now() - captchaDetectedAt));
}

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

// Pure helpers (extractAsin / normaliseAmazonUrl / affiliateUrl /
// parseSpanishPrice) live in ./util for testability. Re-exported here so
// all existing `from '../scraper/amazon'` imports keep working.
export { extractAsin, normaliseAmazonUrl, affiliateUrl, parseSpanishPrice } from './util';
import { extractAsin, normaliseAmazonUrl, parseSpanishPrice } from './util';

// ── Configuración de Timeouts ────────────────────────────────────────────────
// timeoutSeconds is passed per-call from the scheduler (reads app_settings DB).
// These are fixed per-scrape constants that don't depend on the timeout param.
const LOCATOR_TIMEOUT_MS      = 10_000;
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

// Strictly the main buybox containers. We deliberately avoid:
//  - #rightCol / #buybox: they wrap the buybox AND adjacent widgets like
//    "Nuevo y de segunda mano desde X €" and "More buying choices", which
//    show prices for used items / third-party sellers (sometimes excluding
//    shipping). Promise.any made those win when the real buybox lagged.
//  - .a-price.aok-align-center: matches sponsored / recommendation cards.
//  - #dp: too broad, catches accessory prices from "frequently bought together".
// If none of these match, the product has no buybox price (variant unselected,
// only used offers, etc.) and we fail cleanly rather than guess.
// Title selectors — Amazon serves several layouts depending on the
// category (Books, Toys, Electronics all differ). When `#productTitle`
// is the only one we wait for, a non-standard layout causes a 10 s
// timeout + the whole scrape fails even though the price is visible
// (real case: B0D17X2Y4D — toy/game category, no #productTitle).
// We race the lot and take whichever resolves first, then fall back
// to the og:title meta tag which every Amazon page has.
const TITLE_SELECTORS = [
  '#productTitle',
  '#title span#productTitle',
  '#title h1 span',
  '[data-feature-name="title"] h1',
  '[data-csa-c-content-id="title"] span',
  'h1.product-title-word-break',
];
const PRICE_SELECTORS = [
  '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price):not(.a-text-strike) .a-offscreen',
  '#corePrice_feature_div .a-price:not(.a-text-price):not(.a-text-strike) .a-offscreen',
  '#corePrice_desktop .a-price:not(.a-text-price):not(.a-text-strike) .a-offscreen',
  '#apex_desktop_qualifiedBuybox .a-price:not(.a-text-price):not(.a-text-strike) .a-offscreen',
  '#priceblock_ourprice',
  '#priceblock_dealprice',
];
const WAS_PRICE_SELECTORS = [
  // basisPrice — most common for Amazon.es RRP
  '#corePriceDisplay_desktop_feature_div .basisPrice .a-offscreen',
  '#corePrice_desktop_feature_div .basisPrice .a-offscreen',
  '#corePrice_feature_div .basisPrice .a-offscreen',
  '#corePrice_desktop .basisPrice .a-offscreen',
  '#apex_desktop .basisPrice .a-offscreen',
  '#rightCol .basisPrice .a-offscreen',
  '.basisPrice .a-offscreen',
  // a-text-price — strikethrough "Antes: X€" shown next to deal price
  '#corePriceDisplay_desktop_feature_div .a-price.a-text-price .a-offscreen',
  '#corePrice_feature_div .a-price.a-text-price .a-offscreen',
  '#corePrice_desktop .a-price.a-text-price .a-offscreen',
  '#apex_desktop_qualifiedBuybox .a-text-price .a-offscreen',
  '#apex_desktop .a-text-price .a-offscreen',
  // Generic fallbacks for deal/savings blocks
  '.a-section.a-spacing-small .a-price.a-text-price .a-offscreen',
  '[data-feature-name="corePriceDisplay"] .basisPrice .a-offscreen',
  '[data-feature-name="corePrice"] .basisPrice .a-offscreen',
];

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

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900  },
  { width: 1536, height: 864  },
  { width: 1366, height: 768  },
  { width: 1280, height: 720  },
];
function randomViewport() { return VIEWPORTS[Math.floor(Math.random() * VIEWPORTS.length)]; }

async function createNewContext(browser: Browser): Promise<BrowserContext> {
  const storageState = await getAmazonStorageState();
  const ua = randomUserAgent();
  const vp = randomViewport();

  // Build sec-ch-ua to match Chrome 131 UA strings
  const isChrome = ua.includes('Chrome/131');
  const secChUa = isChrome
    ? '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'
    : '"Firefox";v="132", "Not_A Brand";v="99"';

  const context = await browser.newContext({
    userAgent: ua,
    viewport: vp,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    storageState,
    extraHTTPHeaders: {
      'Accept-Language':         'es-ES,es;q=0.9,en;q=0.8',
      'Cache-Control':           'max-age=0',
      'Sec-CH-UA':               secChUa,
      'Sec-CH-UA-Mobile':        '?0',
      'Sec-CH-UA-Platform':      '"Windows"',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  await context.addInitScript((vp: { width: number; height: number }) => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

    // window.chrome — absent in headless, present in real Chrome
    if (!(window as any).chrome) {
      (window as any).chrome = {
        app: { isInstalled: false },
        runtime: { id: undefined },
        loadTimes: () => {},
        csi: () => {},
      };
    }

    // Realistic plugin list (empty = headless tell)
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const mkPlugin = (name: string, filename: string, desc: string) => {
          const p = Object.create(Plugin.prototype);
          Object.defineProperty(p, 'name',        { value: name });
          Object.defineProperty(p, 'filename',    { value: filename });
          Object.defineProperty(p, 'description', { value: desc });
          Object.defineProperty(p, 'length',      { value: 0 });
          return p;
        };
        const arr: any = [
          mkPlugin('Chrome PDF Plugin',         'internal-pdf-viewer',   'Portable Document Format'),
          mkPlugin('Chrome PDF Viewer',          'mhjfbmdgcfjbbpaeojofohoefgiehjai', ''),
          mkPlugin('Native Client',              'internal-nacl-plugin',  ''),
        ];
        arr.item = (i: number) => arr[i];
        arr.namedItem = (n: string) => arr.find((p: any) => p.name === n) ?? null;
        arr.refresh = () => {};
        return arr;
      },
    });

    // Consistent language
    Object.defineProperty(navigator, 'languages', { get: () => ['es-ES', 'es', 'en-US', 'en'] });

    // Screen matches the viewport
    Object.defineProperty(screen, 'width',       { get: () => vp.width });
    Object.defineProperty(screen, 'height',      { get: () => vp.height });
    Object.defineProperty(screen, 'availWidth',  { get: () => vp.width });
    Object.defineProperty(screen, 'availHeight', { get: () => vp.height - 40 });
    Object.defineProperty(screen, 'colorDepth',  { get: () => 24 });
    Object.defineProperty(screen, 'pixelDepth',  { get: () => 24 });
    Object.defineProperty(window, 'outerWidth',  { get: () => vp.width });
    Object.defineProperty(window, 'outerHeight', { get: () => vp.height });

    // permissions.query — headless throws for 'notifications'
    const origQuery = window.navigator.permissions?.query?.bind(navigator.permissions);
    if (origQuery) {
      (navigator.permissions as any).query = (params: any) => {
        if (params.name === 'notifications') return Promise.resolve({ state: 'denied' } as PermissionStatus);
        return origQuery(params);
      };
    }
  }, vp);

  return context;
}

export async function closeBrowser(): Promise<void> {
  if (_browser) { try { await _browser.close(); } catch {} _browser = null; }
}

// ── SCRAPE PRODUCT (LÓGICA COMPLETA) ─────────────────────────────────────────

export async function scrapeProduct(url: string, timeoutSeconds = 30): Promise<ScrapeResult> {
  const asin = extractAsin(url);
  if (!asin) throw new Error(`ASIN inválido: ${url}`);

  const hardTimeoutMs      = Math.max(15, timeoutSeconds) * 1000;
  const pageLoadTimeoutMs  = Math.round(hardTimeoutMs * 0.8);

  const canonicalUrl = normaliseAmazonUrl(asin);
  const browser = await getBrowser();
  const context = await createNewContext(browser);
  const page = await context.newPage();

  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const hardTimeout = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error(`[hard_timeout] ${timeoutSeconds}s`)), hardTimeoutMs);
  });

  try {
    const result = await Promise.race([
      (async (): Promise<ScrapeResult> => {
        await optimizePageForScraping(page);
        await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: pageLoadTimeoutMs });

        const pageTitle = await page.title();

        const isTitleBlock =
          pageTitle.includes('Robot Check') ||
          pageTitle.toLowerCase().includes('sorry') ||
          pageTitle.includes('503') ||
          pageTitle.includes('CAPTCHA');

        // count() is instant — no wait. All product pages have #dp in static HTML.
        const dpCount = await page.locator('#dp, #dp-container').count();
        if (isTitleBlock || dpCount === 0) {
          const bodyText = (await page.textContent('body') ?? '').slice(0, 400).replace(/\s+/g, ' ');

          // Amazon 404 / product-not-found page — not a block, treat as unavailable
          const isNotFound =
            bodyText.includes('¿Estás buscando algo?') ||
            bodyText.toLowerCase().includes('documento no encontrado') ||
            bodyText.toLowerCase().includes('page not found') ||
            bodyText.includes('Lo sentimos. La dirección') ||
            pageTitle.toLowerCase().includes('página no encontrada') ||
            pageTitle.toLowerCase().includes('not found');
          if (isNotFound) {
            throw new ProductUnavailableError('Producto no encontrado en Amazon (ASIN eliminado o URL inválida)');
          }

          // Amazon non-product surfaces (Luna gaming, Audible, Prime Video,
          // Music, Alexa Skills, Kindle subscriptions, etc.). These return
          // valid HTML but no #dp container; treating them as a captcha
          // pauses the whole scraper for 10 min unnecessarily — and the same
          // ASIN bombs the next cycle. ProductUnavailableError instead lets
          // consecutive_unavailable + auto-purge clean these out.
          const lowerTitle = pageTitle.toLowerCase();
          const lowerBody  = bodyText.toLowerCase();
          const isNonPhysicalAmazon =
            lowerTitle.includes('luna') ||
            lowerTitle.includes('audible') ||
            lowerTitle.includes('prime video') ||
            lowerTitle.includes('amazon music') ||
            lowerTitle.includes('alexa skill') ||
            lowerTitle.includes('kindle unlimited') ||
            lowerBody.includes('luna premium') ||
            lowerBody.includes('suscribirse a luna') ||
            lowerBody.includes('audible plus');
          if (isNonPhysicalAmazon) {
            throw new ProductUnavailableError(`Producto no físico (servicio digital Amazon — "${pageTitle}")`);
          }

          // Try clicking through Amazon's interstitial ("Haz clic en el botón de abajo para seguir")
          if (bodyText.includes('botón de abajo') || bodyText.includes('continuar')) {
            const btn = page.locator('input[type="submit"], button[type="submit"], a.a-button-text').first();
            if (await btn.count() > 0) {
              console.log('[scraper] Interstitial detectado — intentando clic...');
              await btn.click({ timeout: 3000 }).catch(() => {});
              await randomDelay(1500, 2500);
              // Re-check after click
              const dpCountAfter = await page.locator('#dp, #dp-container').count();
              if (dpCountAfter > 0) {
                console.log('[scraper] Interstitial superado con clic.');
                // Update shared storage state so next contexts skip the interstitial
                _storageStatePromise = context.storageState().catch(() => null) as any;
              } else {
                captchaDetectedAt = Date.now();
                _storageStatePromise = null;
                throw new CaptchaDetectedError(`Bloqueo Amazon (título: "${pageTitle}" | body: "${bodyText.slice(0, 120)}")`);
              }
            } else {
              captchaDetectedAt = Date.now();
              _storageStatePromise = null;
              throw new CaptchaDetectedError(`Bloqueo Amazon (título: "${pageTitle}" | body: "${bodyText.slice(0, 120)}")`);
            }
          } else {
            captchaDetectedAt = Date.now();
            _storageStatePromise = null;
            const bodySnippet = bodyText.slice(0, 120);
            throw new CaptchaDetectedError(`Bloqueo Amazon (título: "${pageTitle}" | body: "${bodySnippet}")`);
          }
        }

        // Phase 1: name + availability in parallel. Title races every known
        // selector + falls back to the og:title meta tag — the latter is
        // present on every Amazon layout so the only way to genuinely fail
        // here is a non-product page (404 / blocked).
        const [name, availabilityText] = await Promise.all([
          Promise.any(
            TITLE_SELECTORS.map(sel =>
              page.locator(sel).first().textContent({ timeout: LOCATOR_TIMEOUT_MS }).then(t => {
                const s = t?.trim() ?? '';
                if (!s) throw new Error('empty');
                return s;
              })
            )
          ).catch(async () => {
            // Final fallback — meta[property="og:title"] is always set on
            // product pages (used by Amazon for share previews).
            const t = await page.locator('meta[property="og:title"]').first()
              .getAttribute('content', { timeout: 2000 }).catch(() => '');
            return t?.trim() ?? '';
          }),
          page.locator('#availability').first().textContent({ timeout: 5000 }).catch(() => ''),
        ]);
        if (!name) throw new Error('Título no encontrado');
        if (availabilityText?.toLowerCase().includes('no disponible')) throw new ProductUnavailableError('Producto no disponible');

        // Detect pages where Amazon has no qualifying offer of its own:
        //  - 'used'        — main buybox has been replaced by a used/refurbished
        //                    offer (#corePrice* contains "de 2ª mano" etc.)
        //  - 'unqualified' — no qualified buybox at all; Amazon renders
        //                    #unqualifiedBuyBox_feature_div instead (only third-
        //                    party sellers, often at inflated prices, e.g.
        //                    B01N7RLGIJ Mario Kart at 285€).
        // In either case, our price selectors might still match something
        // misleading, so we throw ProductUnavailableError here and let the
        // existing no-stock flow record the product as unavailable.
        const offerState = await page.evaluate(() => {
          const containers = [
            '#corePriceDisplay_desktop_feature_div',
            '#corePrice_feature_div',
            '#corePrice_desktop',
            '#apex_desktop_qualifiedBuybox',
            '#tabular-buybox',
          ];
          for (const sel of containers) {
            const el = document.querySelector(sel);
            if (!el) continue;
            const text = (el.textContent ?? '').toLowerCase();
            if (/de 2[ªa]? ?mano|segunda mano|reacondicionado|renewed|certified refurbished|warehouse/.test(text)) {
              return { state: 'used', snippet: (el.textContent ?? '').slice(0, 250).replace(/\s+/g, ' ').trim() };
            }
          }
          const unq = document.querySelector('#unqualifiedBuyBox_feature_div');
          if (unq && (unq.textContent?.trim().length ?? 0) > 30) {
            return { state: 'unqualified', snippet: (unq.textContent ?? '').slice(0, 250).replace(/\s+/g, ' ').trim() };
          }
          return null;
        }).catch(() => null);
        if (offerState?.state === 'used') {
          throw new ProductUnavailableError('Solo segunda mano / reacondicionado disponible', 'used', offerState.snippet);
        }
        if (offerState?.state === 'unqualified') {
          throw new ProductUnavailableError('Sin oferta de Amazon — solo terceros vendedores', 'unqualified', offerState.snippet);
        }

        // Phase 2: price + wasPrice + image all in parallel
        // Promise.any races all selectors simultaneously — resolves on first non-empty match
        const [rawPrice, rawWasPrice, imageUrl] = await Promise.all([
          Promise.any(
            PRICE_SELECTORS.map(sel =>
              page.locator(sel).first().textContent({ timeout: PRICE_SELECTOR_WAIT_MS }).then(t => {
                const s = t?.trim() ?? '';
                if (!s) throw new Error('empty');
                return s;
              })
            )
          ).catch(() => ''),
          Promise.any(
            WAS_PRICE_SELECTORS.map(sel =>
              page.locator(sel).first().textContent({ timeout: 4_000 }).then(t => {
                const s = t?.trim() ?? '';
                if (!s) throw new Error('empty');
                return s;
              })
            )
          ).catch(() => ''),
          page.locator('#imgTagWrappingLink img, #landingImage').first().getAttribute('src', { timeout: 5000 }).catch(() => null),
        ]);

        if (!rawPrice) throw new Error('Precio no encontrado');
        const price = parseSpanishPrice(rawPrice);
        if (!isFinite(price) || price < 0.5) throw new Error(`Precio inválido: "${rawPrice}" → ${price}`);

        // If selector-based was_price failed, scan the full DOM for any strikethrough price > current
        let wasPriceRaw = rawWasPrice ? parseSpanishPrice(rawWasPrice) : null;
        let wasPriceSrc = 'selector';
        if (!wasPriceRaw || wasPriceRaw <= price * 1.01) {
          const fallback = await page.evaluate((): string | null => {
            const candidates = Array.from(document.querySelectorAll('.a-text-price .a-offscreen, .basisPrice .a-offscreen'));
            for (const el of candidates) {
              const txt = el.textContent?.trim() ?? '';
              if (txt) return txt;
            }
            return null;
          }).catch(() => null);
          if (fallback) {
            const parsed = parseSpanishPrice(fallback);
            if (isFinite(parsed) && parsed > price * 1.01) { wasPriceRaw = parsed; wasPriceSrc = 'dom-fallback'; }
          }
        }
        // Sanity check: real RRP is never more than 4× the deal price
        const wasPrice = wasPriceRaw && wasPriceRaw > price * 1.01 && wasPriceRaw <= price * 4 ? wasPriceRaw : null;
        if (wasPrice) console.log(`[scraper] ${asin} → PVP ${wasPrice.toFixed(2)} € (${wasPriceSrc})`);
        else if (wasPriceRaw && wasPriceRaw > price * 4) console.log(`[scraper] ${asin} → PVP descartado (${wasPriceRaw.toFixed(2)} € = ${(wasPriceRaw/price).toFixed(1)}x — probable falso positivo)`);

        const [extraImages, variants, metadata] = await Promise.all([
          page.evaluate((mainSrc: string | null): string[] => {
            const normalize = (s: string) => s.replace(/\._[^.]+_\./, '.').split('/I/')[1] ?? '';
            const mainKey = normalize(mainSrc ?? '');
            return Array.from(document.querySelectorAll('#altImages .imageThumbnail img, #altImages li img'))
              .map((el: any) => String(el.src).replace(/\._[^.]+_\./, '._SL500_.'))
              .filter((src: string) => src.startsWith('https://') && !src.includes('transparent-pixel') && normalize(src) !== mainKey)
              .slice(0, 2);
          }, imageUrl),
          // Twister variants (color/style/size). Free piggy-back on the page
          // we already loaded — extracts each sibling ASIN, label and whether
          // its swatch is enabled. Selectable does NOT mean "in stock"; only
          // a per-variant scrape can confirm that.
          page.evaluate((selfAsin: string): VariantRef[] => {
            const seen = new Map<string, VariantRef>();
            document.querySelectorAll('li[data-defaultasin], li[data-asin]').forEach((li) => {
              const asin = li.getAttribute('data-defaultasin') || li.getAttribute('data-asin') || '';
              if (!/^[A-Z0-9]{10}$/.test(asin) || asin === selfAsin) return;
              if (seen.has(asin)) return;
              const altLabel = li.querySelector('img')?.getAttribute('alt')?.trim()
                || li.textContent?.trim().slice(0, 40)
                || '';
              const selectable = !li.classList.contains('swatch-disabled')
                && !li.classList.contains('a-button-disabled');
              seen.set(asin, { asin, label: altLabel, selectable });
            });
            return [...seen.values()];
          }, asin).catch(() => [] as VariantRef[]),
          // Popularity metadata — captured best-effort on the same page load.
          // All three signals are optional; the auto-cleanup cron uses
          // their COMBINATION (no badge + few reviews + bad BSR) to decide
          // whether an unowned auto-imported product is dead weight. A
          // missed selector returns null and the product stays untouched.
          page.evaluate((): { bsrValue: number | null; bsrCategory: string | null; reviewCount: number | null; boughtLastMonth: number | null } => {
            const out: any = { bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null };
            try {
              // BSR appears as a list-item inside one of these containers, in
              // formats like "Nº1.234 en Hogar y cocina" or
              // "#5,678 in Home & Kitchen". We pick the FIRST rank line —
              // typically the most specific subcategory.
              const detailsRoot = document.querySelector('#detailBulletsWrapper_feature_div, #productDetails_detailBullets_sections1, #productDetails_db_sections, #SalesRank, #productDetails_techSpec_section_1');
              if (detailsRoot) {
                const text = detailsRoot.textContent || '';
                // Spanish: "nº 12.345" / "n.º 12,345" / "Nº 12345"
                // English: "#12,345"  fallback
                const m = text.match(/n[°ºº]\.?\s*([\d.,]+)\s*en\s+([^\(\n]+?)(?:\s*\(|$)/i)
                       || text.match(/#\s*([\d,]+)\s+in\s+([^\(\n]+?)(?:\s*\(|$)/i);
                if (m) {
                  out.bsrValue    = parseInt(m[1].replace(/[.,]/g, ''), 10) || null;
                  out.bsrCategory = m[2].trim().slice(0, 200);
                }
              }
              // Review count: "1.234 valoraciones" / "1,234 ratings"
              const reviewsEl = document.querySelector('#acrCustomerReviewText, [data-hook="total-review-count"]');
              if (reviewsEl) {
                const m = (reviewsEl.textContent || '').match(/([\d.,]+)/);
                if (m) out.reviewCount = parseInt(m[1].replace(/[.,]/g, ''), 10) || null;
              }
              // "Comprados X veces el último mes" / "X+ bought in past month"
              // social-proof badge — only top-volume listings get it. Selectors
              // changed twice in 2025; we match wrapper id + faceout + the new
              // pqv- id, plus a body-text fallback for layout changes.
              const proofEl = document.querySelector(
                '#social-proofing-faceout-title-tk_bought, ' +
                '#socialProofingAsinFaceout_feature_div, ' +
                '#pqv-bought-in-last-month, ' +
                '[data-csa-c-content-id*="bought"]',
              );
              const proofText = proofEl?.textContent ?? '';
              // Match patterns Amazon actually serves:
              //   "50+ bought in past month"
              //   "1K+ bought in past month"
              //   "Más de 1000 comprado(s) el último mes"
              //   "1.5 mil comprados el mes pasado"
              // The `+` after the digit was the bug v1: original regex didn't
              // tolerate it so every "50+ bought" listing scored 0.
              // Allow the "+" sign either between digit and K/mil ("50+ bought")
              // OR after K/mil ("1K+ bought"). Both shapes occur in production.
              const m = proofText.match(/([\d.,]+)\s*(K|k|mil)?\+?\s*(?:comprad|bought|purchase)/i);
              if (m) {
                let n = parseInt(m[1].replace(/[.,]/g, ''), 10);
                if (m[2] && /k|mil/i.test(m[2])) n *= 1000;
                if (Number.isFinite(n) && n > 0) out.boughtLastMonth = n;
              }
            } catch { /* swallow — metadata is opportunistic */ }
            return out;
          }).catch(() => ({ bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null })),
        ]);

        return {
          asin, name, price, currency: 'EUR', imageUrl, extraImages,
          url: canonicalUrl, wasPrice, variants,
          bsrValue:        metadata.bsrValue,
          bsrCategory:     metadata.bsrCategory,
          reviewCount:     metadata.reviewCount,
          boughtLastMonth: metadata.boughtLastMonth,
        };
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

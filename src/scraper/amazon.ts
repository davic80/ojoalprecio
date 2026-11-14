import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { buildProfiles, pickProfile, profileHeaders, type UaProfile } from './profiles';

export class ProductUnavailableError extends Error {
  // Optional structured reason so the scheduler can route this into the
  // anomaly review queue (used / unqualified buybox cases).
  //  'gone'     — Amazon says the ASIN doesn't exist (404 / "Documento no encontrado")
  //  'redirect' — the page is for a DIFFERENT ASIN (Amazon redirected a retired variant)
  reason?: 'used' | 'unqualified' | 'gone' | 'redirect';
  snippet?: string;
  // Product title captured before the throw, when available. The scheduler
  // persists this so products that fail before reaching persistScrapeResult
  // still have a name for the admin UI / dashboards.
  productName?: string;
  constructor(message: string, reason?: 'used' | 'unqualified' | 'gone' | 'redirect', snippet?: string, productName?: string) {
    super(message);
    this.name = 'ProductUnavailableError';
    this.reason = reason;
    this.snippet = snippet;
    this.productName = productName;
  }
}

export class CaptchaDetectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CaptchaDetectedError';
  }
}

/**
 * Amazon is rendering the page for a delivery location other than Spain (the
 * server egresses from Germany). Prices/offers differ by location, so a
 * "no price / no stock" result here is NOT trustworthy: the scheduler must not
 * mark the product unavailable or count a failure against it.
 */
export class WrongLocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WrongLocationError';
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
  /** Manufacturer/brand text — captured from #bylineInfo or product
      details table. Null when neither selector matched. */
  brand: string | null;
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

// ── Ubicación de entrega + proxy ─────────────────────────────────────────────
// The server lives in Germany, and Amazon.es localises offers by IP ("Enviar a
// Alemania"): new items that don't ship there show only used offers, so prices
// and stock come out wrong. We pin a Spanish postal code in the session, and
// every scrape verifies the page really renders for it.
export const AMAZON_ZIP = process.env.AMAZON_ZIP || '28001';
// Optional egress proxy (e.g. a Spanish tinyproxy reachable over Tailscale).
const SCRAPER_PROXY = process.env.SCRAPER_PROXY || '';

/** Reject if `p` doesn't settle in `ms`. Never leaves a caller awaiting forever. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`[close_timeout] ${what} ${ms}ms`)), ms); });
  return Promise.race([p, timer]).finally(() => clearTimeout(t));
}

/** Close a page/context/browser without ever hanging: a frozen Chromium makes
    close() never return, which used to wedge the whole scheduler. */
async function safeClose(what: string, fn: () => Promise<unknown>, ms = 8_000): Promise<boolean> {
  try { await withTimeout(Promise.resolve().then(fn), ms, what); return true; }
  catch (e) { console.warn(`[scraper] ${what} no cerró limpio: ${(e as Error).message}`); return false; }
}

// pkill is asynchronous: a launch that starts before it has finished would be killed too
// ("browserType.launch: Target page, context or browser has been closed", seen on the Pi after
// a hard timeout). So callers AWAIT the returned promise before launching a new browser.
let _killing: Promise<void> | null = null;
function forceKillChromium(): Promise<void> {
  _killing = new Promise<void>((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require('child_process').execFile('pkill', ['-9', '-f', 'chromium'], () => setTimeout(resolve, 500));
    } catch { resolve(); }
  }).finally(() => { _killing = null; });
  return _killing;
}

let _browserNeedsRecycle = false;

/** Hard reset used by the scheduler watchdog: kill Chromium and forget all
    cached browser state so the next scrape starts clean. */
export function restartBrowser(): void {
  console.warn('[scraper] restartBrowser(): matando Chromium y limpiando estado');
  _browser = null; _browserLaunchPromise = null; _storageStatePromise = null; _sessionProfile = null; _browserUses = 0;
  _browserNeedsRecycle = false;
  forceKillChromium();
}

async function setSpanishLocation(page: Page): Promise<boolean> {
  try {
    await page.locator('#sp-cc-rejectall-link, #sp-cc-accept').first().click({ timeout: 1500 }).catch(() => {});
    await page.locator('#nav-global-location-popover-link, #glow-ingress-block').first().click({ timeout: 5000 });
    await page.waitForSelector('#GLUXZipUpdateInput', { timeout: 8000 });
    await page.fill('#GLUXZipUpdateInput', AMAZON_ZIP);
    await page.locator('#GLUXZipUpdate input, #GLUXZipUpdate').first().click({ timeout: 4000 });
    await randomDelay(2000, 3000);
    await page.locator('#GLUXConfirmClose, .a-popover-footer .a-button-primary input, [name="glowDoneButton"]').first().click({ timeout: 3000 }).catch(() => {});
    await randomDelay(1000, 1500);
    return true;
  } catch (e) {
    console.warn(`[scraper] no se pudo fijar el código postal ${AMAZON_ZIP}: ${(e as Error).message.slice(0, 80)}`);
    return false;
  }
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  return new Promise((r) => setTimeout(r, minMs + Math.random() * (maxMs - minMs)));
}

// Pure helpers (extractAsin / normaliseAmazonUrl / affiliateUrl /
// parseSpanishPrice) live in ./util for testability. Re-exported here so
// all existing `from '../scraper/amazon'` imports keep working.
export { extractAsin, normaliseAmazonUrl, scrapeUrl, affiliateUrl, parseSpanishPrice } from './util';
import { extractAsin, normaliseAmazonUrl, scrapeUrl, parseSpanishPrice } from './util';

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
// One browser identity per Amazon session: the cookies in the shared storage state were
// issued to this user agent/hints, so every scrape that reuses them must present the same one.
let _sessionProfile: UaProfile | null = null;

function sessionProfile(browser: Browser): UaProfile {
  if (!_sessionProfile) _sessionProfile = pickProfile(buildProfiles(browser.version()));
  return _sessionProfile;
}

/** Make navigator.* agree with the user agent we announce (headless Chromium on Linux
    would otherwise report platform "Linux x86_64" and its real userAgentData). */
function identityInitScript(p: UaProfile) {
  return {
    script: (id: { platform: string; chPlatform: string; platformVersion: string; fullVersion: string; brands: Array<{ brand: string; version: string }> }) => {
      Object.defineProperty(navigator, 'platform', { get: () => id.platform });
      const fullList = id.brands.map(b => ({ brand: b.brand, version: b.brand === 'Not_A Brand' ? `${b.version}.0.0.0` : id.fullVersion }));
      const data = {
        brands: id.brands, mobile: false, platform: id.chPlatform,
        getHighEntropyValues: async () => ({
          architecture: 'x86', bitness: '64', brands: id.brands, fullVersionList: fullList, mobile: false,
          model: '', platform: id.chPlatform, platformVersion: id.platformVersion, uaFullVersion: id.fullVersion, wow64: false,
        }),
        toJSON() { return { brands: id.brands, mobile: false, platform: id.chPlatform }; },
      };
      Object.defineProperty(navigator, 'userAgentData', { get: () => data });
    },
    arg: { platform: p.navigatorPlatform, chPlatform: p.chPlatform, platformVersion: p.platformVersion, fullVersion: p.fullVersion, brands: p.brands },
  };
}

function getBrowser(): Promise<Browser> {
  if (captchaDetectedAt && (Date.now() - captchaDetectedAt < CAPTCHA_COOLDOWN_MS)) {
    const remaining = Math.round((CAPTCHA_COOLDOWN_MS - (Date.now() - captchaDetectedAt)) / 1000);
    throw new CaptchaDetectedError(`[PAUSA] Amazon bloqueado. Esperando ${remaining}s`);
  }

  if (_browser?.isConnected() && _browserUses < BROWSER_RECYCLE_AFTER && !_browserNeedsRecycle) {
    _browserUses++;
    return Promise.resolve(_browser);
  }
  if (!_browserLaunchPromise) {
    _browserLaunchPromise = (async () => {
      if (_browser) {
        const old = _browser;
        const closed = await safeClose('browser.close', () => old.close());
        if (!closed || _browserNeedsRecycle) await forceKillChromium();
      }
      if (_killing) await _killing;   // a watchdog restartBrowser() may still be killing
      _browserNeedsRecycle = false;
      _storageStatePromise = null;
      const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
      _browser = await withTimeout(chromium.launch({
        headless: true,
        executablePath: executablePath || undefined,
        args: CHROMIUM_ARGS,
        ...(SCRAPER_PROXY ? { proxy: { server: SCRAPER_PROXY } } : {}),
      }), 30_000, 'chromium.launch');
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
      _sessionProfile = null;                       // new session → new identity
      const profile = sessionProfile(browser);
      console.log(`[scraper] identidad de sesión: ${profile.id} (Chromium ${browser.version()})`);
      // No extraHTTPHeaders here: they apply to EVERY request of the context, including the XHRs
      // behind Amazon's delivery-location popover, and with them the postal code never sticks
      // (A/B on 2026-11-13: 0/3 with headers, 3/3 without). Chromium sends its own Sec-CH-UA.
      const ctx = await browser.newContext({ userAgent: profile.userAgent, locale: 'es-ES' });
      { const id = identityInitScript(profile); await ctx.addInitScript(id.script, id.arg); }
      const page = await ctx.newPage();
      try {
        await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 25000 });
        await randomDelay(1000, 2000);
        // Amazon's "haz clic para seguir comprando" interstitial also shows on the home page.
        const homeBody = ((await page.textContent('body').catch(() => '')) ?? '').slice(0, 300);
        if (homeBody.includes('botón de abajo')) {
          await page.locator('input[type="submit"], button[type="submit"], a.a-button-text').first().click({ timeout: 3000 }).catch(() => {});
          await randomDelay(1500, 2500);
        }
        // Setting the postal code through Amazon's UI is occasionally flaky (popover not
        // ready, layout variant): retry, and only trust it once a reload shows our CP.
        let verified = false;
        for (let attempt = 1; attempt <= 3 && !verified; attempt++) {
          if (attempt > 1) {
            await page.goto('https://www.amazon.es', { waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
            await randomDelay(1000, 2000);
          }
          if (await setSpanishLocation(page)) {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            const label = ((await page.locator('#glow-ingress-block').first().textContent({ timeout: 3000 }).catch(() => '')) ?? '').replace(/\s+/g, ' ');
            verified = label.includes(AMAZON_ZIP);
          }
        }
        console.log(`[scraper] ubicación de entrega ${verified ? 'fijada y verificada' : 'NO verificada'} (CP ${AMAZON_ZIP})`);
        return await ctx.storageState();
      } finally {
        await safeClose('storage.page.close', () => page.close());
        await safeClose('storage.ctx.close', () => ctx.close());
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
  const profile = sessionProfile(browser);
  const vp = randomViewport();

  const context = await browser.newContext({
    userAgent: profile.userAgent,
    viewport: vp,
    locale: 'es-ES',
    timezoneId: 'Europe/Madrid',
    storageState,
    extraHTTPHeaders: profileHeaders(profile),
  });

  { const id = identityInitScript(profile); await context.addInitScript(id.script, id.arg); }

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

  const canonicalUrl = normaliseAmazonUrl(asin);   // stored / returned
  const pageUrl      = scrapeUrl(asin);            // what we navigate to (variation pinned)
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
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: pageLoadTimeoutMs });

        let pageTitle = await page.title();

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
            throw new ProductUnavailableError('Producto no encontrado en Amazon (ASIN eliminado o URL inválida)', 'gone');
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
            throw new ProductUnavailableError(`Producto no físico (servicio digital Amazon — "${pageTitle}")`, undefined, undefined, pageTitle || undefined);
          }

          // Try clicking through Amazon's interstitial ("Haz clic en el botón de abajo para seguir")
          if (bodyText.includes('botón de abajo') || bodyText.includes('continuar')) {
            const btn = page.locator('input[type="submit"], button[type="submit"], a.a-button-text').first();
            if (await btn.count() > 0) {
              console.log('[scraper] Interstitial detectado — intentando clic...');
              // "Seguir comprando" submits /errors_page/validateCaptcha and Amazon then
              // redirects to the HOME page, not back to the product. The old code looked for
              // #dp right after the click, saw the home page and declared a block (10 min
              // global pause) — 255 of 255 interstitials were misjudged that way. Click,
              // wait for the redirect, then load the product again.
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null),
                btn.click({ timeout: 3000 }).catch(() => {}),
              ]);
              await randomDelay(800, 1500);
              await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: pageLoadTimeoutMs }).catch(() => {});
              const dpCountAfter = await page.locator('#dp, #dp-container').count();
              if (dpCountAfter > 0) {
                console.log('[scraper] Interstitial superado con clic + recarga.');
                pageTitle = await page.title();
                // The product page may still be loading.
                await page.waitForSelector('#productTitle, meta[property="og:title"]', { timeout: 8000, state: 'attached' }).catch(() => {});
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

        // Location guard: Amazon localises offers by delivery address. If the page is
        // NOT rendered for our Spanish postal code, nothing below (price, stock,
        // used-offer detection) can be trusted, so bail out without judging the product.
        const ingress = ((await page.locator('#glow-ingress-block').first().textContent({ timeout: 2000 }).catch(() => '')) ?? '')
          .replace(/\s+/g, ' ').trim();
        if (ingress && /enviar a/i.test(ingress) && !ingress.includes(AMAZON_ZIP)) {
          _storageStatePromise = null;
          throw new WrongLocationError(`Amazon muestra la ubicación "${ingress.slice(0, 40)}" en vez de CP ${AMAZON_ZIP}`);
        }

        // Redirect guard: Amazon silently serves ANOTHER variant when the requested child ASIN
        // is retired (seen with an Apple Watch: dp/B0FQG75X2C rendered B0FQFLQJB1). Recording that
        // page's price under this ASIN would be wrong data, so treat it as a different product.
        const pageAsin = await page.locator('#ASIN').first().getAttribute('value', { timeout: 1500 }).catch(() => null);
        if (pageAsin && /^[A-Z0-9]{10}$/i.test(pageAsin) && pageAsin.toUpperCase() !== asin.toUpperCase()) {
          throw new ProductUnavailableError(`El ASIN redirige a otra variante (${pageAsin.toUpperCase()})`, 'redirect');
        }

        // Phase 1: name + availability in parallel. Title races every known
        // selector + falls back to the og:title meta tag — the latter is
        // present on every Amazon layout so the only way to genuinely fail
        // here is a non-product page (404 / blocked).
        const readTitle = (): Promise<string> =>
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
          });
        const readAvailability = (): Promise<string> =>
          page.locator('#availability').first().textContent({ timeout: 5000 }).then(t => t ?? '').catch(() => '');

        let [name, availabilityText] = await Promise.all([readTitle(), readAvailability()]);
        // Intermittently Amazon serves a half-rendered product page: the <title> carries
        // the product name but #productTitle never appears and the visible text is a
        // blob of internal JSON (~12 % of scrapes; products piled up with
        // "Título no encontrado" → 3-strike is_failed). The same ASIN loads fine on the
        // next request, so reload once before giving up.
        let degraded = false;
        if (!name) {
          console.log(`[scraper] ${asin} sin título (página incompleta) — recargando una vez`);
          await page.reload({ waitUntil: 'domcontentloaded', timeout: Math.min(pageLoadTimeoutMs, 15000) }).catch(() => {});
          await page.waitForSelector('#productTitle, #title span', { timeout: 6000, state: 'attached' }).catch(() => {});
          [name, availabilityText] = await Promise.all([readTitle(), readAvailability()]);
        }
        if (!name) {
          const bodyNow = ((await page.textContent('body').catch(() => '')) ?? '').slice(0, 200).replace(/\s+/g, ' ');
          // Still sitting on Amazon's interstitial: that's a session block, not a defect of this product.
          if (bodyNow.includes('botón de abajo')) {
            captchaDetectedAt = Date.now();
            _storageStatePromise = null;
            throw new CaptchaDetectedError(`Bloqueo Amazon (interstitial residual: "${bodyNow.slice(0, 100)}")`);
          }
          // Last resort: the <title> still names the product ("<name> : Amazon.es: <category>").
          const fromTitle = (await page.title().catch(() => pageTitle)).replace(/\s*:\s*Amazon\.es.*$/i, '').trim();
          if (fromTitle.length < 6) {
            throw new Error(`Título no encontrado (título: "${pageTitle.slice(0, 60)}" | body: "${bodyNow.slice(0, 100)}")`);
          }
          name = fromTitle;
          degraded = true;
        }
        if (availabilityText?.toLowerCase().includes('no disponible')) throw new ProductUnavailableError('Producto no disponible', undefined, undefined, name);

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
          throw new ProductUnavailableError('Solo segunda mano / reacondicionado disponible', 'used', offerState.snippet, name);
        }
        if (offerState?.state === 'unqualified') {
          throw new ProductUnavailableError('Sin oferta de Amazon — solo terceros vendedores', 'unqualified', offerState.snippet, name);
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

        // Treated as unavailability rather than a generic scrape error: when
        // Amazon renders a product page with no price selector matching, the
        // product effectively has no offer to show. Carrying the name through
        // lets the scheduler persist basic display info even though we never
        // reached persistScrapeResult.
        if (!rawPrice) {
          // A half-rendered page also lacks the buybox: that says nothing about stock,
          // so don't bench the product — fail this attempt and retry later.
          if (degraded) throw new Error(`Página incompleta sin título ni precio (${asin}); se reintentará`);
          throw new ProductUnavailableError('Sin precio disponible en Amazon', undefined, undefined, name);
        }
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
          page.evaluate((): { bsrValue: number | null; bsrCategory: string | null; reviewCount: number | null; boughtLastMonth: number | null; brand: string | null } => {
            const out: any = { bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null, brand: null };
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
              // Brand capture. Amazon serves brand text in 4 different shapes
              // across layouts; first probe revealed prod hit-rate was 5.6%
              // (242/4315) because the original code missed two of them.
              //
              //   1. #bylineInfo link — "Visita la Tienda de Apple",
              //      "Visit the Apple Store", "Apple Store", "Marca: Apple"
              //   2. #productOverview_feature_div table — "Marca | Apple"
              //   3. #detailBullets_feature_div li — "Marca ‏ : ‎ Apple" /
              //      "Manufacturer ‏ : ‎ HP" / "Brand ‏ : ‎ X"
              //   4. Schema.org meta — last resort, sometimes present in
              //      JSON-LD <script> blocks but parsing JSON in the
              //      sandboxed evaluate is brittle. Skip for now.
              const cleanBrand = (s: string): string => s
                .replace(/^Visita la Tienda de\s+/i, '')
                .replace(/^Visit the\s+/i, '')
                .replace(/\s+Store$/i, '')
                .replace(/\s+Tienda$/i, '')
                .replace(/^(?:Marca|Brand|Manufacturer|Fabricante)\s*[:\s]\s*/i, '')
                .replace(/[‏‎]/g, '')        // strip the U+200F / U+200E direction marks
                .trim()
                .slice(0, 100);
              // Tier 1: byline
              const byline = document.querySelector('#bylineInfo');
              if (byline) {
                const t = (byline.textContent || '').trim();
                if (t && t.length < 120 && !/^\s*$/.test(t)) {
                  const c = cleanBrand(t);
                  if (c && !/^Visit|^Visita/i.test(c)) out.brand = c;
                }
              }
              // Tier 2 + 3: scan ALL likely table rows for label-like prefixes
              if (!out.brand) {
                const rowSelectors = [
                  '#productOverview_feature_div tr',
                  '#detailBullets_feature_div li',
                  '#detailBulletsWrapper_feature_div li',
                  '#productDetails_detailBullets_sections1 tr',
                  '#productDetails_techSpec_section_1 tr',
                ];
                for (const sel of rowSelectors) {
                  for (const row of Array.from(document.querySelectorAll(sel))) {
                    const txt = (row.textContent || '').replace(/[‏‎ ]/g, ' ').replace(/\s+/g, ' ').trim();
                    const m = txt.match(/^(?:Marca|Brand|Manufacturer|Fabricante)\s*[:\s]\s+([^|\n]{2,80})$/i);
                    if (m) { out.brand = cleanBrand(m[1]); break; }
                  }
                  if (out.brand) break;
                }
              }
            } catch { /* swallow — metadata is opportunistic */ }
            return out;
          }).catch(() => ({ bsrValue: null, bsrCategory: null, reviewCount: null, boughtLastMonth: null, brand: null })),
        ]);

        return {
          asin, name, price, currency: 'EUR', imageUrl, extraImages,
          url: canonicalUrl, wasPrice, variants,
          bsrValue:        metadata.bsrValue,
          bsrCategory:     metadata.bsrCategory,
          reviewCount:     metadata.reviewCount,
          boughtLastMonth: metadata.boughtLastMonth,
          brand:           metadata.brand,
        };
      })(),
      hardTimeout,
    ]);
    return result;
  } catch (err) {
    // A hard timeout means the page (or Chromium itself) is wedged: recycle the
    // browser before the next scrape instead of reusing a possibly frozen one.
    if (err instanceof Error && err.message.startsWith('[hard_timeout]')) _browserNeedsRecycle = true;
    throw err;
  } finally {
    clearTimeout(timeoutHandle);
    const pageOk = await safeClose('page.close', () => page.close({ runBeforeUnload: false }));
    const ctxOk  = await safeClose('context.close', () => context.close());
    if (!pageOk || !ctxOk) _browserNeedsRecycle = true;
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
    await safeClose('page.close', () => page.close({ runBeforeUnload: false }));
    await safeClose('context.close', () => context.close());
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
    await safeClose('page.close', () => page.close({ runBeforeUnload: false }));
    await safeClose('context.close', () => context.close());
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
    await safeClose('page.close', () => page.close({ runBeforeUnload: false }));
    await safeClose('context.close', () => context.close());
  }
}

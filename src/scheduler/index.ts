import cron from 'node-cron';
import { db } from '../db/client';
import { products, priceHistory, alerts, alertEvents, users, scrapeAnomalies, userProducts, purgedAsins } from '../db/schema';
import { eq, and, desc, min, isNull, sql, inArray } from 'drizzle-orm';
import { assignGroup, backfillProductGroups } from './groups';
import { scrapeProduct, affiliateUrl, ProductUnavailableError, CaptchaDetectedError, WrongLocationError, restartBrowser, isCaptchaBlocked, captchaRemainingMs, type ScrapeResult } from '../scraper/amazon';
import { autoCategorizeId } from '../scraper/categorize';
import { emitScrapeUpdate } from '../lib/product-events';
import { sendPriceAlert, sendBackInStockAlert, sendProductRemovedEmail } from '../mailer';
import { decideAfterConfirmedUnavailable, describeReason, DEFAULT_LIFECYCLE, type UnavailableReason } from './lifecycle';
import { sendTelegramAlert, sendTelegramBackInStock } from '../mailer/telegram';
import { getSetting } from '../db/settings';
import { selectDue } from './selection';
import { Breaker, type ExecutorStatus } from './executors';
import { sameArticle, ASIN_RE } from './redirect';
import { startExecutorMonitor, isExecutorPaused, getExecutorSystem, pruneExecutorMetrics } from './executor-monitor';
import { remoteScrape, parseRemotes, ExecutorUnavailableError } from '../scraper/remote';
import { sendOpsAlert } from '../lib/ops-alert';
import { optionDisplayName } from '../lib/variants';

const CHECK_INTERVAL = process.env.CHECK_INTERVAL_CRON ?? '0 * * * *';

export interface ScraperLogEntry { id: number; name: string; asin: string; ok: boolean; ts: number; }

export interface ScraperStatus {
  isRunning: boolean;
  current: { id: number; name: string; asin: string } | null;
  done: number;
  total: number;       // products due this cycle
  activeCount: number; // total active non-failed products
  log: ScraperLogEntry[];
}

const state: ScraperStatus = { isRunning: false, current: null, done: 0, total: 0, activeCount: 0, log: [] };

export function getScraperStatus(): ScraperStatus { return { ...state, log: [...state.log] }; }

let isRunning = false;

// ── Cycle supervision ────────────────────────────────────────────────────────
// A wedged Chromium used to freeze one worker forever; `isRunning` then stayed
// true and every later cycle was skipped ("Previous run still active") for
// 11 days. Now: every cycle has a generation id (a watchdog can abandon a stuck
// one), a hard deadline shorter than the cron period, and a progress heartbeat.
let cycleGen = 0;
let cycleStartedAt = 0;
let lastProgressAt = Date.now();
let lastOkAt = Date.now();      // last time Amazon gave us a definitive answer
let lastDueCount = 0;
const CYCLE_MAX_MS           = 50 * 60 * 1000;      // end before the next hourly tick
const STUCK_AFTER_MS         = 8 * 60 * 1000;       // nothing finished for 8 min
const NO_OK_ALERT_AFTER_MS   = 3 * 60 * 60 * 1000;  // no definitive answer for 3 h
const MAX_CONSECUTIVE_BLOCKS = 3;

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ── Executors (where scrapes run: this process, or remote machines such as the Pi) ──
interface Executor { name: string; kind: 'local' | 'remote'; scrape: ScrapeFn; breaker?: Breaker; }
const executorStats = new Map<string, ExecutorStatus>();
const remoteBreakers = new Map<string, Breaker>();
function statFor(e: Executor): ExecutorStatus {
  let st = executorStats.get(e.name);
  if (!st) { st = { name: e.name, kind: e.kind, done: 0, failed: 0, breakerOpen: false, lastError: null }; executorStats.set(e.name, st); }
  return st;
}

export function getScraperHealth() {
  const now = Date.now();
  const stuck = isRunning && now - lastProgressAt > STUCK_AFTER_MS;
  const noAnswers = lastDueCount > 0 && now - lastOkAt > NO_OK_ALERT_AFTER_MS;
  return {
    ok: !stuck && !noAnswers,
    isRunning, stuck, noAnswers,
    lastProgressAgeSec: Math.round((now - lastProgressAt) / 1000),
    lastAnswerAgeSec:   Math.round((now - lastOkAt) / 1000),
    cycleAgeSec:        isRunning ? Math.round((now - cycleStartedAt) / 1000) : null,
    done: state.done, total: state.total,
    executors: [...executorStats.values()].map(e => ({
      ...e,
      breakerOpen: remoteBreakers.get(e.name)?.isOpen(Date.now()) ?? false,
      pausedForPressure: e.kind === 'remote' ? isExecutorPaused(e.name) : false,
      system: e.kind === 'remote' ? (getExecutorSystem(e.name) ?? null) : null,
    })),
  };
}

// A cron tick that arrives while a cycle is still running is remembered, so the next cycle
// starts right after the current one instead of idling until the following hour. Without
// this, a mid-hour restart left the scraper stopped for up to ~50 min (the 50 min cycle
// deadline ended just past :00, that tick was skipped, and the next one was an hour away).
let tickSkipped = false;

async function checkAllProducts(): Promise<void> {
  if (isRunning) {
    console.log('[scheduler] Previous run still active, skipping.');
    tickSkipped = true;
    return;
  }
  tickSkipped = false;
  isRunning = true;
  const gen = ++cycleGen;
  const alive = () => gen === cycleGen;
  cycleStartedAt = Date.now();
  lastProgressAt = Date.now();
  state.isRunning = true;
  state.done = 0;
  state.log = [];

  // Abort cycle early if IP is still in captcha cooldown
  if (isCaptchaBlocked()) {
    const secs = Math.round(captchaRemainingMs() / 1000);
    console.log(`[scheduler] IP bloqueada, saltando ciclo. Cooldown restante: ${secs}s`);
    isRunning = false;
    state.isRunning = false;
    return;
  }

  // Read live settings from DB each cycle — DB is source of truth, no env fallbacks
  const CONCURRENCY            = Math.max(1, Math.min(8,   Number(await getSetting('scraper_concurrency',    2))));
  const RETRY_FAILED_PER_CYCLE = Math.max(0, Math.min(100, Number(await getSetting('retry_failed_per_cycle', 30))));
  const MIN_AGE_MINUTES        = Math.max(1, Math.min(1440,Number(await getSetting('min_age_minutes',        59))));
  const SCRAPER_TIMEOUT        = Math.max(15,Math.min(120, Number(await getSetting('scraper_timeout_seconds',30))));
  // Remote executors (the Pi 4) are several times slower per page (measured 27-36 s vs ~7 s here), so they
  // need their own, longer plazo; with the local 24 s almost every product page timed out there.
  const REMOTE_TIMEOUT         = Math.max(30,Math.min(120, Number(await getSetting('scraper_remote_timeout_seconds', 75))));
  const MIN_AGE_MS = MIN_AGE_MINUTES * 60 * 1000;
  // Unavailable products are "paused": rechecked only this often (grace period before removal).
  const UNAVAILABLE_RECHECK_MS = Math.max(1, Math.min(168, Number(await getSetting('unavailable_pause_hours', 24)))) * 60 * 60 * 1000;

  let processed = 0, answered = 0;
  try {
    // Release up to RETRY_FAILED_PER_CYCLE failed products back into the normal cycle.
    // Ordered by id ASC so the backlog drains predictably (30/cycle ≈ 17 cycles for 512 products).
    if (RETRY_FAILED_PER_CYCLE > 0) {
      const retried = await db.execute(sql`
        UPDATE products
        SET is_failed = FALSE, consecutive_failures = 0
        WHERE id IN (
          SELECT id FROM products
          WHERE is_active = TRUE AND is_failed = TRUE
          ORDER BY id ASC
          LIMIT ${RETRY_FAILED_PER_CYCLE}
        )
        RETURNING id
      `);
      if (retried.rows.length > 0) {
        console.log(`[scheduler] Retry: ${retried.rows.length} failed products re-queued for this cycle`);
      }
    }

    const sysId = await getSystemUserId();
    const activeProducts = await db.execute(sql`
      SELECT p.id, p.url, p.name, p.asin,
        p.is_available AS "isAvailable",
        p.last_checked_at AS "lastCheckedAt",
        (SELECT ph.scraped_at FROM price_history ph WHERE ph.product_id = p.id ORDER BY ph.scraped_at DESC LIMIT 1) AS "lastScrapedAt",
        (p.group_id IS NOT NULL AND p.created_by_user_id IS NOT DISTINCT FROM ${sysId}
          AND NOT EXISTS (SELECT 1 FROM user_products up WHERE up.product_id = p.id AND up.user_id IS DISTINCT FROM ${sysId})
          AND NOT EXISTS (SELECT 1 FROM alerts al WHERE al.product_id = p.id)) AS "lowPriority"
      FROM products p
      WHERE p.is_active = TRUE AND p.is_failed = FALSE
    `);
    // Oldest-checked first; unavailable products are rechecked at most every 12 h.
    const toCheck = selectDue(activeProducts.rows as any[], Date.now(), MIN_AGE_MS, UNAVAILABLE_RECHECK_MS);
    state.total = toCheck.length;
    state.activeCount = activeProducts.rows.length;
    lastDueCount = toCheck.length;
    console.log(`[scheduler] ${toCheck.length}/${activeProducts.rows.length} products due for check (${CONCURRENCY} workers)…`);

    // Worker pool. Workers run on EXECUTORS: this process (CONCURRENCY workers) plus, when
    // `scraper_remote_concurrency` > 0 and SCRAPER_REMOTES is set, workers whose scrapes run
    // on a remote machine (the Pi). The queue, persistence and alerts stay here either way.
    const localExec: Executor = { name: 'local', kind: 'local', scrape: scrapeProduct };
    const remoteCount = Math.max(0, Math.min(4, Number(await getSetting('scraper_remote_concurrency', 0))));
    const remoteExecs: Executor[] = remoteCount > 0
      ? parseRemotes(process.env.SCRAPER_REMOTES, process.env.SCRAPER_REMOTE_TOKEN).map(cfg => {
          if (!remoteBreakers.has(cfg.name)) remoteBreakers.set(cfg.name, new Breaker());
          return { name: cfg.name, kind: 'remote' as const, scrape: (u: string, t: number) => remoteScrape(cfg, u, t), breaker: remoteBreakers.get(cfg.name)! };
        })
      : [];
    const executors: Executor[] = [
      ...Array.from({ length: CONCURRENCY }, () => localExec),
      ...(remoteExecs.length ? Array.from({ length: remoteCount }, (_, i) => remoteExecs[i % remoteExecs.length]) : []),
    ];
    if (remoteExecs.length) console.log(`[scheduler] Ejecutores remotos: ${remoteCount} worker(s) en ${[...new Set(remoteExecs.map(e => e.name))].join(', ')}`);

    // A product handed back after its executor failed is retried by another worker, at most twice.
    const requeues = new Map<number, number>();
    let idx = 0;
    const counters = new Map<string, { blocks: number; wrongLoc: number }>();
    const stopped = new Set<string>();     // executors that gave up for this cycle
    const countersFor = (name: string) => { let c = counters.get(name); if (!c) { c = { blocks: 0, wrongLoc: 0 }; counters.set(name, c); } return c; };

    async function worker(exec: Executor): Promise<void> {
      const st = statFor(exec);
      const cnt = countersFor(exec.name);
      while (alive() && !stopped.has(exec.name) && idx < toCheck.length && Date.now() - cycleStartedAt < CYCLE_MAX_MS) {
        // A remote executor whose breaker is open sits out (and keeps the watchdog calm) until it closes.
        if (exec.breaker?.isOpen(Date.now()) || (exec.kind === 'remote' && isExecutorPaused(exec.name))) { lastProgressAt = Date.now(); await sleep(5000); continue; }
        const product = toCheck[idx++];
        state.current = { id: product.id, name: product.name ?? product.asin, asin: product.asin };
        let ok = true;
        try {
          await checkProduct(product.id, product.url, product.name ?? product.asin, exec.kind === 'remote' ? REMOTE_TIMEOUT : SCRAPER_TIMEOUT, exec.scrape);
          cnt.blocks = 0; cnt.wrongLoc = 0; answered++; st.done++;
          exec.breaker?.success();
        } catch (e) {
          ok = false;
          if (e instanceof ExecutorUnavailableError) {
            st.failed++; st.lastError = e.message.slice(0, 160);
            const n = (requeues.get(product.id) ?? 0) + 1;
            requeues.set(product.id, n);
            if (n <= 2) toCheck.push(product);        // another worker (or this one later) takes it
            const opened = exec.breaker!.failure(Date.now());
            console.log(`[scheduler] Ejecutor ${exec.name} no disponible (${e.message.slice(0, 100)})${opened ? ' — se aparta 5 min' : ''}`);
            if (opened) {
              await sendOpsAlert(`executor-${exec.name}`, `El ejecutor remoto "${exec.name}" no responde`, [
                `Tres fallos seguidos hablando con ${exec.name}. Se aparta 5 minutos; el scraper sigue con el resto.`,
                `Último error: ${e.message.slice(0, 200)}`,
                'Revisa que la Pi esté encendida, con Tailscale activo y el contenedor del scraper en marcha.',
              ], 60 * 60 * 1000);
            }
            lastProgressAt = Date.now();
            await sleep(5000);
            continue;
          }
          if (e instanceof CaptchaDetectedError) {
            // Don't abort the whole cycle on one block: pause for the cooldown and carry on.
            // Only give up (and warn the admin) after several blocks in a row.
            if (!e.message.startsWith('[PAUSA]')) cnt.blocks++;
            if (cnt.blocks >= MAX_CONSECUTIVE_BLOCKS) {
              stopped.add(exec.name);
              await sendOpsAlert(`blocks-${exec.name}`, exec.kind === 'local' ? 'Amazon está bloqueando el scraper' : `Amazon está bloqueando el ejecutor "${exec.name}"`, [
                `${cnt.blocks} bloqueos seguidos (interstitial/captcha). Este ejecutor se detiene y se reintenta en el próximo ciclo.`,
                `Último mensaje: ${e.message.slice(0, 200)}`,
              ]);
              break;
            }
            // The cooldown clock of a remote machine lives there; use a fixed pause for remotes.
            const waitMs = (exec.kind === 'local' ? Math.min(captchaRemainingMs(), 11 * 60 * 1000) : 10 * 60 * 1000) + 2000;
            console.log(`[scheduler] Bloqueo de Amazon en ${exec.name} (${cnt.blocks}/${MAX_CONSECUTIVE_BLOCKS}); pausa ${Math.round(waitMs / 1000)}s y sigo`);
            for (let waited = 0; waited < waitMs && alive(); waited += 5000) { await sleep(5000); lastProgressAt = Date.now(); }
            continue;
          }
          if (e instanceof WrongLocationError) {
            cnt.wrongLoc++;
            if (cnt.wrongLoc === 3) {
              await sendOpsAlert(`location-${exec.name}`, 'Amazon no respeta la ubicación en España', [
                `${cnt.wrongLoc} páginas seguidas con ubicación distinta del CP ${process.env.AMAZON_ZIP || '28001'} (ejecutor: ${exec.name}).`,
                `Detalle: ${e.message}`,
                'Se reinicia el navegador y se vuelve a fijar el código postal.',
              ]);
              if (exec.kind === 'local') restartBrowser();   // a remote service resets its own session on this error
              await sleep(30_000);
            } else if (cnt.wrongLoc >= 8) { stopped.add(exec.name); break; }
          }
        }
        processed++;
        if (!alive()) return;
        lastProgressAt = Date.now();
        state.log.unshift({ id: product.id, name: product.name ?? product.asin, asin: product.asin, ok, ts: Date.now() });
        if (state.log.length > 50) state.log.pop();
        state.done++;
        // Delay skewed toward lower bound: x² pushes ~75% of values into the bottom half of the range
        await sleep(1000 + Math.floor(Math.random() ** 2 * 4000));
      }
    }

    await Promise.all(executors.slice(0, Math.max(1, toCheck.length)).map(exec => worker(exec)));

    if (alive()) {
      const hitDeadline = Date.now() - cycleStartedAt >= CYCLE_MAX_MS;
      console.log(`[scheduler] Cycle complete. ${answered}/${processed} respuestas válidas en ${Math.round((Date.now() - cycleStartedAt) / 60000)} min${hitDeadline ? ' (plazo del ciclo agotado)' : ''}.`);
      if (processed >= 30 && answered / processed < 0.3) {
        await sendOpsAlert('lowrate', 'El scraper casi no obtiene respuestas válidas', [
          `Ciclo con ${answered} respuestas válidas de ${processed} intentos (<30 %).`,
          'Puede ser un cambio en la web de Amazon, un bloqueo o la ubicación.',
        ], 6 * 60 * 60 * 1000);
      }
    }
  } catch (err) {
    console.error('[scheduler] Unexpected error in cycle:', err);
  } finally {
    // A watchdog-abandoned generation must not clobber the state of its successor.
    if (alive()) {
      isRunning = false;
      state.isRunning = false;
      state.current = null;
      if (tickSkipped) {
        tickSkipped = false;
        console.log('[scheduler] Había un aviso pendiente: arranco el siguiente ciclo ya.');
        setTimeout(() => { checkAllProducts().catch(e => console.error('[scheduler] ciclo encadenado:', e)); }, 3000);
      }
    }
  }
}

/**
 * Watchdog (cron, every 5 min). If the running cycle has finished nothing for
 * STUCK_AFTER_MS it is wedged (frozen Chromium): abandon it, kill the browser,
 * tell the admin and start a fresh cycle. Also alerts when Amazon hasn't given
 * a definitive answer for hours although products were due.
 */
export async function runScraperWatchdog(): Promise<void> {
  const now = Date.now();
  if (isRunning && now - lastProgressAt > STUCK_AFTER_MS) {
    const mins = Math.round((now - lastProgressAt) / 60000);
    const lastAsin = state.current?.asin ?? 'desconocido';
    console.error(`[watchdog] Ciclo colgado: ${mins} min sin progreso (${lastAsin}). Reiniciando.`);
    cycleGen++;               // orphan the stuck workers
    isRunning = false;
    state.isRunning = false;
    state.current = null;
    restartBrowser();
    await sendOpsAlert('stuck', 'Scraper colgado: reiniciado automáticamente', [
      `Llevaba ${mins} min sin completar ningún producto (último: ${lastAsin}).`,
      'El vigilante ha matado Chromium y lanza un ciclo nuevo.',
    ], 60 * 60 * 1000);
    setTimeout(() => { checkAllProducts().catch(e => console.error('[watchdog] relanzar ciclo:', e)); }, 5000);
    return;
  }
  if (lastDueCount > 0 && now - lastOkAt > NO_OK_ALERT_AFTER_MS) {
    await sendOpsAlert('noanswers', 'Sin respuestas válidas de Amazon desde hace horas', [
      `Última respuesta definitiva hace ${Math.round((now - lastOkAt) / 60000)} min, con ${lastDueCount} productos pendientes.`,
    ], 6 * 60 * 60 * 1000);
  }
}

// Pure sale logic lives in ./sale-logic for unit testability without pulling
// in db/playwright at module load. Re-exported here for backwards compat.
export { calcSaleTier, evaluateAutoFeature, type SaleInfo } from './sale-logic';
import { calcSaleTier, evaluateAutoFeature, type SaleInfo } from './sale-logic';

/**
 * Compute sale info and persist a scrape result atomically.
 *
 * Used by both the scheduler's `checkProduct` and the admin manual-refresh
 * endpoint so they share the exact same behaviour: was_price, sale tier,
 * deal score, name/image, error flags — everything is consistent regardless
 * of who triggered the scrape.
 *
 * `stats` is optional. The scheduler already pre-fetches all-time stats for
 * other reasons and passes them in to avoid a duplicate query; the manual
 * refresh path passes nothing and we fetch them here.
 *
 * Returns the computed SaleInfo so the caller can react (e.g. process alerts).
 */
export async function persistScrapeResult(
  productId: number,
  result: ScrapeResult,
  opts: { allTimeMax?: number | null; scrapeCount?: number; daysSpan?: number; label?: string; skipVariantIngest?: boolean } = {},
): Promise<SaleInfo> {
  let { allTimeMax, scrapeCount, daysSpan } = opts;
  // recent_high is always fetched: it's the MAX price observed between 2 and
  // 14 days ago and serves as the baseline for "real" sale detection. The
  // scheduler doesn't preflight it, so we read it here regardless of opts.
  const stats2Res = await db.execute(sql`
    SELECT
      ${allTimeMax === undefined  ? sql`MAX(price)::float`                                              : sql`NULL::float`} AS all_time_max,
      ${scrapeCount === undefined ? sql`COUNT(*)::int`                                                  : sql`NULL::int`}   AS scrape_count,
      ${daysSpan === undefined    ? sql`EXTRACT(DAY FROM (NOW() - MIN(scraped_at)))::int`               : sql`NULL::int`}   AS days_span,
      (SELECT MAX(price)::float FROM price_history
        WHERE product_id = ${productId}
          AND scraped_at >= NOW() - INTERVAL '14 days'
          AND scraped_at <  NOW() - INTERVAL '2 days')                                                  AS recent_high
    FROM price_history WHERE product_id = ${productId}
  `);
  const r = stats2Res.rows[0] as any;
  if (allTimeMax  === undefined) allTimeMax  = (r?.all_time_max  ?? null) as number | null;
  if (scrapeCount === undefined) scrapeCount = (r?.scrape_count  ?? 0)    as number;
  if (daysSpan    === undefined) daysSpan    = (r?.days_span     ?? 0)    as number;
  const recentHigh = (r?.recent_high ?? null) as number | null;

  // Read current feature + category state so we can decide whether to toggle
  // is_public AND set category_id in the same transaction as the scrape.
  const [stateRow] = await db.select({
    featureLock: products.featureLock,
    isPublic:    products.isPublic,
    isAvailable: products.isAvailable,
    featuredAt:  products.featuredAt,
    categoryId:  products.categoryId,
  }).from(products).where(eq(products.id, productId)).limit(1);

  // Auto-categorise: only when the product has no category yet (admin-set or
  // category-import-set values are never overwritten). Best-effort — a name
  // that doesn't match any rule keeps category_id NULL and shows up on the
  // admin uncategorized list.
  let nextCategoryId = stateRow?.categoryId ?? null;
  if (nextCategoryId === null && result.name) {
    try {
      const guess = await autoCategorizeId(result.name);
      if (guess !== null) {
        nextCategoryId = guess;
        if (opts.label) console.log(`[scheduler] ${opts.label} → auto-categorize → category #${guess}`);
      }
    } catch (err) { console.error('[scheduler] auto-categorize failed:', err); }
  }

  // is_on_sale and deal_score are derived from REAL price movement, not from
  // Amazon's "PVP recomendado" (wasPrice) — that field is routinely inflated
  // and was flagging stable-price products as permanently on sale. The
  // baseline is the max price observed 2-14 days ago; current must be below
  // that for the product to count as on sale. wasPrice still gets stored and
  // shown in the UI as a crossed-out RRP, just not used to drive on_sale.
  const hasEnoughHistory = scrapeCount! >= 5 && daysSpan! >= 2;
  const baselineRef = (hasEnoughHistory && recentHigh !== null && result.price < recentHigh)
    ? recentHigh
    : null;
  const saleInfo: SaleInfo = baselineRef
    ? calcSaleTier(result.price, baselineRef)
    : { isOnSale: false, saleTier: null, dealScore: null };

  if (saleInfo.isOnSale && opts.label) {
    console.log(`[scheduler] ${opts.label} → ${saleInfo.saleTier} (${saleInfo.dealScore!.toFixed(1)}% off, ref ${baselineRef?.toFixed(2)} [recent_high 2-14d])`);
  }

  // Auto-curation of /ofertas. Only when feature_lock = 'auto'. 'pin' and 'mute'
  // are admin overrides preserved as-is. Alerts are NOT affected by this — the
  // alerts table joins on product_id only, never on is_public.
  let nextIsPublic   = stateRow?.isPublic   ?? false;
  let nextFeaturedAt = stateRow?.featuredAt ?? null;
  if (stateRow && stateRow.featureLock === 'auto') {
    const minScoreRaw = await getSetting('featured_min_deal_score', 20);
    const minScore    = Math.max(5, Math.min(95, Number(minScoreRaw)));
    const decision = evaluateAutoFeature(
      { isPublic: stateRow.isPublic, isAvailable: true, featuredAt: stateRow.featuredAt as Date | null },
      saleInfo, scrapeCount!, daysSpan!, minScore,
    );
    if (decision.isPublic !== stateRow.isPublic && opts.label) {
      console.log(`[scheduler] ${opts.label} → auto-feature ${decision.isPublic ? 'IN' : 'OUT'} (score=${(saleInfo.dealScore ?? 0).toFixed(1)}, threshold=${minScore})`);
    }
    nextIsPublic   = decision.isPublic;
    nextFeaturedAt = decision.featuredAt;
  }

  // Atomic insert + update so a SIGTERM/SIGKILL between the writes can't leave
  // a price_history row without its matching wasPrice / sale-flag update.
  await db.transaction(async (tx) => {
    await tx.insert(priceHistory).values({ productId, price: String(result.price), currency: result.currency });
    await tx.update(products).set({
      name: result.name,
      imageUrl: result.imageUrl,
      extraImages: result.extraImages.length ? JSON.stringify(result.extraImages) : null,
      variantsJson: result.variants && result.variants.length ? JSON.stringify(result.variants) : null,
      consecutiveUnavailable: 0,
      unavailableConfirmations: 0,
      lastError: null,
      isAvailable: true,
      consecutiveFailures: 0,
      consecutiveAnomalies: 0,
      isFailed: false,
      isOnSale: saleInfo.isOnSale,
      saleTier: saleInfo.saleTier,
      dealScore: saleInfo.dealScore != null ? String(saleInfo.dealScore.toFixed(1)) : null,
      ...(result.wasPrice != null ? { wasPrice: String(result.wasPrice.toFixed(2)) } : {}),
      isPublic:   nextIsPublic,
      featuredAt: nextFeaturedAt,
      categoryId: nextCategoryId,
      // Popularity metadata — only overwrite when the scraper actually
      // captured something. A null from the scraper means "didn't find the
      // selector this time"; preserving the previous value is safer than
      // wiping it (auto-cleanup uses these to decide pause-eligibility).
      ...(result.bsrValue        != null ? { bsrValue:        result.bsrValue }        : {}),
      ...(result.bsrCategory     != null ? { bsrCategory:     result.bsrCategory }     : {}),
      ...(result.reviewCount     != null ? { reviewCount:     result.reviewCount }     : {}),
      ...(result.boughtLastMonth != null ? { boughtLastMonth: result.boughtLastMonth } : {}),
      ...(result.brand           != null ? { brand:           result.brand }           : {}),
      ...(result.bsrValue != null || result.reviewCount != null || result.boughtLastMonth != null || result.brand != null
          ? { lastMetadataAt: new Date() } : {}),
    }).where(eq(products.id, productId));
  });

  if (opts.label) console.log(`[scheduler] ${opts.label} → ${result.price} ${result.currency}`);

  // Live push to any open /p/:asin viewer via SSE. Fire-and-forget — listeners
  // re-render server-side fragments on their own.
  emitScrapeUpdate(result.asin);

  // (featured cap, anomaly TTL, blacklist TTL all run together in the
  // hourly maintenance task — not here. Doing them per-scrape thrashed the
  // window function across thousands of rows; once an hour is plenty.)

  // Variant auto-ingest + immediate scrape. For each twister sibling we don't
  // already have, insert it owned by the system user with the parent's
  // category, then queue an immediate background scrape so users see prices
  // right away instead of waiting for the next scheduler cycle. skipVariantIngest
  // breaks the recursion: variants scraped from the queue don't re-ingest their
  // own siblings (they'd be the same set we just discovered).
  if (result.variants && result.variants.length) {
    try {
      // The new rows have last_checked_at = NULL: the first-scrape loop (startFirstScrapeLoop) picks them up
      // within seconds. It reads the database, so a restart in between loses nothing.
      // Discovery starts ONLY from products someone really follows (a system-discovered variant never
      // discovers its own siblings: colour x size families would multiply the catalog), and only for options
      // Amazon offers (an unavailable size would just be purged again).
      if (!opts.skipVariantIngest && ((await getProtection(productId))?.realFollowersN ?? 0) > 0) {
        await ingestNewVariants(productId, [...new Set(result.variants.filter(v => !v.self && v.selectable !== false).map(v => v.asin))]);
      }
      // Group the family (size/colour options) so it is shown as one article.
      await assignGroup(result.asin, result.parentAsin ?? null, result.variants);
    } catch (err) {
      console.error(`[scheduler] variant ingest/group failed for ${result.asin}:`, err);
    }
  }

  return saleInfo;
}

// ── First-scrape loop ────────────────────────────────────────────────────────
// Products nobody has scraped yet (freshly discovered variants above all) are read right away instead of
// waiting for the next 50-minute cycle, which builds its list at the start. State lives in the database
// (last_checked_at IS NULL and no price yet), so a deploy/restart in between loses nothing. One product at
// a time, user-added ones first, and it backs off when the scraper is struggling.
let _firstScrapeRunning = false;

async function pickNeverScraped(): Promise<{ id: number; asin: string; url: string; name: string | null } | null> {
  const systemId = await getSystemUserId();
  const r = await db.execute(sql`
    SELECT p.id, p.asin, p.url, p.name FROM products p
    WHERE p.is_active = TRUE AND p.last_checked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM price_history ph WHERE ph.product_id = p.id)
      AND p.created_at > NOW() - INTERVAL '3 days'
      -- a product the user just added is being read by the add request itself: give that a moment
      AND (p.created_by_user_id IS NOT DISTINCT FROM ${systemId} OR p.created_at < NOW() - INTERVAL '90 seconds')
    ORDER BY (p.created_by_user_id IS NOT DISTINCT FROM ${systemId}) ASC, p.id ASC
    LIMIT 1
  `);
  return (r.rows[0] as any) ?? null;
}

export function startFirstScrapeLoop(): void {
  if (_firstScrapeRunning) return;
  _firstScrapeRunning = true;
  const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
  void (async () => {
    await sleep(20_000);
    for (;;) {
      try {
        const next = await pickNeverScraped();
        if (!next) { await sleep(10_000); continue; }
        await checkProduct(next.id, next.url, next.name ?? next.asin, 40);
        await sleep(1_500);
      } catch (err) {
        console.warn('[first-scrape] paused 2 min:', err instanceof Error ? err.message : err);
        await sleep(120_000);
      }
    }
  })();
  console.log('[first-scrape] Lectura inmediata de productos nuevos sin precio (variantes descubiertas incluidas).');
}

let _systemUserIdCache: number | null = null;
async function getSystemUserId(): Promise<number | null> {
  if (_systemUserIdCache !== null) return _systemUserIdCache;
  const r = await db.select({ id: users.id }).from(users).where(eq(users.email, 'system@ojoalprecio.local')).limit(1);
  _systemUserIdCache = r[0]?.id ?? null;
  return _systemUserIdCache;
}

/** Upper bound of new catalog rows one scrape may create (a colour x size family can list 100+ options). */
const MAX_INGEST_PER_SCRAPE = 60;

async function ingestNewVariants(parentProductId: number, variantAsins: string[]): Promise<Array<{ productId: number; asin: string }>> {
  if (!variantAsins.length) return [];
  const systemUserId = await getSystemUserId();
  if (systemUserId === null) return [];

  // Filter out ASINs that already exist anywhere in the catalog. Use the
  // drizzle `inArray` helper instead of `ANY(${...})` because the raw sql
  // template serializes a JS array as a string literal, which Postgres then
  // refuses with "malformed array literal".
  const existingRows = await db
    .selectDistinct({ asin: products.asin })
    .from(products)
    .where(inArray(products.asin, variantAsins));
  const existing = new Set(existingRows.map(r => r.asin));
  // ASINs Amazon already moved to another one must not come back as new products.
  const aliasRows = await db.execute(sql`SELECT old_asin FROM asin_redirects WHERE old_asin IN (${sql.join(variantAsins.map(a => sql`${a}`), sql`, `)})`);
  for (const r of aliasRows.rows as any[]) existing.add(String(r.old_asin));

  // Also skip ASINs that were recently auto-purged (within 30 days). Without
  // this, the next parent scrape re-discovers them and we churn forever.
  const purgedRows = await db
    .select({ asin: purgedAsins.asin })
    .from(purgedAsins)
    .where(and(inArray(purgedAsins.asin, variantAsins), sql`purged_at > NOW() - INTERVAL '30 days'`));
  const purged = new Set(purgedRows.map(r => r.asin));

  const newAsins = variantAsins.filter(a => !existing.has(a) && !purged.has(a)).slice(0, MAX_INGEST_PER_SCRAPE);
  if (!newAsins.length) return [];

  // Inherit category from parent for nicer grouping
  const [parent] = await db.select({ categoryId: products.categoryId }).from(products).where(eq(products.id, parentProductId)).limit(1);
  const categoryId = parent?.categoryId ?? null;

  const inserted: Array<{ productId: number; asin: string }> = [];
  for (const asin of newAsins) {
    try {
      const [row] = await db.insert(products).values({
        createdByUserId: systemUserId,
        asin,
        url: `https://www.amazon.es/dp/${asin}`,
        categoryId,
        isPublic: false,
      }).returning({ id: products.id });
      // System owns the discovery; this is what protects the variant from being
      // visible in any real user's dashboard while still letting auto-purge run
      // (the purge check excludes system-only follows).
      await db.insert(userProducts).values({ userId: systemUserId, productId: row.id }).onConflictDoNothing();
      inserted.push({ productId: row.id, asin });
      console.log(`[scheduler] variant ingest: + ${asin}`);
    } catch (err) {
      console.error(`[scheduler] variant ingest failed for ${asin}:`, err);
    }
  }
  return inserted;
}

/**
 * Amazon served the page of another ASIN for this product. If that page is the SAME article (titles
 * match), Amazon simply moved it: switch our product to the new ASIN — or, when the new ASIN is already
 * in the catalog, merge followers, alerts and curated lists into it and drop the duplicate. Never hides
 * the product. A different size/colour (titles differ) is NOT followed: returns false and the normal
 * unavailable lifecycle applies. The old ASIN is remembered in asin_redirects.
 */
export async function handleAsinRedirect(productId: number, label: string, newAsinRaw: string, servedName?: string): Promise<boolean> {
  const newAsin = newAsinRaw.toUpperCase();
  if (!ASIN_RE.test(newAsin)) return false;
  const [old] = await db.select({ asin: products.asin, name: products.name }).from(products).where(eq(products.id, productId)).limit(1);
  if (!old || old.asin === newAsin) return false;
  if (!sameArticle(old.name, servedName)) {
    console.log(`[scheduler] ${label} → redirige a ${newAsin} pero el título no coincide ("${(servedName ?? '').slice(0, 50)}"): no se sigue (puede ser otra talla/color)`);
    return false;
  }

  let outcome: 'cambiado' | 'fusionado' = 'cambiado';
  await db.transaction(async (tx) => {
    const target = await tx.execute(sql`
      SELECT id FROM products WHERE asin = ${newAsin} AND id <> ${productId}
      ORDER BY (SELECT COUNT(*) FROM price_history ph WHERE ph.product_id = products.id) DESC LIMIT 1
    `);
    const targetId = (target.rows[0] as any)?.id as number | undefined;
    if (targetId === undefined) {
      // New ASIN not tracked yet: this very product becomes it. Due again at once so the next scrape fills it in.
      await tx.execute(sql`
        UPDATE products SET asin = ${newAsin}, url = ${`https://www.amazon.es/dp/${newAsin}`}, last_error = NULL,
          consecutive_unavailable = 0, unavailable_confirmations = 0, last_checked_at = NULL
        WHERE id = ${productId}
      `);
    } else {
      outcome = 'fusionado';
      // Move everything that belongs to people, then drop the duplicate (the rest cascades).
      await tx.execute(sql`INSERT INTO user_products (user_id, product_id, added_at)
        SELECT user_id, ${targetId}, added_at FROM user_products WHERE product_id = ${productId} ON CONFLICT DO NOTHING`);
      await tx.execute(sql`UPDATE alerts SET product_id = ${targetId} WHERE product_id = ${productId}`);
      await tx.execute(sql`UPDATE alert_events SET product_id = ${targetId} WHERE product_id = ${productId}`);
      await tx.execute(sql`UPDATE recommendation_items SET product_id = ${targetId}
        WHERE product_id = ${productId}
          AND NOT EXISTS (SELECT 1 FROM recommendation_items r2 WHERE r2.product_id = ${targetId} AND r2.list_id = recommendation_items.list_id)`);
      // If someone follows it, the surviving product must be active (it may have been paused by the cleanup).
      await tx.execute(sql`UPDATE products SET is_active = TRUE WHERE id = ${targetId}
        AND (EXISTS (SELECT 1 FROM user_products WHERE product_id = ${targetId}) OR EXISTS (SELECT 1 FROM alerts WHERE product_id = ${targetId}))`);
      await tx.delete(products).where(eq(products.id, productId));
    }
    await tx.execute(sql`INSERT INTO asin_redirects (old_asin, new_asin) VALUES (${old.asin}, ${newAsin})
      ON CONFLICT (old_asin) DO UPDATE SET new_asin = EXCLUDED.new_asin, created_at = NOW()`);
  });
  console.log(`[scheduler] ${label} → ASIN ${old.asin} ahora es ${newAsin} (${outcome}); mismo artículo, no se oculta`);
  return true;
}

/** Who still cares about a product: real (non-system) followers and anyone with an alert. */
async function getProtection(productId: number): Promise<{ asin: string; name: string | null; alertsN: number; realFollowersN: number } | null> {
  const systemUserId = await getSystemUserId();
  const rows = await db.execute(sql`
    SELECT p.asin, p.name,
      (SELECT COUNT(*) FROM alerts WHERE product_id = p.id) AS alerts_n,
      (SELECT COUNT(*) FROM user_products WHERE product_id = p.id
        AND ${systemUserId !== null ? sql`user_id != ${systemUserId}` : sql`TRUE`}) AS real_followers_n
    FROM products p WHERE p.id = ${productId}
  `);
  const r = rows.rows[0] as any;
  if (!r) return null;
  return { asin: String(r.asin), name: r.name ?? null, alertsN: parseInt(r.alerts_n ?? '0', 10), realFollowersN: parseInt(r.real_followers_n ?? '0', 10) };
}

/**
 * Remove a PROTECTED product (it has followers/alerts) once the grace period is over:
 * tell every follower first, then delete it and blacklist the ASIN like an orphan purge.
 */
async function removeProtectedProduct(productId: number, label: string, info: { asin: string; name: string | null }, reason: UnavailableReason, confirmations: number): Promise<void> {
  const reasonText = describeReason(reason);
  const systemUserId = await getSystemUserId();
  const recipients = await db.execute(sql`
    SELECT DISTINCT u.email FROM users u
    WHERE u.email IS NOT NULL
      AND ${systemUserId !== null ? sql`u.id != ${systemUserId}` : sql`TRUE`}
      AND (u.id IN (SELECT user_id FROM user_products WHERE product_id = ${productId})
        OR u.id IN (SELECT user_id FROM alerts WHERE product_id = ${productId}))
  `);
  for (const row of recipients.rows as any[]) {
    try {
      await sendProductRemovedEmail({ to: String(row.email), productName: optionDisplayName(info.name ?? info.asin, await getVariantLabel(productId)), asin: info.asin, reasonText, checks: confirmations });
    } catch (err) {
      console.error(`[scheduler] ${label} → no se pudo avisar de la eliminación:`, err instanceof Error ? err.message : err);
    }
  }
  await db.transaction(async (tx) => {
    await tx.insert(purgedAsins).values({ asin: info.asin, reason: `unavailable x${confirmations}: ${reasonText}`.slice(0, 120) })
      .onConflictDoUpdate({ target: purgedAsins.asin, set: { purgedAt: new Date(), reason: `unavailable x${confirmations}: ${reasonText}`.slice(0, 120) } });
    await tx.delete(products).where(eq(products.id, productId));
  });
  console.log(`[scheduler] ${label} → ELIMINADO tras ${confirmations} comprobaciones (${reasonText}); avisados ${recipients.rows.length} usuario(s)`);
}

/**
 * Auto-purge logic for products stuck unavailable. Caller must have just
 * incremented `consecutive_unavailable`. Returns true if the product was
 * deleted.
 *
 * System-discovered variants (only system follows them, no alerts) get a
 * 1-strike fast purge — they're catalog noise that the parent twister will
 * re-discover whenever Amazon brings them back. Products with real followers
 * or active alerts are never auto-purged: user data is sacred.
 *
 * Purged ASINs are written to `purged_asins` so the variant ingester won't
 * reanimate them on the next parent scrape (would otherwise be an infinite
 * churn loop). Blacklist TTLs at 30 days.
 */
async function maybePurgeOrphan(productId: number, label: string, reason: string): Promise<boolean> {
  const systemUserId = await getSystemUserId();
  const checkRows = await db.execute(sql`
    SELECT
      p.asin,
      (SELECT COUNT(*) FROM alerts WHERE product_id = p.id) AS alerts_n,
      (SELECT COUNT(*) FROM user_products WHERE product_id = p.id
        AND ${systemUserId !== null ? sql`user_id != ${systemUserId}` : sql`TRUE`}) AS real_followers_n
    FROM products p WHERE p.id = ${productId}
  `);
  const r = checkRows.rows[0] as any;
  if (!r) return false;
  const asin    = String(r.asin);
  const alertsN = parseInt(r.alerts_n ?? '0', 10);
  const realN   = parseInt(r.real_followers_n ?? '0', 10);

  // Only orphans (no alerts, no real-user follow) are eligible.
  if (alertsN !== 0 || realN !== 0) return false;

  await db.transaction(async (tx) => {
    await tx.insert(purgedAsins).values({ asin, reason })
      .onConflictDoUpdate({ target: purgedAsins.asin, set: { purgedAt: new Date(), reason } });
    await tx.delete(products).where(eq(products.id, productId));
  });
  console.log(`[scheduler] ${label} → AUTO-PURGE (${reason})`);
  return true;
}

/**
 * Append an anomaly to the review queue. Best-effort — failures are logged
 * but don't block the scrape flow. The queue lets admin recover legit
 * captures the guard misclassified, plus toggle bypass_anomaly_guard for
 * products with naturally wide swings.
 */
async function enqueueAnomaly(input: {
  productId: number;
  type: 'low' | 'high' | 'used' | 'unqualified';
  suspectPrice: number | null;
  medianPrice: number | null;
  message: string;
  snippet?: string;
}): Promise<void> {
  try {
    const [inserted] = await db.insert(scrapeAnomalies).values({
      productId:      input.productId,
      anomalyType:    input.type,
      suspectPrice:   input.suspectPrice != null ? String(input.suspectPrice.toFixed(2)) : null,
      medianPrice:    input.medianPrice  != null ? String(input.medianPrice.toFixed(2))  : null,
      scraperMessage: input.message,
      pageSnippet:    input.snippet ?? null,
      status:         'pending',
    }).returning({ id: scrapeAnomalies.id });

    // Fire the auto-decider. If a deterministic rule matches, the anomaly is
    // resolved immediately and never reaches the human queue. Otherwise it
    // stays pending. Best-effort: a failure here only loses the auto-decision
    // path; the row is still in the queue for manual review.
    try {
      const { decideForAnomalyRow, applyDecision } = await import('./anomaly-auto');
      const decision = await decideForAnomalyRow({
        anomalyId:    inserted.id,
        productId:    input.productId,
        type:         input.type,
        suspectPrice: input.suspectPrice,
        medianPrice:  input.medianPrice,
        message:      input.message,
      });
      if (decision) {
        await applyDecision({
          anomalyId: inserted.id,
          productId: input.productId,
          decision,
          actor:     `auto:${decision.ruleName}`,
        });
      }
    } catch (err) {
      console.error('[scheduler] anomaly auto-decider failed:', err);
    }
  } catch (err) {
    console.error('[scheduler] enqueueAnomaly failed:', err);
  }
}

type ScrapeFn = (url: string, timeoutSeconds: number) => Promise<ScrapeResult>;

async function checkProduct(productId: number, url: string, label: string, timeoutSeconds = 30, scrape: ScrapeFn = scrapeProduct): Promise<void> {
  // Load current state to detect availability transitions and track failures
  const [current] = await db.select({
    isAvailable: products.isAvailable,
    consecutiveFailures: products.consecutiveFailures,
    consecutiveAnomalies: products.consecutiveAnomalies,
    consecutiveUnavailable: products.consecutiveUnavailable,
    bypassAnomalyGuard: products.bypassAnomalyGuard,
  }).from(products).where(eq(products.id, productId)).limit(1);
  const wasUnavailable = current ? !current.isAvailable : false;

  // Stamp the attempt up-front: the scheduler orders by last attempt, so even a
  // product that hangs or errors goes to the back of the queue.
  await db.execute(sql`UPDATE products SET last_checked_at = NOW() WHERE id = ${productId}`).catch(() => {});

  // Fetch all-time stats before this scrape (for sale tier detection)
  const statsResult = await db.execute(sql`
    SELECT
      MAX(price)::float                                      AS all_time_max,
      COUNT(*)::int                                          AS scrape_count,
      EXTRACT(DAY FROM (NOW() - MIN(scraped_at)))::int       AS days_span
    FROM price_history
    WHERE product_id = ${productId}
  `);
  const statsRow    = statsResult.rows[0] as any;
  const allTimeMax  = (statsRow?.all_time_max  ?? null)  as number | null;
  const scrapeCount = (statsRow?.scrape_count  ?? 0)     as number;
  const daysSpan    = (statsRow?.days_span     ?? 0)     as number;

  try {
    console.log(`[scheduler] Scraping: ${label}`);
    const result = await scrape(url, timeoutSeconds);

    // ── Anomaly guard (symmetric: rejects extreme highs and extreme lows) ────
    // Margins widened 2026-05-22 (was 0.4 / 2.5 → 0.25 / 3.5). The system
    // had grown enough confidence in the stock + buybox detection that
    // borderline cases (-50%/-60% flash deals, +100% genuine reprices)
    // were producing too many false-positive anomalies for admin review.
    // Only catch true outliers now:
    //   LOW  (price < median × 0.25): -75 % move → near-certainly an
    //        accessory / "Nuevo y de segunda mano" selector slip.
    //   HIGH (price > median × 3.5): +250 % move → third-party seller
    //        camping the buybox at inflated price (caso B01N7RLGIJ Mario
    //        Kart 285/335 €).
    // Bypass for legit movements: was_price corroborates a real flash deal (RRP ≥
    // 4× price) or a pre-existing high range (max ≥ 0.8 × new price). Auto-accept
    // after 3 consecutive anomalies so a genuine price shift can recover.
    const recentRows = await db.execute(sql`
      SELECT price::float AS p FROM price_history
      WHERE product_id = ${productId}
      ORDER BY scraped_at DESC LIMIT 5
    `);
    const recent = (recentRows.rows as any[]).map(r => r.p as number);
    const anomalyCount = current?.consecutiveAnomalies ?? 0;
    const bypassed = current?.bypassAnomalyGuard ?? false;
    if (recent.length >= 3 && anomalyCount < 3 && !bypassed) {
      const sorted = recent.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      const lowSuspect  = result.price < median * 0.25 && !(result.wasPrice != null && result.wasPrice >= result.price * 4);
      const highSuspect = result.price > median * 3.5  && (allTimeMax === null || result.price > allTimeMax * 1.5);
      if (lowSuspect || highSuspect) {
        const newCount = anomalyCount + 1;
        const dir = lowSuspect ? '<<' : '>>';
        const cause = lowSuspect ? 'probable accesorio o "Nuevo y de segunda mano"' : 'probable tercero/importación con precio inflado';
        const msg = `Precio anómalo descartado (${newCount}/3): ${result.price.toFixed(2)} € ${dir} mediana ${median.toFixed(2)} € — ${cause}`;
        console.warn(`[scheduler] ${label} → ANOMALÍA (${newCount}/3): ${result.price.toFixed(2)} € ${dir} mediana ${median.toFixed(2)} € — descartado`);
        await db.update(products).set({
          consecutiveAnomalies: newCount,
          lastError: msg,
        }).where(eq(products.id, productId));
        await enqueueAnomaly({
          productId,
          type: lowSuspect ? 'low' : 'high',
          suspectPrice: result.price,
          medianPrice: median,
          message: msg,
        });
        return;
      }
    }

    lastOkAt = Date.now();
    const saleInfo = await persistScrapeResult(productId, result, { allTimeMax, scrapeCount, daysSpan, label });

    // Product just came back in stock — notify owner
    if (wasUnavailable) {
      console.log(`[scheduler] ${label} → back in stock, sending notification`);
      await notifyBackInStock(productId, result.price, result.currency, result.name, result.imageUrl, url);
    }

    await processAlerts(productId, result.price, result.currency, label, result.imageUrl, url);
  } catch (err) {
    if (err instanceof ProductUnavailableError) {
      lastOkAt = Date.now(); // Amazon answered definitively
      // Amazon moved the ARTICLE to another ASIN: follow it instead of hiding the product.
      if (err.reason === 'redirect' && err.newAsin && await handleAsinRedirect(productId, label, err.newAsin, err.productName)) return;
      // 'unqualified' is the transient kind: Amazon sometimes returns a product
      // page with no qualified buybox for a few minutes then recovers. Mark
      // unavailable only after 3 consecutive strikes so a single glitch doesn't
      // bench a product visible to users. Other reasons (used, 404, "no
      // disponible" page, non-physical Amazon surfaces) are explicit and
      // definitive — mark immediately as before.
      const prevCu = current?.consecutiveUnavailable ?? 0;
      const newCu = prevCu + 1;
      const transient = err.reason === 'unqualified';
      const markUnavailable = !transient || newCu >= 3;
      console.log(`[scheduler] ${label} → No disponible${err.reason ? ` (${err.reason})` : ''}${transient && !markUnavailable ? ` [transient ${newCu}/3, keeping available]` : ''}`);

      let confirmations = 0;
      if (markUnavailable) {
        // Persist any partial metadata captured before the throw (typically
        // the product title from Promise 1 of the scrape). Without this,
        // products that fail before persistScrapeResult never have a name
        // for the admin UI and look like permanently-stuck rows.
        const fillName = err.productName && err.productName.trim().length > 0
          ? sql`, name = COALESCE(name, ${err.productName})`
          : sql``;
        const upd = await db.execute(sql`
          UPDATE products SET
            is_available = FALSE,
            last_error   = ${err.message},
            is_on_sale   = FALSE,
            sale_tier    = NULL,
            deal_score   = NULL,
            consecutive_unavailable = ${newCu},
            unavailable_confirmations = unavailable_confirmations + 1,
            is_public    = CASE WHEN feature_lock = 'auto' THEN FALSE ELSE is_public END,
            featured_at  = CASE WHEN feature_lock = 'auto' THEN NULL  ELSE featured_at END
            ${fillName}
          WHERE id = ${productId}
          RETURNING unavailable_confirmations AS confirmations
        `);
        confirmations = Number((upd.rows[0] as any)?.confirmations ?? 1);
      } else {
        const fillName = err.productName && err.productName.trim().length > 0
          ? sql`, name = COALESCE(name, ${err.productName})`
          : sql``;
        await db.execute(sql`
          UPDATE products SET
            last_error = ${`Buybox no cualificado (${newCu}/3) — esperando confirmación`},
            consecutive_unavailable = ${newCu}
            ${fillName}
          WHERE id = ${productId}
        `);
      }
      // Reset stock alerts (only relevant once we actually mark unavailable)
      if (markUnavailable) {
        await db.update(alerts).set({ notifiedAt: null })
          .where(and(eq(alerts.productId, productId), eq(alerts.alertType, 'stock')));
      }
      // Queue for admin review when the unavailability has a structured reason
      // (used buybox, unqualified buybox). Admin can confirm or recover the
      // capture if our detection misclassified. Skipped for transient strikes
      // 1 and 2 since most resolve on the next scrape and would just spam
      // the queue.
      if ((err.reason === 'used' || err.reason === 'unqualified') && markUnavailable) {
        await enqueueAnomaly({
          productId,
          type: err.reason,
          suspectPrice: null,
          medianPrice: null,
          message: err.message,
          snippet: err.snippet,
        });
      }
      // Orphan-variant purge only after we've confirmed unavailability —
      // transient strikes shouldn't yank the product.
      if (markUnavailable) {
        const prot = await getProtection(productId);
        if (prot) {
          const isProtected = prot.alertsN > 0 || prot.realFollowersN > 0;
          const action = decideAfterConfirmedUnavailable({
            reason: err.reason, confirmations, isProtected,
            settings: {
              extraChecks:       Math.max(0, Math.min(10, Number(await getSetting('unavailable_extra_checks', DEFAULT_LIFECYCLE.extraChecks)))),
              goneConfirmations: Math.max(1, Math.min(10, Number(await getSetting('gone_confirmations',      DEFAULT_LIFECYCLE.goneConfirmations)))),
            },
          });
          if (action === 'delete') {
            if (isProtected) await removeProtectedProduct(productId, label, { asin: prot.asin, name: prot.name }, err.reason, confirmations);
            else await maybePurgeOrphan(productId, label, `unavailable: ${describeReason(err.reason)}`.slice(0, 120));
          } else {
            console.log(`[scheduler] ${label} → no disponible (${confirmations}ª comprobación); se vuelve a mirar tras la pausa`);
          }
        }
      }
    } else if (err instanceof ExecutorUnavailableError) {
      // The remote scraper machine failed, not the product: leave the product untouched.
      throw err;
    } else if (err instanceof WrongLocationError) {
      // Page rendered for another country: its prices/stock say nothing about the
      // product. Don't penalise it; the worker handles the streak.
      console.log(`[scheduler] ${label} → ubicación incorrecta: ${err.message}`);
      throw err;
    } else if (err instanceof CaptchaDetectedError) {
      // Pausa global por bloqueo Amazon — no penalizar el producto; the worker pauses and resumes
      console.log(`[scheduler] ${label} → ${err.message}`);
      throw err;
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Failed for ${label}: ${msg}`);
      const newFailCount = (current?.consecutiveFailures ?? 0) + 1;
      const isFailed = newFailCount >= 3;
      if (isFailed) console.log(`[scheduler] ${label} → marked as failed after ${newFailCount} consecutive errors`);
      await db.update(products).set({ lastError: msg, consecutiveFailures: newFailCount, isFailed, totalFailures: sql`total_failures + 1` }).where(eq(products.id, productId));
      // Orphan variants whose generic scrape errors hit 3-strike `is_failed`
      // get the same fast purge — nothing useful in keeping them.
      if (isFailed) {
        await maybePurgeOrphan(productId, label, `orphan variant 3x scrape errors (${msg.slice(0, 60)})`);
      }
    }
  }
}

async function notifyBackInStock(
  productId: number,
  currentPrice: number,
  currency: string,
  baseProductName: string,
  imageUrl: string | null | undefined,
  productUrl: string,
): Promise<void> {
  const productAffilUrl = affiliateUrl(productUrl);
  const productName = optionDisplayName(baseProductName, await getVariantLabel(productId));

  // Only notify users who have explicitly opted in via a `stock` alert.
  // The legacy "products.userId == owner gets notified by default" block
  // was removed because it spammed the system user (mail to
  // system@ojoalprecio.local + Telegram to the public channel as fallback)
  // whenever a variant came back into stock. Followers who want stock
  // notifications must add a stock-type alert explicitly.
  const stockAlerts = await db.select().from(alerts).where(
    and(
      eq(alerts.productId, productId),
      eq(alerts.alertType, 'stock'),
      eq(alerts.isActive, true),
      isNull(alerts.notifiedAt),
    ),
  );

  for (const alert of stockAlerts) {
    try {
      const channel = alert.notificationChannel ?? 'email';
      if (channel === 'email' || channel === 'both') {
        await sendBackInStockAlert({ to: alert.notificationEmail, productName, productUrl: productAffilUrl, currentPrice, imageUrl, currency });
      }
      // Telegram: only if the alert specifies a personal chat_id. Never fall
      // back to the public channel — that would broadcast a personal stock
      // notification to every subscriber.
      if ((channel === 'telegram' || channel === 'both') && alert.telegramChatId) {
        await sendTelegramBackInStock({ chatId: alert.telegramChatId, productName, productUrl: productAffilUrl, currentPrice, currency });
      }
      await db.update(alerts).set({ notifiedAt: new Date() }).where(eq(alerts.id, alert.id));
    } catch (err) {
      console.error(`[scheduler] Stock alert ${alert.id} failed:`, err);
    }
  }
}

async function getVariantLabel(productId: number): Promise<string | null> {
  const r = await db.execute(sql`SELECT variant_label FROM products WHERE id = ${productId}`);
  return ((r.rows[0] as { variant_label?: string | null } | undefined)?.variant_label) ?? null;
}

async function processAlerts(
  productId: number,
  currentPrice: number,
  currency: string,
  baseProductName: string,
  imageUrl: string | null | undefined,
  productUrl: string,
): Promise<void> {
  const productAffilUrl = affiliateUrl(productUrl);
  // Each size/colour is its own product: name the option in the alert so two sizes are not mixed up.
  const productName = optionDisplayName(baseProductName, await getVariantLabel(productId));

  // Load all active alerts for this product
  const activeAlerts = await db
    .select()
    .from(alerts)
    .where(and(eq(alerts.productId, productId), eq(alerts.isActive, true)));

  // All-time low for alltime_low alert type
  const [lowestRow] = await db
    .select({ val: min(priceHistory.price) })
    .from(priceHistory)
    .where(eq(priceHistory.productId, productId));
  const alltimeLow = lowestRow?.val ? parseFloat(String(lowestRow.val)) : null;

  // Previous price (second most recent record) for drop display in email
  const prevPriceResult = await db.execute(sql`
    SELECT price FROM price_history WHERE product_id = ${productId} ORDER BY scraped_at DESC LIMIT 1 OFFSET 1
  `);
  const previousPrice = prevPriceResult.rows[0] ? parseFloat(String((prevPriceResult.rows[0] as any).price)) : null;

  for (const alert of activeAlerts) {
    const type = alert.alertType ?? 'price';

    // Determine if this alert should fire
    let shouldFire = false;
    let thresholdLabel = '';

    if (type === 'price') {
      const threshold = parseFloat(String(alert.thresholdPrice ?? 0));
      shouldFire = !!alert.thresholdPrice && currentPrice <= threshold;
      thresholdLabel = `${threshold.toFixed(2)} €`;
      // Auto-reactivate: if price went back above threshold after notifying, reset
      if (alert.notifiedAt && currentPrice > threshold + 0.01) {
        await db.update(alerts).set({ notifiedAt: null }).where(eq(alerts.id, alert.id));
      }
    } else if (type === 'percent') {
      const ref = parseFloat(String(alert.referencePrice ?? 0));
      const drop = parseFloat(String(alert.percentageDrop ?? 0));
      // No referencePrice yet (immediate scrape failed when product was added) — initialize now, fire next cycle
      if (ref === 0) {
        await db.update(alerts).set({ referencePrice: String(currentPrice.toFixed(2)) }).where(eq(alerts.id, alert.id));
        continue;
      }
      const targetPrice = ref * (1 - drop / 100);
      shouldFire = drop > 0 && currentPrice <= targetPrice;
      thresholdLabel = `−${drop.toFixed(0)}% desde ${ref.toFixed(2)} €`;
      if (alert.notifiedAt && currentPrice > targetPrice + 0.01) {
        await db.update(alerts).set({ notifiedAt: null }).where(eq(alerts.id, alert.id));
      }
    } else if (type === 'alltime_low') {
      // Fires whenever a new all-time low is set (we compare with pre-insert min)
      // Here: alltimeLow already includes the current price (just inserted). Fire if current = alltimeLow
      shouldFire = alltimeLow !== null && currentPrice <= alltimeLow + 0.01;
      thresholdLabel = 'nuevo mínimo histórico';
      // Always allow re-firing for alltime_low (reset after each cycle)
      if (alert.notifiedAt) {
        await db.update(alerts).set({ notifiedAt: null }).where(eq(alerts.id, alert.id));
        continue; // will fire next cycle if still at low
      }
    }

    if (!shouldFire || alert.notifiedAt) continue;

    try {
      const channel = alert.notificationChannel ?? 'email';

      if (channel === 'email' || channel === 'both') {
        await sendPriceAlert({
          to: alert.notificationEmail,
          productName,
          productUrl: productAffilUrl,
          productId,
          currentPrice,
          previousPrice,
          thresholdPrice: parseFloat(String(alert.thresholdPrice ?? currentPrice)),
          imageUrl,
          currency,
        });
      }

      // Telegram: only with a personal chat_id on the alert. No public-channel
      // fallback — a price alert is per-user and must not be broadcast.
      if ((channel === 'telegram' || channel === 'both') && alert.telegramChatId) {
        await sendTelegramAlert({
          chatId: alert.telegramChatId,
          productName,
          productUrl: productAffilUrl,
          currentPrice,
          thresholdLabel,
          currency,
        });
      }

      await db.update(alerts).set({ notifiedAt: new Date() }).where(eq(alerts.id, alert.id));
      await db.insert(alertEvents).values({
        alertId: alert.id,
        productId,
        userId: alert.userId,
        alertType: type,
        priceAtTime: String(currentPrice),
        thresholdLabel,
      });
    } catch (err) {
      console.error(`[scheduler] Failed to send alert ${alert.id}:`, err);
    }
  }
}

export function triggerScrape(): boolean {
  if (isRunning) return false;
  checkAllProducts().catch(err => console.error('[scheduler] Manual trigger error:', err));
  return true;
}

/**
 * Hourly housekeeping. Three light maintenance tasks bundled so they share a
 * single cron slot — runs at :15 every hour, deliberately offset from the
 * main scrape cycle (:00) and the category-import (:10).
 *
 * 1. Featured cap — demote auto-featured products that fell out of the
 *    top-N by deal_score. Used to run after every successful scrape, which
 *    invoked a window function across the whole catalog hundreds of times
 *    per cycle; once an hour is plenty.
 * 2. Anomaly queue TTL — pending anomalies older than 60 days get deleted.
 *    Reviewed (approved/denied) ones are already pruned at 30 days in the
 *    /admin/anomalies route (lazy on each list load).
 * 3. Purged-ASIN blacklist TTL — entries older than 30 days are removed.
 *    The ingest filter already ignores them past 30 days; this just keeps
 *    the table size in check.
 */
async function runHourlyMaintenance(): Promise<void> {
  await pruneExecutorMetrics().catch(err => console.error('[maintenance] executor_metrics prune failed:', err instanceof Error ? err.message : err));
  // 1. Featured cap with freshness rotation. Composite score subtracts a
  // 1.5-point penalty per day the product has been featured, so deals that
  // have been on the panel for a while drop in ranking and let fresher
  // discoveries take their place. A fresh product (featured_at NULL) starts
  // with no penalty so it competes on raw deal_score.
  //
  // We also need to RE-PROMOTE qualifying auto products that the cap demoted
  // previously but are now back in the top N (e.g. a stale product has
  // accumulated enough penalty to fall behind a previously demoted one).
  try {
    const capRaw = await getSetting('featured_max_count', 100);
    const cap    = Math.max(1, Math.min(500, Number(capRaw)));
    const result = await db.execute(sql`
      WITH eligible AS (
        SELECT id, is_public,
          deal_score::float
            - GREATEST(0, EXTRACT(EPOCH FROM (NOW() - COALESCE(featured_at, NOW()))) / 86400.0) * 1.5
            AS composite_score
        FROM products
        WHERE is_active = TRUE AND feature_lock = 'auto' AND is_on_sale = TRUE AND is_available = TRUE
      ),
      ranked AS (
        SELECT id, is_public, ROW_NUMBER() OVER (ORDER BY composite_score DESC NULLS LAST) AS rnk
        FROM eligible
      )
      UPDATE products SET
        is_public   = (r.rnk <= ${cap}),
        featured_at = CASE
          WHEN r.rnk <= ${cap} AND products.featured_at IS NULL THEN NOW()
          WHEN r.rnk  > ${cap}                                  THEN NULL
          ELSE products.featured_at
        END
      FROM ranked r
      WHERE products.id = r.id
        AND ( (r.rnk <= ${cap}) != products.is_public )
      RETURNING products.id, products.is_public
    `);
    const promoted = result.rows.filter((r: any) => r.is_public).length;
    const demoted  = result.rows.filter((r: any) => !r.is_public).length;
    if (promoted + demoted > 0) {
      console.log(`[maintenance] rotation: +${promoted} promoted, -${demoted} demoted (cap=${cap})`);
    }
  } catch (err) { console.error('[maintenance] featured cap failed:', err); }

  // 2a. Auto-approve unqualified anomalies whose product self-recovered.
  // 'unqualified' captures a transient Amazon glitch (no qualified buybox at
  // that exact moment). If a later successful scrape brought the product
  // back to is_available = TRUE, the anomaly is moot — close it without
  // bothering admin.
  try {
    const recovered = await db.execute(sql`
      UPDATE scrape_anomalies SET
        status = 'approved',
        reviewed_at = NOW(),
        scraper_message = COALESCE(scraper_message, '') || ' [auto-recovered: product re-available]'
      WHERE status = 'pending' AND anomaly_type = 'unqualified'
        AND product_id IN (SELECT id FROM products WHERE is_available = TRUE)
      RETURNING id
    `);
    if (recovered.rows.length > 0) {
      console.log(`[maintenance] anomalies: auto-recovered ${recovered.rows.length} unqualified (product now available)`);
    }
  } catch (err) { console.error('[maintenance] anomaly auto-recovery failed:', err); }

  // 2b. Anomaly queue TTL — 60d for pending
  try {
    const dropped = await db.execute(sql`
      DELETE FROM scrape_anomalies
      WHERE status = 'pending' AND detected_at < NOW() - INTERVAL '60 days'
      RETURNING id
    `);
    if (dropped.rows.length > 0) {
      console.log(`[maintenance] anomalies: dropped ${dropped.rows.length} stale pending`);
    }
  } catch (err) { console.error('[maintenance] anomaly TTL failed:', err); }

  // 3. Purged-ASIN blacklist TTL — 30d
  try {
    const dropped = await db.execute(sql`
      DELETE FROM purged_asins WHERE purged_at < NOW() - INTERVAL '30 days' RETURNING asin
    `);
    if (dropped.rows.length > 0) {
      console.log(`[maintenance] blacklist: pruned ${dropped.rows.length} entries`);
    }
  } catch (err) { console.error('[maintenance] blacklist TTL failed:', err); }
}

export function startScheduler(): void {
  console.log(`[scheduler] Starting with schedule: "${CHECK_INTERVAL}"`);
  checkAllProducts();
  cron.schedule(CHECK_INTERVAL, () => { checkAllProducts(); });

  startExecutorMonitor();
  startFirstScrapeLoop();
  // Build the variant groups of what is already in the catalog (idempotent, runs once per start).
  setTimeout(() => { backfillProductGroups().catch(err => console.error('[groups] backfill failed:', err)); }, 45_000).unref();

  // Watchdog: abandon a wedged cycle, restart Chromium, email the admin.
  cron.schedule('*/5 * * * *', () => {
    runScraperWatchdog().catch(err => console.error('[watchdog] failed:', err));
  });
  console.log('[watchdog] Vigilante del scraper activo cada 5 min (ciclo colgado → reinicio + email).');

  // Hourly housekeeping at :15 — between the main scrape (:00) and the
  // category-import (:10).
  cron.schedule('15 * * * *', () => {
    runHourlyMaintenance().catch(err => console.error('[maintenance] failed:', err));
  });
  console.log('[maintenance] Housekeeping scheduled at :15 each hour (featured cap, anomaly TTL, blacklist TTL).');

  // Auto-cleanup at :20 — fires after maintenance so we operate on the most
  // recent metadata. Reads its own feature flag from app_settings; a no-op
  // when disabled. See src/scheduler/auto-cleanup.ts for the eligibility rule.
  const { runAutoCleanupTick } = require('./auto-cleanup');
  cron.schedule('20 * * * *', () => {
    runAutoCleanupTick().catch((err: Error) => console.error('[auto-cleanup] failed:', err.message));
  });
  console.log('[auto-cleanup] Scheduled at :20 each hour (gated by auto_cleanup_enabled app setting).');

  // Anomaly auto-decider calibration — once a day at 04:30 UTC. Computes per-
  // rule revert rate over the last 7 days and warns to console when any rule
  // crosses the threshold. Read-only: no state changes, just signal. The
  // banner on /admin/anomalies surfaces the same info aggregated.
  const { runAnomalyCalibrationTick } = require('./anomaly-auto');
  cron.schedule('30 4 * * *', () => {
    runAnomalyCalibrationTick().catch((err: Error) => console.error('[anomaly-calibration] failed:', err.message));
  });
  console.log('[anomaly-calibration] Scheduled daily at 04:30 UTC.');

  const { startCategoryImportScheduler } = require('./category-import');
  startCategoryImportScheduler();
}

export { checkProduct };

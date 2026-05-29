import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { scrapeAnomalies, priceHistory, products, anomalyDecisionLog, ruleTuningLog } from '../db/schema';
import { getSetting, setSetting } from '../db/settings';

/**
 * Auto-decider for scrape anomalies. Called by enqueueAnomaly() after a
 * pending row lands so we can immediately apply a routine action and keep
 * /admin/anomalies free of cases the admin would just rubber-stamp.
 *
 * Rules are deterministic and run in priority order. Each carries a name
 * (logged to anomaly_decision_log) and confidence — 1.00 for now since
 * nothing here is probabilistic. Calibration cron (V1) will surface rules
 * that get reverted often.
 *
 * Add new rules at the bottom of `RULES`, return null for "no match",
 * tests live in anomaly-auto.test.ts.
 */

export type AnomalyType = 'low' | 'high' | 'used' | 'unqualified';

export interface AnomalyContext {
  anomalyId:        number;
  productId:        number;
  type:             AnomalyType;
  suspectPrice:     number | null;
  medianPrice:      number | null;
  message:          string;
  bypassFlag:       boolean;          // products.bypass_anomaly_guard
  approvedSame:     number;           // count for this product + same type
  deniedSame:       number;
  reviewedSame:     number;           // approved + denied for this (product, type)
  knownBad:         KnownBadCounts;   // cross-product counts for this message prefix
  streakThreshold:  number;           // runtime, from app_settings
  knownBadThreshold: number;          // runtime, from app_settings
}

export interface AutoDecision {
  ruleName:    string;
  confidence:  number;              // 0–1
  newStatus:   'approved' | 'denied';
  applyAction: 'approve_with_price' | 'approve_noop' | 'deny' | 'mark_unavailable';
}

type Rule = (ctx: AnomalyContext) => AutoDecision | null;

/** Default minimum samples before streak rules fire — protects new/rare
 *  products. Overridable at runtime via the `anomaly_streak_threshold`
 *  app_setting; the calibration cron tweaks that setting from this default
 *  once auto-tune kicks in. */
const DEFAULT_STREAK_THRESHOLD = 3;
const STREAK_THRESHOLD_FLOOR   = 2;
const STREAK_THRESHOLD_CEILING = 10;

/** Default minimum cross-product denials before the known_bad_message rule
 *  fires. Same runtime / auto-tune story as the streak threshold. */
const DEFAULT_KNOWN_BAD_THRESHOLD = 5;
const KNOWN_BAD_THRESHOLD_FLOOR   = 2;
const KNOWN_BAD_THRESHOLD_CEILING = 20;

/** How many leading characters of scraper_message form the "pattern key" the
 *  known_bad_message rule matches against. Long enough to be specific, short
 *  enough to ignore trailing per-product variation (URL, asin, dynamic price). */
const KNOWN_BAD_PREFIX_LEN = 80;

export interface KnownBadCounts { deniedSamePattern: number; approvedSamePattern: number }

/** Read the runtime thresholds from app_settings, clamping to the safe
 *  bounds. Falls back to the default constant if the setting is missing,
 *  out of range, or non-numeric. Pure read; never writes. */
async function loadThresholds(): Promise<{ streak: number; knownBad: number }> {
  const rawStreak = Number(await getSetting('anomaly_streak_threshold', DEFAULT_STREAK_THRESHOLD));
  const rawKb     = Number(await getSetting('anomaly_known_bad_threshold', DEFAULT_KNOWN_BAD_THRESHOLD));
  const streak = Number.isFinite(rawStreak)
    ? Math.max(STREAK_THRESHOLD_FLOOR, Math.min(STREAK_THRESHOLD_CEILING, Math.round(rawStreak)))
    : DEFAULT_STREAK_THRESHOLD;
  const knownBad = Number.isFinite(rawKb)
    ? Math.max(KNOWN_BAD_THRESHOLD_FLOOR, Math.min(KNOWN_BAD_THRESHOLD_CEILING, Math.round(rawKb)))
    : DEFAULT_KNOWN_BAD_THRESHOLD;
  return { streak, knownBad };
}

const RULES: Rule[] = [
  // 1. Product was previously flagged "always accept" by an admin via the
  //    bypass-product action. Existing scheduler code already auto-approves
  //    based on this flag; we still log it here so the audit trail is complete.
  function bypassFlag(ctx) {
    if (!ctx.bypassFlag) return null;
    if (ctx.type === 'used' || ctx.type === 'unqualified') {
      return { ruleName: 'bypass_flag', confidence: 1.00, newStatus: 'approved', applyAction: 'approve_noop' };
    }
    return { ruleName: 'bypass_flag', confidence: 1.00, newStatus: 'approved', applyAction: 'approve_with_price' };
  },

  // 2. Approved streak: ≥N admins-said-yes for (product, type) with 0 denials
  //    → the same shape of anomaly keeps showing up legitimately (product has
  //    naturally wide swings, e.g. flash sales). Apply the suspect price.
  function approvedStreak(ctx) {
    if (ctx.approvedSame < ctx.streakThreshold || ctx.deniedSame > 0) return null;
    if (ctx.type === 'used' || ctx.type === 'unqualified') {
      return { ruleName: 'approved_streak', confidence: 1.00, newStatus: 'approved', applyAction: 'mark_unavailable' };
    }
    return { ruleName: 'approved_streak', confidence: 1.00, newStatus: 'approved', applyAction: 'approve_with_price' };
  },

  // 3. Denied streak: ≥N rejections for (product, type) with 0 approvals
  //    → this product keeps producing the same kind of garbage. Auto-deny.
  function deniedStreak(ctx) {
    if (ctx.deniedSame < ctx.streakThreshold || ctx.approvedSame > 0) return null;
    return { ruleName: 'denied_streak', confidence: 1.00, newStatus: 'denied', applyAction: 'deny' };
  },

  // 4. Known bad message: the same scraper_message prefix has been denied
  //    ≥N times CROSS-PRODUCT with zero approvals — a clear "bad" pattern
  //    (e.g. "Bloqueo Amazon (título: '500 - Se ha producido un error'…")
  //    that the operator has explicitly rejected before. Auto-deny.
  function knownBadMessage(ctx) {
    if (ctx.knownBad.deniedSamePattern < ctx.knownBadThreshold) return null;
    if (ctx.knownBad.approvedSamePattern > 0) return null;
    return { ruleName: 'known_bad_message', confidence: 1.00, newStatus: 'denied', applyAction: 'deny' };
  },
];

/** Run all rules in order and return the first match. */
export function decideAnomaly(ctx: AnomalyContext): AutoDecision | null {
  for (const rule of RULES) {
    const d = rule(ctx);
    if (d) return d;
  }
  return null;
}

/**
 * Gather counts + flags from DB to build the context, then decide.
 * Returns null when no rule applies (anomaly stays `pending` for human review).
 */
export async function decideForAnomalyRow(input: {
  anomalyId: number;
  productId: number;
  type: AnomalyType;
  suspectPrice: number | null;
  medianPrice: number | null;
  message: string;
}): Promise<AutoDecision | null> {
  const rows = await db.execute(sql`
    SELECT
      p.bypass_anomaly_guard AS "bypassFlag",
      COUNT(*) FILTER (WHERE a.status = 'approved')  AS approved_same,
      COUNT(*) FILTER (WHERE a.status = 'denied')    AS denied_same
    FROM products p
    LEFT JOIN scrape_anomalies a
      ON a.product_id = p.id AND a.anomaly_type = ${input.type} AND a.id <> ${input.anomalyId}
    WHERE p.id = ${input.productId}
    GROUP BY p.id, p.bypass_anomaly_guard
  `);
  const r = rows.rows[0] as { bypassFlag: boolean; approved_same: string | number; denied_same: string | number } | undefined;
  if (!r) return null;
  const approvedSame = Number(r.approved_same) || 0;
  const deniedSame   = Number(r.denied_same)   || 0;

  // Cross-product message-pattern lookup. The pattern key is the LEFT
  // KNOWN_BAD_PREFIX_LEN chars of scraper_message — long enough to be
  // specific, short enough to ignore trailing per-product variation. We
  // skip the query entirely for short / null messages since they can't
  // meaningfully match anything.
  const pattern = (input.message ?? '').slice(0, KNOWN_BAD_PREFIX_LEN);
  let deniedSamePattern = 0;
  let approvedSamePattern = 0;
  if (pattern.length >= 20) {
    const patternRows = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'denied')   AS denied_pat,
        COUNT(*) FILTER (WHERE status = 'approved') AS approved_pat
      FROM scrape_anomalies
      WHERE LEFT(scraper_message, ${KNOWN_BAD_PREFIX_LEN}) = ${pattern}
        AND id <> ${input.anomalyId}
    `);
    const pr = patternRows.rows[0] as { denied_pat: string | number; approved_pat: string | number } | undefined;
    deniedSamePattern   = Number(pr?.denied_pat   ?? 0);
    approvedSamePattern = Number(pr?.approved_pat ?? 0);
  }

  const thresholds = await loadThresholds();
  return decideAnomaly({
    anomalyId:        input.anomalyId,
    productId:        input.productId,
    type:             input.type,
    suspectPrice:     input.suspectPrice,
    medianPrice:      input.medianPrice,
    message:          input.message,
    bypassFlag:       !!r.bypassFlag,
    approvedSame,
    deniedSame,
    reviewedSame:     approvedSame + deniedSame,
    knownBad:         { deniedSamePattern, approvedSamePattern },
    streakThreshold:  thresholds.streak,
    knownBadThreshold: thresholds.knownBad,
  });
}

/**
 * Daily calibration tick. Two modes, gated by the
 * `anomaly_auto_tune_starts_at` app_setting:
 *
 *   • Before that date (or if the setting is empty): WARN ONLY — log per-rule
 *     revert rates and flag any rule above CALIBRATION_RAISE_PCT.
 *   • On or after that date: AUTO-TUNE — apply +1 / -1 adjustments to the
 *     runtime thresholds, persist them to app_settings, and audit every
 *     change in rule_tuning_log.
 *
 * The streak group bundles approved_streak + denied_streak under a single
 * `anomaly_streak_threshold` setting; known_bad_message gets its own.
 *
 * Aggregation window is 7 days. We require at least RAISE_MIN_SAMPLES /
 * LOWER_MIN_SAMPLES firings before doing anything so a few unlucky reverts
 * can't flap the threshold up and down.
 */
const CALIBRATION_RAISE_PCT  = 25;
const CALIBRATION_LOWER_PCT  =  5;
const CALIBRATION_RAISE_MIN  = 10;
const CALIBRATION_LOWER_MIN  = 20;

export async function runAnomalyCalibrationTick(): Promise<{
  ruleName: string; applied: number; reverted: number; revertPct: number; warn: boolean
}[]> {
  // Pull both the per-rule rollup and the auto-tune start date in parallel.
  const [rowsRes, startsAtRaw] = await Promise.all([
    db.execute(sql`
      SELECT
        rule_name AS "ruleName",
        COUNT(*)::int                                          AS applied,
        COUNT(*) FILTER (WHERE reverted_at IS NOT NULL)::int   AS reverted
      FROM anomaly_decision_log
      WHERE actor LIKE 'auto:%'
        AND decided_at > NOW() - INTERVAL '7 days'
      GROUP BY rule_name
      ORDER BY applied DESC
    `),
    getSetting('anomaly_auto_tune_starts_at', ''),
  ]);

  const rows = rowsRes.rows as Array<{ ruleName: string; applied: number; reverted: number }>;
  const startsAt = String(startsAtRaw ?? '').trim();
  const autoTuneActive = startsAt.length > 0 && startsAt <= new Date().toISOString().slice(0, 10);

  // Always emit per-rule visibility.
  const out: { ruleName: string; applied: number; reverted: number; revertPct: number; warn: boolean }[] = [];
  for (const r of rows) {
    const revertPct = r.applied > 0 ? Math.round((r.reverted / r.applied) * 100) : 0;
    const warn = r.applied >= CALIBRATION_RAISE_MIN && revertPct > CALIBRATION_RAISE_PCT;
    out.push({ ruleName: r.ruleName, applied: r.applied, reverted: r.reverted, revertPct, warn });
    if (warn) {
      console.warn(`[anomaly-calibration] Rule '${r.ruleName}' revert rate ${revertPct}% over ${r.applied} firings in 7d.`);
    } else if (r.applied > 0) {
      console.log(`[anomaly-calibration] Rule '${r.ruleName}': ${r.applied} fired, ${r.reverted} reverted (${revertPct}%)`);
    }
  }

  if (!autoTuneActive) {
    if (startsAt) console.log(`[anomaly-calibration] Auto-tune scheduled to start ${startsAt} — warn-only mode today.`);
    else          console.log(`[anomaly-calibration] Auto-tune disabled (anomaly_auto_tune_starts_at empty).`);
    return out;
  }

  // Aggregate the rules that share a tunable knob.
  const byGroup = new Map<'streak' | 'known_bad', { fired: number; reverted: number }>([
    ['streak',    { fired: 0, reverted: 0 }],
    ['known_bad', { fired: 0, reverted: 0 }],
  ]);
  for (const r of rows) {
    if (r.ruleName === 'approved_streak' || r.ruleName === 'denied_streak') {
      const g = byGroup.get('streak')!;
      g.fired += r.applied; g.reverted += r.reverted;
    } else if (r.ruleName === 'known_bad_message') {
      const g = byGroup.get('known_bad')!;
      g.fired += r.applied; g.reverted += r.reverted;
    }
  }

  const current = await loadThresholds();
  await maybeAdjust({
    group:  'streak',
    setting: 'anomaly_streak_threshold',
    current: current.streak,
    floor:   STREAK_THRESHOLD_FLOOR,
    ceiling: STREAK_THRESHOLD_CEILING,
    stats:   byGroup.get('streak')!,
  });
  await maybeAdjust({
    group:  'known_bad',
    setting: 'anomaly_known_bad_threshold',
    current: current.knownBad,
    floor:   KNOWN_BAD_THRESHOLD_FLOOR,
    ceiling: KNOWN_BAD_THRESHOLD_CEILING,
    stats:   byGroup.get('known_bad')!,
  });

  return out;
}

/** Internal: decide whether `current` needs +1, -1, or no change for one rule
 *  group, then persist + log. Encodes the auto-tune policy in one place. */
async function maybeAdjust(input: {
  group:   'streak' | 'known_bad';
  setting: string;
  current: number;
  floor:   number;
  ceiling: number;
  stats:   { fired: number; reverted: number };
}): Promise<void> {
  const { fired, reverted } = input.stats;
  if (fired === 0) return;                       // nothing happened — skip
  const pct = Math.round((reverted / fired) * 100);

  let newValue = input.current;
  let reason: string | null = null;

  if (fired >= CALIBRATION_RAISE_MIN && pct > CALIBRATION_RAISE_PCT && input.current < input.ceiling) {
    newValue = input.current + 1;
    reason = `revert ${pct}% over ${fired} firings → raise to ${newValue}`;
  } else if (fired >= CALIBRATION_LOWER_MIN && pct < CALIBRATION_LOWER_PCT && input.current > input.floor) {
    newValue = input.current - 1;
    reason = `revert ${pct}% over ${fired} firings → lower to ${newValue}`;
  }

  if (!reason || newValue === input.current) return;

  await setSetting(input.setting, String(newValue));
  await db.insert(ruleTuningLog).values({
    ruleGroup:  input.group,
    priorValue: input.current,
    newValue,
    reason,
  });
  console.log(`[anomaly-calibration] Auto-tuned ${input.group}: ${input.current} → ${newValue} (${reason})`);
}

/**
 * Apply a decision to the DB. Used by:
 *   • the auto-decider (actor='auto:<rule>'), called from enqueueAnomaly
 *   • the manual review routes (actor='user:<id>'), called from admin.ts
 *
 * Writes exactly one row to anomaly_decision_log; the row's side_effects
 * column captures what changed elsewhere (price_history id, prior bypass
 * flag, etc) so revertDecision() can undo it cleanly later.
 *
 * Returns the new log row id.
 */
export async function applyDecision(input: {
  anomalyId: number;
  productId: number;
  decision:  AutoDecision;
  actor:     string;                // 'user:<id>' | 'auto:<rule>'
}): Promise<number> {
  const [anomaly] = await db.select().from(scrapeAnomalies).where(eq(scrapeAnomalies.id, input.anomalyId)).limit(1);
  if (!anomaly) throw new Error(`applyDecision: anomaly ${input.anomalyId} not found`);
  const priorStatus = anomaly.status;
  const sideEffects: Record<string, unknown> = {};

  // Side-effect 1: price_history insertion (approve with price)
  if (input.decision.applyAction === 'approve_with_price' && anomaly.suspectPrice) {
    const [inserted] = await db.insert(priceHistory).values({
      productId: input.productId,
      price:     String(anomaly.suspectPrice),
      currency:  'EUR',
      scrapedAt: anomaly.detectedAt,
    }).returning({ id: priceHistory.id });
    sideEffects.priceHistoryId = inserted.id;
    // Recompute deal_score / is_on_sale against the new tail price.
    await db.execute(sql`
      WITH stats AS (
        SELECT MAX(price)::float AS amax,
               (SELECT price::float FROM price_history WHERE product_id = ${input.productId} ORDER BY scraped_at DESC LIMIT 1) AS cur
        FROM price_history WHERE product_id = ${input.productId}
      )
      UPDATE products SET
        is_on_sale = (SELECT cur < amax * 0.93 FROM stats),
        deal_score = (SELECT ROUND(((amax - cur) / amax * 100)::numeric, 1) FROM stats WHERE amax > 0)
      WHERE id = ${input.productId}
    `);
  }

  // Side-effect 2: mark product unavailable (used/unqualified path).
  // Mirrors the manual /admin/anomalies/:id/mark-unavailable side effects:
  // also clears sale flags and auto-published featured state. Revert only
  // restores is_available — the other flags will repopulate on next scrape.
  if (input.decision.applyAction === 'mark_unavailable') {
    const [prior] = await db.select({ isAvailable: products.isAvailable }).from(products).where(eq(products.id, input.productId)).limit(1);
    sideEffects.priorIsAvailable = prior?.isAvailable ?? null;
    await db.execute(sql`
      UPDATE products SET
        is_available = FALSE,
        is_on_sale   = FALSE,
        sale_tier    = NULL,
        deal_score   = NULL,
        is_public    = CASE WHEN feature_lock = 'auto' THEN FALSE ELSE is_public END,
        featured_at  = CASE WHEN feature_lock = 'auto' THEN NULL  ELSE featured_at END
      WHERE id = ${input.productId}
    `);
  }

  // Update the anomaly itself.
  await db.update(scrapeAnomalies)
    .set({ status: input.decision.newStatus, reviewedAt: new Date() })
    .where(eq(scrapeAnomalies.id, input.anomalyId));

  const [logged] = await db.insert(anomalyDecisionLog).values({
    anomalyId:   input.anomalyId,
    productId:   input.productId,
    action:      input.decision.applyAction,
    actor:       input.actor,
    ruleName:    input.actor.startsWith('auto:') ? input.decision.ruleName : null,
    confidence:  input.actor.startsWith('auto:') ? String(input.decision.confidence) : null,
    priorStatus,
    newStatus:   input.decision.newStatus,
    sideEffects: Object.keys(sideEffects).length ? sideEffects : null,
  }).returning({ id: anomalyDecisionLog.id });

  if (input.actor.startsWith('auto:')) {
    console.log(`[anomaly-auto] ${input.decision.ruleName} → ${input.decision.applyAction} on anomaly ${input.anomalyId} (product ${input.productId})`);
  }
  return logged.id;
}

/**
 * Revert a previously-applied decision. Drops the side-effects captured at
 * apply time, flips the anomaly back to its prior status, and stamps the
 * original log row as reverted (plus inserts a new 'reverted' log row so
 * the timeline reads chronologically).
 */
export async function revertDecision(logId: number, revertedByUserId: number): Promise<void> {
  const [log] = await db.select().from(anomalyDecisionLog).where(eq(anomalyDecisionLog.id, logId)).limit(1);
  if (!log) throw new Error(`revertDecision: log ${logId} not found`);
  if (log.revertedAt) throw new Error(`revertDecision: log ${logId} already reverted`);

  const fx = (log.sideEffects ?? {}) as Record<string, unknown>;

  // Undo side-effects in reverse order of apply.
  if (typeof fx.priceHistoryId === 'number') {
    await db.delete(priceHistory).where(eq(priceHistory.id, fx.priceHistoryId));
    // Recompute deal flags after removing the row.
    await db.execute(sql`
      WITH stats AS (
        SELECT MAX(price)::float AS amax,
               (SELECT price::float FROM price_history WHERE product_id = ${log.productId} ORDER BY scraped_at DESC LIMIT 1) AS cur
        FROM price_history WHERE product_id = ${log.productId}
      )
      UPDATE products SET
        is_on_sale = COALESCE((SELECT cur < amax * 0.93 FROM stats), FALSE),
        deal_score = (SELECT ROUND(((amax - cur) / amax * 100)::numeric, 1) FROM stats WHERE amax > 0)
      WHERE id = ${log.productId}
    `);
  }
  if (fx.priorIsAvailable != null) {
    await db.update(products).set({ isAvailable: Boolean(fx.priorIsAvailable) }).where(eq(products.id, log.productId));
  }

  // Flip the anomaly back to its prior status (typically 'pending') so the
  // operator can re-decide manually if they want.
  await db.update(scrapeAnomalies)
    .set({ status: log.priorStatus, reviewedAt: null, reviewedBy: null })
    .where(eq(scrapeAnomalies.id, log.anomalyId));

  // Mark the original row as reverted + leave a breadcrumb row for timeline.
  await db.update(anomalyDecisionLog)
    .set({ revertedAt: new Date(), revertedBy: revertedByUserId })
    .where(eq(anomalyDecisionLog.id, logId));
  await db.insert(anomalyDecisionLog).values({
    anomalyId:   log.anomalyId,
    productId:   log.productId,
    action:      'reverted',
    actor:       `user:${revertedByUserId}`,
    priorStatus: log.newStatus,
    newStatus:   log.priorStatus,
  });
}

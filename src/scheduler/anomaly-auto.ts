import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { scrapeAnomalies, priceHistory, products, anomalyDecisionLog } from '../db/schema';

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
  anomalyId:    number;
  productId:    number;
  type:         AnomalyType;
  suspectPrice: number | null;
  medianPrice:  number | null;
  message:      string;
  bypassFlag:   boolean;            // products.bypass_anomaly_guard
  approvedSame: number;             // count for this product + same type
  deniedSame:   number;
  reviewedSame: number;             // approved + denied for this (product, type)
}

export interface AutoDecision {
  ruleName:    string;
  confidence:  number;              // 0–1
  newStatus:   'approved' | 'denied';
  applyAction: 'approve_with_price' | 'approve_noop' | 'deny' | 'mark_unavailable';
}

type Rule = (ctx: AnomalyContext) => AutoDecision | null;

/** Minimum samples before streak rules fire — protects new/rare products. */
const STREAK_THRESHOLD = 3;

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

  // 2. Approved streak: ≥3 admins-said-yes for (product, type) with 0 denials
  //    → the same shape of anomaly keeps showing up legitimately (product has
  //    naturally wide swings, e.g. flash sales). Apply the suspect price.
  function approvedStreak(ctx) {
    if (ctx.approvedSame < STREAK_THRESHOLD || ctx.deniedSame > 0) return null;
    if (ctx.type === 'used' || ctx.type === 'unqualified') {
      return { ruleName: 'approved_streak', confidence: 1.00, newStatus: 'approved', applyAction: 'mark_unavailable' };
    }
    return { ruleName: 'approved_streak', confidence: 1.00, newStatus: 'approved', applyAction: 'approve_with_price' };
  },

  // 3. Denied streak: ≥3 rejections for (product, type) with 0 approvals
  //    → this product keeps producing the same kind of garbage. Auto-deny.
  function deniedStreak(ctx) {
    if (ctx.deniedSame < STREAK_THRESHOLD || ctx.approvedSame > 0) return null;
    return { ruleName: 'denied_streak', confidence: 1.00, newStatus: 'denied', applyAction: 'deny' };
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
  return decideAnomaly({
    anomalyId:    input.anomalyId,
    productId:    input.productId,
    type:         input.type,
    suspectPrice: input.suspectPrice,
    medianPrice:  input.medianPrice,
    message:      input.message,
    bypassFlag:   !!r.bypassFlag,
    approvedSame,
    deniedSame,
    reviewedSame: approvedSame + deniedSame,
  });
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

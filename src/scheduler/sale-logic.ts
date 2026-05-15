/**
 * Pure sale-detection + auto-feature logic. Extracted from scheduler/index.ts
 * so it can be unit-tested without pulling in db/playwright at module load.
 *
 * Two functions:
 *  - calcSaleTier(currentPrice, reference): turns a price drop pct into a
 *    SaleInfo tier (oferta / super / mega / broooooferton / 67oferta).
 *  - evaluateAutoFeature(current, saleInfo, scrapeCount, daysSpan, minScore):
 *    decides whether a product enters or exits /ofertas, with a 5-point
 *    hysteresis to avoid flip-flop and 14-day fatigue cutoff.
 */

export interface SaleInfo {
  isOnSale: boolean;
  saleTier: string | null;
  dealScore: number | null;
}

export function calcSaleTier(currentPrice: number, reference: number): SaleInfo {
  const pctOff = (reference - currentPrice) / reference * 100;
  if (pctOff >= 67) return { isOnSale: true, saleTier: '67oferta',      dealScore: pctOff };
  if (pctOff >= 50) return { isOnSale: true, saleTier: 'broooooferton', dealScore: pctOff };
  if (pctOff >= 30) return { isOnSale: true, saleTier: 'mega-oferta',   dealScore: pctOff };
  if (pctOff >= 15) return { isOnSale: true, saleTier: 'super-oferta',  dealScore: pctOff };
  if (pctOff >= 7)  return { isOnSale: true, saleTier: 'oferta',        dealScore: pctOff };
  return { isOnSale: false, saleTier: null, dealScore: null };
}

export function evaluateAutoFeature(
  current: { isPublic: boolean; isAvailable: boolean; featuredAt: Date | null },
  saleInfo: SaleInfo,
  scrapeCount: number,
  daysSpan: number,
  minScore: number,
  now: Date = new Date(),
): { isPublic: boolean; featuredAt: Date | null } {
  const exitScore = Math.max(5, minScore - 5);
  const score     = saleInfo.dealScore ?? 0;
  const fatigueMs = 14 * 24 * 60 * 60 * 1000;

  if (current.isPublic) {
    const aged = current.featuredAt && (now.getTime() - current.featuredAt.getTime()) > fatigueMs;
    if (!current.isAvailable || !saleInfo.isOnSale || score < exitScore || aged) {
      return { isPublic: false, featuredAt: null };
    }
    return { isPublic: true, featuredAt: current.featuredAt ?? now };
  }
  if (current.isAvailable && saleInfo.isOnSale && score >= minScore && scrapeCount >= 5 && daysSpan >= 2) {
    return { isPublic: true, featuredAt: now };
  }
  return { isPublic: false, featuredAt: null };
}

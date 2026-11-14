// What happens to a product that Amazon confirms as unavailable. Pure so it is unit-testable.
//
// Rules agreed with the owner (2026-11-14):
//  * Products nobody follows (discovered by the system, no alerts, no real follower) go away
//    at the first confirmation — they are catalog noise.
//  * Products that DO have a real follower or an alert are protected: they get a grace period
//    (the scheduler rechecks them every `unavailable_pause_hours`) and are removed only after
//    the initial confirmation + `unavailable_extra_checks` further bad checks (default 1 + 2 = 3).
//  * "Gone" products (Amazon says the ASIN doesn't exist) don't need that grace: delete at once
//    when unprotected, after `gone_confirmations` consecutive confirmations (default 2) when protected.
//  * A page that belongs to a DIFFERENT ASIN ("redirect") is treated like "gone", but never
//    deletes on a single sighting, even for unprotected products.
//  * A successful scrape resets the counter (unavailable_confirmations = 0).

export type UnavailableReason = 'gone' | 'redirect' | 'used' | 'unqualified' | undefined;

export interface LifecycleSettings {
  /** Extra checks after the first confirmation before a protected product is removed. */
  extraChecks: number;
  /** Consecutive confirmations of "gone" before a protected product is removed. */
  goneConfirmations: number;
}

export const DEFAULT_LIFECYCLE: LifecycleSettings = { extraChecks: 2, goneConfirmations: 2 };

export type LifecycleAction = 'keep' | 'delete';

export function decideAfterConfirmedUnavailable(input: {
  reason: UnavailableReason;
  /** Number of confirmed-unavailable checks so far INCLUDING the current one (>= 1). */
  confirmations: number;
  /** Has a real (non-system) follower or any alert. */
  isProtected: boolean;
  settings?: LifecycleSettings;
}): LifecycleAction {
  const s = input.settings ?? DEFAULT_LIFECYCLE;
  const n = Math.max(1, input.confirmations);

  if (input.reason === 'redirect') {
    return n >= s.goneConfirmations ? 'delete' : 'keep';
  }
  if (!input.isProtected) return 'delete';

  if (input.reason === 'gone') return n >= s.goneConfirmations ? 'delete' : 'keep';
  return n >= 1 + s.extraChecks ? 'delete' : 'keep';
}

export function describeReason(reason: UnavailableReason): string {
  switch (reason) {
    case 'gone':        return 'Amazon indica que el producto ya no existe';
    case 'redirect':    return 'Amazon redirige este producto a otra variante distinta';
    case 'used':        return 'solo hay ofertas de segunda mano';
    case 'unqualified': return 'solo lo venden terceros, sin oferta de Amazon';
    default:            return 'Amazon lo muestra como no disponible';
  }
}

// A product that has just been added has no price yet: the scrape runs in the background and takes
// from a few seconds up to a minute or two. While that is the case the product page shows a
// "collecting information" screen instead of an empty page.
//   ready       — there is at least one price: the regular product page.
//   working     — first scrape still running (spinner + progress bar, auto-refresh).
//   delayed     — it is taking too long / failed: say so, keep checking.
//   unavailable — Amazon answered: not sold by Amazon / out of stock. No price will appear.
export type CollectState = 'ready' | 'working' | 'delayed' | 'unavailable';

/** How long after creation we still consider the first scrape "in progress". */
export const COLLECT_WINDOW_MS = 4 * 60 * 1000;

export function collectState(p: {
  historyCount: number;
  createdAt: Date | string | null | undefined;
  lastError: string | null | undefined;
  isAvailable: boolean | null | undefined;
  /** The scraper has already tried this product at least once (products.last_checked_at). */
  checked?: boolean;
  now?: number;
}): CollectState {
  if (p.historyCount > 0) return 'ready';
  // New rows default to is_available = TRUE, so FALSE together with "already tried" means Amazon said no.
  if (p.isAvailable === false && p.checked) return 'unavailable';
  const now = p.now ?? Date.now();
  const age = p.createdAt ? now - new Date(p.createdAt).getTime() : Infinity;
  if (!p.lastError && age < COLLECT_WINDOW_MS) return 'working';
  return 'delayed';
}

/**
 * What the status poll should answer. `shown` is the state the open page was rendered with:
 * a page that already shows "delayed" only reloads once the outcome changes (otherwise it would
 * reload itself forever); a page showing the spinner reloads on any change.
 */
export function pollAction(current: CollectState, shown: 'working' | 'delayed'): 'wait' | 'reload' {
  if (current === 'ready' || current === 'unavailable') return 'reload';
  if (current === 'working') return 'wait';
  return shown === 'delayed' ? 'wait' : 'reload';
}

/** A user-facing sentence for why Amazon does not offer the product (from products.last_error). */
export function unavailableText(lastError: string | null | undefined): string {
  const e = (lastError ?? '').toLowerCase();
  if (e.includes('tercero')) return 'Ahora mismo solo lo venden vendedores externos, sin oferta de Amazon, y de momento solo seguimos productos que vende Amazon.';
  if (e.includes('segunda mano') || e.includes('used')) return 'Ahora mismo solo hay ofertas de segunda mano; solo seguimos productos nuevos que vende Amazon.';
  if (e.includes('no existe') || e.includes('not found') || e.includes('404')) return 'Amazon indica que este producto ya no existe.';
  return 'Amazon no lo muestra disponible ahora mismo.';
}

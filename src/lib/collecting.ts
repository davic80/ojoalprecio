// A product that has just been added has no price yet: the scrape runs in the background and takes
// from a few seconds up to a minute or two. While that is the case the product page shows a
// "collecting information" screen instead of an empty page.
export type CollectState = 'ready' | 'working' | 'delayed';

/** How long after creation we still consider the first scrape "in progress". */
export const COLLECT_WINDOW_MS = 4 * 60 * 1000;

export function collectState(p: {
  historyCount: number;
  createdAt: Date | string | null | undefined;
  lastError: string | null | undefined;
  isAvailable: boolean | null | undefined;
  now?: number;
}): CollectState {
  if (p.historyCount > 0) return 'ready';
  // Amazon said it is not sold/new/available: the regular page explains it ("Sin stock").
  if (p.isAvailable === false) return 'ready';
  const now = p.now ?? Date.now();
  const age = p.createdAt ? now - new Date(p.createdAt).getTime() : Infinity;
  if (!p.lastError && age < COLLECT_WINDOW_MS) return 'working';
  return 'delayed';
}

/**
 * What the status poll should answer. `shown` is the state the open page was rendered with:
 * a page that already shows "delayed" only reloads once the data is really there (otherwise it
 * would reload itself forever); a page showing the spinner reloads on any change.
 */
export function pollAction(current: CollectState, shown: 'working' | 'delayed'): 'wait' | 'reload' {
  if (current === 'ready') return 'reload';
  if (current === 'working') return 'wait';
  return shown === 'delayed' ? 'wait' : 'reload';
}

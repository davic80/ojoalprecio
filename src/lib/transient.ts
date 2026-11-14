// Errors that only mean "the shared Chromium was restarted/killed while this page was open"
// (the scheduler restarts it after a hard timeout or a block). Retrying a little later works.
const BROWSER_LIFECYCLE = /has been closed|target closed|browser closed|browser has disconnected|execution context was destroyed|page was closed|protocol error|browsertype\.launch|failed to launch/i;

export function isTransientBrowserError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return BROWSER_LIFECYCLE.test(msg);
}

/** What to show a person instead of a raw scraper error for a product that has no price yet. */
export function friendlyScrapeError(raw: string | null | undefined): string {
  return isTransientBrowserError(raw) || /hard_timeout|timeout|net::|navigation/i.test(raw ?? '')
    ? 'Reintentando automáticamente…'
    : 'No se ha podido leer todavía; se reintentará automáticamente.';
}

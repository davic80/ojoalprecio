import { EventEmitter } from 'events';

/**
 * Single-process pub/sub for product updates. The scheduler emits a
 * `scrape:<asin>` event each time a successful scrape finishes; SSE
 * subscribers (one per active /p/:asin viewer) wake up and trigger an
 * HTMX fragment refresh.
 *
 * Keep the bus deliberately tiny — no payload other than the ASIN. The
 * client fetches a server-rendered HTML fragment via HTMX, so we never
 * have to keep payload schemas in sync between scheduler and browser.
 *
 * setMaxListeners(0) disables the "possible memory leak" warning that
 * Node prints once 11+ listeners are attached to the same event. We
 * legitimately have N listeners per popular ASIN.
 */
class ProductBus extends EventEmitter {}

export const productBus = new ProductBus();
productBus.setMaxListeners(0);

export type ScrapeUpdateEvent = { asin: string };

export function emitScrapeUpdate(asin: string): void {
  productBus.emit(`scrape:${asin.toUpperCase()}`, { asin: asin.toUpperCase() });
}

export function onScrapeUpdate(asin: string, listener: (e: ScrapeUpdateEvent) => void): () => void {
  const ev = `scrape:${asin.toUpperCase()}`;
  productBus.on(ev, listener);
  return () => { productBus.off(ev, listener); };
}

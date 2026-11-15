// Work queue of the continuous scraper. Pure (no DB, no timers) so it is unit-testable.
//
// Before, the scraper worked in hourly cycles: it built the list of due products, worked it for at most
// 50 minutes and then idled until the next :00 (about 17 % of the time). Now the workers never stop:
// they take the next due product from this queue, and the queue is rebuilt from the database
// every few minutes (or as soon as it runs dry) with the same fair order (see selection.ts).

export interface QueueItem { id: number }

export class WorkQueue<T extends QueueItem> {
  private items: T[] = [];
  private readonly inFlight = new Set<number>();

  /** Products waiting to be taken. */
  get size(): number { return this.items.length; }
  /** Products being scraped right now. */
  get running(): number { return this.inFlight.size; }
  isInFlight(id: number): boolean { return this.inFlight.has(id); }

  /**
   * Replace the waiting list with a freshly sorted one. Products being scraped right now are left out
   * (another worker must not take them again), and a product can appear only once.
   * Returns how many were queued.
   */
  replace(sorted: T[]): number {
    const seen = new Set<number>();
    this.items = sorted.filter(p => {
      if (this.inFlight.has(p.id) || seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });
    return this.items.length;
  }

  /** Next product to scrape, marked as in flight until done() or giveBack() is called. */
  take(): T | null {
    const p = this.items.shift() ?? null;
    if (p) this.inFlight.add(p.id);
    return p;
  }

  /** Finished (with or without result): it leaves the in-flight set. */
  done(p: T): void { this.inFlight.delete(p.id); }

  /** The executor failed, not the product: back to the front so another worker takes it soon. */
  giveBack(p: T): void {
    this.inFlight.delete(p.id);
    if (!this.items.some(x => x.id === p.id)) this.items.unshift(p);
  }

  clear(): void { this.items = []; }
}

/**
 * Counters of the current hour of work, to log it and to raise the "almost no valid answers" alert
 * (before this lived in the end-of-cycle code, which no longer exists).
 */
export class RateWindow {
  processed = 0;
  answered = 0;
  private startedAt: number;
  constructor(now: number) { this.startedAt = now; }

  record(answeredOk: boolean): void { this.processed++; if (answeredOk) this.answered++; }
  ageMs(now: number): number { return now - this.startedAt; }
  /** True when there were enough attempts and fewer than 30 % got a definitive answer. */
  isLowRate(): boolean { return this.processed >= 30 && this.answered / this.processed < 0.3; }
  reset(now: number): void { this.processed = 0; this.answered = 0; this.startedAt = now; }
}

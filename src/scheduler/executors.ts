// Circuit breaker for remote scraper executors: after a few consecutive infrastructure
// failures the executor is skipped for a while instead of eating a product on every try.
// Pure (time injected) so it is unit-testable.

export class Breaker {
  private failures = 0;
  private openUntil = 0;
  constructor(private readonly threshold = 3, private readonly openMs = 5 * 60 * 1000) {}

  isOpen(now: number): boolean { return now < this.openUntil; }
  success(): void { this.failures = 0; this.openUntil = 0; }
  /** Returns true when this failure just opened the breaker. */
  failure(now: number): boolean {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.failures = 0;
      this.openUntil = now + this.openMs;
      return true;
    }
    return false;
  }
  get remainingMs(): number { return Math.max(0, this.openUntil - Date.now()); }
}

export interface ExecutorStatus {
  name: string;
  kind: 'local' | 'remote';
  done: number;
  failed: number;
  breakerOpen: boolean;
  lastError: string | null;
}

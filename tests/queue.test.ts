import { describe, it, expect } from 'vitest';
import { WorkQueue, RateWindow } from '../src/scheduler/queue';

const P = (id: number) => ({ id, name: `p${id}` });

describe('WorkQueue', () => {
  it('serves products in the order they were given and marks them in flight', () => {
    const q = new WorkQueue(); q.replace([P(3), P(1), P(2)]);
    expect(q.size).toBe(3);
    expect(q.take()?.id).toBe(3); expect(q.take()?.id).toBe(1);
    expect(q.size).toBe(1); expect(q.running).toBe(2);
    expect(q.isInFlight(3)).toBe(true);
  });

  it('returns null when empty', () => {
    expect(new WorkQueue().take()).toBeNull();
  });

  it('a refresh leaves out what is being scraped right now and removes duplicates', () => {
    const q = new WorkQueue(); q.replace([P(1), P(2), P(3)]);
    const a = q.take()!;                                   // 1 in flight
    expect(q.replace([P(1), P(2), P(2), P(4)])).toBe(2);   // 1 is running; 2 appears twice
    expect(q.take()?.id).toBe(2); expect(q.take()?.id).toBe(4);
    q.done(a);
    expect(q.running).toBe(2);                             // 2 and 4 still running
    expect(q.replace([P(1)])).toBe(1);                     // once done, 1 can queue again
  });

  it('a refresh replaces the waiting list: what is not in the new list is dropped', () => {
    const q = new WorkQueue(); q.replace([P(1), P(2), P(3)]);
    q.replace([P(9)]);
    expect(q.take()?.id).toBe(9); expect(q.take()).toBeNull();
  });

  it('giveBack puts it at the front, once, and frees the in-flight mark', () => {
    const q = new WorkQueue(); q.replace([P(1), P(2)]);
    const a = q.take()!;
    q.giveBack(a);
    expect(q.running).toBe(0);
    expect(q.take()?.id).toBe(1);
    const again = q.take()!; q.giveBack(again); q.giveBack(again);   // twice: no duplicate
    expect(q.size).toBe(1);
  });

  it('done frees the product even if it fails, so it is not stuck as running', () => {
    const q = new WorkQueue(); q.replace([P(1)]);
    const a = q.take()!; q.done(a); q.done(a);
    expect(q.running).toBe(0);
  });

  it('clear empties the waiting list but keeps in-flight ones', () => {
    const q = new WorkQueue(); q.replace([P(1), P(2)]); q.take();
    q.clear();
    expect(q.size).toBe(0); expect(q.running).toBe(1);
  });
});

describe('RateWindow', () => {
  it('flags a low rate only with enough attempts', () => {
    const w = new RateWindow(0);
    for (let i = 0; i < 29; i++) w.record(false);
    expect(w.isLowRate()).toBe(false);           // < 30 attempts: not enough to judge
    w.record(false);
    expect(w.isLowRate()).toBe(true);            // 0 of 30
  });
  it('is fine at 30 % or above and resets', () => {
    const w = new RateWindow(0);
    for (let i = 0; i < 100; i++) w.record(i < 30);
    expect(w.isLowRate()).toBe(false);
    w.reset(5000);
    expect([w.processed, w.answered, w.ageMs(6000)]).toEqual([0, 0, 1000]);
  });
});

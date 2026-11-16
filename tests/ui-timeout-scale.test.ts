import { describe, it, expect } from 'vitest';
import { uiTimeoutScale } from '../src/scraper/util';

describe('uiTimeoutScale (more patience for the delivery-location flow on slow machines)', () => {
  it('is 1 when not set or not a number', () => {
    for (const v of [undefined, '', 'abc', 'NaN']) expect(uiTimeoutScale(v)).toBe(1);
  });
  it('never makes the waits shorter', () => {
    for (const v of ['0', '0.5', '-3']) expect(uiTimeoutScale(v)).toBe(1);
  });
  it('accepts a multiplier like 2.5 (5 s becomes 12.5 s)', () => {
    expect(uiTimeoutScale('2.5')).toBe(2.5);
    expect(Math.round(5000 * uiTimeoutScale('2.5'))).toBe(12500);
  });
  it('caps absurd values', () => {
    expect(uiTimeoutScale('1000')).toBe(10);
  });
});

import { browserRecycleAfter, IdleGate } from '../src/scraper/util';

describe('browserRecycleAfter', () => {
  it('defaults to 500 and ignores garbage', () => {
    for (const v of [undefined, '', 'x', '3', '-5']) expect(browserRecycleAfter(v)).toBe(500);
  });
  it('accepts a lower value for machines that need a smaller Node process', () => {
    expect(browserRecycleAfter('60')).toBe(60);
    expect(browserRecycleAfter('999999')).toBe(5000);
  });
});

describe('IdleGate (the shared browser is only replaced when no scrape is running on it)', () => {
  it('is idle at the start and after everything left', async () => {
    const g = new IdleGate();
    expect(await g.waitIdle(10)).toBe(true);
    g.enter(); g.enter(); g.leave(); g.leave();
    expect(g.active).toBe(0);
    expect(await g.waitIdle(10)).toBe(true);
  });
  it('waits for the running ones and wakes up as soon as the last leaves', async () => {
    const g = new IdleGate(); g.enter(); g.enter();
    const p = g.waitIdle(2000);
    g.leave();
    let done = false; p.then(() => { done = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(done).toBe(false);          // one still running
    g.leave();
    expect(await p).toBe(true);
  });
  it('gives up after the timeout if something never finishes', async () => {
    const g = new IdleGate(); g.enter();
    expect(await g.waitIdle(30)).toBe(false);
    g.leave();
    expect(await g.waitIdle(30)).toBe(true);   // and still works afterwards
  });
  it('a stray leave() cannot make the counter negative', () => {
    const g = new IdleGate(); g.leave(); g.leave();
    expect(g.active).toBe(0);
  });
});

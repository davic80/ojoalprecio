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

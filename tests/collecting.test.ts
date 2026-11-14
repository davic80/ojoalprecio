import { describe, it, expect } from 'vitest';
import { collectState, pollAction, unavailableText, COLLECT_WINDOW_MS } from '../src/lib/collecting';

const now = Date.parse('2026-11-14T14:00:00Z');
const ago = (ms: number) => new Date(now - ms);

describe('collectState', () => {
  it('ready as soon as there is any price', () => {
    expect(collectState({ historyCount: 1, createdAt: ago(1000), lastError: null, isAvailable: true, now })).toBe('ready');
  });
  it('working right after adding, with no price yet (new rows default to available)', () => {
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: null, isAvailable: true, now })).toBe('working');
    // is_available=false but never tried yet is NOT "Amazon said no"
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: null, isAvailable: false, checked: false, now })).toBe('working');
  });
  it('unavailable once Amazon has answered "no"', () => {
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: 'Sin oferta de Amazon — solo terceros vendedores', isAvailable: false, checked: true, now })).toBe('unavailable');
  });
  it('delayed once the window has passed or the scrape failed', () => {
    expect(collectState({ historyCount: 0, createdAt: ago(COLLECT_WINDOW_MS + 1), lastError: null, isAvailable: true, now })).toBe('delayed');
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: 'timeout', isAvailable: true, checked: true, now })).toBe('delayed');
  });
});

describe('pollAction', () => {
  it('spinner page: wait while working, reload on any outcome', () => {
    expect(pollAction('working', 'working')).toBe('wait');
    expect(pollAction('ready', 'working')).toBe('reload');
    expect(pollAction('delayed', 'working')).toBe('reload');
    expect(pollAction('unavailable', 'working')).toBe('reload');
  });
  it('delayed page: never reloads itself in a loop, only when the outcome changes', () => {
    expect(pollAction('delayed', 'delayed')).toBe('wait');
    expect(pollAction('ready', 'delayed')).toBe('reload');
    expect(pollAction('unavailable', 'delayed')).toBe('reload');
  });
});

describe('unavailableText', () => {
  it('explains third-party-only and never promises a notification', () => {
    const t = unavailableText('Sin oferta de Amazon — solo terceros vendedores');
    expect(t).toContain('vendedores externos');
    expect(t.toLowerCase()).not.toContain('notific');
  });
  it('falls back to a generic sentence', () => { expect(unavailableText(null)).toContain('no lo muestra disponible'); });
});

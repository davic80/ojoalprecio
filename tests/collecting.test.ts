import { describe, it, expect } from 'vitest';
import { collectState, pollAction, COLLECT_WINDOW_MS } from '../src/lib/collecting';

const now = Date.parse('2026-11-14T14:00:00Z');
const ago = (ms: number) => new Date(now - ms);

describe('collectState', () => {
  it('ready as soon as there is any price', () => {
    expect(collectState({ historyCount: 1, createdAt: ago(1000), lastError: null, isAvailable: true, now })).toBe('ready');
  });
  it('working right after adding, with no price yet', () => {
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: null, isAvailable: true, now })).toBe('working');
  });
  it('delayed once the window has passed or the scrape failed', () => {
    expect(collectState({ historyCount: 0, createdAt: ago(COLLECT_WINDOW_MS + 1), lastError: null, isAvailable: true, now })).toBe('delayed');
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: 'timeout', isAvailable: true, now })).toBe('delayed');
  });
  it('unavailable products use the regular page', () => {
    expect(collectState({ historyCount: 0, createdAt: ago(5_000), lastError: null, isAvailable: false, now })).toBe('ready');
  });
});

describe('pollAction', () => {
  it('spinner page: wait while working, reload on ready or when it gives up', () => {
    expect(pollAction('working', 'working')).toBe('wait');
    expect(pollAction('ready', 'working')).toBe('reload');
    expect(pollAction('delayed', 'working')).toBe('reload');
  });
  it('delayed page: never reloads itself in a loop, only when the data arrives', () => {
    expect(pollAction('delayed', 'delayed')).toBe('wait');
    expect(pollAction('ready', 'delayed')).toBe('reload');
  });
});

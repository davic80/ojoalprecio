import { describe, it, expect, vi } from 'vitest';
import { turnstileConfig, verifyTurnstile } from '../src/lib/turnstile';

const cfg = { siteKey: 'site', secret: 'secreto' };
const answer = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as Response);

describe('turnstileConfig', () => {
  it('is on only when both keys are set', () => {
    expect(turnstileConfig({} as any)).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: 'a' } as any)).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: ' ' } as any)).toBeNull();
    expect(turnstileConfig({ TURNSTILE_SITE_KEY: 'a', TURNSTILE_SECRET_KEY: 'b' } as any)).toEqual({ siteKey: 'a', secret: 'b' });
  });
});

describe('verifyTurnstile (fails closed)', () => {
  it('accepts only an explicit success and sends secret, token and IP', async () => {
    const f = answer({ success: true });
    expect(await verifyTurnstile('tok', '1.2.3.4', cfg, f as any)).toBe(true);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    const sent = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(sent)).toEqual({ secret: 'secreto', response: 'tok', remoteip: '1.2.3.4' });
  });
  it('rejects a failed challenge', async () => {
    expect(await verifyTurnstile('tok', undefined, cfg, answer({ success: false, 'error-codes': ['invalid-input-response'] }) as any)).toBe(false);
  });
  it('rejects a missing, empty, non-string or oversized token without calling Cloudflare', async () => {
    const f = answer({ success: true });
    for (const t of [undefined, '', null, 123, ['a'], 'x'.repeat(3000)]) expect(await verifyTurnstile(t, '1.1.1.1', cfg, f as any)).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects when Cloudflare errors, times out or answers garbage', async () => {
    expect(await verifyTurnstile('tok', undefined, cfg, answer({}, false) as any)).toBe(false);
    expect(await verifyTurnstile('tok', undefined, cfg, (async () => { throw new Error('red'); }) as any)).toBe(false);
    expect(await verifyTurnstile('tok', undefined, cfg, answer({ success: 'true' }) as any)).toBe(false);
    expect(await verifyTurnstile('tok', undefined, cfg, answer(null) as any)).toBe(false);
  });
});

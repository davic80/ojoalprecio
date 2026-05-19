import { describe, it, expect } from 'vitest';
import { signRequest, systemParams, formatBeijingTimestamp } from '../src/marketplaces/aliexpress/sign';

describe('aliexpress request signing', () => {
  it('produces a 64-char uppercase hex digest', () => {
    const sig = signRequest({ method: 'foo.bar', app_key: 'AK', timestamp: '2026-01-01 00:00:00' }, 'SECRET');
    expect(sig).toMatch(/^[0-9A-F]{64}$/);
  });

  it('sorts keys ASCII-ascending before concatenation', () => {
    // Two equivalent param sets that should produce the same signature.
    const a = signRequest({ zeta: '1', alpha: '2', mu: '3' }, 'K');
    const b = signRequest({ mu: '3', zeta: '1', alpha: '2' }, 'K');
    expect(a).toBe(b);
  });

  it('excludes `sign` from the signed payload (idempotent)', () => {
    const baseParams = { method: 'foo', app_key: 'AK' };
    const sig1 = signRequest(baseParams, 'K');
    const sig2 = signRequest({ ...baseParams, sign: sig1 }, 'K');
    expect(sig1).toBe(sig2);
  });

  it('changes when a value changes', () => {
    const a = signRequest({ method: 'foo', app_key: 'AK' }, 'K');
    const b = signRequest({ method: 'bar', app_key: 'AK' }, 'K');
    expect(a).not.toBe(b);
  });

  it('changes when the secret changes', () => {
    const a = signRequest({ method: 'foo' }, 'KEY-A');
    const b = signRequest({ method: 'foo' }, 'KEY-B');
    expect(a).not.toBe(b);
  });

  it('throws on missing secret', () => {
    expect(() => signRequest({ method: 'foo' }, '')).toThrow(/App Secret/);
  });

  // Known-good vector — concat of "k1v1k2v2" with HMAC-SHA256("S") then upper hex.
  // Verified independently:
  //   echo -n "ab1cd2" | openssl dgst -sha256 -hmac S | awk '{print toupper($2)}'
  it('matches an independently-computed reference vector', () => {
    const sig = signRequest({ a: 'b1', c: 'd2' }, 'S');
    expect(sig).toBe('068D1FEE5FE98E3D2375E34E773B79A44669CF8C4294BC722AEE8DA679B4A062');
  });
});

describe('aliexpress system params', () => {
  it('includes the required TOP fields', () => {
    const sys = systemParams('AK', 'aliexpress.affiliate.productdetail.get');
    expect(sys.app_key).toBe('AK');
    expect(sys.method).toBe('aliexpress.affiliate.productdetail.get');
    expect(sys.format).toBe('json');
    expect(sys.v).toBe('2.0');
    expect(sys.sign_method).toBe('hmac-sha256');
    expect(sys.timestamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('formats the timestamp in Beijing time (GMT+8)', () => {
    // 2026-01-01 00:00:00 UTC = 2026-01-01 08:00:00 Beijing
    const utc = new Date('2026-01-01T00:00:00Z');
    expect(formatBeijingTimestamp(utc)).toBe('2026-01-01 08:00:00');
  });

  it('handles negative UTC offsets correctly', () => {
    // 2026-06-30 20:00:00 UTC = 2026-07-01 04:00:00 Beijing
    const utc = new Date('2026-06-30T20:00:00Z');
    expect(formatBeijingTimestamp(utc)).toBe('2026-07-01 04:00:00');
  });
});

import { describe, it, expect } from 'vitest';
import { buildProfiles, pickProfile, majorVersion, secChUaHeader, profileHeaders } from '../src/scraper/profiles';

describe('browser profiles', () => {
  const profiles = buildProfiles('156.0.8078.79');

  it('announces the REAL engine major version everywhere (no hardcoded Chrome 131)', () => {
    for (const p of profiles) {
      expect(p.userAgent).toContain('Chrome/156.0.0.0');
      expect(secChUaHeader(p)).toContain('v="156"');
      expect(p.userAgent).not.toContain('131');
    }
  });

  it('keeps user agent, client-hint platform and navigator.platform consistent per OS', () => {
    for (const p of profiles) {
      const h = profileHeaders(p);
      expect(h['Sec-CH-UA-Platform']).toBe(`"${p.chPlatform}"`);
      if (p.chPlatform === 'Windows') { expect(p.userAgent).toContain('Windows NT 10.0'); expect(p.navigatorPlatform).toBe('Win32'); }
      if (p.chPlatform === 'macOS')   { expect(p.userAgent).toContain('Macintosh');       expect(p.navigatorPlatform).toBe('MacIntel'); }
      if (p.chPlatform === 'Linux')   { expect(p.userAgent).toContain('X11; Linux');      expect(p.navigatorPlatform).toBe('Linux x86_64'); }
    }
  });

  it('Edge carries both the Edg/ token and the Microsoft Edge brand; Chrome does not', () => {
    const edge = profiles.find(p => p.id === 'edge-win')!;
    expect(edge.userAgent).toMatch(/ Edg\/156\.0\.0\.0$/);
    expect(secChUaHeader(edge)).toContain('"Microsoft Edge";v="156"');
    for (const p of profiles.filter(p => p.id !== 'edge-win')) {
      expect(p.userAgent).not.toContain('Edg/');
      expect(secChUaHeader(p)).toContain('"Google Chrome"');
    }
  });

  it('never impersonates a browser the Chromium engine cannot be (no Firefox/Safari/mobile)', () => {
    for (const p of profiles) {
      expect(p.userAgent).not.toMatch(/Firefox|Gecko\/|Mobile|iPhone|Android/);
      expect(profileHeaders(p)['Sec-CH-UA-Mobile']).toBe('?0');
    }
  });

  it('weights follow the desktop mix (≈80% Windows, 12% macOS, 8% Linux) when sampled', () => {
    const N = 10000; const count: Record<string, number> = {};
    for (let i = 0; i < N; i++) { const p = pickProfile(profiles, i / N); count[p.chPlatform] = (count[p.chPlatform] ?? 0) + 1; }
    expect(count.Windows / N).toBeCloseTo(0.8, 1);
    expect(count.macOS / N).toBeCloseTo(0.12, 1);
    expect(count.Linux / N).toBeCloseTo(0.08, 1);
  });

  it('pickProfile is total for rnd edge values and majorVersion tolerates junk', () => {
    expect(pickProfile(profiles, 0)).toBe(profiles[0]);
    expect(pickProfile(profiles, 0.999999)).toBe(profiles[profiles.length - 1]);
    expect(majorVersion('156.0.8078.79')).toBe(156);
    expect(majorVersion('')).toBe(131);
    expect(buildProfiles('garbage')[0].userAgent).toContain('Chrome/131.0.0.0');
  });
});

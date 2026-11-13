// Coherent browser identities for the Amazon scraper.
//
// The engine is always Chromium (version taken from the running browser), so every
// identity must be a Chromium-family desktop browser whose User-Agent, Client Hints
// (Sec-CH-UA*), navigator.platform and navigator.userAgentData all tell the same
// story. The previous code announced a fixed "Chrome 131" while the real engine was
// 156, sent "Windows" hints with Mac/Linux user agents and attached Chrome hints to a
// Firefox user agent. Safari/Firefox/mobile identities are deliberately absent: they
// cannot be impersonated honestly by Chromium, and Amazon's mobile site has a
// different DOM than the selectors expect.
//
// Pure module (no Playwright import) so it can be unit tested.

export interface UaProfile {
  id: string;
  userAgent: string;
  /** navigator.platform */
  navigatorPlatform: string;
  /** Sec-CH-UA-Platform / userAgentData.platform */
  chPlatform: 'Windows' | 'macOS' | 'Linux';
  platformVersion: string;
  /** Brand list used for Sec-CH-UA and navigator.userAgentData.brands */
  brands: Array<{ brand: string; version: string }>;
  fullVersion: string;
  /** Relative frequency among desktop Chromium-family browsers. */
  weight: number;
}

/** "156.0.8078.79" → 156 */
export function majorVersion(version: string): number {
  const m = /^(\d+)/.exec(version ?? '');
  return m ? parseInt(m[1], 10) : 131;
}

const greaseBrand = (major: number) => ({ brand: 'Not_A Brand', version: major % 2 === 0 ? '24' : '99' });

export function buildProfiles(browserVersion: string): UaProfile[] {
  const major = majorVersion(browserVersion);
  const full = /^\d+\.\d+\.\d+\.\d+$/.test(browserVersion) ? browserVersion : `${major}.0.0.0`;
  const v = `${major}.0.0.0`; // Chrome freezes the minor parts in the UA string
  const chromeBrands = [
    greaseBrand(major),
    { brand: 'Chromium', version: String(major) },
    { brand: 'Google Chrome', version: String(major) },
  ];
  const edgeBrands = [
    greaseBrand(major),
    { brand: 'Chromium', version: String(major) },
    { brand: 'Microsoft Edge', version: String(major) },
  ];
  const base = (os: string) => `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
  return [
    // Windows ≈ 80 % of desktop; Chrome ≈ 70 / Edge ≈ 30 of that.
    { id: 'chrome-win', userAgent: base('Windows NT 10.0; Win64; x64'), navigatorPlatform: 'Win32', chPlatform: 'Windows', platformVersion: '10.0.0', brands: chromeBrands, fullVersion: full, weight: 56 },
    { id: 'edge-win',   userAgent: base('Windows NT 10.0; Win64; x64') + ` Edg/${v}`, navigatorPlatform: 'Win32', chPlatform: 'Windows', platformVersion: '10.0.0', brands: edgeBrands, fullVersion: full, weight: 24 },
    // macOS ≈ 12 % (Safari excluded: not impersonable on Chromium → Chrome only).
    { id: 'chrome-mac', userAgent: base('Macintosh; Intel Mac OS X 10_15_7'), navigatorPlatform: 'MacIntel', chPlatform: 'macOS', platformVersion: '14.6.0', brands: chromeBrands, fullVersion: full, weight: 12 },
    // Linux ≈ 8 %.
    { id: 'chrome-linux', userAgent: base('X11; Linux x86_64'), navigatorPlatform: 'Linux x86_64', chPlatform: 'Linux', platformVersion: '6.5.0', brands: chromeBrands, fullVersion: full, weight: 8 },
  ];
}

/** Weighted pick. `rnd` ∈ [0,1) injectable for tests. */
export function pickProfile(profiles: UaProfile[], rnd: number = Math.random()): UaProfile {
  const total = profiles.reduce((s, p) => s + p.weight, 0);
  let x = rnd * total;
  for (const p of profiles) {
    if ((x -= p.weight) < 0) return p;
  }
  return profiles[profiles.length - 1];
}

/** Value of the Sec-CH-UA header for a profile. */
export function secChUaHeader(p: UaProfile): string {
  return p.brands.map(b => `"${b.brand}";v="${b.version}"`).join(', ');
}

/** Headers that must travel with the profile's user agent. */
export function profileHeaders(p: UaProfile): Record<string, string> {
  return {
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Cache-Control': 'max-age=0',
    'Sec-CH-UA': secChUaHeader(p),
    'Sec-CH-UA-Mobile': '?0',
    'Sec-CH-UA-Platform': `"${p.chPlatform}"`,
    'Upgrade-Insecure-Requests': '1',
  };
}

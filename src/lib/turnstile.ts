// Cloudflare Turnstile (captcha). Only enforced when both keys are set, so the site keeps working without them.
const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileConfig { siteKey: string; secret: string }

export function turnstileConfig(env: NodeJS.ProcessEnv = process.env): TurnstileConfig | null {
  const siteKey = (env.TURNSTILE_SITE_KEY ?? '').trim();
  const secret = (env.TURNSTILE_SECRET_KEY ?? '').trim();
  return siteKey && secret ? { siteKey, secret } : null;
}

/** Asks Cloudflare whether the challenge was solved. Fails CLOSED: any error or doubt = not verified. */
export async function verifyTurnstile(
  token: unknown, ip: string | undefined, cfg: TurnstileConfig, fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (typeof token !== 'string' || !token || token.length > 2048) return false;
  try {
    const body = new URLSearchParams({ secret: cfg.secret, response: token });
    if (ip) body.set('remoteip', ip);
    const r = await fetchImpl(VERIFY_URL, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(), signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return false;
    return ((await r.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}

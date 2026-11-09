// Operational alerts by email to the admin (ADMIN_EMAIL), with per-key
// throttling so a persistent fault sends one mail, not one per cycle.
import { sendOpsEmail } from '../mailer';

const lastSent = new Map<string, number>();

/** Returns true (and records it) when an alert for `key` may be sent now. */
export function shouldSendAlert(key: string, now: number, minIntervalMs: number): boolean {
  const prev = lastSent.get(key);
  if (prev !== undefined && now - prev < minIntervalMs) return false;
  lastSent.set(key, now);
  return true;
}

export function _resetAlertThrottle(): void { lastSent.clear(); }

const HOW_TO_FIX = [
  '',
  'Cómo revisarlo:',
  '  1. Abre Claude Code en /Users/david/proyectos/ojoalprecio y dile:',
  '     "Ha llegado una alerta del scraper de OjoAlPrecio, revísalo y arréglalo".',
  '  2. Logs:  ssh david@46.225.211.9 \'docker logs ojoalprecio-app --tail 150\'',
  '  3. Estado: https://ojoalprecio.com/healthz/scraper',
].join('\n');

export async function sendOpsAlert(
  key: string,
  subject: string,
  details: string[],
  minIntervalMs = 3 * 60 * 60 * 1000,
): Promise<void> {
  if (!shouldSendAlert(key, Date.now(), minIntervalMs)) return;
  const body = [`[OjoAlPrecio] ${subject}`, '', ...details, HOW_TO_FIX, '', `Enviado: ${new Date().toISOString()}`].join('\n');
  try {
    await sendOpsEmail(`⚠️ OjoAlPrecio: ${subject}`, body);
    console.log(`[ops-alert] email enviado (${key}): ${subject}`);
  } catch (err) {
    console.error(`[ops-alert] no se pudo enviar el email (${key}):`, err instanceof Error ? err.message : err);
  }
}

// Tiny server-side charts for the admin health page: no JS library, just inline SVG.

export interface SparkOptions { width?: number; height?: number; min?: number; max?: number; stroke?: string; label?: string }

/** Align rows ({b: bucket start in seconds, ...}) onto `n` consecutive buckets of `stepSec`; missing buckets are null. */
export function alignBuckets<T extends { b: number | string }>(
  rows: T[], pick: (r: T) => number | null | undefined, startSec: number, stepSec: number, n: number,
): (number | null)[] {
  const out: (number | null)[] = Array.from({ length: n }, () => null);
  for (const r of rows) {
    const i = Math.round((Number(r.b) - startSec) / stepSec);
    if (i < 0 || i >= n) continue;
    const v = pick(r);
    out[i] = v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v);
  }
  return out;
}

export interface SeriesSummary { last: number | null; min: number | null; max: number | null }
export function summarize(values: (number | null)[]): SeriesSummary {
  const v = values.filter((x): x is number => x !== null);
  return { last: v.length ? v[v.length - 1] : null, min: v.length ? Math.min(...v) : null, max: v.length ? Math.max(...v) : null };
}

/** A polyline chart; gaps (null) break the line. Returns an <svg> string safe to embed (numbers and a plain label only). */
export function sparkline(values: (number | null)[], o: SparkOptions = {}): string {
  const w = o.width ?? 240, h = o.height ?? 48, pad = 3;
  const label = (o.label ?? 'gráfica').replace(/[<>&"]/g, '');
  const nums = values.filter((x): x is number => x !== null);
  if (nums.length < 2) {
    return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="${label}: sin datos"><text x="${w / 2}" y="${h / 2 + 4}" text-anchor="middle" font-size="11" fill="currentColor" opacity=".5">sin datos</text></svg>`;
  }
  const lo = o.min ?? Math.min(...nums);
  let hi = o.max ?? Math.max(...nums);
  if (hi <= lo) hi = lo + 1;
  const n = values.length;
  const x = (i: number) => pad + (n === 1 ? 0 : (i * (w - 2 * pad)) / (n - 1));
  const y = (v: number) => h - pad - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * (h - 2 * pad);
  const segs: string[] = [];
  let cur: string[] = [];
  values.forEach((v, i) => {
    if (v === null) { if (cur.length) { segs.push(cur.join(' ')); cur = []; } return; }
    cur.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (cur.length) segs.push(cur.join(' '));
  const stroke = o.stroke ?? 'var(--primary, #1d4ed8)';
  const lines = segs.map(p => p.includes(' ')
    ? `<polyline points="${p}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/>`
    : `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="1.6" fill="${stroke}"/>`).join('');
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="${label}">${lines}</svg>`;
}

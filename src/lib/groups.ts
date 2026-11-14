// Variant groups: the size/colour options of one article, shown together like Amazon's twister.
// Pure helpers (no DB) so they are unit-testable; the DB side lives in scheduler/groups.ts.
import { cleanVariantLabel } from './variants';

const ASIN = /^[A-Z0-9]{10}$/;

/**
 * Safety net: Amazon's largest real families (mattress sizes × packs) have ~65 options. A merge that would
 * produce more than this is almost surely a stray "related product" gluing two families together: skip it.
 */
export const MAX_GROUP_SIZE = 150;

/**
 * Several known ASINs may already point at different groups (two families discovered separately that
 * turn out to be one). Keep the oldest group and report the others to be merged into it.
 */
export function planGroups(groupIds: Array<number | null | undefined>): { target: number | null; merge: number[] } {
  const ids = [...new Set(groupIds.filter((g): g is number => typeof g === 'number'))].sort((a, b) => a - b);
  if (!ids.length) return { target: null, merge: [] };
  return { target: ids[0], merge: ids.slice(1) };
}

/** Group key: Amazon's parent ASIN when known (stable across the family), else the seed product's ASIN. */
export function chooseGroupKey(selfAsin: string, parentAsin?: string | null): string {
  return parentAsin && ASIN.test(parentAsin) ? parentAsin : selfAsin;
}

export interface RawVariant { asin: string; label?: string; selectable?: boolean; dim?: string; self?: boolean }

/**
 * The variants that really are options of this article. Scrapes made since the twister rows are
 * tagged (`dim`) only trust tagged entries — the page also holds "related products" carousels that
 * look similar; older stored data has no tags, so it is used as is.
 */
export function groupableVariants(variants: RawVariant[], selfAsin: string): RawVariant[] {
  const valid = variants.filter(v => v && ASIN.test(v.asin) && v.asin !== selfAsin && !v.self);
  return valid.some(v => v.dim) ? valid.filter(v => v.dim) : valid;
}

export interface VariantLabel { asin: string; label: string; dim: string | null }

/** Order of the selector rows inside a full option name ("Negro · 42": colour before size). */
function dimRank(dim: string | null | undefined): number {
  const d = (dim ?? '').replace(/_name$/, '');
  return ({ color: 0, style: 1, pattern: 2, configuration: 3, flavor: 4, package_type: 5, unit_count: 6, size: 7 } as Record<string, number>)[d] ?? 9;
}
const joinParts = (parts: Array<{ dim: string | null; label: string }>): string =>
  parts.slice().sort((a, b) => dimRank(a.dim) - dimRank(b.dim)).map(p => p.label).join(' · ');

/**
 * Option names. A SIZE sibling carries only the size ("43"); the page that listed it has the other rows selected
 * (`selfEntries`, e.g. colour "Negro"), and a size option keeps that colour, so its full name is "Negro · 43".
 * Other rows (colour…) stay plain: see the note below.
 */
export function variantLabels(variants: RawVariant[], selfEntries: RawVariant[] = []): VariantLabel[] {
  const out: VariantLabel[] = [];
  for (const v of variants) {
    if (!v || !ASIN.test(v.asin)) continue;
    const dim = v.dim ? v.dim.slice(0, 30) : null;
    const own = cleanVariantLabel(v.label ?? '');
    // Only a SIZE sibling is known to share the page's other selections (same colour). A colour swatch's ASIN is
    // that colour's default option, whatever size this page shows, so it stays a plain name until it is read itself.
    const others = dim && /^size/.test(dim) ? selfEntries.filter(e => e.dim && e.dim !== dim && e.label).map(e => ({ dim: e.dim!, label: cleanVariantLabel(e.label ?? '') })) : [];
    out.push({ asin: v.asin, label: others.length ? joinParts([{ dim, label: own }, ...others]) : own, dim });
  }
  return out;
}

/** Full name of the option this page has selected ("Negro · 42"), from the entries flagged `self`. */
export function ownLabel(variants: RawVariant[], selfAsin: string): { label: string; dim: string | null } | null {
  const e = variants.filter(v => v && v.self && v.asin === selfAsin && v.label && v.dim);
  if (!e.length) return null;
  return { label: joinParts(e.map(v => ({ dim: v.dim!, label: cleanVariantLabel(v.label ?? '') }))), dim: e[0].dim ?? null };
}

export interface CatalogInfo { price: number | null; available: boolean | null; followed: boolean; inCatalog: boolean }
export interface SelectorOption { asin: string; label: string; current: boolean; price: number | null; available: boolean; followed: boolean; inCatalog: boolean }
export interface SelectorRow { dim: string | null; title: string; options: SelectorOption[] }

const natural = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true, sensitivity: 'base' });

/**
 * The option selector of a product page, like Amazon's: one row per selector row of THIS page's twister
 * (colour, size…) with the page's own option highlighted. `variants` is the product's stored twister list
 * (siblings + self entries). Old data has no row tags: it becomes a single row. null = nothing to choose.
 */
export function buildSelector(
  variants: RawVariant[], selfAsin: string, lookup: (asin: string) => CatalogInfo, selfFallbackLabel: string | null,
): SelectorRow[] | null {
  const valid = variants.filter(v => v && ASIN.test(v.asin));
  const tagged = valid.some(v => v.dim);
  const byRow = new Map<string, RawVariant[]>();
  for (const v of valid) {
    const key = tagged ? (v.dim ?? '') : '';
    if (tagged && !v.dim) continue;
    byRow.set(key, [...(byRow.get(key) ?? []), v]);
  }
  if (!tagged) byRow.set('', [...(byRow.get('') ?? [])]);
  const rows: SelectorRow[] = [];
  for (const [key, vs] of byRow) {
    const seen = new Set<string>();
    const options: SelectorOption[] = [];
    const add = (asin: string, label: string, current: boolean) => {
      if (seen.has(asin)) return; seen.add(asin);
      const info = lookup(asin);
      options.push({ asin, label: cleanVariantLabel(label), current, price: info.price, available: info.available !== false && info.inCatalog, followed: info.followed, inCatalog: info.inCatalog });
    };
    for (const v of vs) add(v.asin, v.label ?? '', v.asin === selfAsin);
    if (!options.some(o => o.current)) add(selfAsin, selfFallbackLabel ?? 'Esta opción', true);
    options.sort((a, b) => natural(a.label, b.label));
    rows.push({ dim: key || null, title: key ? dimTitle(key) : guessTitle(options.map(o => o.label)), options });
  }
  rows.sort((a, b) => dimRank(a.dim) - dimRank(b.dim));
  const choosable = rows.filter(r => r.options.length >= 2);     // a row with only the current option offers no choice
  return choosable.length ? choosable : null;
}

/** Old stored data has no row tag: numbers-ish labels are sizes, the rest is a generic "Opciones". */
function guessTitle(labels: string[]): string {
  const sizeLike = labels.filter(l => /^\d/.test(l.trim())).length;
  return labels.length && sizeLike / labels.length >= 0.7 ? 'Talla' : 'Opciones';
}

/** Human name of a selector row: 'size_name' → 'Talla'. */
export function dimTitle(dim: string | null | undefined): string {
  switch ((dim ?? '').replace(/_name$/, '')) {
    case 'size': return 'Talla';
    case 'color': return 'Color';
    case 'style': return 'Estilo';
    case 'pattern': return 'Modelo';
    case 'configuration': return 'Configuración';
    case 'flavor': return 'Sabor';
    case 'package_type': return 'Formato';
    case 'unit_count': return 'Cantidad';
    default: return 'Opción';
  }
}

/**
 * Public listings (/ofertas, categories, search): show an article once, not once per size/colour.
 * Inside each group the best offer (highest discount score, then lowest price) represents it, in the
 * position that product already had; `groupCount` options and the lowest `groupMinPrice` are attached.
 */
export function collapseByGroup<T extends { groupId?: number | null; dealScore?: number | string | null; currentPrice?: number | string | null }>(
  rows: T[],
): Array<T & { groupCount: number; groupMinPrice: number | null }> {
  const price = (r: T): number | null => (r.currentPrice === null || r.currentPrice === undefined || r.currentPrice === '' ? null : Number(r.currentPrice));
  const score = (r: T): number => (r.dealScore === null || r.dealScore === undefined ? -1 : Number(r.dealScore));
  const best = new Map<number, T>(), count = new Map<number, number>(), min = new Map<number, number>();
  for (const r of rows) {
    const g = r.groupId;
    if (typeof g !== 'number') continue;
    count.set(g, (count.get(g) ?? 0) + 1);
    const p = price(r);
    if (p !== null && p < (min.get(g) ?? Infinity)) min.set(g, p);
    const cur = best.get(g);
    if (!cur || score(r) > score(cur) || (score(r) === score(cur) && (price(r) ?? Infinity) < (price(cur) ?? Infinity))) best.set(g, r);
  }
  const out: Array<T & { groupCount: number; groupMinPrice: number | null }> = [];
  for (const r of rows) {
    const g = r.groupId;
    if (typeof g !== 'number') out.push({ ...r, groupCount: 1, groupMinPrice: price(r) });
    else if (best.get(g) === r) out.push({ ...r, groupCount: count.get(g)!, groupMinPrice: min.get(g) ?? null });
  }
  return out;
}

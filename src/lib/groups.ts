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

export interface RawVariant { asin: string; label?: string; selectable?: boolean; dim?: string }

/**
 * The variants that really are options of this article. Scrapes made since the twister rows are
 * tagged (`dim`) only trust tagged entries — the page also holds "related products" carousels that
 * look similar; older stored data has no tags, so it is used as is.
 */
export function groupableVariants(variants: RawVariant[], selfAsin: string): RawVariant[] {
  const valid = variants.filter(v => v && ASIN.test(v.asin) && v.asin !== selfAsin);
  return valid.some(v => v.dim) ? valid.filter(v => v.dim) : valid;
}

export interface VariantLabel { asin: string; label: string; dim: string | null }

export function variantLabels(variants: RawVariant[]): VariantLabel[] {
  const out: VariantLabel[] = [];
  for (const v of variants) {
    if (!v || !ASIN.test(v.asin)) continue;
    out.push({ asin: v.asin, label: cleanVariantLabel(v.label ?? ''), dim: v.dim ? v.dim.slice(0, 30) : null });
  }
  return out;
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

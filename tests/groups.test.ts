import { describe, it, expect } from 'vitest';
import { planGroups, chooseGroupKey, groupableVariants, variantLabels, dimTitle } from '../src/lib/groups';

describe('planGroups', () => {
  it('no known group → create one', () => { expect(planGroups([null, undefined])).toEqual({ target: null, merge: [] }); });
  it('one known group → reuse it', () => { expect(planGroups([7, null, 7])).toEqual({ target: 7, merge: [] }); });
  it('several → keep the oldest and merge the rest', () => { expect(planGroups([9, 3, null, 5])).toEqual({ target: 3, merge: [5, 9] }); });
});

describe('chooseGroupKey', () => {
  it('prefers a valid parent ASIN', () => { expect(chooseGroupKey('B0AAAAAAA1', 'B0PARENT01')).toBe('B0PARENT01'); });
  it('falls back to the product ASIN', () => {
    expect(chooseGroupKey('B0AAAAAAA1', null)).toBe('B0AAAAAAA1');
    expect(chooseGroupKey('B0AAAAAAA1', 'not-an-asin')).toBe('B0AAAAAAA1');
  });
});

describe('groupableVariants', () => {
  const v = (asin: string, dim?: string) => ({ asin, label: 'x', dim });
  it('drops itself and malformed ASINs', () => {
    expect(groupableVariants([v('B0AAAAAAA1'), v('B0AAAAAAA2'), v('short')], 'B0AAAAAAA1').map(x => x.asin)).toEqual(['B0AAAAAAA2']);
  });
  it('when entries are tagged, ignores untagged ones (related-products carousels)', () => {
    const out = groupableVariants([v('B0AAAAAAA2', 'size_name'), v('B0AAAAAAA3')], 'B0AAAAAAA1');
    expect(out.map(x => x.asin)).toEqual(['B0AAAAAAA2']);
  });
  it('older untagged data is used as is', () => {
    expect(groupableVariants([v('B0AAAAAAA2'), v('B0AAAAAAA3')], 'B0AAAAAAA1')).toHaveLength(2);
  });
});

describe('variantLabels / dimTitle', () => {
  it('cleans CSS junk and keeps the row', () => {
    const [l] = variantLabels([{ asin: 'B0AAAAAAA2', label: '  42   /* .a-x{} */', dim: 'size_name' }]);
    expect(l).toMatchObject({ asin: 'B0AAAAAAA2', dim: 'size_name' });
    expect(l.label).not.toContain('/*');
  });
  it('names the selector rows in Spanish', () => {
    expect(dimTitle('size_name')).toBe('Talla');
    expect(dimTitle('color_name')).toBe('Color');
    expect(dimTitle(null)).toBe('Opción');
  });
});

import { buildSelector, ownLabel, type CatalogInfo } from '../src/lib/groups';

describe('composed option names', () => {
  const selfEntries = [
    { asin: 'B0SELF0001', label: 'Negro', dim: 'color_name', self: true },
    { asin: 'B0SELF0001', label: '42', dim: 'size_name', self: true },
  ];
  it('a sibling from the size row inherits the selected colour', () => {
    const [l] = variantLabels([{ asin: 'B0AAAAAAA2', label: '43', dim: 'size_name' }], selfEntries);
    expect(l.label).toBe('Negro · 43');
  });
  it('a sibling from the colour row inherits the selected size, colour first', () => {
    const [l] = variantLabels([{ asin: 'B0AAAAAAA3', label: 'Rojo', dim: 'color_name' }], selfEntries);
    expect(l.label).toBe('Rojo · 42');
  });
  it('own name is the selected value of every row', () => {
    expect(ownLabel(selfEntries, 'B0SELF0001')).toEqual({ label: 'Negro · 42', dim: 'color_name' });
    expect(ownLabel([], 'B0SELF0001')).toBeNull();
  });
  it('a single-row twister keeps the plain label', () => {
    const [l] = variantLabels([{ asin: 'B0AAAAAAA2', label: '43', dim: 'size_name' }], [{ asin: 'B0SELF0001', label: '42', dim: 'size_name', self: true }]);
    expect(l.label).toBe('43');
  });
});

describe('buildSelector', () => {
  const info: Record<string, Partial<CatalogInfo>> = {
    B0SIZE0043: { price: 59.9, available: true, followed: true, inCatalog: true },
    B0SIZE0042: { price: 54.99, available: true, followed: false, inCatalog: true },
    B0SIZE0100: { price: null, available: null, followed: false, inCatalog: false },
    B0COLOR001: { price: 70, available: true, followed: false, inCatalog: true },
  };
  const lookup = (a: string): CatalogInfo => ({ price: null, available: null, followed: false, inCatalog: false, ...info[a] });

  it('builds one row per selector row, colour before size, sizes in natural order, current highlighted', () => {
    const rows = buildSelector([
      { asin: 'B0SELF0001', label: 'Negro', dim: 'color_name', self: true },
      { asin: 'B0SELF0001', label: '42', dim: 'size_name', self: true },
      { asin: 'B0COLOR001', label: 'Rojo', dim: 'color_name' },
      { asin: 'B0SIZE0100', label: '100', dim: 'size_name' },
      { asin: 'B0SIZE0043', label: '43', dim: 'size_name' },
      { asin: 'B0SIZE0042', label: '9', dim: 'size_name' },
    ], 'B0SELF0001', lookup, null)!;
    expect(rows.map(r => r.title)).toEqual(['Color', 'Talla']);
    expect(rows[1].options.map(o => o.label)).toEqual(['9', '42', '43', '100']);       // numeric order, not "100" before "42"
    expect(rows[1].options.find(o => o.current)!.asin).toBe('B0SELF0001');
    const o43 = rows[1].options.find(o => o.label === '43')!;
    expect(o43).toMatchObject({ price: 59.9, followed: true, available: true });
    expect(rows[1].options.find(o => o.label === '100')).toMatchObject({ inCatalog: false, available: false });
  });

  it('old untagged data becomes a single row and the current option is added', () => {
    const rows = buildSelector([{ asin: 'B0SIZE0043', label: '43' }, { asin: 'B0SIZE0042', label: '42' }], 'B0SELF0001', lookup, '41 EU')!;
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Talla');
    expect(rows[0].options.find(o => o.current)!.label).toBe('41 EU');
  });

  it('nothing to choose → null', () => {
    expect(buildSelector([], 'B0SELF0001', lookup, null)).toBeNull();
    expect(buildSelector([{ asin: 'B0SELF0001', label: 'Negro', dim: 'color_name', self: true }], 'B0SELF0001', lookup, null)).toBeNull();
  });
});

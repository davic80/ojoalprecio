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

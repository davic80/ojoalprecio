import { describe, it, expect } from 'vitest';
import { cleanVariantLabel, parseThreshold } from '../src/lib/variants';

describe('cleanVariantLabel', () => {
  it('drops the CSS comment garbage Amazon swatches carry', () => {
    expect(cleanVariantLabel('2TB        \t\t/* Temporary CSS overrides for the twister */ .a-x { }')).toBe('2TB');
    expect(cleanVariantLabel('10G Negro/Plateado        \t\t/* Temporary')).toBe('10G Negro/Plateado');
    expect(cleanVariantLabel('GW1210: WS90+GW1200 Gateway   /* ')).toBe('GW1210: WS90+GW1200 Gateway');
  });
  it('keeps clean labels, collapses whitespace, bounds length, has a fallback', () => {
    expect(cleanVariantLabel('Café   Piel prémium')).toBe('Café Piel prémium');
    expect(cleanVariantLabel('x'.repeat(100)).length).toBeLessThanOrEqual(58);
    expect(cleanVariantLabel('')).toBe('Opción');
    expect(cleanVariantLabel(null)).toBe('Opción');
    expect(cleanVariantLabel('/* solo basura */', 'Opción X')).toBe('Opción X');
  });
});

describe('parseThreshold', () => {
  it('accepts Spanish and English price formats', () => {
    expect(parseThreshold('29,99')).toBe(29.99);
    expect(parseThreshold('29.99')).toBe(29.99);
    expect(parseThreshold(' 30 € ')).toBe(30);
    expect(parseThreshold('1.299,50')).toBe(1299.5);
    expect(parseThreshold('1,299.50')).toBe(1299.5);
    expect(parseThreshold(45)).toBe(45);
  });
  it('rejects empty, zero, negative, absurd and non-numeric input', () => {
    for (const bad of ['', '   ', '0', '0,00', '-5', 'abc', '12abc', '1e3', '100000,01', '1,2,3', null, undefined, '12.345', '5,'])
      expect(parseThreshold(bad as any)).toBeNull();
  });
});

import { optionDisplayName } from '../src/lib/variants';

describe('optionDisplayName', () => {
  it('appends the option so two sizes of one article differ', () => {
    expect(optionDisplayName('Puma St Runner NL', 'Lona Azul · 43 EU')).toBe('Puma St Runner NL — Lona Azul · 43 EU');
  });
  it('leaves the name alone when there is no option or it is already in the name', () => {
    expect(optionDisplayName('Puma St Runner NL', null)).toBe('Puma St Runner NL');
    expect(optionDisplayName('Puma St Runner NL', '  ')).toBe('Puma St Runner NL');
    expect(optionDisplayName('Puma St Runner NL negro', 'Negro')).toBe('Puma St Runner NL negro');
  });
});

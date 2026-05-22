import { describe, it, expect } from 'vitest';
import { tokenize, extractBrandModel, textSimilarity } from '../src/marketplaces/aliexpress/text';

describe('tokenize', () => {
  it('lowercases + strips diacritics', () => {
    expect(tokenize('Cámara Acción')).toEqual(['camara', 'accion']);
  });

  it('preserves alphanumeric model codes including hyphens', () => {
    expect(tokenize('Baofeng BF-88E walkie')).toEqual(['baofeng', 'bf-88e', 'walkie']);
  });

  it('drops short tokens (<2 chars)', () => {
    expect(tokenize('A b c d 12')).toEqual(['12']);
  });

  it('drops Spanish/English/AE stopwords', () => {
    const out = tokenize('Cámara de acción Original 4K con envío gratis para deportes');
    expect(out).not.toContain('de');
    expect(out).not.toContain('con');
    expect(out).not.toContain('para');
    expect(out).not.toContain('original');     // AE stopword
    expect(out).not.toContain('envio');         // AE stopword
    expect(out).not.toContain('gratis');        // AE stopword
    expect(out).toContain('camara');
    expect(out).toContain('accion');
    expect(out).toContain('4k');
    expect(out).toContain('deportes');
  });

  it('returns empty array on empty/falsy input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null as unknown as string)).toEqual([]);
  });
});

describe('extractBrandModel', () => {
  it('picks the first 4 non-stopword tokens of a verbose AE title', () => {
    const title = 'Baofeng BF-88E Pro Walkie Talkie frecuencia de copia inalámbrica';
    // "pro" is an AE stopword → skipped. So picked = Baofeng, BF-88E, Walkie, Talkie
    expect(extractBrandModel(title)).toBe('Baofeng BF-88E Walkie Talkie');
  });

  it('preserves original case (important for branded search)', () => {
    expect(extractBrandModel('Sonos Era 100 altavoz inalámbrico')).toBe('Sonos Era 100 altavoz');
  });

  it('honours custom maxWords', () => {
    expect(extractBrandModel('Sonos Era 100 altavoz inalámbrico portátil', 2)).toBe('Sonos Era');
  });

  it('returns empty string on empty title', () => {
    expect(extractBrandModel('')).toBe('');
  });

  it('skips diacritic-only / pure-punctuation tokens', () => {
    expect(extractBrandModel('—  ¡¡  Sonos Era 100  !!')).toBe('Sonos Era 100');
  });
});

describe('textSimilarity (Jaccard)', () => {
  it('returns 1 for identical titles', () => {
    const s = textSimilarity('Baofeng BF-88E walkie talkie', 'Baofeng BF-88E walkie talkie');
    expect(s).toBeCloseTo(1, 2);
  });

  it('returns 0 for fully disjoint titles', () => {
    const s = textSimilarity('Sonos Era 100 altavoz', 'Pelota fútbol Adidas 5');
    expect(s).toBe(0);
  });

  it('scores partial overlap proportionally', () => {
    // Same brand + same product type, different model → moderate score
    const s = textSimilarity('Baofeng BF-88E walkie talkie', 'Baofeng UV-5R walkie talkie');
    // tokens: {baofeng, bf-88e, walkie, talkie} vs {baofeng, uv-5r, walkie, talkie}
    // intersection: {baofeng, walkie, talkie} = 3; union = 5 → 0.6
    expect(s).toBeCloseTo(0.6, 2);
  });

  it('penalises generic vs specific matches', () => {
    const specific = textSimilarity('Sonos Era 100 altavoz', 'Sonos Era 100 altavoz wifi');
    const generic  = textSimilarity('Sonos Era 100 altavoz', 'Sonos Move altavoz');
    expect(specific).toBeGreaterThan(generic);
  });

  it('is symmetric', () => {
    const a = textSimilarity('Sonos Era 100 altavoz', 'Sonos Era 200 altavoz pro');
    const b = textSimilarity('Sonos Era 200 altavoz pro', 'Sonos Era 100 altavoz');
    expect(a).toBeCloseTo(b, 5);
  });

  it('handles empty titles gracefully', () => {
    expect(textSimilarity('', 'anything')).toBe(0);
    expect(textSimilarity('anything', '')).toBe(0);
    expect(textSimilarity('', '')).toBe(0);
  });

  it('lifts short-vs-long matches above raw jaccard (Amazon vs verbose AE)', () => {
    // Real-world shape: Amazon's short branded title vs an AE listing that
    // stuffs the same brand+model inside a marketing-tail string.
    const amazon = 'Sonos Era 100 altavoz';
    const ae     = 'Original Sonos Era 100 altavoz inteligente bluetooth wifi 2025 venta hogar';
    const score = textSimilarity(amazon, ae);
    // Pure jaccard would have been ~0.25-0.30 (intersection 4 / union 10ish).
    // With the min-coverage boost it lands well above 0.30.
    expect(score).toBeGreaterThanOrEqual(0.55);
  });

  it('does NOT boost single-token overlaps (generic noise stays low)', () => {
    // "Cable" alone must not pull AE noise above the eligibility threshold.
    const amazon = 'Cable USB';
    const ae     = 'Cable HDMI 4K alta velocidad oro';
    expect(textSimilarity(amazon, ae)).toBeLessThan(0.30);
  });
});

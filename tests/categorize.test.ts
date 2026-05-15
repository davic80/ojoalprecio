import { describe, it, expect } from 'vitest';
import { autoCategorizeSlug } from '../src/scraper/categorize';

describe('autoCategorizeSlug', () => {
  it('returns null for empty / null input', () => {
    expect(autoCategorizeSlug('')).toBeNull();
    expect(autoCategorizeSlug(null)).toBeNull();
    expect(autoCategorizeSlug(undefined)).toBeNull();
  });

  it('classifies Kindle products', () => {
    expect(autoCategorizeSlug('Kindle Paperwhite 16 GB')).toBe('kindle');
    expect(autoCategorizeSlug('Amazon Kindle Scribe')).toBe('kindle');
  });

  it('classifies pool products', () => {
    expect(autoCategorizeSlug('Limpiafondos para piscina')).toBe('piscina');
    expect(autoCategorizeSlug('Cloro choque líquido')).toBe('piscina');
  });

  it('classifies videogames', () => {
    expect(autoCategorizeSlug('PlayStation 5 Spider-Man Miles Morales')).toBe('videojuegos');
    expect(autoCategorizeSlug('Mario Kart 8 Deluxe Nintendo Switch')).toBe('videojuegos');
    expect(autoCategorizeSlug('Xbox Wireless Controller')).toBe('videojuegos');
  });

  it('classifies audio products', () => {
    expect(autoCategorizeSlug('Sonos Beam Gen 2')).toBe('audio');
    expect(autoCategorizeSlug('Auriculares Bluetooth')).toBe('audio');
    expect(autoCategorizeSlug('AirPods Pro 2')).toBe('audio');
    expect(autoCategorizeSlug('Marshall Wilburn II auriculares')).toBe('audio');
  });

  it('classifies Apple computing as informatica', () => {
    expect(autoCategorizeSlug('Apple iPad de 11 Pulgadas')).toBe('informatica');
    expect(autoCategorizeSlug('Apple MacBook Pro')).toBe('informatica');
    expect(autoCategorizeSlug('Apple Magic Mouse')).toBe('informatica');
  });

  it('classifies wearables as electronica', () => {
    expect(autoCategorizeSlug('Apple Watch Series 11')).toBe('electronica');
    expect(autoCategorizeSlug('iPhone 17 Pro')).toBe('electronica');
    expect(autoCategorizeSlug('Google Pixel 10a')).toBe('electronica');
    expect(autoCategorizeSlug('Fitbit Air pulsera de actividad')).toBe('electronica');
  });

  it('classifies foto products', () => {
    expect(autoCategorizeSlug('Sony Alpha 7 IV cámara mirrorless')).toBe('foto');
    expect(autoCategorizeSlug('Fujifilm Instax Mini 12')).toBe('foto');
  });

  it('classifies automoción products', () => {
    expect(autoCategorizeSlug('Parasol coche universal')).toBe('automocion');
    expect(autoCategorizeSlug('Valeo bombilla H7 coche')).toBe('automocion');
  });

  it('classifies hogar y cocina', () => {
    expect(autoCategorizeSlug('Freidora de aire')).toBe('hogar-y-cocina');
    expect(autoCategorizeSlug('Lavadora Bosch 8 kg')).toBe('hogar-y-cocina');
  });

  it('classifies juguetes', () => {
    expect(autoCategorizeSlug('LEGO Speed Champions')).toBe('juguetes');
    expect(autoCategorizeSlug('Funko Pop Star Wars')).toBe('juguetes');
  });

  it('classifies bebé', () => {
    expect(autoCategorizeSlug('Pañal Dodot bebé talla 4')).toBe('bebe');
    expect(autoCategorizeSlug('Maxi-cosi silla coche bebé')).toBe('bebe');
  });

  it('classifies deporte', () => {
    expect(autoCategorizeSlug('Venum Challenger protector bucal')).toBe('deporte');
    expect(autoCategorizeSlug('Mancuernas ajustables')).toBe('deporte');
  });

  it('returns null for unmatched product names', () => {
    expect(autoCategorizeSlug('Algo random sin reglas asociadas')).toBeNull();
  });

  it('most-specific rule wins (Kindle before generic Informática)', () => {
    // Kindle dispositivo should hit kindle slug, not informatica
    expect(autoCategorizeSlug('Kindle Paperwhite con publicidad')).toBe('kindle');
  });

  it('handles accents by stripping them', () => {
    // "automocion" rule has /automovil/ pattern (no accent in regex)
    expect(autoCategorizeSlug('Aceite motor Castrol para automóvil')).toBe('automocion');
  });
});

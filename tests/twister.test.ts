import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { extractTwister } from '../src/scraper/twister';

// Structure copied from a real amazon.es page (colour swatches in twister-plus + size dropdown).
const NEW_LAYOUT = `
<div id="twister_feature_div"><div id="inline-twister-row-color_name"><div id="inline-twister-expander-content-color_name">
  <ul id="tp-inline-twister-dim-values-container">
    <li data-asin="B0DJC3WYTP" class="dimension-value-list-item-square-image"><img alt="Lona Azul Persa Puma Blanca"></li>
    <li data-asin="B097C7T48V" class="dimension-value-list-item-square-image"><img alt="Black White"></li>
    <li data-asin="B077MLYRVN" class="dimension-value-list-item-square-image swatch-disabled"><img alt="V2 Black White"></li>
  </ul></div></div>
  <div id="variation_size_name"><select id="native_dropdown_selected_size_name">
    <option value="-1" class="">Seleccionar</option>
    <option value="0,B0FTNXVGYK" class="dropdownUnavailable">35.5 EU</option>
    <option value="7,B077MLYRVN" class="dropdownUnavailable">39 EU</option>
    <option value="11,B097C25256" class="dropdownAvailable">42 EU</option>
    <option value="13,B0DJC3WYTP" class="dropdownSelect" selected>43 EU</option>
  </select></div></div>
<div id="related"><ul><li data-asin="B0RELATED1"><span>carousel item</span></li></ul></div>`;

const OLD_LAYOUT = `
<div id="variation_size_name"><ul><li data-defaultasin="B0AAAAAAA2"><span>43</span></li><li data-defaultasin="B0AAAAAAA1" class="swatchSelect"><span>42</span></li></ul></div>`;

let browser: Browser | null = null;
let page: Page;
beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined });
    page = await browser.newPage();
  } catch { browser = null; }
}, 30_000);
afterAll(async () => { await browser?.close(); });

const run = async (html: string, selfAsin: string) => { await page.setContent(html); return page.evaluate(extractTwister, selfAsin); };

describe('extractTwister (needs a local Chromium; skipped otherwise)', () => {
  it('reads colour swatches and the size dropdown, flags the page\'s own options', async (ctx) => {
    if (!browser) return ctx.skip();
    const v = await run(NEW_LAYOUT, 'B0DJC3WYTP');
    const self = v.filter(x => x.self);
    expect(self.map(x => `${x.dim}:${x.label}`).sort()).toEqual(['color_name:Lona Azul Persa Puma Blanca', 'size_name:43 EU']);
    expect(v.filter(x => x.dim === 'color_name' && !x.self).map(x => x.asin)).toEqual(['B097C7T48V', 'B077MLYRVN']);
    expect(v.find(x => x.asin === 'B097C25256')).toMatchObject({ dim: 'size_name', label: '42 EU', selectable: true });
    expect(v.find(x => x.asin === 'B0FTNXVGYK')).toMatchObject({ dim: 'size_name', selectable: false });
    expect(v.some(x => x.asin === 'B0RELATED1' && x.dim)).toBe(false);     // untagged carousel item has no row
  });

  it('keeps an ASIN that Amazon reuses in two rows (colour AND size) once per row', async (ctx) => {
    if (!browser) return ctx.skip();
    const v = await run(NEW_LAYOUT, 'B0DJC3WYTP');
    expect(v.filter(x => x.asin === 'B077MLYRVN').map(x => x.dim).sort()).toEqual(['color_name', 'size_name']);
  });

  it('still reads the old variation_ layout', async (ctx) => {
    if (!browser) return ctx.skip();
    const v = await run(OLD_LAYOUT, 'B0AAAAAAA1');
    expect(v.find(x => x.self)).toMatchObject({ asin: 'B0AAAAAAA1', dim: 'size_name' });
    expect(v.find(x => x.asin === 'B0AAAAAAA2')).toMatchObject({ dim: 'size_name', label: '43' });
  });
});

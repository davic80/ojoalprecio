// Reads Amazon's option selector ("twister") of a product page. The function runs INSIDE the browser
// (page.evaluate), so it must stay self-contained: no imports, no references to outer variables.
//
// Amazon serves two layouts and a product can mix them:
//   * colour / style swatches   <li data-asin> inside  #inline-twister-row-<dim>  (new)  or  #variation_<dim>  (old)
//   * sizes as a dropdown       <select id="native_dropdown_selected_size_name"> whose <option value="3,B0XXXXXXXX">
//     carries the ASIN of that size (same colour). The selected <option> is this very page's size.
import type { VariantRef } from './amazon';

export function extractTwister(selfAsin: string): VariantRef[] {
  const out = new Map<string, VariantRef>();
  const rowDim = (el: Element): string | undefined => {
    const row = el.closest('[id^="inline-twister-row-"], [id^="variation_"]');
    return row && row.id ? row.id.replace(/^(inline-twister-row-|variation_)/, '').slice(0, 30) : undefined;
  };

  document.querySelectorAll('li[data-defaultasin], li[data-asin]').forEach((li) => {
    const asin = li.getAttribute('data-defaultasin') || li.getAttribute('data-asin') || '';
    if (!/^[A-Z0-9]{10}$/.test(asin)) return;
    const isSelf = asin === selfAsin;
    const dim = rowDim(li);
    // One entry per ASIN per selector row (Amazon sometimes reuses an ASIN in two rows, e.g. a colour and a size).
    const key = asin + '|' + (dim || '');
    if (out.has(key)) return;
    const label = (li.querySelector('img')?.getAttribute('alt')?.trim() || li.textContent?.trim().slice(0, 40) || '');
    const selectable = !li.classList.contains('swatch-disabled') && !li.classList.contains('a-button-disabled');
    out.set(key, { asin, label, selectable, ...(dim ? { dim } : {}), ...(isSelf ? { self: true } : {}) });
  });

  document.querySelectorAll('select[id^="native_dropdown_selected_"]').forEach((sel) => {
    const dim = sel.id.replace('native_dropdown_selected_', '').slice(0, 30);
    Array.from((sel as HTMLSelectElement).options).forEach((opt) => {
      const m = /^\d+,([A-Z0-9]{10})$/.exec(opt.value);
      const label = (opt.text || '').replace(/\s+/g, ' ').trim();
      if (!m || !label) return;
      const selectable = !opt.disabled && !/unavailable/i.test(opt.className || '');
      if (opt.selected || m[1] === selfAsin) {
        const key = selfAsin + '|' + dim;
        if (!out.has(key)) out.set(key, { asin: selfAsin, label, selectable, dim, self: true });
      } else if (!out.has(m[1] + '|' + dim)) {
        out.set(m[1] + '|' + dim, { asin: m[1], label, selectable, dim });
      }
    });
  });

  return [...out.values()];
}

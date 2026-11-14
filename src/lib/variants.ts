// Helpers for the "choose your option and price" flow. Pure so they can be unit-tested.

/**
 * Variant labels come from the page's swatches (`li.textContent`) and often carry CSS pasted
 * after the real text, e.g. "2TB        \t\t/* Temporary CSS overrides ...". Keep only the text
 * before the first comment marker, collapse whitespace, bound the length.
 */
export function cleanVariantLabel(raw: string | null | undefined, fallback = 'Opción'): string {
  let s = (raw ?? '').replace(/\/\*[\s\S]*$/, '').replace(/\s+/g, ' ').trim();
  if (!s) return fallback;
  if (s.length > 60) s = s.slice(0, 57).trimEnd() + '…';
  return s;
}

/** Target price typed by a user ("29,99", "29.99", "1.299,50"). null when not a sane positive price. */
export function parseThreshold(raw: unknown): number | null {
  let s = String(raw ?? '').trim().replace(/\s|€/g, '');
  if (!s) return null;
  // "1.299,50" → "1299.50"; "29,99" → "29.99"; "1,299.50" → "1299.50"
  if (s.includes(',') && s.includes('.')) {
    s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const n = parseFloat(s);
  return n >= 0.01 && n <= 100_000 ? Math.round(n * 100) / 100 : null;
}

/**
 * Name to show in alerts: the article plus the option the alert is about ("… — Lona Azul · 43 EU"), so two
 * alerts for two sizes of the same article can be told apart. Unchanged when there is no option name.
 */
export function optionDisplayName(name: string, optionLabel: string | null | undefined): string {
  const label = (optionLabel ?? '').trim();
  if (!label || name.toLowerCase().includes(label.toLowerCase())) return name;
  return `${name} — ${label}`;
}

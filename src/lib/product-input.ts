// What the "add product" box accepts besides a full URL: a bare identifier.
//   Amazon ASIN       "B0DJC3WYTP" (B + 9 letters/digits) or a book ISBN-10 ("8408163450", last char may be X)
//   AliExpress id     11-16 digits  ("1005006123456789")
// The two never collide: an ASIN has letters (or exactly 10 characters), an AliExpress id is a longer number.
export type BareProduct = { kind: 'amazon'; asin: string } | { kind: 'aliexpress'; id: string };

export function parseBareProductId(input: string | null | undefined): BareProduct | null {
  if (!input) return null;
  // Tolerate a label and quotes/whitespace around it: "ASIN: B0DJC3WYTP", ' B0DJC3WYTP '.
  const t = input.trim().replace(/^(?:asin|id)\s*[:=#-]?\s*/i, '').replace(/^["'`]+|["'`]+$/g, '').trim().toUpperCase();
  if (/^B[0-9A-Z]{9}$/.test(t) || /^\d{9}[\dX]$/.test(t)) return { kind: 'amazon', asin: t };
  if (/^\d{11,16}$/.test(t)) return { kind: 'aliexpress', id: t };
  return null;
}

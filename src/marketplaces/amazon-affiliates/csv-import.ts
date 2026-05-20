import { parse } from 'csv-parse/sync';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client';

/**
 * Parser + importer for Amazon Affiliates CSV reports.
 *
 * Amazon Associates exposes several report flavours from
 * afiliados.amazon.es (Earnings, Orders, Fee-Earnings, Bounty, etc.).
 * Each has its own column set but they all share a few key fields we
 * care about: a date, a tracking id, optional ASIN, earnings/commission,
 * optional click/order counts.
 *
 * This module sniffs the header row, maps known column synonyms (ES + EN
 * + a few EU locales) into a uniform shape, and UPSERTs into
 * amazon_affiliate_stats. The composite PK (tracking_id, asin, day) plus
 * ON CONFLICT DO UPDATE means re-uploading an overlapping period keeps
 * the most-recent numbers (Amazon revises rows after the fact for
 * returns + adjustments).
 *
 * Aggregate-only rows (no ASIN column) are stored with asin = '*' so the
 * PK still bites.
 */

const COLUMN_SYNONYMS: Record<string, string[]> = {
  day: [
    'date', 'day', 'fecha', 'día', 'dia', 'date shipped', 'fecha de envío',
    'fecha de envio', 'order date', 'fecha del pedido',
  ],
  trackingId: [
    'tracking id', 'tracking', 'trackingid', 'tracking_id',
    'identificador de seguimiento', 'id de seguimiento', 'id seguimiento',
  ],
  asin: ['asin', 'product id', 'item id', 'sku'],
  earnings: [
    'earnings', 'bounty earnings', 'comisión', 'comision',
    'comisiones', 'comisiones por publicidad', 'ad fees',
    'tarifas de publicidad', 'total earnings', 'revenue',
    'commission', 'ganancias', 'ingresos',
  ],
  currency: ['currency', 'moneda', 'divisa', 'currency code'],
  clicks: ['clicks', 'clicks (sin filtro)', 'clics', 'click count'],
  itemsOrdered: [
    'items ordered', 'qty ordered', 'productos comprados',
    'unidades pedidas', 'qty', 'quantity ordered', 'units ordered',
  ],
  itemsReturned: [
    'items returned', 'qty returned', 'devoluciones',
    'productos devueltos', 'returned items',
  ],
};

interface ParsedRow {
  trackingId:    string;
  asin:          string;        // '*' if aggregate
  day:           string;        // ISO YYYY-MM-DD
  earnings:      number | null;
  currency:      string | null;
  clicks:        number | null;
  itemsOrdered:  number | null;
  itemsReturned: number | null;
  raw:           Record<string, unknown>;
}

export interface ImportSummary {
  imported:    number;
  updated:     number;     // rows that hit ON CONFLICT — overlapped a previous upload
  skipped:     number;     // rows that didn't parse (bad date / missing tracking)
  daysCovered: string[];   // sorted unique day list, useful for the UI summary
  errors:      string[];   // first 5 row-level errors
}

/** Normalises a header label so synonyms match: lowercase + strip BOM, accents, parens, extra spaces. */
function normHeader(s: string): string {
  return s
    .replace(/^﻿/, '')
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, '')   // drop "(EUR)" etc.
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build a header→field-key map by walking synonyms. */
function buildHeaderMap(headers: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const h of headers) {
    const norm = normHeader(h);
    for (const [field, syns] of Object.entries(COLUMN_SYNONYMS)) {
      if (syns.some(s => normHeader(s) === norm)) {
        map[h] = field;
        break;
      }
    }
  }
  return map;
}

/** Parse a single date cell into ISO YYYY-MM-DD, or null on failure. */
function parseDate(raw: string): string | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // ISO already
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // DD/MM/YYYY or DD-MM-YYYY (es-ES default in many Amazon EU exports)
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);
  if (m) {
    const dd = m[1].padStart(2, '0');
    const mm = m[2].padStart(2, '0');
    return `${m[3]}-${mm}-${dd}`;
  }
  // YYYY/MM/DD
  m = s.match(/^(\d{4})[\/.](\d{1,2})[\/.](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  // Last resort — let Date constructor try, but only accept reasonable years
  const d = new Date(s);
  if (!isNaN(d.getTime()) && d.getFullYear() >= 2015 && d.getFullYear() <= 2100) {
    return d.toISOString().slice(0, 10);
  }
  return null;
}

/** Parse "1.234,56" (es) or "1,234.56" (en) or "12.34" or "12,34" into a Number. */
function parseDecimal(raw: unknown): number | null {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // Strip currency symbols + spaces
  s = s.replace(/[€$£\s]/g, '');
  // Heuristic: if both ',' and '.' present, the rightmost is the decimal mark
  const lastComma = s.lastIndexOf(',');
  const lastDot   = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) {
      // es-style "1.234,56"
      s = s.replace(/\./g, '').replace(',', '.');
    } else {
      // en-style "1,234.56"
      s = s.replace(/,/g, '');
    }
  } else if (lastComma > -1) {
    // Only commas — assume comma is the decimal mark (es)
    s = s.replace(',', '.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function parseInteger(raw: unknown): number | null {
  if (raw == null) return null;
  const s = String(raw).replace(/[.,\s]/g, '');
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a CSV blob into an array of normalised rows. Doesn't touch the DB.
 * Returns rows + per-row errors so the caller can surface a summary.
 */
export function parseAmazonCsv(csv: string): { rows: ParsedRow[]; errors: string[]; headerMap: Record<string, string> } {
  // csv-parse's `delimiter: array` treats each item as a valid separator
  // SIMULTANEOUSLY (so a ',' inside a ';'-delimited row breaks the parse).
  // We need to sniff the actual delimiter from the header line ourselves.
  // Strip BOM first so it doesn't bias the count.
  const cleanCsv = csv.replace(/^﻿/, '');
  const firstLine = cleanCsv.split(/\r?\n/, 1)[0] ?? '';
  const counts: Record<string, number> = {
    ',':  (firstLine.match(/,/g)  ?? []).length,
    ';':  (firstLine.match(/;/g)  ?? []).length,
    '\t': (firstLine.match(/\t/g) ?? []).length,
  };
  // Most-frequent character in the header line wins, fallback ','
  const delimiter = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || ',';

  const records = parse(cleanCsv, {
    bom:           true,
    columns:       true,
    skip_empty_lines: true,
    relax_quotes:  true,
    trim:          true,
    delimiter,
  }) as Record<string, string>[];

  if (records.length === 0) return { rows: [], errors: ['CSV vacío o cabecera no detectada.'], headerMap: {} };

  const headerMap = buildHeaderMap(Object.keys(records[0]));
  // Tracking ID is OPTIONAL — Amazon omits the column on single-tracking
  // exports (and on aggregate reports like Categories or Linked-Product
  // totals). When missing we attribute everything to a 'default' sentinel
  // so the composite PK still bites and re-uploads UPSERT correctly.
  // Date is the only truly required column — without it nothing can be
  // keyed.
  if (!Object.values(headerMap).includes('day')) {
    return {
      rows: [],
      errors: [
        `No encuentro la columna de fecha (Date / Fecha / Día). Cabeceras detectadas: ${Object.keys(records[0]).join(' | ')}`,
      ],
      headerMap,
    };
  }

  const rows: ParsedRow[] = [];
  const errors: string[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const get = (field: string): string | undefined => {
      for (const [h, f] of Object.entries(headerMap)) {
        if (f === field) return r[h];
      }
      return undefined;
    };

    const day = parseDate(get('day') ?? '');
    if (!day) {
      if (errors.length < 5) errors.push(`Fila ${i + 2}: falta fecha (${JSON.stringify(r).slice(0, 100)}…)`);
      continue;
    }
    // Tracking ID falls back to 'default' when missing — see header check above.
    const trackingId = String(get('trackingId') ?? '').trim() || 'default';

    // Amazon's Linked-Product Total row uses the string 'others' as a
    // placeholder in the ASIN column for the aggregate sum line. Map it
    // to our '*' sentinel so the PK stays distinct from real ASINs.
    let asinRaw = String(get('asin') ?? '').trim().toUpperCase();
    if (!asinRaw || asinRaw === 'OTHERS' || asinRaw === 'OTROS' || asinRaw === '-') asinRaw = '*';
    const asin = asinRaw;

    rows.push({
      trackingId,
      asin,
      day,
      earnings:      parseDecimal(get('earnings')),
      currency:      (get('currency') ?? 'EUR').toUpperCase() || null,
      clicks:        parseInteger(get('clicks')),
      itemsOrdered:  parseInteger(get('itemsOrdered')),
      itemsReturned: parseInteger(get('itemsReturned')),
      raw:           r,
    });
  }

  return { rows, errors, headerMap };
}

/** Upsert parsed rows into amazon_affiliate_stats, returning a summary. */
export async function importAmazonCsv(csv: string): Promise<ImportSummary> {
  const parsed = parseAmazonCsv(csv);
  const summary: ImportSummary = {
    imported: 0,
    updated:  0,
    skipped:  0,
    daysCovered: [],
    errors:   parsed.errors,
  };
  if (parsed.rows.length === 0) return summary;

  const daysSet = new Set<string>();

  // Upsert in a single transaction. ON CONFLICT returns the (xmax = 0) trick to
  // detect inserts vs updates so we can give the admin a meaningful summary.
  await db.transaction(async (tx) => {
    for (const r of parsed.rows) {
      try {
        const result = await tx.execute(sql`
          INSERT INTO amazon_affiliate_stats (
            tracking_id, asin, day,
            clicks, items_ordered, items_returned,
            earnings, currency, raw_row, uploaded_at
          ) VALUES (
            ${r.trackingId}, ${r.asin}, ${r.day},
            ${r.clicks}, ${r.itemsOrdered}, ${r.itemsReturned},
            ${r.earnings}, ${r.currency}, ${JSON.stringify(r.raw)}::jsonb, NOW()
          )
          ON CONFLICT (tracking_id, asin, day) DO UPDATE SET
            clicks         = EXCLUDED.clicks,
            items_ordered  = EXCLUDED.items_ordered,
            items_returned = EXCLUDED.items_returned,
            earnings       = EXCLUDED.earnings,
            currency       = EXCLUDED.currency,
            raw_row        = EXCLUDED.raw_row,
            uploaded_at    = NOW()
          RETURNING (xmax = 0) AS inserted
        `);
        const inserted = (result.rows[0] as any)?.inserted === true;
        if (inserted) summary.imported++; else summary.updated++;
        daysSet.add(r.day);
      } catch (err) {
        summary.skipped++;
        if (summary.errors.length < 5) summary.errors.push(`DB: ${(err as Error).message.slice(0, 140)}`);
      }
    }
  });

  summary.daysCovered = [...daysSet].sort();
  return summary;
}

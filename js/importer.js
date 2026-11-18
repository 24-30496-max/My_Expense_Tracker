// Turns a spreadsheet grid (array of rows) into expense rows ready to save.
// Pure functions: the browser reads the file with SheetJS and passes the grid in.
import { toCents } from './money.js';

export const STATUSES = ['needed', 'ordered', 'received', 'used'];

const FIELD_PATTERNS = {
  name: /^(item|items|name|component|components|description|particulars|product|materials?)$/i,
  price: /^(price|unit price|cost|amount|total|php|₱)$/i,
  qty: /^(qty|quantity|pcs|count)$/i,
  date: /^(date|purchased|bought|purchase date)$/i,
  category: /^(category|type)$/i,
  paid_by: /^(paid by|payer|bought by|paid)$/i,
  store: /^(store|shop|seller|vendor|store we bought)$/i,
  status: /^(status)$/i,
  notes: /^(notes?|remarks?|comments?)$/i,
};

export function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const cellText = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** The first row (within the top 15) that looks like a header. */
export function detectHeaderRow(grid) {
  const limit = Math.min(grid.length, 15);
  for (let r = 0; r < limit; r++) {
    const hits = (grid[r] || []).filter((c) => Object.values(FIELD_PATTERNS).some((p) => p.test(cellText(c)))).length;
    if (hits >= 2) return r;
  }
  return 0;
}

/** Every non-empty header cell, as a choice for the mapping dropdowns. */
export function columnOptions(grid, headerRow) {
  const header = grid[headerRow] || [];
  const width = Math.max(header.length, ...grid.slice(headerRow, headerRow + 50).map((r) => (r || []).length), 0);
  const out = [];
  for (let i = 0; i < width; i++) {
    const label = cellText(header[i]);
    const hasData = grid.slice(headerRow + 1).some((r) => cellText((r || [])[i]) !== '');
    if (label || hasData) out.push({ index: i, letter: colLetter(i), label: label || '(no header)' });
  }
  return out;
}

/** Best guess of which column holds what. Returns {field: columnIndex | null}. */
export function guessMapping(options) {
  const map = {};
  for (const [field, pattern] of Object.entries(FIELD_PATTERNS)) {
    const hit = options.find((o) => pattern.test(o.label));
    map[field] = hit ? hit.index : null;
  }
  // "Materials" is a name column; "Store we bought" must not be taken as a name.
  if (map.name !== null && map.name === map.store) map.store = null;
  return map;
}

/** Excel serial number, ISO date, or common text date -> "YYYY-MM-DD" (or null). */
export function parseDate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000).toISOString().slice(0, 10);
    return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/); // month/day/year (PH/US order)
  if (m) {
    let y = +m[3];
    if (y < 100) y += 2000;
    return iso(y, +m[1], +m[2]);
  }
  const t = Date.parse(`${s} UTC`);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}
function iso(y, mo, d) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * grid: array of rows. mapping: {field: colIndex|null}.
 * defaults: {paid_by, date, category, status}. members: [{id,name,email}].
 * priceMode: 'unit' (price is per piece) or 'total' (price is the whole line).
 */
export function buildRows({ grid, headerRow, mapping, defaults, members, categories = [], priceMode = 'unit' }) {
  const get = (row, field) => (mapping[field] === null || mapping[field] === undefined ? '' : (row || [])[mapping[field]]);
  const rows = [];
  for (let r = headerRow + 1; r < grid.length; r++) {
    const raw = grid[r] || [];
    const name = cellText(get(raw, 'name'));
    const priceRaw = get(raw, 'price');
    const priceText = cellText(priceRaw);
    if (!name && !priceText) continue; // blank row

    const errors = [];
    const warnings = [];
    if (!name) errors.push('Missing item name');

    let cents = toCents(priceRaw);
    if (Number.isNaN(cents)) { errors.push('Price is not a number'); cents = 0; }
    if (cents < 0) { errors.push('Price is negative'); cents = 0; }

    let qty = 1;
    const qtyText = cellText(get(raw, 'qty'));
    if (qtyText !== '') {
      const q = Number(qtyText);
      if (Number.isInteger(q) && q >= 1) qty = q;
      else warnings.push(`Quantity "${qtyText}" ignored, using 1`);
    }

    let unit = cents;
    let fees = 0;
    if (priceMode === 'total' && qty > 1) {
      unit = Math.floor(cents / qty);
      fees = cents - unit * qty; // keeps the line total exact
    }

    let date = parseDate(get(raw, 'date'));
    if (cellText(get(raw, 'date')) !== '' && !date) warnings.push('Date not understood, using default');
    if (!date) date = defaults.date;

    let paid_by = defaults.paid_by;
    const payerText = cellText(get(raw, 'paid_by')).toLowerCase();
    if (payerText) {
      const m = members.find((x) => x.name.toLowerCase() === payerText || x.email.toLowerCase() === payerText)
        || members.find((x) => x.name.toLowerCase().startsWith(payerText) || payerText.startsWith(x.name.toLowerCase()));
      if (m) paid_by = m.id;
      else warnings.push(`Payer "${cellText(get(raw, 'paid_by'))}" not found, using default`);
    }

    let category = defaults.category;
    const catText = cellText(get(raw, 'category'));
    if (catText) {
      const c = categories.find((x) => x.toLowerCase() === catText.toLowerCase());
      if (c) category = c;
      else warnings.push(`Category "${catText}" not in this project, using default`);
    }

    let status = defaults.status;
    const stText = cellText(get(raw, 'status')).toLowerCase();
    if (stText) {
      if (STATUSES.includes(stText)) status = stText;
      else warnings.push(`Status "${stText}" not recognised, using default`);
    }

    rows.push({
      rowNumber: r + 1,
      name, qty, unit_price_cents: unit, fees_cents: fees,
      purchased_on: date, paid_by, category, status,
      store: cellText(get(raw, 'store')) || null,
      notes: cellText(get(raw, 'notes')) || null,
      errors, warnings, duplicate: false,
    });
  }
  return rows;
}

const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
const rowTotal = (x) => x.qty * x.unit_price_cents + x.fees_cents;

/** Flags rows that match an existing expense (same name, same total) or repeat earlier in the file. */
export function markDuplicates(rows, existing) {
  const seen = new Set(existing.filter((e) => !e.deleted_at).map((e) => `${norm(e.name)}|${rowTotal(e)}`));
  for (const row of rows) {
    const key = `${norm(row.name)}|${rowTotal(row)}`;
    if (seen.has(key)) row.duplicate = true;
    seen.add(key);
  }
  return rows;
}

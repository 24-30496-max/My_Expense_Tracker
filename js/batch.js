// Maths and parsing for entering a whole receipt at once. Pure functions (see tests/batch.test.mjs).
import { toCents } from './money.js';

/**
 * Splits `extraCents` (shipping/tax, or a negative discount) across lines in proportion to each
 * line's cost, using largest-remainder rounding so the pieces add up to EXACTLY extraCents.
 * subtotals: array of non-negative line costs in cents. Returns an array of the same length.
 * Throws if there is nothing to spread it over, or a discount is bigger than the items.
 */
export function allocateExtra(subtotals, extraCents) {
  const n = subtotals.length;
  const out = new Array(n).fill(0);
  if (!extraCents) return out;
  const base = subtotals.reduce((s, x) => s + x, 0);
  if (base <= 0) throw new Error('Enter the item prices first, so the difference can be spread across them.');
  const mag = Math.abs(extraCents);
  if (extraCents < 0 && mag > base) throw new Error('The receipt total is lower than zero once the discount is applied. Check the prices and the total.');
  const sign = extraCents < 0 ? -1 : 1;
  const parts = subtotals.map((x, i) => {
    const exact = (mag * x) / base;
    const floor = Math.floor(exact);
    return { i, floor, frac: exact - floor };
  });
  let left = mag - parts.reduce((s, p) => s + p.floor, 0);
  parts.sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const p of parts) {
    out[p.i] = p.floor + (left > 0 ? 1 : 0);
    if (left > 0) left--;
  }
  return out.map((v) => v * sign);
}

/**
 * lines: [{qty, unit_price_cents}]. receiptTotalCents: number or null (not entered).
 * Returns {itemsTotal, grandTotal, extra, fees:[per line], lineTotals:[per line]}.
 */
export function planBatch(lines, receiptTotalCents) {
  const subtotals = lines.map((l) => l.qty * l.unit_price_cents);
  const itemsTotal = subtotals.reduce((s, x) => s + x, 0);
  const hasTotal = receiptTotalCents !== null && receiptTotalCents !== undefined;
  const extra = hasTotal ? receiptTotalCents - itemsTotal : 0;
  const fees = allocateExtra(subtotals, extra);
  const lineTotals = subtotals.map((s, i) => s + fees[i]);
  return { itemsTotal, grandTotal: itemsTotal + extra, extra, fees, lineTotals };
}

/**
 * Turns pasted text, one item per line, into lines.
 *   "ESP32 S3 599"         -> 1 x ESP32 S3 at 599
 *   "Jumper wires x3 45"   -> 3 x Jumper wires at 45 each
 *   "Jumper wires 3x 45"   -> same
 * Prices may carry a peso sign or commas. Returns {lines, problems}.
 */
export function parsePastedLines(text) {
  const lines = [];
  const problems = [];
  String(text).split(/\r?\n/).forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const m = line.match(/(?:₱|php|p)?\s*(\d[\d,]*(?:\.\d+)?)\s*$/i);
    if (!m || m.index === 0 && m[0].trim() === line && !/\D/.test(line.replace(/[.,\s]/g, ''))) {
      problems.push(`Line ${idx + 1} ("${line}") has no item name or price.`);
      return;
    }
    const cents = toCents(m[1]);
    let rest = line.slice(0, m.index).trim();
    let qty = 1;
    const q = rest.match(/(?:^|\s)(?:x\s*(\d+)|(\d+)\s*x)\s*$/i);
    if (q) {
      qty = parseInt(q[1] || q[2], 10);
      rest = rest.slice(0, q.index).trim();
    }
    const name = rest.replace(/[\s,;:|\-–—\t]+$/, '').trim();
    if (!name || Number.isNaN(cents) || qty < 1) {
      problems.push(`Line ${idx + 1} ("${line}") has no item name or price.`);
      return;
    }
    lines.push({ name, qty, unit_price_cents: cents });
  });
  return { lines, problems };
}

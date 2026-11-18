// Money is always stored and calculated as integer centavos. Never floats.

/** "₱1,234.50" / "1234.5" / 1234.5 -> 123450. Returns NaN if it is not a number. */
export function toCents(input) {
  if (input === null || input === undefined) return NaN;
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : NaN;
  const s = String(input).replace(/[^\d.\-]/g, '');
  if (s === '' || s === '-' || s === '.' || s === '-.') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

export function formatMoney(cents, currency = 'PHP') {
  const value = (Number(cents) || 0) / 100;
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** 123450 -> "1234.50" (for form fields and CSV) */
export function centsToPlain(cents) {
  return ((Number(cents) || 0) / 100).toFixed(2);
}

export function expenseTotal(e) {
  return (Number(e.qty) || 1) * (Number(e.unit_price_cents) || 0) + (Number(e.fees_cents) || 0);
}

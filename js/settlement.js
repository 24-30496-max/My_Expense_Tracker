// Equal-split and settlement maths. Pure functions, no browser needed (see tests/).
import { expenseTotal } from './money.js';

export function hashStr(s) {
  let h = 0;
  for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/**
 * Splits totalCents equally between members. Leftover centavos go to members one by one,
 * starting at a position picked from `seed` (the expense id) so no one is always the one rounded up.
 * Guarantee: the shares always add up exactly to totalCents.
 */
export function splitEqual(totalCents, memberIds, seed = '') {
  const ids = [...memberIds].sort();
  const n = ids.length;
  const out = {};
  if (!n) return out;
  const base = Math.trunc(totalCents / n);
  let rem = totalCents - base * n;
  ids.forEach((id) => { out[id] = base; });
  const step = rem >= 0 ? 1 : -1;
  rem = Math.abs(rem);
  const start = hashStr(seed) % n;
  for (let i = 0; i < rem; i++) out[ids[(start + i) % n]] += step;
  return out;
}

/** An expense counts toward spending once it is no longer just "needed" (planned) and is not deleted. */
export function isCounted(e) {
  return !e.deleted_at && e.status !== 'needed';
}

/**
 * balance = paid - fair share + payments sent - payments received.
 * Positive: the group owes this member. Negative: this member owes the group.
 */
export function computeBalances({ members, expenses, payments = [] }) {
  const ids = members.map((m) => m.id);
  const rows = {};
  ids.forEach((id) => { rows[id] = { id, paid: 0, share: 0, sent: 0, received: 0, balance: 0 }; });

  let totalSpent = 0;
  for (const e of expenses) {
    if (!isCounted(e)) continue;
    const total = expenseTotal(e);
    totalSpent += total;
    if (rows[e.paid_by]) rows[e.paid_by].paid += total;
    const shares = splitEqual(total, ids, e.id);
    for (const id of ids) rows[id].share += shares[id];
  }
  for (const p of payments) {
    if (p.deleted_at) continue;
    if (rows[p.from_member]) rows[p.from_member].sent += p.amount_cents;
    if (rows[p.to_member]) rows[p.to_member].received += p.amount_cents;
  }
  for (const id of ids) {
    const r = rows[id];
    r.balance = r.paid - r.share + r.sent - r.received;
  }
  return { rows, totalSpent };
}

/** Fewest payments that settle everyone (largest debtor pays largest creditor first). */
export function suggestSettlements(rows) {
  const list = Object.values(rows);
  const creditors = list.filter((r) => r.balance > 0).map((r) => ({ id: r.id, amt: r.balance }));
  const debtors = list.filter((r) => r.balance < 0).map((r) => ({ id: r.id, amt: -r.balance }));
  creditors.sort((a, b) => b.amt - a.amt);
  debtors.sort((a, b) => b.amt - a.amt);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(debtors[i].amt, creditors[j].amt);
    if (amount > 0) out.push({ from: debtors[i].id, to: creditors[j].id, amount });
    debtors[i].amt -= amount;
    creditors[j].amt -= amount;
    if (debtors[i].amt === 0) i++;
    if (creditors[j].amt === 0) j++;
  }
  return out;
}

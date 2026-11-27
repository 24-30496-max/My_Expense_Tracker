import test from 'node:test';
import assert from 'node:assert/strict';
import { toCents, expenseTotal } from '../js/money.js';
import { splitEqual, computeBalances, suggestSettlements, isPaymentCounted } from '../js/settlement.js';

const M = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);

test('toCents parses common inputs', () => {
  assert.equal(toCents('599'), 59900);
  assert.equal(toCents('₱1,234.50'), 123450);
  assert.equal(toCents(19.99), 1999);
  assert.equal(toCents('abc'), NaN);
  assert.equal(toCents(''), NaN);
});

test('splitEqual always sums exactly to the total', () => {
  for (let total = 0; total < 2000; total += 7) {
    for (const seed of ['x', 'y', 'some-uuid']) {
      const s = splitEqual(total, ['a', 'b', 'c'], seed);
      assert.equal(sum(s), total);
      const vals = Object.values(s);
      assert.ok(Math.max(...vals) - Math.min(...vals) <= 1);
    }
  }
});

test('splitEqual rounds up different members for different expenses', () => {
  const ups = new Set();
  for (let i = 0; i < 30; i++) {
    const s = splitEqual(100, ['a', 'b', 'c'], `exp-${i}`); // 34/33/33
    ups.add(Object.entries(s).find(([, v]) => v === 34)[0]);
  }
  assert.ok(ups.size > 1);
});

test('balances: payer is owed, others owe, and everything nets to zero', () => {
  const expenses = [
    { id: 'e1', paid_by: 'a', qty: 1, unit_price_cents: 30000, fees_cents: 0, status: 'received' },
    { id: 'e2', paid_by: 'b', qty: 2, unit_price_cents: 5000, fees_cents: 1000, status: 'used' },
  ];
  const { rows, totalSpent } = computeBalances({ members: M, expenses });
  assert.equal(totalSpent, 41000);
  assert.equal(rows.a.paid, 30000);
  assert.equal(rows.b.paid, 11000);
  assert.equal(rows.c.paid, 0);
  assert.equal(sum(Object.fromEntries(Object.values(rows).map((r) => [r.id, r.balance]))), 0);
  assert.ok(rows.a.balance > 0 && rows.c.balance < 0);
});

test('"needed" (planned) and deleted expenses are not counted', () => {
  const expenses = [
    { id: 'e1', paid_by: 'a', qty: 1, unit_price_cents: 9000, fees_cents: 0, status: 'needed' },
    { id: 'e2', paid_by: 'a', qty: 1, unit_price_cents: 9000, fees_cents: 0, status: 'received', deleted_at: '2026-01-01' },
    { id: 'e3', paid_by: 'a', qty: 1, unit_price_cents: 3000, fees_cents: 0, status: 'ordered' },
  ];
  assert.equal(computeBalances({ members: M, expenses }).totalSpent, 3000);
});

test('suggested payments settle everyone, in at most n-1 payments', () => {
  const expenses = [
    { id: 'e1', paid_by: 'a', qty: 1, unit_price_cents: 90100, fees_cents: 0, status: 'received' },
    { id: 'e2', paid_by: 'b', qty: 1, unit_price_cents: 20033, fees_cents: 0, status: 'received' },
  ];
  const { rows } = computeBalances({ members: M, expenses });
  const plan = suggestSettlements(rows);
  assert.ok(plan.length <= 2);
  // apply the plan as recorded payments -> all balances become 0
  const payments = plan.map((p) => ({ from_member: p.from, to_member: p.to, amount_cents: p.amount }));
  const after = computeBalances({ members: M, expenses, payments }).rows;
  for (const r of Object.values(after)) assert.equal(r.balance, 0);
});

test('a payment reduces what is owed, and undoing (deleted) restores it', () => {
  const expenses = [{ id: 'e1', paid_by: 'a', qty: 1, unit_price_cents: 30000, fees_cents: 0, status: 'received' }];
  const pay = { from_member: 'b', to_member: 'a', amount_cents: 10000 };
  const before = computeBalances({ members: M, expenses }).rows;
  const paid = computeBalances({ members: M, expenses, payments: [pay] }).rows;
  assert.equal(paid.b.balance, before.b.balance + 10000);
  const undone = computeBalances({ members: M, expenses, payments: [{ ...pay, deleted_at: 'x' }] }).rows;
  assert.equal(undone.b.balance, before.b.balance);
});

test('expenseTotal = qty x unit + fees', () => {
  assert.equal(expenseTotal({ qty: 3, unit_price_cents: 1000, fees_cents: 250 }), 3250);
});

test('only confirmed or directly recorded payments count; waiting, declined, cancelled and undone do not', () => {
  const expenses = [{ id: 'e1', qty: 1, unit_price_cents: 30000, fees_cents: 0, paid_by: 'a', status: 'received', deleted_at: null }];
  const base = { from_member: 'b', to_member: 'a', amount_cents: 5000, deleted_at: null };
  const bal = (payments) => computeBalances({ members: M, expenses, payments }).rows.b.balance;
  const start = bal([]);
  assert.equal(start, -10000);
  assert.equal(bal([{ ...base }]), -5000, 'old rows without a status count (recorded directly)');
  assert.equal(bal([{ ...base, status: 'confirmed', proposed_by: 'b' }]), -5000, 'confirmed agreement counts');
  for (const status of ['pending', 'declined', 'cancelled', 'undone']) {
    assert.equal(bal([{ ...base, status }]), start, `${status} does not change balances`);
  }
  assert.equal(bal([{ ...base, status: 'confirmed', deleted_at: '2026-11-27T00:00:00Z' }]), start, 'undone (deleted) does not count');
  assert.equal(isPaymentCounted({ status: 'pending', deleted_at: null }), false);
  assert.equal(isPaymentCounted({ deleted_at: null }), true);
});

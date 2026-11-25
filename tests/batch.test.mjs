import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateExtra, planBatch, parsePastedLines } from '../js/batch.js';

const sum = (a) => a.reduce((x, y) => x + y, 0);

test('extra is spread in proportion and adds up exactly (many random cases)', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let t = 0; t < 2000; t++) {
    const lines = Array.from({ length: 1 + rnd(12) }, () => rnd(200000));
    if (sum(lines) === 0) continue;
    const extra = rnd(50000) - 20000 * (rnd(2));
    if (extra < 0 && -extra > sum(lines)) continue;
    const parts = allocateExtra(lines, extra);
    assert.equal(sum(parts), extra);
    parts.forEach((p, i) => { assert.ok(lines[i] + p >= 0, 'no item ends up below zero'); });
  }
});

test('shipping of 100 over 3 equal items: 34/33/33, never lost', () => {
  const parts = allocateExtra([1000, 1000, 1000], 100);
  assert.equal(sum(parts), 100);
  assert.deepEqual([...parts].sort(), [33, 33, 34]);
});

test('bigger items take a bigger share', () => {
  const [a, b] = allocateExtra([9000, 1000], 1000);
  assert.equal(a, 900);
  assert.equal(b, 100);
});

test('a discount reduces items proportionally', () => {
  const parts = allocateExtra([6000, 4000], -1000);
  assert.deepEqual(parts, [-600, -400]);
});

test('nothing to spread, or impossible discount, is refused with a clear message', () => {
  assert.throws(() => allocateExtra([0, 0], 500), /prices first/);
  assert.throws(() => allocateExtra([1000], -1500), /lower than zero/);
  assert.deepEqual(allocateExtra([100, 200], 0), [0, 0]);
});

test('planBatch: items 1,000 + receipt 1,150 -> 150 of fees, grand total equals the receipt', () => {
  const p = planBatch([{ qty: 2, unit_price_cents: 30000 }, { qty: 1, unit_price_cents: 40000 }], 115000);
  assert.equal(p.itemsTotal, 100000);
  assert.equal(p.extra, 15000);
  assert.equal(p.grandTotal, 115000);
  assert.equal(sum(p.lineTotals), 115000);
});

test('planBatch without a receipt total adds nothing', () => {
  const p = planBatch([{ qty: 1, unit_price_cents: 500 }, { qty: 3, unit_price_cents: 100 }], null);
  assert.equal(p.extra, 0);
  assert.equal(p.grandTotal, 800);
  assert.deepEqual(p.fees, [0, 0]);
});

test('pasted lines: names, quantities and prices', () => {
  const { lines, problems } = parsePastedLines(`
    ESP32 S3 599
    Jumper wires x3 45
    Resistor pack 3x 12.50
    Servo SG90, ₱1,169.00
    Resistor 220 5
  `);
  assert.deepEqual(problems, []);
  assert.deepEqual(lines, [
    { name: 'ESP32 S3', qty: 1, unit_price_cents: 59900 },
    { name: 'Jumper wires', qty: 3, unit_price_cents: 4500 },
    { name: 'Resistor pack', qty: 3, unit_price_cents: 1250 },
    { name: 'Servo SG90', qty: 1, unit_price_cents: 116900 },
    { name: 'Resistor 220', qty: 1, unit_price_cents: 500 },
  ]);
});

test('pasted lines: bad lines are reported, good ones kept', () => {
  const { lines, problems } = parsePastedLines('Just words\n250\nGood item 10');
  assert.equal(lines.length, 1);
  assert.equal(problems.length, 2);
});

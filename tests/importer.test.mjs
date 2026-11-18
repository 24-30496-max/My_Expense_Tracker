import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { detectHeaderRow, columnOptions, guessMapping, buildRows, markDuplicates, parseDate } from '../js/importer.js';

const require = createRequire(import.meta.url);
const XLSX = require('xlsx');
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'past-expenses.xlsx');
const wb = XLSX.readFile(file);
const grid = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });

const members = [
  { id: 'm1', name: 'Andrei', email: 'andrei@x.com' },
  { id: 'm2', name: 'Rowland', email: 'row@x.com' },
  { id: 'm3', name: 'Fesarit', email: 'fes@x.com' },
];
const defaults = { paid_by: 'm1', date: '2026-11-16', category: 'Components', status: 'received' };

test('detects the header row and the two item/price tables in the real file', () => {
  const h = detectHeaderRow(grid);
  assert.equal(h, 0);
  const opts = columnOptions(grid, h);
  const letters = opts.map((o) => o.letter);
  assert.ok(letters.includes('A') && letters.includes('B') && letters.includes('D') && letters.includes('E'));
  const map = guessMapping(opts);
  assert.equal(map.name, 0); // "item"
  assert.equal(map.price, 1); // "price"
});

test('imports all 13 items from the first table with exact prices', () => {
  const opts = columnOptions(grid, 0);
  const map = guessMapping(opts);
  const rows = buildRows({ grid, headerRow: 0, mapping: map, defaults, members, categories: ['Components'] });
  const ok = rows.filter((r) => !r.errors.length);
  assert.equal(ok.length, 13);
  assert.equal(ok[0].name, 'ESP32 S3');
  assert.equal(ok[0].unit_price_cents, 59900);
  assert.equal(ok.find((r) => r.name === 'Brass Wire').unit_price_cents, 11400); // trailing space trimmed
  const total = ok.reduce((s, r) => s + r.qty * r.unit_price_cents + r.fees_cents, 0);
  assert.equal(total, (599 + 199 + 169 + 154 + 115 + 104 + 99 + 79 + 95 + 55 + 30 + 114 + 74) * 100);
});

test('the second "Materials" table (Kalabito 25) imports by re-mapping columns D/E', () => {
  const rows = buildRows({ grid, headerRow: 0, mapping: { name: 3, price: 4 }, defaults, members });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Kalabito');
  assert.equal(rows[0].unit_price_cents, 2500);
});

test('duplicates are flagged against existing expenses', () => {
  const rows = buildRows({ grid, headerRow: 0, mapping: { name: 0, price: 1 }, defaults, members });
  markDuplicates(rows, [{ name: 'esp32 s3', qty: 1, unit_price_cents: 59900, fees_cents: 0 }]);
  assert.equal(rows.filter((r) => r.duplicate).length, 1);
});

test('bad rows are reported, not dropped silently', () => {
  const g = [['item', 'price'], ['Good', '10'], ['Bad price', 'abc'], ['', '50']];
  const rows = buildRows({ grid: g, headerRow: 0, mapping: { name: 0, price: 1 }, defaults, members });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].errors.length, 0);
  assert.equal(rows[1].errors[0], 'Price is not a number');
  assert.equal(rows[2].errors[0], 'Missing item name');
});

test('payer, date, quantity and "line total" prices', () => {
  const g = [['item', 'qty', 'total', 'paid by', 'date'], ['Wire', 3, 100, 'rowland', '11/03/2026']];
  const rows = buildRows({
    grid: g, headerRow: 0, mapping: { name: 0, qty: 1, price: 2, paid_by: 3, date: 4 },
    defaults, members, priceMode: 'total',
  });
  const r = rows[0];
  assert.equal(r.paid_by, 'm2');
  assert.equal(r.purchased_on, '2026-11-03');
  assert.equal(r.qty * r.unit_price_cents + r.fees_cents, 10000); // 3 x 33.33 + 0.01
});

test('date parsing', () => {
  assert.equal(parseDate(45000), '2023-03-15'); // Excel serial number
  assert.equal(parseDate('2026-03-05'), '2026-03-05');
  assert.equal(parseDate('3/5/2026'), '2026-03-05');
  assert.equal(parseDate('nonsense'), null);
});

// Import past expenses from a CSV or Excel file: pick columns, preview, then save.
import * as api from '../api.js';
import { state, refreshProject, isActive } from '../store.js';
import { h, select, field, today, toast, download, toCsv, STATUS_LABEL } from '../util.js';
import { formatMoney } from '../money.js';
import { detectHeaderRow, columnOptions, guessMapping, buildRows, markDuplicates } from '../importer.js';

const FIELDS = [
  ['name', 'Item name', true], ['price', 'Price', true], ['qty', 'Quantity', false], ['date', 'Date', false],
  ['category', 'Category', false], ['paid_by', 'Paid by', false], ['store', 'Store', false],
  ['status', 'Status', false], ['notes', 'Notes', false],
];

// Kept at module level so a live update from a teammate does not wipe a half-finished import.
const S = {
  fileName: '', grids: {}, sheet: '', headerRow: 0, mapping: {}, priceMode: 'unit',
  defaults: null, rows: [], picked: new Set(),
};

function resetImport() {
  Object.assign(S, { fileName: '', grids: {}, sheet: '', headerRow: 0, mapping: {}, priceMode: 'unit', defaults: null, rows: [], picked: new Set() });
}

function rebuild() {
  S.rows = markDuplicates(buildRows({
    grid: S.grids[S.sheet], headerRow: S.headerRow, mapping: S.mapping, defaults: S.defaults,
    members: state.members, categories: state.project.categories || [], priceMode: S.priceMode,
  }), state.expenses);
  S.picked = new Set(S.rows.map((r, i) => (!r.errors.length && !r.duplicate ? i : -1)).filter((i) => i >= 0));
}

async function loadFile(file) {
  if (!window.XLSX) throw new Error('The spreadsheet reader did not load. Check your connection and reload the page.');
  const wb = window.XLSX.read(await file.arrayBuffer(), { type: 'array' });
  const grids = {};
  for (const name of wb.SheetNames) {
    grids[name] = window.XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: '' });
  }
  const first = wb.SheetNames.find((n) => grids[n].length) || wb.SheetNames[0];
  S.fileName = file.name;
  S.grids = grids;
  S.sheet = first;
  S.defaults = { paid_by: (state.me || state.members[0]).id, date: today(), category: (state.project.categories || [])[0] || '', status: 'received' };
  chooseSheet(first);
}

function chooseSheet(name) {
  S.sheet = name;
  S.headerRow = detectHeaderRow(S.grids[name]);
  S.mapping = guessMapping(columnOptions(S.grids[name], S.headerRow));
  rebuild();
}

export function renderImport(main) {
  if (!isActive()) { main.append(h('section', { class: 'panel' }, h('p', {}, 'This project is archived, so nothing can be imported.'))); return; }
  const redraw = () => { main.replaceChildren(); draw(); };
  const cur = state.project.currency;

  function draw() {
    if (!S.fileName) {
      const input = h('input', { type: 'file', accept: '.csv,.xlsx,.xls,.ods', class: 'visually-hidden', id: 'import-file',
        onchange: async (ev) => {
          const file = ev.target.files[0];
          if (!file) return;
          try { await loadFile(file); redraw(); } catch (err) { toast(err.message, 'error'); }
        } });
      main.append(h('section', { class: 'panel' },
        h('h2', {}, 'Import past expenses'),
        h('p', {}, 'Choose a CSV or Excel file. You will pick which column is the item and which is the price, then check a preview before anything is saved.'),
        h('div', { class: 'actions left' },
          h('button', { class: 'btn primary', onclick: () => input.click() }, 'Choose a file'),
          h('button', { class: 'btn', onclick: () => download('expenses-template.csv', toCsv([
            ['item', 'price', 'qty', 'date', 'category', 'paid by', 'store', 'status', 'notes'],
            ['ESP32 DevKit', 599, 1, '2026-11-03', 'Components', state.members[0].name, 'Shopee', 'received', ''],
          ]), 'text/csv') }, 'Download a template'),
          input),
        h('p', { class: 'muted' }, 'Only the item and price are required. Payer, date, category and status can be set for the whole file below. Importing again skips items that already exist.')));
      return;
    }

    const grid = S.grids[S.sheet];
    const opts = columnOptions(grid, S.headerRow);
    const colChoices = [['', 'Not in my file'], ...opts.map((o) => [String(o.index), `${o.letter}: ${o.label}`])];

    const sheetSel = Object.keys(S.grids).length > 1
      ? field('Sheet', select(Object.keys(S.grids), S.sheet, { onchange: (ev) => { chooseSheet(ev.target.value); redraw(); } })) : null;
    const headerIn = h('input', { type: 'number', min: 1, value: S.headerRow + 1, onchange: (ev) => {
      S.headerRow = Math.max(0, (parseInt(ev.target.value, 10) || 1) - 1);
      S.mapping = guessMapping(columnOptions(grid, S.headerRow));
      rebuild(); redraw();
    } });

    const mapSelects = FIELDS.map(([key, label, required]) => field(required ? `${label} (required)` : label,
      select(colChoices, S.mapping[key] === null || S.mapping[key] === undefined ? '' : String(S.mapping[key]), {
        'aria-label': `${label} column`,
        onchange: (ev) => { S.mapping[key] = ev.target.value === '' ? null : Number(ev.target.value); rebuild(); drawPreview(); },
      })));

    const dflt = (key, ctl) => { ctl.addEventListener('change', () => { S.defaults[key] = ctl.value; rebuild(); drawPreview(); }); return ctl; };
    const defaultsRow = h('div', { class: 'row4' },
      field('Paid by (when the file has no payer)', dflt('paid_by', select(state.members.map((m) => [m.id, m.name]), S.defaults.paid_by))),
      field('Date (when the file has none)', dflt('date', h('input', { type: 'date', value: S.defaults.date }))),
      field('Category (default)', dflt('category', select([['', 'None'], ...(state.project.categories || []).map((c) => [c, c])], S.defaults.category))),
      field('Status (default)', dflt('status', select(Object.entries(STATUS_LABEL), S.defaults.status))));

    const priceMode = field('The price in my file is', select([['unit', 'Per piece'], ['total', 'The whole line (qty included)']], S.priceMode,
      { onchange: (ev) => { S.priceMode = ev.target.value; rebuild(); drawPreview(); } }));

    const previewBox = h('div', { class: 'import-preview' });
    const importBtn = h('button', { class: 'btn primary', type: 'button' });
    const stats = h('p', { class: 'list-summary' });

    function drawPreview() {
      previewBox.replaceChildren();
      if (S.mapping.name === null || S.mapping.name === undefined || S.mapping.price === null || S.mapping.price === undefined) {
        stats.textContent = '';
        importBtn.disabled = true;
        importBtn.textContent = 'Import';
        previewBox.append(h('p', { class: 'notice' }, 'Choose the Item name and Price columns above to see a preview.'));
        return;
      }
      const errs = S.rows.filter((r) => r.errors.length).length;
      const dups = S.rows.filter((r) => r.duplicate).length;
      const total = [...S.picked].reduce((s, i) => s + S.rows[i].qty * S.rows[i].unit_price_cents + S.rows[i].fees_cents, 0);
      stats.textContent = `${S.rows.length} rows found: ${S.rows.length - errs - dups} ready, ${dups} already in this project, ${errs} with problems.`;
      importBtn.disabled = S.picked.size === 0;
      importBtn.textContent = `Import ${S.picked.size} expense${S.picked.size === 1 ? '' : 's'} (${formatMoney(total, cur)})`;
      const tbody = h('tbody', {});
      S.rows.forEach((r, i) => {
        const bad = r.errors.length > 0;
        const issues = [...r.errors, ...(r.duplicate ? ['Already in this project'] : []), ...r.warnings];
        tbody.append(h('tr', { class: bad ? 'row-bad' : r.duplicate ? 'row-dup' : '' },
          h('td', {}, h('input', { type: 'checkbox', checked: S.picked.has(i), disabled: bad, 'aria-label': `Import row ${r.rowNumber}`,
            onchange: (ev) => { if (ev.target.checked) S.picked.add(i); else S.picked.delete(i); drawPreview(); } })),
          h('td', { class: 'muted' }, r.rowNumber),
          h('td', {}, r.name || '(empty)'),
          h('td', { class: 'num' }, r.qty),
          h('td', { class: 'num money' }, formatMoney(r.qty * r.unit_price_cents + r.fees_cents, cur)),
          h('td', {}, r.purchased_on),
          h('td', {}, select(state.members.map((m) => [m.id, m.name]), r.paid_by, { 'aria-label': `Payer for row ${r.rowNumber}`, onchange: (ev) => { r.paid_by = ev.target.value; } })),
          h('td', { class: bad ? 'neg' : 'muted' }, issues.join('. '))));
      });
      previewBox.append(h('div', { class: 'table-wrap' }, h('table', { class: 'preview' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Row'), h('th', {}, 'Item'), h('th', { class: 'num' }, 'Qty'), h('th', { class: 'num' }, 'Total'), h('th', {}, 'Date'), h('th', {}, 'Paid by'), h('th', {}, 'Check'))),
        tbody)));
    }

    importBtn.addEventListener('click', async () => {
      importBtn.disabled = true;
      importBtn.textContent = 'Importing...';
      try {
        const payload = [...S.picked].sort((a, b) => a - b).map((i) => {
          const r = S.rows[i];
          return { project_id: state.pid, name: r.name, qty: r.qty, unit_price_cents: r.unit_price_cents, fees_cents: r.fees_cents,
            purchased_on: r.purchased_on, paid_by: r.paid_by, category: r.category || null, status: r.status, store: r.store, notes: r.notes };
        });
        await api.insertExpenses(payload);
        await refreshProject();
        toast(`Imported ${payload.length} expense${payload.length === 1 ? '' : 's'}`);
        resetImport();
        location.hash = `#/p/${state.pid}/expenses`;
      } catch (err) {
        toast(`Import stopped: ${err.message}. Rows already saved will be skipped as duplicates if you import again.`, 'error');
        drawPreview();
      }
    });

    main.append(
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', {}, S.fileName),
          h('button', { class: 'btn small', onclick: () => { resetImport(); redraw(); } }, 'Choose another file')),
        h('div', { class: 'row2' }, sheetSel, field('Header is on row', headerIn, 'The row with names like "item" and "price".')),
        h('div', { class: 'map-grid' }, mapSelects),
        priceMode,
        h('h3', {}, 'Fill in what the file does not say'),
        defaultsRow,
        h('p', { class: 'muted' }, 'If your file has two lists side by side (for example parts and materials), import one, then choose the file again and map the other columns.')),
      h('section', { class: 'panel' }, h('h2', {}, 'Preview'), stats, previewBox,
        h('div', { class: 'actions' }, h('span', { class: 'spacer' }), importBtn)));
    drawPreview();
  }
  draw();
}

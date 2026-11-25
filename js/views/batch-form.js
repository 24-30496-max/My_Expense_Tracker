// Add a whole receipt: many items, one date, one receipt total, one set of photos.
import * as api from '../api.js';
import { state, refreshProject } from '../store.js';
import { h, select, field, modal, today, toast, STATUS_LABEL } from '../util.js';
import { toCents, formatMoney } from '../money.js';
import { splitEqual } from '../settlement.js';
import { planBatch, parsePastedLines } from '../batch.js';
import { prepareReceipt } from '../image.js';
import { openExpenseDialog } from './expense-form.js';

const MAX_LINES = 100;

/** "One item | Whole receipt" switch shown at the top of both add dialogs. */
export function modeSwitch(current, onPick) {
  return h('div', { class: 'seg mode-switch', role: 'group', 'aria-label': 'What are you adding?' },
    [['single', 'One item'], ['batch', 'Whole receipt']].map(([key, label]) =>
      h('button', { type: 'button', class: current === key ? 'on' : '', 'aria-pressed': current === key ? 'true' : 'false', onclick: () => { if (key !== current) onPick(key); } }, label)));
}

export function openBatchDialog() {
  const project = state.project;
  const cur = project.currency;
  const categories = project.categories || [];
  const memberIds = state.members.map((m) => m.id);
  const lines = [];
  const queued = [];

  const f = {
    date: h('input', { type: 'date', value: today(), required: true }),
    paid_by: select(state.members.map((m) => [m.id, m.name]), state.me ? state.me.id : state.members[0].id),
    store: h('input', { type: 'text', placeholder: 'Shopee, Lazada, local shop...' }),
    status: select(Object.entries(STATUS_LABEL), 'received'),
    total: h('input', { type: 'text', inputMode: 'decimal', placeholder: 'As printed on the receipt' }),
    notes: h('input', { type: 'text', placeholder: 'Optional' }),
  };

  const linesBox = h('div', { class: 'batch-lines' });
  const summary = h('div', { class: 'batch-summary', 'aria-live': 'polite' });
  const msg = h('p', { class: 'form-msg err', role: 'alert' });

  // ----- read the screen -> numbers -----
  const readLine = (l) => {
    const name = l.name.value.trim();
    const priceText = l.price.value.trim();
    const qty = Math.max(1, parseInt(l.qty.value, 10) || 1);
    const unit = priceText === '' ? null : toCents(l.price.value);
    return { name, qty, unit, blank: !name && priceText === '' };
  };
  const readTotal = () => (f.total.value.trim() === '' ? null : toCents(f.total.value));

  function recalc() {
    const rows = lines.map(readLine);
    const used = rows.filter((r) => !r.blank);
    const ready = used.every((r) => r.unit !== null && !Number.isNaN(r.unit) && r.unit >= 0);
    lines.forEach((l, i) => {
      const r = rows[i];
      l.totalOut.textContent = r.unit !== null && !Number.isNaN(r.unit) ? formatMoney(r.qty * r.unit, cur) : '';
    });
    summary.replaceChildren();
    if (!used.length) { summary.append(h('p', { class: 'muted' }, 'Add the items on the receipt. Each one is saved as its own expense.')); return; }
    if (!ready) { summary.append(h('p', { class: 'muted' }, 'Enter a price for every item to see the totals.')); return; }
    const rt = readTotal();
    if (Number.isNaN(rt) || (rt !== null && rt < 0)) { summary.append(h('p', { class: 'warn' }, 'The receipt total is not a valid amount.')); return; }
    let plan;
    try { plan = planBatch(used.map((r) => ({ qty: r.qty, unit_price_cents: r.unit })), rt); } catch (err) { summary.append(h('p', { class: 'warn' }, err.message)); return; }

    const diff = plan.extra;
    summary.append(
      h('div', { class: 'sum-row' }, h('span', {}, `${used.length} item${used.length === 1 ? '' : 's'} add up to`), h('strong', { class: 'money' }, formatMoney(plan.itemsTotal, cur))),
      rt !== null ? h('div', { class: 'sum-row' }, h('span', {}, 'Receipt total'), h('strong', { class: 'money' }, formatMoney(rt, cur))) : null,
      rt !== null
        ? h('p', { class: diff === 0 ? 'ok-text' : 'muted' }, diff === 0
          ? 'The items match the receipt total.'
          : diff > 0
            ? `The receipt is ${formatMoney(diff, cur)} more than the items (shipping, tax or fees). It is spread across the items in proportion to their prices, so each item carries its fair part.`
            : `The receipt is ${formatMoney(-diff, cur)} less than the items (a discount). It is spread across the items in proportion to their prices.`)
        : h('p', { class: 'muted' }, 'Enter the receipt total to include shipping, tax or discounts. Leave it empty if the items already add up.'),
      h('div', { class: 'sum-row big' }, h('span', {}, 'Total for this receipt'), h('strong', { class: 'money' }, formatMoney(plan.grandTotal, cur))),
      h('p', { class: 'split-line' }, f.status.value === 'needed'
        ? 'Marked Needed: not counted in spending or splits until ordered.'
        : (() => {
          const sh = Object.values(splitEqual(plan.grandTotal, memberIds, 'batch'));
          const lo = Math.min(...sh); const hi = Math.max(...sh);
          return `Split equally between ${memberIds.length} members: ${lo === hi ? formatMoney(lo, cur) : `${formatMoney(lo, cur)} to ${formatMoney(hi, cur)}`} each.`;
        })()));
  }
  [f.total, f.status].forEach((el) => el.addEventListener('input', recalc));

  // ----- item lines -----
  function addLine(init = {}) {
    const l = {
      name: h('input', { type: 'text', class: 'bl-name', placeholder: 'Item', value: init.name || '', 'aria-label': 'Item name', autocomplete: 'off' }),
      qty: h('input', { type: 'number', min: 1, step: 1, value: init.qty || 1, inputMode: 'numeric', 'aria-label': 'Quantity' }),
      price: h('input', { type: 'text', inputMode: 'decimal', placeholder: 'Price each', value: init.unit !== undefined ? (init.unit / 100).toFixed(2) : '', 'aria-label': 'Price each' }),
      cat: select([['', 'No category'], ...categories.map((c) => [c, c])], init.category !== undefined ? init.category : (categories[0] || ''), { 'aria-label': 'Category' }),
      totalOut: h('output', { class: 'bl-total' }),
    };
    l.remove = h('button', { type: 'button', class: 'btn small danger-quiet', 'aria-label': 'Remove this item', onclick: () => {
      if (lines.length === 1) return;
      lines.splice(lines.indexOf(l), 1);
      l.el.remove();
      recalc();
    } }, 'Remove');
    l.el = h('div', { class: 'batch-line' }, l.name, h('div', { class: 'bl-nums' }, l.qty, l.price, l.totalOut), h('div', { class: 'bl-foot' }, l.cat, l.remove));
    [l.name, l.qty, l.price].forEach((el) => el.addEventListener('input', recalc));
    l.price.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); if (l === lines[lines.length - 1]) { addLine(); lines[lines.length - 1].name.focus(); } }
    });
    lines.push(l);
    linesBox.append(l.el);
    return l;
  }
  for (let i = 0; i < 3; i++) addLine();

  // ----- paste a list -----
  const pasteBox = h('textarea', { rows: 6, placeholder: 'ESP32 S3 599\nJumper wires x3 45\nServo SG90 169' });
  const pasteMsg = h('p', { class: 'form-msg err', role: 'alert' });
  const pastePanel = h('div', { class: 'paste-panel', hidden: true },
    h('p', { class: 'muted' }, 'One item per line: name, then price. Write "x3" before the price for 3 pieces ("Jumper wires x3 45" is 3 pieces at 45 each).'),
    pasteBox, pasteMsg,
    h('div', { class: 'actions left' },
      h('button', { type: 'button', class: 'btn small primary', onclick: () => {
        const { lines: parsed, problems } = parsePastedLines(pasteBox.value);
        pasteMsg.textContent = problems.join(' ');
        if (!parsed.length) return;
        // reuse empty starter rows first
        for (const p of parsed) {
          const empty = lines.find((l) => readLine(l).blank);
          if (empty) { empty.name.value = p.name; empty.qty.value = p.qty; empty.price.value = (p.unit_price_cents / 100).toFixed(2); } else if (lines.length < MAX_LINES) addLine({ name: p.name, qty: p.qty, unit: p.unit_price_cents });
        }
        if (!problems.length) { pasteBox.value = ''; pastePanel.hidden = true; }
        recalc();
        toast(`Added ${parsed.length} item${parsed.length === 1 ? '' : 's'}`);
      } }, 'Add these items'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { pastePanel.hidden = true; } }, 'Close')));

  // ----- receipt photos (shared by every item on the receipt) -----
  const photoBox = h('div', { class: 'receipt-grid' });
  const drawPhotos = () => {
    photoBox.replaceChildren();
    queued.forEach((file, i) => {
      const url = URL.createObjectURL(file);
      photoBox.append(h('div', { class: 'receipt-tile new' },
        h('img', { src: url, alt: `Receipt photo ${i + 1}`, onload: () => URL.revokeObjectURL(url) }),
        h('button', { type: 'button', class: 'receipt-x', 'aria-label': 'Remove photo', onclick: () => { queued.splice(i, 1); drawPhotos(); } })));
    });
    if (!queued.length) photoBox.append(h('p', { class: 'muted' }, 'No photos yet. One photo is shared by all the items on this receipt.'));
  };
  const addFiles = (input) => { for (const file of input.files) queued.push(file); input.value = ''; drawPhotos(); };
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', tabIndex: -1, onchange: (ev) => addFiles(ev.target) });
  const gallery = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', tabIndex: -1, onchange: (ev) => addFiles(ev.target) });
  drawPhotos();

  // ----- save -----
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Add receipt');
  const form = h('form', { class: 'form-grid', novalidate: true },
    modeSwitch('batch', () => { m.close(); openExpenseDialog(null); }),
    h('div', { class: 'row2' }, field('Date on the receipt', f.date), field('Paid by', f.paid_by)),
    h('div', { class: 'row2' }, field('Store', f.store), field('Status', f.status, 'Needed items are planned and not counted yet.')),
    h('fieldset', { class: 'batch-items' }, h('legend', {}, 'Items on the receipt'),
      linesBox,
      h('div', { class: 'actions left' },
        h('button', { type: 'button', class: 'btn small', onclick: () => { if (lines.length < MAX_LINES) { addLine(); lines[lines.length - 1].name.focus(); } } }, '+ Add item'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { pastePanel.hidden = !pastePanel.hidden; if (!pastePanel.hidden) pasteBox.focus(); } }, 'Paste a list')),
      pastePanel),
    field(`Total on the receipt (${cur})`, f.total),
    summary,
    field('Notes', f.notes),
    h('fieldset', { class: 'receipts' }, h('legend', {}, 'Receipt photos'), photoBox,
      h('div', { class: 'receipt-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => camera.click() }, 'Take photo'),
        h('button', { type: 'button', class: 'btn', onclick: () => gallery.click() }, 'Add photos'), camera, gallery)),
    msg,
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), saveBtn));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    if (!f.date.value) { msg.textContent = 'Pick the date on the receipt.'; return; }
    const all = lines.map((l, i) => ({ l, r: readLine(l), i })).filter((x) => !x.r.blank);
    if (!all.length) { msg.textContent = 'Add at least one item.'; return; }
    for (const { r, i } of all) {
      if (!r.name) { msg.textContent = `Item ${i + 1} needs a name.`; lines[i].name.focus(); return; }
      if (r.unit === null || Number.isNaN(r.unit) || r.unit < 0) { msg.textContent = `Enter a valid price for "${r.name}".`; lines[i].price.focus(); return; }
    }
    const rt = readTotal();
    if (Number.isNaN(rt) || (rt !== null && rt < 0)) { msg.textContent = 'The receipt total is not a valid amount.'; f.total.focus(); return; }
    let plan;
    try { plan = planBatch(all.map((x) => ({ qty: x.r.qty, unit_price_cents: x.r.unit })), rt); } catch (err) { msg.textContent = err.message; return; }

    const batchId = crypto.randomUUID();
    const ids = all.map(() => crypto.randomUUID());
    const rows = all.map((x, k) => ({
      id: ids[k], project_id: project.id, name: x.r.name, category: x.l.cat.value || null, qty: x.r.qty,
      unit_price_cents: x.r.unit, fees_cents: plan.fees[k], purchased_on: f.date.value, paid_by: f.paid_by.value,
      status: f.status.value, store: f.store.value.trim() || null, notes: f.notes.value.trim() || null,
      batch_id: batchId, batch_total_cents: plan.grandTotal,
    }));
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      await api.insertExpenses(rows);
      let failed = 0;
      let lastErr = '';
      for (const file of queued) {
        try { await api.attachSharedReceipt(project.id, ids, await prepareReceipt(file)); } catch (err) { failed++; lastErr = err.message; }
      }
      await refreshProject();
      if (failed) toast(`Receipt saved, but ${failed} photo(s) failed: ${lastErr}`, 'error');
      else toast(`Added ${rows.length} item${rows.length === 1 ? '' : 's'}, ${formatMoney(plan.grandTotal, cur)} in total`);
      m.close();
    } catch (err) {
      msg.textContent = err.message;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Add receipt';
    }
  });

  const m = modal({ title: 'Add a receipt', content: form, wide: true });
  recalc();
  lines[0].name.focus();
  return m;
}

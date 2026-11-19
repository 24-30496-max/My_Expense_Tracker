// Add / view / edit one expense, including receipt photos and its edit history.
import * as api from '../api.js';
import { state, refreshProject, canEditExpense, isActive, memberName, receiptsOf, memberByUser, holderOf } from '../store.js';
import { h, select, field, modal, today, toast, confirmBox, fmtDateTime, STATUS_LABEL } from '../util.js';
import { toCents, centsToPlain, formatMoney, expenseTotal } from '../money.js';
import { splitEqual } from '../settlement.js';
import { prepareReceipt } from '../image.js';

const FIELD_LABEL = {
  name: 'item', category: 'category', qty: 'quantity', unit_price_cents: 'price', fees_cents: 'fees',
  purchased_on: 'date', paid_by: 'payer', store: 'store', link: 'link', status: 'status', notes: 'notes',
};

export async function openLightbox(path) {
  let url = state.urls[path];
  if (!url) {
    try { Object.assign(state.urls, await api.signedUrls([path])); url = state.urls[path]; } catch (e) { toast(e.message, 'error'); return; }
  }
  modal({ title: 'Receipt', wide: true, content: h('img', { class: 'lightbox-img', src: url, alt: 'Receipt photo' }) });
}

function describeChange(entry) {
  const o = entry.old_row;
  const n = entry.new_row;
  if (!o.deleted_at && n.deleted_at) return 'deleted this expense';
  if (o.deleted_at && !n.deleted_at) return 'restored this expense';
  const changed = Object.keys(FIELD_LABEL).filter((k) => String(o[k] ?? '') !== String(n[k] ?? ''));
  return changed.length ? `changed ${changed.map((k) => FIELD_LABEL[k]).join(', ')}` : 'saved without changes';
}

/** expense = existing row to view/edit, or null to add a new one. */
export function openExpenseDialog(expense = null) {
  const isNew = !expense;
  const editable = isNew ? isActive() : canEditExpense(expense);
  const project = state.project;
  const cur = project.currency;
  const categories = project.categories || [];
  const existingReceipts = isNew ? [] : receiptsOf(expense.id);
  const removedReceipts = new Set();
  const queued = []; // File objects waiting to upload

  const e = expense || {
    name: '', category: categories[0] || '', qty: 1, unit_price_cents: 0, fees_cents: 0,
    purchased_on: today(), paid_by: state.me ? state.me.id : state.members[0].id, status: 'received',
    store: '', link: '', notes: '',
  };

  const f = {
    name: h('input', { type: 'text', value: e.name, required: true, maxLength: 200, autocomplete: 'off', placeholder: 'e.g. ESP32 DevKit' }),
    category: select([['', 'None'], ...categories.map((c) => [c, c])], e.category || ''),
    qty: h('input', { type: 'number', min: 1, step: 1, value: e.qty, inputMode: 'numeric' }),
    price: h('input', { type: 'text', inputMode: 'decimal', value: isNew ? '' : centsToPlain(e.unit_price_cents), placeholder: '0.00', required: true }),
    fees: h('input', { type: 'text', inputMode: 'decimal', value: e.fees_cents ? centsToPlain(e.fees_cents) : '', placeholder: '0.00' }),
    date: h('input', { type: 'date', value: e.purchased_on, required: true }),
    paid_by: select(state.members.map((m) => [m.id, m.name]), e.paid_by),
    status: select(Object.entries(STATUS_LABEL), e.status),
    store: h('input', { type: 'text', value: e.store || '', placeholder: 'Shopee, Lazada, local shop...' }),
    link: h('input', { type: 'url', value: e.link || '', placeholder: 'https://' }),
    notes: h('textarea', { rows: 2 }, e.notes || ''),
  };

  const totalOut = h('output', { class: 'total-out' });
  const splitOut = h('p', { class: 'split-line' });
  const readCents = () => {
    const q = Math.max(1, parseInt(f.qty.value, 10) || 1);
    const unit = f.price.value.trim() === '' ? 0 : toCents(f.price.value);
    const fees = f.fees.value.trim() === '' ? 0 : toCents(f.fees.value);
    return { q, unit, fees };
  };
  const recalc = () => {
    const { q, unit, fees } = readCents();
    if (Number.isNaN(unit) || Number.isNaN(fees)) { totalOut.textContent = '-'; splitOut.textContent = ''; return; }
    const total = expenseTotal({ qty: q, unit_price_cents: unit, fees_cents: fees });
    totalOut.textContent = formatMoney(total, cur);
    const shares = Object.values(splitEqual(total, state.members.map((m) => m.id), expense ? expense.id : 'new'));
    const lo = Math.min(...shares);
    const hi = Math.max(...shares);
    const each = lo === hi ? formatMoney(lo, cur) : `${formatMoney(lo, cur)} to ${formatMoney(hi, cur)}`;
    const counted = f.status.value !== 'needed';
    splitOut.textContent = counted
      ? `Split equally between ${state.members.length} members: ${each} each.`
      : 'Marked Needed: not counted in spending or splits until it is ordered.';
  };
  [f.qty, f.price, f.fees, f.status].forEach((el) => el.addEventListener('input', recalc));
  recalc();

  // ----- receipts -----
  const receiptBox = h('div', { class: 'receipt-grid' });
  const drawReceipts = () => {
    receiptBox.replaceChildren();
    for (const r of existingReceipts.filter((x) => !removedReceipts.has(x.id))) {
      const src = state.urls[r.thumb_path || r.path];
      receiptBox.append(h('div', { class: 'receipt-tile' },
        h('button', { type: 'button', class: 'receipt-open', 'aria-label': 'View receipt full size', onclick: () => openLightbox(r.path) },
          src ? h('img', { src, alt: 'Receipt thumbnail', loading: 'lazy' }) : h('span', {}, 'Photo')),
        editable ? h('button', {
          type: 'button', class: 'receipt-x', 'aria-label': 'Remove receipt',
          onclick: () => { removedReceipts.add(r.id); drawReceipts(); },
        }, '×') : null));
    }
    queued.forEach((file, i) => {
      const url = URL.createObjectURL(file);
      receiptBox.append(h('div', { class: 'receipt-tile new' },
        h('img', { src: url, alt: `New photo ${file.name}`, onload: () => URL.revokeObjectURL(url) }),
        h('button', { type: 'button', class: 'receipt-x', 'aria-label': 'Remove photo', onclick: () => { queued.splice(i, 1); drawReceipts(); } }, '×'),
        h('span', { class: 'receipt-badge' }, 'Not saved yet')));
    });
    if (!receiptBox.children.length) receiptBox.append(h('p', { class: 'muted' }, 'No receipt photos.'));
  };
  const addFiles = (input) => {
    for (const file of input.files) queued.push(file);
    input.value = '';
    drawReceipts();
  };
  const camera = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'visually-hidden', tabIndex: -1, onchange: (ev) => addFiles(ev.target) });
  const gallery = h('input', { type: 'file', accept: 'image/*', multiple: true, class: 'visually-hidden', tabIndex: -1, onchange: (ev) => addFiles(ev.target) });
  drawReceipts();

  // ----- history -----
  const historyBox = h('details', { class: 'history' }, h('summary', {}, 'Edit history'));
  const addedBy = !isNew && memberByUser(e.created_by);
  if (!isNew) {
    let loaded = false;
    historyBox.addEventListener('toggle', async () => {
      if (!historyBox.open || loaded) return;
      loaded = true;
      const list = h('ul', { class: 'history-list' }, h('li', {}, `Added by ${addedBy ? addedBy.name : 'a member'} on ${fmtDateTime(e.created_at)}`));
      historyBox.append(list);
      try {
        const rows = await api.loadHistory(e.id);
        for (const entry of rows) {
          const who = memberByUser(entry.changed_by);
          list.append(h('li', {}, `${who ? who.name : 'A member'} ${describeChange(entry)}, ${fmtDateTime(entry.changed_at)}`));
        }
      } catch (err) { list.append(h('li', {}, `Could not load history: ${err.message}`)); }
    });
  }

  // ----- form -----
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, isNew ? 'Add expense' : 'Save changes');
  const form = h('form', { class: 'form-grid', novalidate: true },
    field('Item', f.name),
    h('div', { class: 'row2' }, field('Category', f.category), field('Status', f.status,
      'Needed items are planned and not counted in spending yet.')),
    h('div', { class: 'row3' }, field('Qty', f.qty), field(`Unit price (${cur})`, f.price), field('Extra fees', f.fees, 'Shipping, tax')),
    h('div', { class: 'total-row' }, h('span', {}, 'Total'), totalOut),
    splitOut,
    isNew ? null : h('p', { class: 'split-line' }, holderOf(expense.id) ? `Held by ${holderOf(expense.id).name}. ` : 'Not assigned to anyone yet. ', h('a', { href: `#/p/${state.pid}/owners`, onclick: () => document.querySelector('dialog')?.close() }, 'See Owners')),
    h('div', { class: 'row2' }, field('Date', f.date), field('Paid by', f.paid_by)),
    h('div', { class: 'row2' }, field('Store', f.store), field('Link', f.link)),
    field('Notes', f.notes),
    (!editable && !existingReceipts.length) ? null : h('fieldset', { class: 'receipts' },
      h('legend', {}, 'Receipt photos'),
      receiptBox,
      editable ? h('div', { class: 'receipt-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => camera.click() }, 'Take photo'),
        h('button', { type: 'button', class: 'btn', onclick: () => gallery.click() }, 'Add photos'),
        camera, gallery) : null),
    isNew ? null : historyBox,
    msg,
    h('div', { class: 'actions' },
      !isNew && editable ? h('button', {
        class: 'btn danger-quiet', type: 'button',
        onclick: async () => {
          if (!(await confirmBox(`Delete "${e.name}"? You can restore it later from "Show deleted".`, 'Delete', true))) return;
          try { await api.softDeleteExpense(e.id); await refreshProject(); toast('Deleted'); m.close(); } catch (err) { msg.textContent = err.message; }
        },
      }, 'Delete') : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, editable ? 'Cancel' : 'Close'),
      editable ? saveBtn : null),
  );

  if (!editable) {
    const why = !isActive()
      ? 'This project is archived, so entries cannot be changed.'
      : `Only ${addedBy ? addedBy.name : 'the member who added it'} or ${memberName(e.paid_by)} (who paid) can edit this.`;
    form.prepend(h('p', { class: 'notice' }, why));
    form.querySelectorAll('input:not([type=file]), select, textarea').forEach((el) => { el.disabled = true; });
  }
  if (!isNew && expense.deleted_at && canEditExpense(expense)) {
    form.prepend(h('div', { class: 'notice' }, 'This expense is deleted. ',
      h('button', {
        class: 'btn small', type: 'button',
        onclick: async () => { try { await api.restoreExpense(e.id); await refreshProject(); toast('Restored'); m.close(); } catch (err) { msg.textContent = err.message; } },
      }, 'Restore')));
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    const { q, unit, fees } = readCents();
    if (!f.name.value.trim()) { msg.textContent = 'Enter the item name.'; f.name.focus(); return; }
    if (Number.isNaN(unit) || unit < 0) { msg.textContent = 'Enter a valid unit price, for example 599 or 599.50.'; f.price.focus(); return; }
    if (Number.isNaN(fees) || fees < 0) { msg.textContent = 'Extra fees must be a number, or empty.'; f.fees.focus(); return; }
    if (!f.date.value) { msg.textContent = 'Pick the purchase date.'; return; }
    const row = {
      name: f.name.value.trim(), category: f.category.value || null, qty: q, unit_price_cents: unit, fees_cents: fees,
      purchased_on: f.date.value, paid_by: f.paid_by.value, status: f.status.value,
      store: f.store.value.trim() || null, link: f.link.value.trim() || null, notes: f.notes.value.trim() || null,
    };
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    try {
      let id;
      if (isNew) {
        id = crypto.randomUUID();
        await api.insertExpense({ ...row, id, project_id: project.id });
      } else {
        id = e.id;
        await api.updateExpense(id, row);
      }
      let failed = 0;
      let lastErr = '';
      for (const rec of existingReceipts.filter((x) => removedReceipts.has(x.id))) {
        try { await api.deleteReceipt(rec); } catch (err) { failed++; lastErr = err.message; }
      }
      for (const file of queued) {
        try { await api.uploadReceipt(project.id, id, await prepareReceipt(file)); } catch (err) { failed++; lastErr = err.message; }
      }
      await refreshProject();
      if (failed) toast(`Saved, but ${failed} photo change(s) failed: ${lastErr}`, 'error');
      else toast(isNew ? 'Expense added' : 'Changes saved');
      m.close();
    } catch (err) {
      msg.textContent = err.message;
      saveBtn.disabled = false;
      saveBtn.textContent = isNew ? 'Add expense' : 'Save changes';
    }
  });

  const m = modal({ title: isNew ? 'Add expense' : (editable ? 'Edit expense' : 'Expense'), content: form, wide: true });
  if (isNew) f.name.focus();
  return m;
}

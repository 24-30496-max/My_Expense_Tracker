// Project tab: export, settings, members, archive.
import * as api from '../api.js';
import { state, refreshProject, isOwner, isActive, ownerName } from '../store.js';
import { h, field, toast, confirmBox, download, toCsv, today } from '../util.js';
import { toCents, centsToPlain, expenseTotal } from '../money.js';
import { computeBalances, isCounted, splitEqual } from '../settlement.js';
import { receiptsOf } from '../store.js';

function buildExport() {
  const { members, expenses, payments, project } = state;
  const ids = members.map((m) => m.id);
  const name = (id) => (members.find((m) => m.id === id) || {}).name || '';
  const money = (c) => centsToPlain(c);
  const live = expenses.filter((e) => !e.deleted_at).sort((a, b) => a.purchased_on.localeCompare(b.purchased_on));

  const expRows = [[
    'Date', 'Item', 'Category', 'Qty', 'Unit price', 'Extra fees', 'Total', 'Paid by', 'Store', 'Link', 'Status', 'Notes', 'Receipts',
    ...members.map((m) => `${m.name} share`),
  ]];
  for (const e of live) {
    const total = expenseTotal(e);
    const shares = isCounted(e) ? splitEqual(total, ids, e.id) : {};
    expRows.push([e.purchased_on, e.name, e.category || '', e.qty, money(e.unit_price_cents), money(e.fees_cents), money(total),
      name(e.paid_by), e.store || '', e.link || '', e.status, e.notes || '', receiptsOf(e.id).length,
      ...ids.map((id) => (isCounted(e) ? money(shares[id]) : '0.00'))]);
  }
  const { rows, totalSpent } = computeBalances({ members, expenses, payments });
  const balRows = [['Member', 'Paid', 'Fair share', 'Payments sent', 'Payments received', 'Balance (positive = is owed)']];
  members.forEach((m) => {
    const r = rows[m.id];
    balRows.push([m.name, money(r.paid), money(r.share), money(r.sent), money(r.received), money(r.balance)]);
  });
  balRows.push(['Total spent', money(totalSpent)]);
  const payRows = [['Date', 'From', 'To', 'Amount', 'Note']];
  payments.filter((p) => !p.deleted_at).forEach((p) => payRows.push([p.paid_on, name(p.from_member), name(p.to_member), money(p.amount_cents), p.note || '']));
  const base = `${project.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'project'}-${today()}`;
  return { expRows, balRows, payRows, base };
}

function exportCsv() {
  const { expRows, balRows, payRows, base } = buildExport();
  download(`${base}.csv`, toCsv([...expRows, [], ['SETTLEMENT SUMMARY'], ...balRows, [], ['PAYMENTS RECORDED'], ...payRows]), 'text/csv');
}

function exportXlsx() {
  if (!window.XLSX) { toast('The spreadsheet writer did not load. Check your connection and reload.', 'error'); return; }
  const { expRows, balRows, payRows, base } = buildExport();
  const num = (rows) => rows.map((r, i) => (i === 0 ? r : r.map((c) => (typeof c === 'string' && /^-?\d+\.\d{2}$/.test(c) ? Number(c) : c))));
  const wb = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(num(expRows)), 'Expenses');
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(num(balRows)), 'Settlement');
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.aoa_to_sheet(num(payRows)), 'Payments');
  window.XLSX.writeFile(wb, `${base}.xlsx`);
}

export function renderProject(main) {
  const { project, members } = state;
  const owner = isOwner();
  const cur = project.currency;

  main.append(h('section', { class: 'panel' },
    h('h2', {}, 'Export'),
    h('p', { class: 'muted' }, 'Expenses, who owes whom, and payments, for your report or records.'),
    h('div', { class: 'actions left' },
      h('button', { class: 'btn primary', onclick: exportXlsx }, 'Download Excel (.xlsx)'),
      h('button', { class: 'btn', onclick: exportCsv }, 'Download CSV'))));

  // ----- settings -----
  const name = h('input', { type: 'text', value: project.name, disabled: !owner, required: true });
  const budget = h('input', { type: 'text', inputMode: 'decimal', value: project.budget_cents ? centsToPlain(project.budget_cents) : '', placeholder: 'No budget', disabled: !owner });
  const cats = h('input', { type: 'text', value: (project.categories || []).join(', '), disabled: !owner });
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const form = h('form', { class: 'form-grid', novalidate: true },
    field('Project name', name),
    h('div', { class: 'row2' }, field(`Budget (${cur})`, budget, 'Leave empty for no budget.'), field('Currency', h('input', { type: 'text', value: cur, disabled: true }))),
    field('Categories', cats, 'Separated by commas.'),
    msg,
    owner ? h('div', { class: 'actions' }, h('span', { class: 'spacer' }), h('button', { class: 'btn primary', type: 'submit' }, 'Save settings')) : null);
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    const b = budget.value.trim() === '' ? null : toCents(budget.value);
    if (b !== null && (Number.isNaN(b) || b < 0)) { msg.textContent = 'Budget must be a number, or empty.'; return; }
    const list = [...new Set(cats.value.split(',').map((c) => c.trim()).filter(Boolean))];
    if (!name.value.trim()) { msg.textContent = 'Project name is required.'; return; }
    try {
      await api.updateProject(state.pid, { name: name.value.trim(), budget_cents: b, categories: list });
      await refreshProject();
      toast('Settings saved');
    } catch (err) { msg.textContent = err.message; }
  });
  main.append(h('section', { class: 'panel' },
    h('h2', {}, 'Project settings'),
    owner ? null : h('p', { class: 'notice' }, `Only ${ownerName()} (who created this project) can change settings and members.`),
    form));

  // ----- members -----
  const memberList = h('ul', { class: 'member-list' }, members.map((mb) => {
    const nameIn = h('input', { type: 'text', value: mb.name, disabled: !owner, 'aria-label': `Name for ${mb.email}` });
    return h('li', {},
      h('div', { class: 'member-main' }, nameIn,
        h('span', { class: 'muted' }, mb.email),
        h('span', { class: `pill ${mb.user_id ? 'received' : 'needed'}` }, mb.user_id ? 'Signed in' : 'Not signed in yet')),
      owner ? h('div', { class: 'member-actions' },
        h('button', { class: 'btn small', onclick: async () => {
          if (!nameIn.value.trim()) return;
          try { await api.renameMember(mb.id, nameIn.value.trim()); await refreshProject(); toast('Name saved'); } catch (err) { toast(err.message, 'error'); }
        } }, 'Save name'),
        mb.user_id !== state.user.id ? h('button', { class: 'btn small danger-quiet', onclick: async () => {
          if (!(await confirmBox(`Remove ${mb.name} from this project?`, 'Remove', true))) return;
          try { await api.removeMember(mb.id); await refreshProject(); toast('Member removed'); } catch (err) { toast(err.message, 'error'); }
        } }, 'Remove') : null) : null);
  }));

  const newName = h('input', { type: 'text', placeholder: 'Name' });
  const newEmail = h('input', { type: 'email', placeholder: 'Email they sign in with' });
  const addForm = h('form', { class: 'row-add', novalidate: true }, newName, newEmail, h('button', { class: 'btn', type: 'submit' }, 'Add member'));
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!newName.value.trim() || !/^\S+@\S+\.\S+$/.test(newEmail.value.trim())) { toast('Enter a name and a valid email.', 'error'); return; }
    if (state.expenses.some((e) => !e.deleted_at)
      && !(await confirmBox(`Adding a member splits every existing expense ${members.length + 1} ways instead of ${members.length}, so everyone's fair share changes. Continue?`, 'Add member'))) return;
    try {
      await api.addMember(state.pid, newName.value.trim(), newEmail.value.trim());
      newName.value = ''; newEmail.value = '';
      await refreshProject();
      toast('Member added');
    } catch (err) { toast(err.message, 'error'); }
  });

  main.append(h('section', { class: 'panel' },
    h('h2', {}, `Members (${members.length})`),
    memberList,
    owner && isActive() ? addForm : null,
    h('p', { class: 'muted' }, `Everyone signs in at ${location.origin}${location.pathname} with the email listed above. Expenses are always split equally between all members.`)));

  // ----- archive -----
  if (owner) {
    const active = isActive();
    main.append(h('section', { class: 'panel' },
      h('h2', {}, active ? 'Finish this project' : 'Archived project'),
      h('p', { class: 'muted' }, active
        ? 'Archiving locks the project: everything stays viewable and exportable, but nothing can be added or changed. You can unarchive it later. Create a new project from the project list for your next activity.'
        : 'This project is archived and read-only. Unarchive it to add or change entries.'),
      h('button', { class: active ? 'btn danger-quiet' : 'btn primary', onclick: async () => {
        if (active && !(await confirmBox('Archive this project? Nobody will be able to add or change entries until you unarchive it.', 'Archive project', true))) return;
        try { await api.updateProject(state.pid, { status: active ? 'archived' : 'active' }); await refreshProject(); toast(active ? 'Project archived' : 'Project is active again'); } catch (err) { toast(err.message, 'error'); }
      } }, active ? 'Archive project' : 'Unarchive project')));
  }
}

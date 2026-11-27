// Project tab: export, settings, members, archive.
import * as api from '../api.js';
import { state, refreshProject, isOwner, isActive, ownerName } from '../store.js';
import { h, field, toast, confirmBox, download, toCsv, today } from '../util.js';
import { toCents, centsToPlain, expenseTotal } from '../money.js';
import { computeBalances, isCounted, splitEqual } from '../settlement.js';
import { receiptsOf, holderOf } from '../store.js';

function buildExport() {
  const { members, expenses, payments, project } = state;
  const ids = members.map((m) => m.id);
  const name = (id) => (members.find((m) => m.id === id) || {}).name || '';
  const money = (c) => centsToPlain(c);
  const live = expenses.filter((e) => !e.deleted_at).sort((a, b) => a.purchased_on.localeCompare(b.purchased_on));

  const expRows = [[
    'Date', 'Item', 'Category', 'Qty', 'Unit price', 'Extra fees', 'Total', 'Paid by', 'Store', 'Link', 'Status', 'Held by', 'Notes', 'Receipts', 'Receipt total',
    ...members.map((m) => `${m.name} share`),
  ]];
  for (const e of live) {
    const total = expenseTotal(e);
    const shares = isCounted(e) ? splitEqual(total, ids, e.id) : {};
    expRows.push([e.purchased_on, e.name, e.category || '', e.qty, money(e.unit_price_cents), money(e.fees_cents), money(total),
      name(e.paid_by), e.store || '', e.link || '', e.status, (holderOf(e.id) || {}).name || '', e.notes || '', receiptsOf(e.id).length, e.batch_total_cents != null ? money(e.batch_total_cents) : '',
      ...ids.map((id) => (isCounted(e) ? money(shares[id]) : '0.00'))]);
  }
  const { rows, totalSpent } = computeBalances({ members, expenses, payments });
  const balRows = [['Member', 'Paid', 'Fair share', 'Payments sent (confirmed)', 'Payments received (confirmed)', 'Balance (positive = is owed)']];
  members.forEach((m) => {
    const r = rows[m.id];
    balRows.push([m.name, money(r.paid), money(r.share), money(r.sent), money(r.received), money(r.balance)]);
  });
  balRows.push(['Total spent', money(totalSpent)]);
  const payRows = [['Date', 'From', 'To', 'Amount', 'Note', 'Status']];
  const payStatus = (p) => (p.deleted_at && p.status === 'confirmed' ? 'Undone' : { pending: 'Waiting for confirmation', confirmed: p.proposed_by ? 'Confirmed' : 'Recorded directly', declined: 'Declined', cancelled: 'Cancelled', undone: 'Undone' }[p.status || 'confirmed']);
  payments.slice().sort((a, b) => a.paid_on.localeCompare(b.paid_on)).forEach((p) => payRows.push([p.paid_on, name(p.from_member), name(p.to_member), money(p.amount_cents), p.note || '', payStatus(p)]));
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
    h('p', { class: 'muted' }, 'Expenses, who owes whom, and payments and agreements (with their status), for your report or records. Only confirmed payments count in the totals.'),
    h('div', { class: 'actions left' },
      h('button', { class: 'btn primary', onclick: exportXlsx }, 'Download Excel (.xlsx)'),
      h('button', { class: 'btn', onclick: exportCsv }, 'Download CSV'))));

  if (isActive()) {
    main.append(h('section', { class: 'panel' },
      h('h2', {}, 'Import past expenses'),
      h('p', { class: 'muted' }, 'Bring in expenses you already tracked in a spreadsheet (CSV or Excel).'),
      h('a', { class: 'btn', href: `#/p/${state.pid}/import` }, 'Import from a file')));
  }

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
    const nameIn = h('input', { type: 'text', value: mb.name, disabled: !owner, 'aria-label': `Name for ${mb.email || mb.name}` });
    const temporary = !mb.email;
    const emailIn = temporary && owner ? h('input', { type: 'email', placeholder: 'Their email', 'aria-label': `Email for ${mb.name}` }) : null;
    return h('li', { 'data-member': mb.name },
      h('div', { class: 'member-main' }, nameIn,
        temporary ? h('span', { class: 'muted' }, 'No email yet') : h('span', { class: 'muted' }, mb.email),
        temporary
          ? h('span', { class: 'pill needed' }, 'Temporary')
          : h('span', { class: `pill ${mb.user_id ? 'received' : 'ordered'}` }, mb.user_id ? 'Signed in' : 'Not signed in yet'),
        emailIn),
      owner ? h('div', { class: 'member-actions' },
        emailIn ? h('button', { class: 'btn small primary', onclick: async () => {
          const addr = emailIn.value.trim();
          if (!/^\S+@\S+\.\S+$/.test(addr)) { toast('Enter a valid email for ' + mb.name + '.', 'error'); return; }
          if (!(await confirmBox(`Give ${mb.name} the email ${addr}? When they sign in with it they will be linked to ${mb.name}, with all of ${mb.name}'s expenses and items. An email can be assigned only once.`, 'Assign email'))) return;
          try { await api.setMemberEmail(mb.id, addr); await refreshProject(); toast(`${mb.name} can now sign in with ${addr}`); } catch (err) { toast(err.message, 'error'); }
        } }, 'Assign email') : null,
        h('button', { class: 'btn small', onclick: async () => {
          if (!nameIn.value.trim()) return;
          try { await api.renameMember(mb.id, nameIn.value.trim()); await refreshProject(); toast('Name saved'); } catch (err) { toast(err.message, 'error'); }
        } }, 'Save name'),
        mb.user_id !== state.user.id ? h('button', { class: 'btn small danger-quiet', onclick: async () => {
          if (!(await confirmBox(`Remove ${mb.name} from this project? Anything assigned to them becomes unassigned.`, 'Remove', true))) return;
          try { await api.removeMember(mb.id); await refreshProject(); toast('Member removed'); } catch (err) { toast(err.message, 'error'); }
        } }, 'Remove') : null) : null);
  }));

  const newName = h('input', { type: 'text', placeholder: 'Name' });
  const newEmail = h('input', { type: 'email', placeholder: 'Email (optional, add it later)' });
  const addForm = h('form', { class: 'row-add', novalidate: true }, newName, newEmail, h('button', { class: 'btn', type: 'submit' }, 'Add member'));
  addForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const addr = newEmail.value.trim();
    if (!newName.value.trim()) { toast('Enter a name.', 'error'); return; }
    if (addr && !/^\S+@\S+\.\S+$/.test(addr)) { toast('That email does not look right. Leave it empty to add it later.', 'error'); return; }
    if (state.expenses.some((e) => !e.deleted_at)
      && !(await confirmBox(`Adding a member splits every existing expense ${members.length + 1} ways instead of ${members.length}, so everyone's fair share changes. Continue?`, 'Add member'))) return;
    try {
      await api.addMember(state.pid, newName.value.trim(), addr);
      newName.value = ''; newEmail.value = '';
      await refreshProject();
      toast(addr ? 'Member added' : 'Temporary member added. Assign their email when you have it.');
    } catch (err) { toast(err.message, 'error'); }
  });

  main.append(h('section', { class: 'panel' },
    h('h2', {}, `Members (${members.length})`),
    memberList,
    owner && isActive() ? addForm : null,
    h('p', { class: 'muted' }, 'A member added by name only is temporary: you can record expenses for them and assign items to them right away. When you add their email, the first time they sign in with it they are linked to that name.'),
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

// Project list and the "new project" form.
import * as api from '../api.js';
import { state, refreshProjects } from '../store.js';
import { h, field, toast, fmtDate } from '../util.js';
import { toCents } from '../money.js';

export function renderProjects(main) {
  const active = state.projects.filter((p) => p.status === 'active');
  const archived = state.projects.filter((p) => p.status !== 'active');
  const card = (p) => h('a', { class: `project-card${p.status === 'archived' ? ' archived' : ''}`, href: `#/p/${p.id}/overview` },
    h('span', { class: 'project-name' }, p.name),
    h('span', { class: 'muted' }, `${p.status === 'archived' ? 'Archived, ' : ''}started ${fmtDate(p.created_at)} · ${p.currency}`));

  main.append(
    h('div', { class: 'page-head' }, h('h1', {}, 'Your projects'), h('a', { class: 'btn primary', href: '#/new' }, 'New project')),
    state.projects.length
      ? h('div', {}, h('div', { class: 'project-grid' }, active.map(card)),
        archived.length ? h('h2', { class: 'sub' }, 'Archived') : null,
        h('div', { class: 'project-grid' }, archived.map(card)))
      : h('section', { class: 'panel empty' },
        h('p', {}, 'No projects yet.'),
        h('p', { class: 'muted' }, 'Create one for your prototype. If a teammate already made it, ask them to add the email you signed in with, then reload this page.'),
        h('a', { class: 'btn primary', href: '#/new' }, 'Create your first project')));
}

export function renderNewProject(main) {
  const myEmail = state.user.email;
  const name = h('input', { type: 'text', required: true, placeholder: 'e.g. Smart plant watering prototype' });
  const currency = h('input', { type: 'text', value: 'PHP', maxLength: 3, style: 'text-transform:uppercase' });
  const budget = h('input', { type: 'text', inputMode: 'decimal', placeholder: 'Optional' });
  const msg = h('p', { class: 'form-msg err', role: 'alert' });

  const rows = [];
  const list = h('div', { class: 'member-rows' });
  const addRow = (n = '', e = '', locked = false) => {
    const r = { n: h('input', { type: 'text', value: n, placeholder: 'Name', 'aria-label': 'Member name' }), e: h('input', { type: 'email', value: e, placeholder: 'Email', disabled: locked, 'aria-label': 'Member email' }), locked };
    rows.push(r);
    list.append(h('div', { class: 'row-add' }, r.n, r.e, locked ? h('span', { class: 'muted' }, 'You') : null));
  };
  addRow('', myEmail, true);
  addRow(); addRow();

  const form = h('form', { class: 'panel form-grid', novalidate: true },
    h('h2', {}, 'New project'),
    field('Project name', name),
    h('div', { class: 'row2' }, field('Currency', currency), field('Budget', budget, 'You can set or change this later.')),
    h('fieldset', {}, h('legend', {}, 'Members'),
      h('p', { class: 'muted' }, 'Add everyone who shares the costs, including you. Each person signs in with the email you enter here. Expenses are split equally.'),
      list,
      h('button', { class: 'btn small', type: 'button', onclick: () => addRow() }, 'Add another member')),
    msg,
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
      h('a', { class: 'btn', href: '#/' }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Create project')));

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    const members = rows.map((r) => ({ name: r.n.value.trim(), email: r.e.value.trim().toLowerCase() })).filter((m) => m.name || m.email);
    if (!name.value.trim()) { msg.textContent = 'Give the project a name.'; return; }
    if (members.some((m) => !m.name || !/^\S+@\S+\.\S+$/.test(m.email))) { msg.textContent = 'Every member needs a name and a valid email.'; return; }
    if (new Set(members.map((m) => m.email)).size !== members.length) { msg.textContent = 'Two members have the same email.'; return; }
    const b = budget.value.trim() === '' ? null : toCents(budget.value);
    if (b !== null && (Number.isNaN(b) || b < 0)) { msg.textContent = 'Budget must be a number, or empty.'; return; }
    try {
      const id = await api.createProject(name.value.trim(), currency.value.trim().toUpperCase() || 'PHP', b, members);
      await refreshProjects();
      toast('Project created');
      location.hash = `#/p/${id}/overview`;
    } catch (err) { msg.textContent = err.message; }
  });
  main.append(form);
}

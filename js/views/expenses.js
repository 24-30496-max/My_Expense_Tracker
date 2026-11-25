// Everything bought: searchable, filterable, shown as a list or as cards.
import { state, memberName, receiptsOf, holderOf } from '../store.js';
import { h, select, fmtDate, STATUS_LABEL, debounce } from '../util.js';
import { expenseTotal, formatMoney } from '../money.js';
import { isCounted } from '../settlement.js';
import { openExpenseDialog } from './expense-form.js';
import { openBatchDialog } from './batch-form.js';

const LAYOUT_KEY = 'bench-ledger:expenses-layout';
const readLayout = () => { try { return localStorage.getItem(LAYOUT_KEY) === 'cards' ? 'cards' : 'list'; } catch { return 'list'; } };
const saveLayout = (v) => { try { localStorage.setItem(LAYOUT_KEY, v); } catch { /* private mode: just not remembered */ } };

// Filters survive re-renders (e.g. a live update from a teammate).
const filters = { q: '', category: '', status: '', payer: '', sort: 'newest', deleted: false, layout: readLayout() };

const SORTS = {
  newest: (a, b) => b.purchased_on.localeCompare(a.purchased_on) || b.created_at.localeCompare(a.created_at),
  oldest: (a, b) => a.purchased_on.localeCompare(b.purchased_on) || a.created_at.localeCompare(b.created_at),
  highest: (a, b) => expenseTotal(b) - expenseTotal(a),
  lowest: (a, b) => expenseTotal(a) - expenseTotal(b),
  name: (a, b) => a.name.localeCompare(b.name),
};

export function renderExpenses(main) {
  const cur = state.project.currency;
  const listBox = h('div');
  const summary = h('p', { class: 'list-summary' });
  const layoutBtns = h('div', { class: 'seg', role: 'group', 'aria-label': 'Layout' });
  const batchSize = new Map();
  for (const x of state.expenses) if (x.batch_id && !x.deleted_at) batchSize.set(x.batch_id, (batchSize.get(x.batch_id) || 0) + 1);
  const batchNote = (e) => (e.batch_id && batchSize.get(e.batch_id) > 1 ? `receipt of ${batchSize.get(e.batch_id)} items` : null);

  const drawLayoutButtons = () => {
    layoutBtns.replaceChildren(...[['list', 'List'], ['cards', 'Cards']].map(([key, label]) =>
      h('button', {
        type: 'button', class: filters.layout === key ? 'on' : '', 'aria-pressed': filters.layout === key ? 'true' : 'false',
        onclick: () => { filters.layout = key; saveLayout(key); drawLayoutButtons(); apply(); },
      }, label)));
  };

  const listRow = (e) => {
    const rec = receiptsOf(e.id);
    const thumbSrc = rec.length ? state.urls[rec[0].thumb_path || rec[0].path] : null;
    const holder = holderOf(e.id);
    return h('button', { type: 'button', class: `expense-row${rec.length ? ' has-thumb' : ''}${e.deleted_at ? ' is-deleted' : ''}${e.status === 'needed' ? ' is-planned' : ''}`, onclick: () => openExpenseDialog(e) },
      rec.length ? h('span', { class: 'thumb' }, thumbSrc ? h('img', { src: thumbSrc, alt: '', loading: 'lazy' }) : null) : null,
      h('span', { class: 'row-main' },
        h('span', { class: 'row-name' }, e.name),
        h('span', { class: 'row-meta' },
          [fmtDate(e.purchased_on), e.category, `paid by ${memberName(e.paid_by)}`, holder ? `held by ${holder.name}` : null, batchNote(e), e.store].filter(Boolean).join(' · '),
          rec.length ? ` · ${rec.length} receipt${rec.length > 1 ? 's' : ''}` : '')),
      h('span', { class: 'row-amount' },
        h('span', { class: 'money' }, formatMoney(expenseTotal(e), cur)),
        h('span', { class: 'row-sub' },
          e.qty > 1 ? `${e.qty} × ${formatMoney(e.unit_price_cents, cur)}` : '',
          h('span', { class: `pill ${e.status}` }, STATUS_LABEL[e.status]))));
  };

  const card = (e) => {
    const rec = receiptsOf(e.id);
    const thumbSrc = rec.length ? state.urls[rec[0].thumb_path || rec[0].path] : null;
    const holder = holderOf(e.id);
    return h('button', { type: 'button', class: `expense-card${e.deleted_at ? ' is-deleted' : ''}${e.status === 'needed' ? ' is-planned' : ''}`, onclick: () => openExpenseDialog(e) },
      thumbSrc ? h('span', { class: 'card-photo' }, h('img', { src: thumbSrc, alt: '', loading: 'lazy' })) : null,
      h('span', { class: 'card-body' },
        h('span', { class: 'card-top' },
          h('span', { class: 'row-name' }, e.name),
          h('span', { class: `pill ${e.status}` }, STATUS_LABEL[e.status])),
        h('span', { class: 'card-price money' }, formatMoney(expenseTotal(e), cur)),
        e.qty > 1 ? h('span', { class: 'row-meta' }, `${e.qty} × ${formatMoney(e.unit_price_cents, cur)}`) : null,
        h('span', { class: 'card-facts' },
          h('span', {}, h('span', { class: 'muted' }, 'Paid by '), memberName(e.paid_by)),
          holder ? h('span', {}, h('span', { class: 'muted' }, 'Held by '), holder.name) : h('span', { class: 'muted' }, 'Not assigned yet'),
          h('span', { class: 'muted' }, [fmtDate(e.purchased_on), e.category, batchNote(e), e.store].filter(Boolean).join(' · ')),
          rec.length ? h('span', { class: 'muted' }, `${rec.length} receipt${rec.length > 1 ? 's' : ''}`) : null)));
  };

  const apply = () => {
    const q = filters.q.trim().toLowerCase();
    let rows = state.expenses.filter((e) => (filters.deleted ? !!e.deleted_at : !e.deleted_at));
    if (q) rows = rows.filter((e) => [e.name, e.store, e.notes, e.category].some((s) => (s || '').toLowerCase().includes(q)));
    if (filters.category) rows = rows.filter((e) => e.category === filters.category);
    if (filters.status) rows = rows.filter((e) => e.status === filters.status);
    if (filters.payer) rows = rows.filter((e) => e.paid_by === filters.payer);
    rows.sort(SORTS[filters.sort]);

    listBox.className = filters.layout === 'cards' ? 'expense-cards' : 'expense-list';
    listBox.replaceChildren();
    if (!rows.length) {
      const none = !state.expenses.some((e) => !e.deleted_at);
      listBox.append(h('div', { class: 'empty' },
        h('p', {}, filters.deleted ? 'No deleted expenses.' : none ? 'No expenses yet.' : 'Nothing matches these filters.'),
        none && !filters.deleted && state.project.status === 'active'
          ? h('div', { class: 'empty-actions' },
            h('button', { class: 'btn primary', onclick: () => openExpenseDialog(null) }, 'Add the first expense'),
            h('button', { class: 'btn', onclick: () => openBatchDialog() }, 'Add a whole receipt'),
            h('a', { class: 'btn', href: `#/p/${state.pid}/import` }, 'Import past expenses'))
          : null));
    }
    for (const e of rows) listBox.append(filters.layout === 'cards' ? card(e) : listRow(e));
    const counted = rows.filter(isCounted);
    summary.textContent = `${rows.length} item${rows.length === 1 ? '' : 's'}${filters.deleted ? ' deleted' : `, ${formatMoney(counted.reduce((s, e) => s + expenseTotal(e), 0), cur)} counted`}`;
  };

  const cats = state.project.categories || [];
  const search = h('input', { type: 'search', placeholder: 'Search items, stores, notes', value: filters.q, 'aria-label': 'Search expenses', class: 'grow' });
  search.addEventListener('input', debounce(() => { filters.q = search.value; apply(); }, 120));
  const bind = (el, key) => { el.addEventListener('change', () => { filters[key] = el.value; apply(); }); return el; };

  main.append(
    h('div', { class: 'toolbar' },
      search,
      bind(select([['', 'All categories'], ...cats.map((c) => [c, c])], filters.category, { 'aria-label': 'Category' }), 'category'),
      bind(select([['', 'All statuses'], ...Object.entries(STATUS_LABEL)], filters.status, { 'aria-label': 'Status' }), 'status'),
      bind(select([['', 'Anyone paid'], ...state.members.map((m) => [m.id, m.name])], filters.payer, { 'aria-label': 'Paid by' }), 'payer'),
      bind(select([['newest', 'Newest first'], ['oldest', 'Oldest first'], ['highest', 'Highest price'], ['lowest', 'Lowest price'], ['name', 'Name A-Z']], filters.sort, { 'aria-label': 'Sort' }), 'sort'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: filters.deleted, onchange: (ev) => { filters.deleted = ev.target.checked; apply(); } }),
        'Show deleted')),
    h('div', { class: 'summary-bar' }, summary,
      h('div', { class: 'bar-actions' },
        state.project.status === 'active' ? h('button', { class: 'btn small', onclick: () => openBatchDialog() }, 'Add receipt') : null, layoutBtns)),
    listBox,
  );
  drawLayoutButtons();
  apply();
}

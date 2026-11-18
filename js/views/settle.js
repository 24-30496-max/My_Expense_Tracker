// Who owes whom, the fewest payments to square up, and a record of payments made.
import * as api from '../api.js';
import { state, refreshProject, memberName, isActive } from '../store.js';
import { h, select, field, modal, today, toast, fmtDate, confirmBox } from '../util.js';
import { formatMoney, toCents, centsToPlain } from '../money.js';
import { computeBalances, suggestSettlements } from '../settlement.js';

export function openPaymentDialog(prefill = {}) {
  const cur = state.project.currency;
  const opts = state.members.map((m) => [m.id, m.name]);
  const meId = state.me ? state.me.id : state.members[0].id;
  const from = select(opts, prefill.from || meId);
  const to = select(opts, prefill.to || (state.members.find((m) => m.id !== (prefill.from || meId)) || {}).id);
  const amount = h('input', { type: 'text', inputMode: 'decimal', value: prefill.amount ? centsToPlain(prefill.amount) : '', placeholder: '0.00', required: true });
  const date = h('input', { type: 'date', value: today(), required: true });
  const note = h('input', { type: 'text', placeholder: 'GCash, cash, bank transfer...' });
  const msg = h('p', { class: 'form-msg', role: 'alert' });
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('div', { class: 'row2' }, field('Who paid', from), field('Paid to', to)),
    h('div', { class: 'row2' }, field(`Amount (${cur})`, amount), field('Date', date)),
    field('Note', note),
    msg,
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Record payment')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = toCents(amount.value);
    if (from.value === to.value) { msg.textContent = 'Choose two different members.'; return; }
    if (Number.isNaN(cents) || cents <= 0) { msg.textContent = 'Enter an amount greater than zero.'; return; }
    try {
      await api.insertPayment({ project_id: state.pid, from_member: from.value, to_member: to.value, amount_cents: cents, paid_on: date.value, note: note.value.trim() || null });
      await refreshProject();
      toast('Payment recorded');
      m.close();
    } catch (err) { msg.textContent = err.message; }
  });
  const m = modal({ title: 'Record payment', content: form });
}

export function renderSettle(main) {
  const { project, members, expenses, payments } = state;
  const cur = project.currency;
  const { rows, totalSpent } = computeBalances({ members, expenses, payments });
  const maxAbs = Math.max(1, ...Object.values(rows).map((r) => Math.abs(r.balance)));
  const plan = suggestSettlements(rows);
  const active = isActive();

  const board = h('section', { class: 'panel' },
    h('h2', {}, 'Where everyone stands'),
    h('p', { class: 'muted' }, `Fair share each: about ${formatMoney(Math.round(totalSpent / Math.max(1, members.length)), cur)}. Bars show who is above or below an equal split, after payments already recorded.`),
    h('div', { class: 'ledger' }, members.map((mb) => {
      const r = rows[mb.id];
      const side = r.balance > 0 ? 'pos' : r.balance < 0 ? 'neg' : 'zero';
      const width = (Math.abs(r.balance) / maxAbs) * 50;
      const text = r.balance > 0 ? `is owed ${formatMoney(r.balance, cur)}` : r.balance < 0 ? `owes ${formatMoney(-r.balance, cur)}` : 'all settled';
      return h('div', { class: 'ledger-row' },
        h('div', { class: 'ledger-who' }, mb.name, state.me && mb.id === state.me.id ? h('span', { class: 'you' }, 'you') : null),
        h('div', { class: 'diverge', role: 'img', 'aria-label': `${mb.name} ${text}` },
          h('span', { class: 'diverge-mid' }),
          h('span', { class: `diverge-bar ${side}`, style: `width:${width}%` })),
        h('div', { class: `ledger-amt ${side}` }, text),
        h('div', { class: 'ledger-sub muted' },
          `Paid ${formatMoney(r.paid, cur)}, share ${formatMoney(r.share, cur)}`,
          r.sent || r.received ? `, payments ${formatMoney(r.sent - r.received, cur)}` : ''));
    })),
    h('div', { class: 'ledger-axis muted', 'aria-hidden': 'true' }, h('span', {}, 'owes'), h('span', {}, 'equal share'), h('span', {}, 'is owed')));

  const steps = h('section', { class: 'panel' },
    h('h2', {}, 'To settle up'),
    plan.length
      ? h('ul', { class: 'plan' }, plan.map((p) => h('li', {},
        h('span', {}, h('strong', {}, memberName(p.from)), ' pays ', h('strong', {}, memberName(p.to))),
        h('span', { class: 'money' }, formatMoney(p.amount, cur)),
        active ? h('button', { class: 'btn small', onclick: () => openPaymentDialog({ from: p.from, to: p.to, amount: p.amount }) }, 'Record payment') : null)))
      : h('p', {}, totalSpent ? 'Everyone is settled. Nobody owes anything.' : 'Nothing to settle yet.'),
    active ? h('p', {}, h('button', { class: 'btn', onclick: () => openPaymentDialog() }, 'Record a different payment')) : null);

  const live = payments.filter((p) => !p.deleted_at);
  const history = h('section', { class: 'panel' },
    h('h2', {}, 'Payments recorded'),
    live.length
      ? h('ul', { class: 'pay-list' }, live.map((p) => h('li', {},
        h('span', {}, h('strong', {}, memberName(p.from_member)), ' paid ', h('strong', {}, memberName(p.to_member)),
          h('span', { class: 'muted' }, ` on ${fmtDate(p.paid_on)}${p.note ? `, ${p.note}` : ''}`)),
        h('span', { class: 'money' }, formatMoney(p.amount_cents, cur)),
        active && p.created_by === state.user.id ? h('button', {
          class: 'btn small danger-quiet',
          onclick: async () => {
            if (!(await confirmBox('Undo this payment? Balances will go back to what they were before it.', 'Undo payment', true))) return;
            try { await api.undoPayment(p.id); await refreshProject(); toast('Payment undone'); } catch (err) { toast(err.message, 'error'); }
          },
        }, 'Undo') : null)))
      : h('p', { class: 'muted' }, 'No payments recorded yet.'));

  main.append(board, steps, history);
}

// Who owes whom, the fewest payments to square up, and a record of payments made.
import * as api from '../api.js';
import { state, refreshProject, memberName, isActive, otherSide, canConfirmWith } from '../store.js';
import { h, select, field, modal, today, toast, fmtDate, confirmBox } from '../util.js';
import { formatMoney, toCents, centsToPlain } from '../money.js';
import { computeBalances, suggestSettlements, isPaymentCounted } from '../settlement.js';
import { waitingPanel, askUndo } from './agreements.js';

export function openPaymentDialog(prefill = {}) {
  const cur = state.project.currency;
  const opts = state.members.map((m) => [m.id, m.name]);
  const meId = state.me ? state.me.id : state.members[0].id;
  const from = select(opts, prefill.from || meId);
  const to = select(opts, prefill.to || (state.members.find((m) => m.id !== (prefill.from || meId)) || {}).id);
  const amount = h('input', { type: 'text', inputMode: 'decimal', value: prefill.amount ? centsToPlain(prefill.amount) : '', placeholder: '0.00', required: true });
  const date = h('input', { type: 'date', value: today(), required: true });
  const note = h('input', { type: 'text', placeholder: 'GCash, cash, personal item, correction...' });
  const how = select([['ask', 'Ask them to confirm'], ['now', 'Record it now']], 'ask', { 'aria-label': 'How to record' });
  const hint = h('p', { class: 'muted how-hint' });
  const msg = h('p', { class: 'form-msg', role: 'alert' });

  // "Ask them to confirm" needs: I am one of the two people, and the other one has signed in.
  const askState = () => {
    const involvesMe = state.me && (from.value === state.me.id) !== (to.value === state.me.id);
    if (!involvesMe) return { ok: false, why: 'You can ask for confirmation only when you are one of the two people.' };
    const other = from.value === state.me.id ? to.value : from.value;
    if (!canConfirmWith(other)) return { ok: false, why: `${memberName(other)} has not signed in yet, so they cannot confirm.` };
    return { ok: true, other };
  };
  const sync = (reset) => {
    const a = askState();
    how.querySelector('option[value="ask"]').disabled = !a.ok;
    if (!a.ok) how.value = 'now'; else if (reset) how.value = 'ask';
    hint.textContent = how.value === 'ask'
      ? `${memberName(a.other)} will see this on their Overview and must confirm before it counts.`
      : `Counted straight away. Use this when you already agreed in person.${a.ok ? '' : ' ' + a.why}`;
  };
  [from, to].forEach((el) => el.addEventListener('change', () => sync(true)));
  how.addEventListener('change', () => sync(false));
  sync(true);

  const form = h('form', { class: 'form-grid', novalidate: true },
    h('div', { class: 'row2' }, field('Who pays', from), field('Who receives', to)),
    h('div', { class: 'row2' }, field(`Amount (${cur})`, amount), field('Date', date)),
    field('Reason or note', note),
    field('How to record it', how), hint,
    msg,
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const cents = toCents(amount.value);
    if (from.value === to.value) { msg.textContent = 'Choose two different members.'; return; }
    if (Number.isNaN(cents) || cents <= 0) { msg.textContent = 'Enter an amount greater than zero.'; return; }
    const row = { project_id: state.pid, from_member: from.value, to_member: to.value, amount_cents: cents, paid_on: date.value, note: note.value.trim() || null };
    try {
      if (how.value === 'ask') {
        if (!askState().ok) { msg.textContent = askState().why; return; }
        await api.proposePayment(row);
        toast(`Sent to ${memberName(askState().other)} to confirm`);
      } else {
        await api.insertPayment(row);
        toast('Payment recorded');
      }
      await refreshProject();
      m.close();
    } catch (err) { msg.textContent = err.message; }
  });
  const m = modal({ title: 'Payment or agreement', content: form });
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
    active ? h('p', {}, h('button', { class: 'btn', onclick: () => openPaymentDialog() }, 'New payment or agreement')) : null);

  const me = state.me && state.me.id;
  const live = payments.filter(isPaymentCounted);
  const label = (p) => (p.proposed_by ? `Confirmed by ${memberName(otherSide(p, p.proposed_by))}` : 'Recorded directly');
  const undoCell = (p) => {
    if (!active) return null;
    if (!p.proposed_by) {
      return p.created_by === state.user.id ? h('button', {
        class: 'btn small danger-quiet',
        onclick: async () => {
          if (!(await confirmBox('Undo this payment? Balances will go back to what they were before it.', 'Undo payment', true))) return;
          try { await api.undoPayment(p.id); await refreshProject(); toast('Payment undone'); } catch (err) { toast(err.message, 'error'); }
        },
      }, 'Undo') : null;
    }
    const party = me && (p.from_member === me || p.to_member === me);
    if (!party) return null;
    if (!p.undo_requested_by) {
      return h('button', {
        class: 'btn small danger-quiet',
        onclick: async () => {
          if (!(await confirmBox(`Ask ${memberName(otherSide(p, me))} to agree to undo this? It stays counted until they agree.`, 'Ask to undo', true))) return;
          await askUndo(p);
        },
      }, 'Ask to undo');
    }
    return h('span', { class: 'muted small-note' }, p.undo_requested_by === me ? 'Undo asked' : `Undo asked by ${memberName(p.undo_requested_by)}`);
  };
  const history = h('section', { class: 'panel' },
    h('h2', {}, 'Agreements and payments'),
    live.length
      ? h('ul', { class: 'pay-list' }, live.map((p) => h('li', { 'data-payment': p.id },
        h('span', {}, h('strong', {}, memberName(p.from_member)), ' paid ', h('strong', {}, memberName(p.to_member)),
          h('span', { class: 'muted' }, ` on ${fmtDate(p.paid_on)}${p.note ? `, ${p.note}` : ''}. ${label(p)}`)),
        h('span', { class: 'money' }, formatMoney(p.amount_cents, cur)),
        undoCell(p))))
      : h('p', { class: 'muted' }, 'No payments or agreements yet.'));

  const closed = payments.filter((p) => !isPaymentCounted(p) && p.status !== 'pending');
  const closedText = (p) => {
    if (p.status === 'declined') return `Declined by ${memberName(otherSide(p, p.proposed_by))}${p.decline_reason ? `: ${p.decline_reason}` : ''}`;
    if (p.status === 'cancelled') return `Cancelled by ${memberName(p.proposed_by)}`;
    return 'Undone';
  };
  const past = closed.length ? h('details', { class: 'panel history' }, h('summary', {}, `History (${closed.length} declined, cancelled or undone)`),
    h('ul', { class: 'pay-list greyed' }, closed.map((p) => h('li', {},
      h('span', {}, h('strong', {}, memberName(p.from_member)), ' to ', h('strong', {}, memberName(p.to_member)),
        h('span', { class: 'muted' }, ` on ${fmtDate(p.paid_on)}${p.note ? `, ${p.note}` : ''}. ${closedText(p)}`)),
      h('span', { class: 'money' }, formatMoney(p.amount_cents, cur)))))) : null;

  main.append(board, ...[waitingPanel({ mine: false }), steps, history, past].filter(Boolean));
}

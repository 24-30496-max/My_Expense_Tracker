// Agreements between two members: one proposes, the other confirms before it counts.
import * as api from '../api.js';
import { state, refreshProject, memberName, isActive, needsMyAnswer, myWaiting, waitingAgreements, otherSide } from '../store.js';
import { h, field, modal, toast, fmtDate } from '../util.js';
import { formatMoney } from '../money.js';

const cur = () => state.project.currency;

/** "Andrei pays Fesarit ₱500.00" with date and note underneath. */
export function agreementLine(p) {
  return h('span', { class: 'agr-text' },
    h('span', {}, h('strong', {}, memberName(p.from_member)), ' pays ', h('strong', {}, memberName(p.to_member)), ' ', h('span', { class: 'money' }, formatMoney(p.amount_cents, cur()))),
    h('span', { class: 'muted' }, [fmtDate(p.paid_on), p.note, `proposed by ${memberName(p.proposed_by)}`].filter(Boolean).join(' · ')));
}

async function run(fn, done) {
  try { await fn(); await refreshProject(); toast(done); } catch (err) { toast(err.message, 'error'); await refreshProject().catch(() => {}); }
}

export const confirmAgreement = (p) => run(() => api.decidePayment(p.id, true), 'Confirmed. It now counts in the balances.');
export const cancelAgreement = (p) => run(() => api.cancelPayment(p.id), 'Cancelled');
export const askUndo = (p) => run(() => api.requestUndo(p.id), `Asked ${memberName(otherSide(p, state.me.id))} to agree to undo it`);
export const withdrawUndo = (p) => run(() => api.cancelUndo(p.id), 'Undo request withdrawn');
export const agreeUndo = (p) => run(() => api.decideUndo(p.id, true), 'Undone. The balances went back.');
export const keepAgreement = (p) => run(() => api.decideUndo(p.id, false), 'Kept as it was');

export function declineAgreement(p) {
  const reason = h('textarea', { rows: 2, placeholder: 'For example: the amount is wrong', maxLength: 200 });
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('p', {}, `${memberName(p.from_member)} pays ${memberName(p.to_member)} ${formatMoney(p.amount_cents, cur())}. Nothing changes in the balances if you decline.`),
    field('Reason (optional)', reason),
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Back'),
      h('button', { class: 'btn danger', type: 'submit' }, 'Decline')));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    m.close();
    await run(() => api.decidePayment(p.id, false, reason.value.trim() || null), 'Declined');
  });
  const m = modal({ title: 'Decline this agreement?', content: form });
}

const btn = (label, cls, fn) => h('button', { class: `btn small ${cls}`.trim(), type: 'button', onclick: () => fn() }, label);

/**
 * The "waiting" panel. mine=true (Overview): only what needs me or what I sent.
 * mine=false (Settle up): every waiting agreement in the project.
 * Returns null when there is nothing to show.
 */
export function waitingPanel({ mine }) {
  const active = isActive();
  const me = state.me && state.me.id;
  const need = needsMyAnswer();
  const sent = myWaiting();
  const items = [];

  for (const p of need.confirm) {
    items.push(h('li', { class: 'agr need' }, agreementLine(p),
      h('span', { class: 'agr-note muted' }, `Once you confirm, this lowers what ${memberName(p.from_member)} owes.`),
      active ? h('span', { class: 'agr-actions' }, btn('Confirm', 'primary', () => confirmAgreement(p)), btn('Decline', '', () => declineAgreement(p))) : null));
  }
  for (const p of need.undo) {
    items.push(h('li', { class: 'agr need' }, agreementLine(p),
      h('span', { class: 'agr-note muted' }, `${memberName(p.undo_requested_by)} asks to undo this payment. If you agree, balances go back to before it.`),
      active ? h('span', { class: 'agr-actions' }, btn('Agree to undo', 'primary', () => agreeUndo(p)), btn('Keep it', '', () => keepAgreement(p))) : null));
  }
  const heading = need.confirm.length + need.undo.length ? 'Waiting for your OK' : null;

  const waitingRows = [];
  for (const p of sent.proposals) {
    waitingRows.push(h('li', { class: 'agr' }, agreementLine(p),
      h('span', { class: 'agr-note muted' }, `Waiting for ${memberName(otherSide(p, me))} to confirm. It does not count yet.`),
      active ? h('span', { class: 'agr-actions' }, btn('Cancel', 'danger-quiet', () => cancelAgreement(p))) : null));
  }
  for (const p of sent.undo) {
    waitingRows.push(h('li', { class: 'agr' }, agreementLine(p),
      h('span', { class: 'agr-note muted' }, `You asked ${memberName(otherSide(p, me))} to agree to undo this payment.`),
      active ? h('span', { class: 'agr-actions' }, btn('Withdraw', 'danger-quiet', () => withdrawUndo(p))) : null));
  }
  if (!mine) {
    // everyone else's waiting agreements, for visibility (the project creator can see them all)
    for (const p of waitingAgreements().filter((x) => x.from_member !== me && x.to_member !== me)) {
      waitingRows.push(h('li', { class: 'agr' }, agreementLine(p),
        h('span', { class: 'agr-note muted' }, `Waiting for ${memberName(otherSide(p, p.proposed_by))} to confirm. It does not count yet.`)));
    }
  }

  if (!items.length && !waitingRows.length) return null;
  return h('section', { class: `panel${items.length ? ' attention' : ''}`, 'data-panel': 'agreements' },
    heading ? h('h2', {}, heading) : null,
    items.length ? h('ul', { class: 'agr-list' }, items) : null,
    waitingRows.length ? h('h3', { class: 'agr-sub' }, mine ? 'Waiting for the other person' : 'Waiting for confirmation') : null,
    waitingRows.length ? h('ul', { class: 'agr-list' }, waitingRows) : null);
}

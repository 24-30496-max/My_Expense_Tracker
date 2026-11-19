// Owners tab: who holds each component. The project owner assigns items and approves requests;
// any member can ask for an item they do not hold.
import * as api from '../api.js';
import { state, refreshProject, holderOf, pendingRequests, myPendingFor, isOwner, isActive, ownerName, memberName } from '../store.js';
import { h, select, modal, toast, confirmBox, fmtDate, STATUS_LABEL } from '../util.js';
import { expenseTotal, formatMoney } from '../money.js';
import { openExpenseDialog } from './expense-form.js';

// Kept across redraws so a live update does not reset your search.
const ui = { q: '', mine: false };

function openRequestDialog(expense) {
  const holder = holderOf(expense.id);
  const note = h('textarea', { rows: 2, placeholder: 'Optional: why you need it, or when you will use it' });
  const msg = h('p', { class: 'form-msg err', role: 'alert' });
  const send = h('button', { class: 'btn primary', type: 'submit' }, 'Send request');
  const form = h('form', { class: 'form-grid', novalidate: true },
    h('p', {}, `Ask ${ownerName()} to assign `, h('strong', {}, expense.name), ' to you.',
      holder ? ` It is currently with ${holder.name}.` : ' It is not assigned to anyone yet.'),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Note'), note),
    msg,
    h('div', { class: 'actions' }, h('span', { class: 'spacer' }),
      h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), send));
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    send.disabled = true;
    try {
      await api.requestComponent({
        project_id: state.pid, expense_id: expense.id, requester_member: state.me.id,
        requested_by: state.user.id, note: note.value.trim() || null,
      });
      await refreshProject();
      toast('Request sent');
      m.close();
    } catch (err) { msg.textContent = err.message; send.disabled = false; }
  });
  const m = modal({ title: 'Request this item', content: form });
}

export function renderOwners(main) {
  const owner = isOwner();
  const active = isActive();
  const cur = state.project.currency;
  const ownerLabel = ownerName();
  const alive = state.expenses.filter((e) => !e.deleted_at);
  const byId = new Map(state.expenses.map((e) => [e.id, e]));

  main.append(h('p', { class: 'muted' }, owner
    ? 'Assign each component to the member who keeps it. Members can request items, and you approve or decline here.'
    : `${ownerLabel} assigns each component to the member who keeps it. You can request an item and ${ownerLabel} will approve or decline.`));

  // ----- requests waiting for a decision -----
  const pending = pendingRequests();
  if (pending.length) {
    main.append(h('section', { class: 'panel attention' },
      h('h2', {}, owner ? `Requests to review (${pending.length})` : `Open requests (${pending.length})`),
      h('ul', { class: 'request-list' }, pending.map((r) => {
        const e = byId.get(r.expense_id);
        const holder = holderOf(r.expense_id);
        const mine = state.me && r.requester_member === state.me.id;
        return h('li', {},
          h('div', { class: 'request-main' },
            h('p', {}, h('strong', {}, memberName(r.requester_member)), ' wants ', h('strong', {}, e.name),
              h('span', { class: 'muted' }, ` (${formatMoney(expenseTotal(e), cur)}), ${holder ? `now with ${holder.name}` : 'not assigned yet'}`)),
            r.note ? h('p', { class: 'muted quote' }, `"${r.note}"`) : null,
            h('p', { class: 'muted small' }, `Asked ${fmtDate(r.created_at)}`)),
          h('div', { class: 'request-actions' },
            owner && active ? [
              h('button', { class: 'btn small primary', onclick: async () => {
                try { await api.decideRequest(r.id, true); await refreshProject(); toast(`${e.name} assigned to ${memberName(r.requester_member)}`); } catch (err) { toast(err.message, 'error'); }
              } }, 'Approve'),
              h('button', { class: 'btn small', onclick: async () => {
                try { await api.decideRequest(r.id, false); await refreshProject(); toast('Request declined'); } catch (err) { toast(err.message, 'error'); }
              } }, 'Decline'),
            ] : null,
            !owner ? h('span', { class: 'muted small' }, `Waiting for ${ownerLabel}`) : null,
            mine && active ? h('button', { class: 'btn small danger-quiet', onclick: async () => {
              try { await api.withdrawRequest(r.id); await refreshProject(); toast('Request withdrawn'); } catch (err) { toast(err.message, 'error'); }
            } }, 'Withdraw') : null));
      }))));
  }

  // ----- items grouped by holder -----
  const box = h('div', { class: 'owner-groups' });
  const draw = () => {
    box.replaceChildren();
    const q = ui.q.trim().toLowerCase();
    const visible = alive.filter((e) => {
      if (q && !`${e.name} ${e.category || ''} ${e.store || ''}`.toLowerCase().includes(q)) return false;
      if (ui.mine && !(holderOf(e.id) && state.me && holderOf(e.id).id === state.me.id)) return false;
      return true;
    }).sort((a, b) => a.name.localeCompare(b.name));

    const groups = [...state.members.map((m) => ({ key: m.id, member: m })), { key: 'none', member: null }];
    for (const g of groups) {
      const items = visible.filter((e) => {
        const hld = holderOf(e.id);
        return g.member ? hld && hld.id === g.member.id : !hld;
      });
      if (ui.mine && !g.member) continue;
      const total = items.reduce((s, e) => s + expenseTotal(e), 0);
      const isMe = g.member && state.me && g.member.id === state.me.id;
      box.append(h('section', { class: `panel group${g.member ? '' : ' unassigned'}` },
        h('div', { class: 'panel-head' },
          h('h2', {}, g.member ? g.member.name : 'Not assigned yet', isMe ? h('span', { class: 'you' }, 'you') : null,
            g.member && !g.member.email ? h('span', { class: 'pill needed' }, 'Temporary') : null),
          h('span', { class: 'muted money' }, `${items.length} item${items.length === 1 ? '' : 's'}${items.length ? `, ${formatMoney(total, cur)}` : ''}`)),
        items.length
          ? h('ul', { class: 'owner-items' }, items.map((e) => itemRow(e)))
          : h('p', { class: 'muted' }, g.member ? 'Nothing assigned yet.' : 'Every item has someone holding it.')));
    }
    if (!alive.length) box.replaceChildren(h('section', { class: 'panel empty' }, h('p', {}, 'No components yet. Add expenses first, then assign them here.')));
  };

  function itemRow(e) {
    const holder = holderOf(e.id);
    const mine = holder && state.me && holder.id === state.me.id;
    const pend = myPendingFor(e.id);
    let action = null;
    if (owner && active) {
      const sel = select([['', 'Not assigned'], ...state.members.map((m) => [m.id, m.name])], holder ? holder.id : '', { 'aria-label': `Holder of ${e.name}` });
      sel.addEventListener('change', async () => {
        try {
          if (sel.value) await api.assignComponent(state.pid, e.id, sel.value, state.user.id);
          else await api.unassignComponent(e.id);
          await refreshProject();
          toast(sel.value ? `${e.name} assigned to ${memberName(sel.value)}` : `${e.name} is now unassigned`);
        } catch (err) { toast(err.message, 'error'); await refreshProject(); }
      });
      action = sel;
    } else if (mine) {
      action = h('span', { class: 'pill received' }, 'You hold this');
    } else if (pend) {
      action = h('span', { class: 'pill ordered' }, 'Requested');
    } else if (active && state.me) {
      action = h('button', { class: 'btn small', onclick: () => openRequestDialog(e) }, 'Request');
    }
    return h('li', {},
      h('button', { type: 'button', class: 'item-link', onclick: () => openExpenseDialog(e) },
        h('span', { class: 'row-name' }, e.name),
        h('span', { class: 'row-meta' }, `${formatMoney(expenseTotal(e), cur)} · ${STATUS_LABEL[e.status]}${e.category ? ` · ${e.category}` : ''}`)),
      h('div', { class: 'item-action' }, action));
  }

  const search = h('input', { type: 'search', placeholder: 'Search components', value: ui.q, 'aria-label': 'Search components', class: 'grow' });
  search.addEventListener('input', () => { ui.q = search.value; draw(); });
  main.append(
    h('div', { class: 'toolbar owners-toolbar' }, search,
      state.me ? h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: ui.mine, onchange: (ev) => { ui.mine = ev.target.checked; draw(); } }), 'Only mine') : null),
    box);
  draw();

  // ----- what happened to past requests -----
  const done = state.requests.filter((r) => r.status !== 'pending' && byId.has(r.expense_id)).slice(0, 10);
  if (done.length) {
    const label = { approved: 'approved', declined: 'declined', cancelled: 'withdrawn', superseded: 'closed (item was assigned to someone else)' };
    main.append(h('section', { class: 'panel' },
      h('h2', {}, 'Recent decisions'),
      h('ul', { class: 'history-list' }, done.map((r) => h('li', {},
        `${memberName(r.requester_member)}'s request for ${byId.get(r.expense_id).name} was ${label[r.status]}${r.decided_at ? `, ${fmtDate(r.decided_at)}` : ''}`)))));
  }
}

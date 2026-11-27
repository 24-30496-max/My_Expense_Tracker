// Dashboard: how much was spent, against budget, by category, over time, and by person.
import { state } from '../store.js';
import { h, fmtDate } from '../util.js';
import { expenseTotal, formatMoney } from '../money.js';
import { computeBalances, isCounted } from '../settlement.js';
import { openExpenseDialog } from './expense-form.js';
import { waitingPanel } from './agreements.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  kids.forEach((k) => el.append(k));
  return el;
};

function compact(cents, currency) {
  try {
    return new Intl.NumberFormat('en-PH', { style: 'currency', currency, notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
  } catch { return String(Math.round(cents / 100)); }
}

function niceMax(v) {
  if (v <= 0) return 100;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function categoryBars(expenses, cur) {
  const totals = new Map();
  for (const e of expenses) {
    const k = e.category || 'No category';
    totals.set(k, (totals.get(k) || 0) + expenseTotal(e));
  }
  const items = [...totals.entries()].sort((a, b) => b[1] - a[1]);
  const max = items.length ? items[0][1] : 1;
  const sum = items.reduce((s, i) => s + i[1], 0) || 1;
  return h('div', { class: 'bars', role: 'list' }, items.map(([label, cents]) =>
    h('div', { class: 'bar-row', role: 'listitem' },
      h('span', { class: 'bar-label' }, label),
      h('span', { class: 'bar-track' }, h('span', { class: 'bar-fill', style: `width:${Math.max(2, (cents / max) * 100)}%` })),
      h('span', { class: 'bar-value money' }, formatMoney(cents, cur), h('small', {}, ` ${Math.round((cents / sum) * 100)}%`)))));
}

function trendChart(expenses, cur, width) {
  const byDay = new Map();
  for (const e of expenses) byDay.set(e.purchased_on, (byDay.get(e.purchased_on) || 0) + expenseTotal(e));
  const days = [...byDay.keys()].sort();
  if (days.length < 2) {
    return h('p', { class: 'muted' }, 'The trend appears once expenses fall on at least two different dates.');
  }
  let run = 0;
  const pts = days.map((d) => { run += byDay.get(d); return { d, day: byDay.get(d), cum: run, t: new Date(`${d}T00:00:00`).getTime() }; });
  const W = Math.max(300, Math.min(760, width));
  const H = 220;
  const m = { l: 52, r: 14, t: 12, b: 28 };
  const yMax = niceMax(run);
  const x = (t) => m.l + ((t - pts[0].t) / (pts[pts.length - 1].t - pts[0].t)) * (W - m.l - m.r);
  const y = (v) => H - m.b - (v / yMax) * (H - m.t - m.b);

  const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'trend', role: 'img', 'aria-label': `Cumulative spending from ${fmtDate(days[0])} to ${fmtDate(days[days.length - 1])}, reaching ${formatMoney(run, cur)}` });
  for (const frac of [0, 0.5, 1]) {
    const v = yMax * frac;
    root.append(
      svg('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: 'grid' }),
      Object.assign(svg('text', { x: m.l - 8, y: y(v) + 4, class: 'axis', 'text-anchor': 'end' }), { textContent: compact(v, cur) }));
  }
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.cum).toFixed(1)}`).join(' ');
  root.append(
    svg('path', { d: `${line} L${x(pts[pts.length - 1].t)},${y(0)} L${x(pts[0].t)},${y(0)} Z`, class: 'area' }),
    svg('path', { d: line, class: 'line' }));
  const xl = [pts[0], pts[pts.length - 1]];
  xl.forEach((p, i) => root.append(Object.assign(svg('text', { x: x(p.t), y: H - 8, class: 'axis', 'text-anchor': i ? 'end' : 'start' }), { textContent: fmtDate(p.d) })));
  const dot = svg('circle', { r: 5, class: 'dot', cx: -10, cy: -10 });
  root.append(dot);

  const tip = h('div', { class: 'tip', hidden: true });
  const wrap = h('div', { class: 'chart' }, root, tip);
  const move = (ev) => {
    const box = root.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    let best = pts[0];
    for (const p of pts) if (Math.abs(x(p.t) - px) < Math.abs(x(best.t) - px)) best = p;
    dot.setAttribute('cx', x(best.t));
    dot.setAttribute('cy', y(best.cum));
    tip.hidden = false;
    tip.replaceChildren(h('strong', {}, fmtDate(best.d)), h('div', {}, `Total so far ${formatMoney(best.cum, cur)}`), h('div', { class: 'muted' }, `That day ${formatMoney(best.day, cur)}`));
    const left = (x(best.t) / W) * box.width;
    tip.style.left = `${Math.min(Math.max(left, 70), box.width - 70)}px`;
    tip.style.top = `${(y(best.cum) / H) * box.height - 8}px`;
  };
  root.addEventListener('pointermove', move);
  root.addEventListener('pointerdown', move);
  root.addEventListener('pointerleave', () => { tip.hidden = true; dot.setAttribute('cx', -10); });

  const table = h('details', { class: 'data-table' }, h('summary', {}, 'View as table'),
    h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Date'), h('th', { class: 'num' }, 'That day'), h('th', { class: 'num' }, 'Total so far'))),
      h('tbody', {}, pts.map((p) => h('tr', {}, h('td', {}, fmtDate(p.d)), h('td', { class: 'num money' }, formatMoney(p.day, cur)), h('td', { class: 'num money' }, formatMoney(p.cum, cur)))))));
  return h('div', {}, wrap, table);
}

export function renderOverview(main) {
  const { project, members, expenses, payments } = state;
  const cur = project.currency;
  const counted = expenses.filter(isCounted);
  const planned = expenses.filter((e) => !e.deleted_at && e.status === 'needed');
  const { rows, totalSpent } = computeBalances({ members, expenses, payments });
  const plannedTotal = planned.reduce((s, e) => s + expenseTotal(e), 0);
  const budget = project.budget_cents;

  const head = h('section', { class: 'panel hero' },
    h('div', { class: 'hero-figure' },
      h('p', { class: 'hero-label' }, 'Spent so far'),
      h('p', { class: 'hero-number money' }, formatMoney(totalSpent, cur)),
      h('p', { class: 'muted' }, `${counted.length} item${counted.length === 1 ? '' : 's'}${plannedTotal ? `, plus ${formatMoney(plannedTotal, cur)} still needed` : ''}. About ${formatMoney(Math.round(totalSpent / Math.max(1, members.length)), cur)} per member.`)),
    budget
      ? (() => {
        const pct = Math.min(100, (totalSpent / budget) * 100);
        const over = totalSpent > budget;
        return h('div', { class: 'budget' },
          h('div', { class: 'budget-line' },
            h('span', {}, 'Budget'), h('span', { class: 'money' }, formatMoney(budget, cur))),
          h('div', { class: `meter${over ? ' over' : ''}`, role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(pct), 'aria-label': 'Budget used' },
            h('span', { style: `width:${pct}%` })),
          h('p', { class: over ? 'warn' : 'muted' },
            over ? `Over budget by ${formatMoney(totalSpent - budget, cur)}.` : `${Math.round(pct)}% used, ${formatMoney(budget - totalSpent, cur)} left.`));
      })()
      : h('p', { class: 'muted' }, 'No budget set. Add one under the Project tab to see how much is left.'));

  const people = h('section', { class: 'panel' },
    h('h2', {}, 'Who paid what'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Member'), h('th', { class: 'num' }, 'Paid'), h('th', { class: 'num hide-sm' }, 'Fair share'), h('th', { class: 'num' }, 'Balance'))),
      h('tbody', {}, members.map((mb) => {
        const r = rows[mb.id];
        const cls = r.balance > 0 ? 'pos' : r.balance < 0 ? 'neg' : '';
        const label = r.balance > 0 ? `is owed ${formatMoney(r.balance, cur)}` : r.balance < 0 ? `owes ${formatMoney(-r.balance, cur)}` : 'settled';
        return h('tr', {},
          h('td', {}, mb.name, state.me && mb.id === state.me.id ? h('span', { class: 'you' }, 'you') : null),
          h('td', { class: 'num money' }, formatMoney(r.paid, cur)),
          h('td', { class: 'num money hide-sm' }, formatMoney(r.share, cur)),
          h('td', { class: `num ${cls}` }, label));
      })))),
    h('p', { class: 'muted' }, h('a', { href: `#/p/${state.pid}/settle` }, 'Go to Settle up'), ' to record who pays whom.'));

  const waiting = waitingPanel({ mine: true });
  if (waiting) main.append(waiting);
  main.append(head);
  if (!counted.length) {
    main.append(h('section', { class: 'panel empty' },
      h('p', {}, 'No spending recorded yet.'),
      project.status === 'active' ? h('div', { class: 'empty-actions' },
        h('button', { class: 'btn primary', onclick: () => openExpenseDialog(null) }, 'Add an expense'),
        h('a', { class: 'btn', href: `#/p/${state.pid}/import` }, 'Import past expenses')) : null));
    return;
  }
  main.append(
    people,
    h('section', { class: 'panel' }, h('h2', {}, 'By category'), categoryBars(counted, cur)),
    h('section', { class: 'panel' }, h('h2', {}, 'Spending over time'), trendChart(counted, cur, main.clientWidth - 40)));
}

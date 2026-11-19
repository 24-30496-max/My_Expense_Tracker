// Small DOM and formatting helpers shared by every view.

export const $ = (sel, root = document) => root.querySelector(sel);

/** h('div', {class:'x', onclick: fn}, 'text', childEl, [more children]) */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** options: ['a','b'] or [['value','Label'], ...] */
export function select(options, value, attrs = {}) {
  const s = h('select', attrs);
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    s.append(h('option', { value: v, selected: String(v) === String(value) }, l));
  }
  return s;
}

export function field(label, control, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control,
    hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(`${String(iso).slice(0, 10)}T00:00:00`);
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function toast(message, kind = 'ok') {
  let box = document.getElementById('toasts');
  if (!box) { box = h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  while (box.children.length >= 3) box.firstChild.remove();
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

export function modal({ title, content, wide = false, onClose }) {
  const dlg = h('dialog', { class: `modal${wide ? ' wide' : ''}` });
  const close = () => dlg.close();
  dlg.append(
    h('div', { class: 'modal-head' },
      h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, '×')),
    h('div', { class: 'modal-body' }, content),
  );
  dlg.addEventListener('close', () => { dlg.remove(); if (onClose) onClose(); });
  dlg.addEventListener('click', (e) => { if (e.target === dlg) close(); });
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, close };
}

export function confirmBox(message, confirmLabel = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; resolve(v); m.close(); };
    const content = h('div', {},
      h('p', {}, message),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
        h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, type: 'button', onclick: () => done(true) }, confirmLabel)));
    const m = modal({ title: 'Are you sure?', content, onClose: () => { if (!answered) resolve(false); } });
  });
}

export function download(filename, data, mime = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function toCsv(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${rows.map((r) => r.map(esc).join(',')).join('\r\n')}`;
}

export const STATUS_LABEL = { needed: 'Needed', ordered: 'Ordered', received: 'Received', used: 'Used' };

// Sign in: email link (no password) or email + password.
import * as api from '../api.js';
import { h, field } from '../util.js';

export function renderLogin(root) {
  const email = h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'you@example.com' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Only if you use a password' });
  const msg = h('p', { class: 'form-msg', role: 'status' });
  const buttons = [];

  const run = (fn) => async () => {
    msg.className = 'form-msg';
    msg.textContent = '';
    const addr = email.value.trim();
    if (!/^\S+@\S+\.\S+$/.test(addr)) { msg.className = 'form-msg err'; msg.textContent = 'Enter your email address.'; email.focus(); return; }
    buttons.forEach((b) => { b.disabled = true; });
    try { await fn(addr); } catch (err) { msg.className = 'form-msg err'; msg.textContent = err.message; }
    buttons.forEach((b) => { b.disabled = false; });
  };

  const signIn = h('button', { class: 'btn primary', type: 'button', onclick: run(async (addr) => {
    if (!pw.value) throw new Error('Type your password, or tap "Email me a sign-in link".');
    await api.auth.signIn(addr, pw.value);
  }) }, 'Sign in');
  const signUp = h('button', { class: 'btn', type: 'button', onclick: run(async (addr) => {
    if (pw.value.length < 6) throw new Error('Choose a password with at least 6 characters.');
    const res = await api.auth.signUp(addr, pw.value);
    if (!res.session) { msg.className = 'form-msg ok'; msg.textContent = `Check ${addr} for a confirmation email, then come back and sign in.`; }
  }) }, 'Create account');
  const link = h('button', { class: 'btn link', type: 'button', onclick: run(async (addr) => {
    await api.auth.magicLink(addr);
    msg.className = 'form-msg ok';
    msg.textContent = `Sign-in link sent to ${addr}. Open it on this device.`;
  }) }, 'Email me a sign-in link instead');
  buttons.push(signIn, signUp, link);

  root.replaceChildren(h('main', { class: 'login' },
    h('div', { class: 'login-card' },
      h('h1', { class: 'brand-big' }, 'Bench Ledger'),
      h('p', { class: 'muted' }, 'Track what your group spends on a project, and who owes whom.'),
      h('form', { class: 'form-grid', onsubmit: (ev) => { ev.preventDefault(); signIn.click(); } },
        field('Email', email),
        field('Password', pw),
        h('div', { class: 'actions left' }, signIn, signUp),
        link,
        msg))));
}

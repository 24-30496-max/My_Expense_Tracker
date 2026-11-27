// App shell: sign-in state, routing, header and tabs.
import { isConfigured } from './config.js';
import * as api from './api.js';
import { state, onState, setUser, openProject, closeProject, refreshProjects, isActive, isOwner, pendingRequests, answersNeeded } from './store.js';
import { h, $, toast, debounce } from './util.js';
import { renderLogin } from './views/login.js';
import { renderProjects, renderNewProject } from './views/projects.js';
import { renderOverview } from './views/overview.js';
import { renderExpenses } from './views/expenses.js';
import { renderSettle } from './views/settle.js';
import { renderImport } from './views/import.js';
import { renderProject } from './views/project.js';
import { renderOwners } from './views/owners.js';
import { openExpenseDialog } from './views/expense-form.js';

const root = $('#app');
const TABS = [['overview', 'Overview'], ['expenses', 'Expenses'], ['owners', 'Owners'], ['settle', 'Settle up'], ['project', 'Project']];
const VIEWS = { overview: renderOverview, expenses: renderExpenses, owners: renderOwners, settle: renderSettle, import: renderImport, project: renderProject };

let loadError = '';
let lastKey = '';

function parseRoute() {
  const hash = location.hash;
  if (/access_token|error_description|refresh_token/.test(hash)) return { name: 'home' };
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'new') return { name: 'new' };
  if (parts[0] === 'p' && parts[1]) return { name: 'project', pid: parts[1], tab: VIEWS[parts[2]] ? parts[2] : 'overview' };
  return { name: 'home' };
}

function renderSetup() {
  root.replaceChildren(h('main', { class: 'login' }, h('div', { class: 'login-card' },
    h('h1', { class: 'brand-big' }, 'Bench Ledger'),
    h('p', {}, 'The app is not connected to a database yet.'),
    h('p', { class: 'muted' }, 'Open js/config.js, paste your Supabase project URL and anon key, then reload. The README has the full step-by-step setup.'))));
}

function shell(route) {
  const inProject = route.name === 'project' && state.project;
  const header = h('header', { class: 'top' },
    h('a', { class: 'brand', href: '#/' }, 'Bench Ledger'),
    inProject ? h('span', { class: 'crumb' }, h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'), h('a', { href: `#/p/${state.pid}/overview` }, state.project.name),
      state.project.status === 'archived' ? h('span', { class: 'pill archived' }, 'Archived') : null) : null,
    h('span', { class: 'spacer' }),
    h('span', { class: 'who muted' }, state.user.email),
    h('button', { class: 'btn small', onclick: () => api.auth.signOut() }, 'Sign out'));
  const needsReview = inProject && isOwner() ? pendingRequests().length : 0;
  const needsAnswer = inProject ? answersNeeded() : 0;
  const activeTab = route.tab === 'import' ? 'project' : route.tab; // Import lives under Project
  const nav = inProject ? h('nav', { class: 'tabs', 'aria-label': 'Sections' }, TABS.map(([key, label]) =>
    h('a', { href: `#/p/${state.pid}/${key}`, class: activeTab === key ? 'on' : '', 'aria-current': activeTab === key ? 'page' : null },
      label,
      key === 'owners' && needsReview ? h('span', { class: 'badge', 'aria-label': `${needsReview} requests to review` }, needsReview) : null,
      key === 'overview' && needsAnswer ? h('span', { class: 'badge', 'aria-label': `${needsAnswer} waiting for your OK` }, needsAnswer) : null))) : null;
  const main = h('main', { id: 'view', class: 'view' });
  const fab = inProject && isActive() && ['overview', 'expenses'].includes(route.tab)
    ? h('button', { class: 'fab', onclick: () => openExpenseDialog(null), 'aria-label': 'Add expense' }, h('span', { 'aria-hidden': 'true' }, '+'), ' Add expense')
    : null;
  root.replaceChildren(...[header, nav, main, fab].filter(Boolean));
  return main;
}

function paint() {
  if (!isConfigured()) { renderSetup(); return; }
  if (!state.user) { renderLogin(root); return; }
  const route = parseRoute();
  const key = `${route.name}/${route.pid || ''}/${route.tab || ''}`;
  const y = key === lastKey ? window.scrollY : 0;
  const main = shell(route);
  try {
    if (loadError) {
      main.append(h('section', { class: 'panel' }, h('h2', {}, 'Could not open this'), h('p', {}, loadError), h('a', { class: 'btn', href: '#/' }, 'Back to projects')));
    } else if (route.name === 'new') renderNewProject(main);
    else if (route.name === 'project') {
      if (state.project && state.pid === route.pid) VIEWS[route.tab](main);
      else main.append(h('p', { class: 'muted loading' }, 'Loading project...'));
    } else renderProjects(main);
  } catch (err) {
    console.error(err);
    main.replaceChildren(h('section', { class: 'panel' }, h('h2', {}, 'Something went wrong showing this page'), h('p', {}, err.message), h('a', { class: 'btn', href: '#/' }, 'Back to projects')));
  }
  lastKey = key;
  window.scrollTo(0, y);
}

async function route() {
  if (!isConfigured() || !state.user) { paint(); return; }
  const r = parseRoute();
  loadError = '';
  try {
    if (r.name === 'project') {
      if (state.pid !== r.pid) { paint(); await openProject(r.pid); }
    } else {
      if (state.pid) closeProject();
      if (r.name === 'home') { try { await api.claim(); } catch { /* not fatal */ } await refreshProjects(); }
    }
  } catch (err) { loadError = err.message; }
  paint();
}

async function onSignedIn(user) {
  setUser(user);
  try { await api.claim(); } catch (err) { console.warn('claim failed', err); }
  await route();
}

async function boot() {
  if (!isConfigured()) { paint(); return; }
  api.auth.onChange((evt, session) => {
    // Do not call Supabase inside this callback directly (it can deadlock); defer a tick.
    setTimeout(() => {
      if (session && (!state.user || state.user.id !== session.user.id)) onSignedIn(session.user);
      else if (!session && state.user) { setUser(null); paint(); }
    }, 0);
  });
  const session = await api.auth.session();
  if (session) await onSignedIn(session.user);
  else paint();
}

window.addEventListener('hashchange', () => route());
// Only the Overview charts depend on the window width. Never redraw while someone is typing:
// on phones the on-screen keyboard resizes the window, and a redraw would wipe the form.
window.addEventListener('resize', debounce(() => {
  if (state.user && parseRoute().tab === 'overview' && !typingInView()) paint();
}, 250));
// A teammate's change arrives while you are typing in a field: hold the redraw until you leave it.
let pendingPaint = false;
const typingInView = () => {
  const a = document.activeElement;
  return !!a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !!a.closest('#view');
};
onState((passive) => {
  if (passive && typingInView()) { pendingPaint = true; return; }
  pendingPaint = false;
  paint();
});
document.addEventListener('focusout', () => {
  if (!pendingPaint) return;
  setTimeout(() => { if (pendingPaint && !typingInView()) { pendingPaint = false; paint(); } }, 150);
});
window.addEventListener('unhandledrejection', (e) => { toast(e.reason && e.reason.message ? e.reason.message : 'Something went wrong', 'error'); });

boot();

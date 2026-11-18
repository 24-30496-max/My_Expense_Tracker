// In-memory state for the signed-in user and the project they have open.
import * as api from './api.js';
import { debounce } from './util.js';

export const state = {
  user: null,
  projects: [],
  pid: null,
  project: null,
  members: [],
  expenses: [],
  payments: [],
  receipts: [],
  urls: {}, // storage path -> signed url
  me: null, // my member row in the open project
};

const listeners = new Set();
export const onState = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const emit = (passive = false) => listeners.forEach((f) => f(passive));

let unsubscribe = null;

export function setUser(user) {
  state.user = user;
  if (!user) closeProject();
}

export function closeProject() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  Object.assign(state, { pid: null, project: null, members: [], expenses: [], payments: [], receipts: [], urls: {}, me: null });
}

async function fetchProject(pid) {
  const data = await api.loadProject(pid);
  if (!data.project) throw new Error('Project not found, or you are not a member of it.');
  state.pid = pid;
  state.project = data.project;
  state.members = data.members;
  state.expenses = data.expenses;
  state.payments = data.payments;
  state.receipts = data.receipts;
  state.me = data.members.find((m) => m.user_id === state.user.id) || null;
  const missing = data.receipts.map((r) => r.thumb_path || r.path).filter((p) => !state.urls[p]);
  if (missing.length) {
    try { Object.assign(state.urls, await api.signedUrls(missing)); } catch { /* thumbnails are optional */ }
  }
}

export async function openProject(pid) {
  if (state.pid !== pid) {
    closeProject();
    await fetchProject(pid);
    unsubscribe = api.subscribe(pid, debounce(() => refreshProject(true).catch(() => {}), 400));
  } else {
    await fetchProject(pid);
  }
  emit();
}

/** passive = triggered by someone else's change; the screen may hold it back while you type. */
export async function refreshProject(passive = false) {
  if (!state.pid) return;
  await fetchProject(state.pid);
  emit(passive);
}

export async function refreshProjects() {
  state.projects = await api.listProjects();
  emit();
}

// ---------- helpers the views share ----------
export const memberName = (id) => (state.members.find((m) => m.id === id) || {}).name || 'Unknown';
export const isOwner = () => !!state.project && !!state.user && state.project.created_by === state.user.id;
export const isActive = () => !!state.project && state.project.status === 'active';
export const ownerName = () => {
  const m = state.members.find((x) => x.user_id === (state.project || {}).created_by);
  return m ? m.name : 'the project creator';
};
export const canEditExpense = (e) =>
  isActive() && !!state.me && (e.created_by === state.user.id || e.paid_by === state.me.id);
export const receiptsOf = (expenseId) => state.receipts.filter((r) => r.expense_id === expenseId);
export const memberByUser = (uid) => state.members.find((m) => m.user_id === uid);

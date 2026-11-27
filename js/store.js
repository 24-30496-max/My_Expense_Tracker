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
  assignments: [],
  requests: [],
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
  Object.assign(state, { pid: null, project: null, members: [], expenses: [], payments: [], receipts: [], assignments: [], requests: [], urls: {}, me: null });
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
  state.assignments = data.assignments;
  state.requests = data.requests;
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

// ---------- component owners ----------
/** The member who holds this component, or null if nobody has been assigned yet. */
export const holderOf = (expenseId) => {
  const a = state.assignments.find((x) => x.expense_id === expenseId);
  return a ? state.members.find((m) => m.id === a.member_id) || null : null;
};
const expenseAlive = (id) => state.expenses.some((e) => e.id === id && !e.deleted_at);
export const pendingRequests = () => state.requests.filter((r) => r.status === 'pending' && expenseAlive(r.expense_id));
export const myPendingFor = (expenseId) =>
  state.requests.find((r) => r.status === 'pending' && r.expense_id === expenseId && state.me && r.requester_member === state.me.id);

// ---------- agreements (payments that wait for the other person's OK) ----------
const otherSide = (p, memberId) => (p.from_member === memberId ? p.to_member : p.from_member);
/** Waiting agreements, newest first. */
export const waitingAgreements = () => state.payments.filter((p) => p.status === 'pending');
/** Things that need MY answer: agreements to confirm, and undo requests from the other person. */
export function needsMyAnswer() {
  const me = state.me && state.me.id;
  if (!me) return { confirm: [], undo: [] };
  return {
    confirm: waitingAgreements().filter((p) => p.proposed_by && p.proposed_by !== me && (p.from_member === me || p.to_member === me)),
    undo: state.payments.filter((p) => p.status === 'confirmed' && !p.deleted_at && p.undo_requested_by && p.undo_requested_by !== me && (p.from_member === me || p.to_member === me)),
  };
}
/** Things I sent that are still waiting for the other person. */
export function myWaiting() {
  const me = state.me && state.me.id;
  if (!me) return { proposals: [], undo: [] };
  return {
    proposals: waitingAgreements().filter((p) => p.proposed_by === me),
    undo: state.payments.filter((p) => p.status === 'confirmed' && !p.deleted_at && p.undo_requested_by === me),
  };
}
export const answersNeeded = () => { const n = needsMyAnswer(); return n.confirm.length + n.undo.length; };
export const canConfirmWith = (memberId) => { const m = state.members.find((x) => x.id === memberId); return !!(m && m.user_id); };
export { otherSide };

// Everything that talks to Supabase lives here, so the views stay simple.
import { supabaseUrl, supabaseKey, isConfigured } from './config.js';

export const sb = isConfigured()
  ? window.supabase.createClient(supabaseUrl(), supabaseKey(), {
    auth: { flowType: 'implicit', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  })
  : null;

function friendly(err) {
  const m = (err && err.message) || String(err);
  if (/row-level security|permission denied/i.test(m)) {
    return 'Not allowed. You can only change entries you added or paid for, and only while the project is active.';
  }
  if (/duplicate key/i.test(m)) return 'That already exists.';
  if (/foreign key/i.test(m)) return 'That is still used by an expense or payment, so it cannot be removed.';
  if (/Invalid login credentials/i.test(m)) return 'Wrong email or password. If you have not set a password, use "Email me a sign-in link".';
  return m;
}

async function ok(promise) {
  const { data, error } = await promise;
  if (error) throw new Error(friendly(error));
  return data;
}

// ---------- auth ----------
const redirect = () => `${location.origin}${location.pathname}`;

export const auth = {
  async session() { return (await sb.auth.getSession()).data.session; },
  onChange(cb) { return sb.auth.onAuthStateChange((evt, session) => cb(evt, session)); },
  async magicLink(email) {
    const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect() } });
    if (error) throw new Error(friendly(error));
  },
  async signIn(email, password) {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(friendly(error));
  },
  async signUp(email, password) {
    const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: redirect() } });
    if (error) throw new Error(friendly(error));
    return data;
  },
  signOut() { return sb.auth.signOut(); },
};

// ---------- projects ----------
export const claim = () => ok(sb.rpc('claim_memberships'));
export const listProjects = () => ok(sb.from('projects').select('*').order('created_at', { ascending: false }));

export async function loadProject(pid) {
  const [project, members, expenses, payments, receipts, assignments, requests] = await Promise.all([
    ok(sb.from('projects').select('*').eq('id', pid).maybeSingle()),
    ok(sb.from('project_members').select('*').eq('project_id', pid).order('created_at').order('name')),
    ok(sb.from('expenses').select('*').eq('project_id', pid).order('purchased_on', { ascending: false })),
    ok(sb.from('payments').select('*').eq('project_id', pid).order('paid_on', { ascending: false })),
    ok(sb.from('receipts').select('*').eq('project_id', pid)),
    ok(sb.from('component_assignments').select('*').eq('project_id', pid)),
    ok(sb.from('component_requests').select('*').eq('project_id', pid).order('created_at', { ascending: false })),
  ]);
  return { project, members, expenses, payments, receipts, assignments, requests };
}

export const createProject = (name, currency, budgetCents, members) =>
  ok(sb.rpc('create_project', { p_name: name, p_currency: currency, p_budget_cents: budgetCents, p_members: members }));

export const updateProject = (id, patch) => ok(sb.from('projects').update(patch).eq('id', id));

// ---------- members ----------
/** email is optional: a member with no email is a temporary member until the owner assigns one. */
export const addMember = (projectId, name, email) =>
  ok(sb.from('project_members').insert({ project_id: projectId, name, email: email ? email.toLowerCase() : null }));
export const setMemberEmail = (id, email) => ok(sb.from('project_members').update({ email: email.toLowerCase() }).eq('id', id));
export const renameMember = (id, name) => ok(sb.from('project_members').update({ name }).eq('id', id));
export const removeMember = (id) => ok(sb.from('project_members').delete().eq('id', id));

// ---------- expenses ----------
export const insertExpense = (row) => ok(sb.from('expenses').insert(row));
export const insertExpenses = async (rows) => {
  for (let i = 0; i < rows.length; i += 100) await ok(sb.from('expenses').insert(rows.slice(i, i + 100)));
};
export const updateExpense = (id, patch) => ok(sb.from('expenses').update(patch).eq('id', id));
export const softDeleteExpense = (id) => updateExpense(id, { deleted_at: new Date().toISOString() });
export const restoreExpense = (id) => updateExpense(id, { deleted_at: null });
export const loadHistory = (id) =>
  ok(sb.from('expense_history').select('*').eq('expense_id', id).order('changed_at', { ascending: false }));

// ---------- receipts ----------
const bucket = () => sb.storage.from('receipts');

export async function uploadReceipt(projectId, expenseId, { full, thumb }) {
  const base = `${projectId}/${expenseId}/${crypto.randomUUID()}`;
  const path = `${base}.jpg`;
  const thumbPath = `${base}_t.jpg`;
  const opts = { contentType: 'image/jpeg', upsert: false };
  await ok(bucket().upload(path, full, opts));
  await ok(bucket().upload(thumbPath, thumb, opts));
  await ok(sb.from('receipts').insert({ expense_id: expenseId, project_id: projectId, path, thumb_path: thumbPath }));
}

/** One photo for a whole receipt: upload once, then link it to every item bought on that receipt. */
export async function attachSharedReceipt(projectId, expenseIds, { full, thumb }) {
  const base = `${projectId}/${expenseIds[0]}/${crypto.randomUUID()}`;
  const path = `${base}.jpg`;
  const thumbPath = `${base}_t.jpg`;
  const opts = { contentType: 'image/jpeg', upsert: false };
  await ok(bucket().upload(path, full, opts));
  await ok(bucket().upload(thumbPath, thumb, opts));
  await ok(sb.from('receipts').insert(expenseIds.map((id) => ({ expense_id: id, project_id: projectId, path, thumb_path: thumbPath }))));
}

/** `all` = every receipt row of the project: a file shared with other items is kept until the last one is removed. */
export async function deleteReceipt(rec, all = []) {
  const stillUsed = all.some((r) => r.id !== rec.id && r.path === rec.path);
  if (!stillUsed) await ok(bucket().remove([rec.path, rec.thumb_path].filter(Boolean))); // file first, then the row
  await ok(sb.from('receipts').delete().eq('id', rec.id));
}

export async function signedUrls(paths) {
  if (!paths.length) return {};
  const data = await ok(bucket().createSignedUrls(paths, 6 * 3600));
  const out = {};
  for (const d of data || []) if (d.signedUrl) out[d.path] = d.signedUrl;
  return out;
}

// ---------- payments ----------
export const insertPayment = (row) => ok(sb.from('payments').insert(row));
export const undoPayment = (id) => ok(sb.from('payments').update({ deleted_at: new Date().toISOString() }).eq('id', id));

// Agreements: one person proposes, the other confirms (rules are enforced in the database).
export const proposePayment = (r) => ok(sb.rpc('propose_payment', {
  p_project: r.project_id, p_from: r.from_member, p_to: r.to_member, p_amount: r.amount_cents, p_paid_on: r.paid_on, p_note: r.note || null }));
export const cancelPayment = (id) => ok(sb.rpc('cancel_payment', { p_id: id }));
export const decidePayment = (id, confirm, reason = null) => ok(sb.rpc('decide_payment', { p_id: id, p_confirm: confirm, p_reason: reason }));
export const requestUndo = (id) => ok(sb.rpc('request_undo', { p_id: id }));
export const cancelUndo = (id) => ok(sb.rpc('cancel_undo', { p_id: id }));
export const decideUndo = (id, approve) => ok(sb.rpc('decide_undo', { p_id: id, p_approve: approve }));

// ---------- component owners and requests ----------
export const assignComponent = (projectId, expenseId, memberId, userId) =>
  ok(sb.from('component_assignments').upsert(
    { expense_id: expenseId, project_id: projectId, member_id: memberId, assigned_by: userId, assigned_at: new Date().toISOString() },
    { onConflict: 'expense_id' }));
export const unassignComponent = (expenseId) => ok(sb.from('component_assignments').delete().eq('expense_id', expenseId));
export const requestComponent = async (row) => {
  try { await ok(sb.from('component_requests').insert(row)); } catch (err) {
    if (/already exists/i.test(err.message)) throw new Error('You already have a pending request for this item.');
    throw err;
  }
};
export const withdrawRequest = (id) => ok(sb.from('component_requests').update({ status: 'cancelled' }).eq('id', id));
export const decideRequest = (id, approve) => ok(sb.rpc('decide_request', { p_request: id, p_approve: approve }));

// ---------- live updates ----------
export function subscribe(pid, onChange) {
  const ch = sb.channel(`project-${pid}`);
  for (const table of ['expenses', 'payments', 'receipts', 'project_members', 'component_assignments', 'component_requests']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `project_id=eq.${pid}` }, onChange);
  }
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${pid}` }, onChange);
  ch.subscribe();
  return () => sb.removeChannel(ch);
}

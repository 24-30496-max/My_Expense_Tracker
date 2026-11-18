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
  const [project, members, expenses, payments, receipts] = await Promise.all([
    ok(sb.from('projects').select('*').eq('id', pid).maybeSingle()),
    ok(sb.from('project_members').select('*').eq('project_id', pid).order('created_at').order('name')),
    ok(sb.from('expenses').select('*').eq('project_id', pid).order('purchased_on', { ascending: false })),
    ok(sb.from('payments').select('*').eq('project_id', pid).order('paid_on', { ascending: false })),
    ok(sb.from('receipts').select('*').eq('project_id', pid)),
  ]);
  return { project, members, expenses, payments, receipts };
}

export const createProject = (name, currency, budgetCents, members) =>
  ok(sb.rpc('create_project', { p_name: name, p_currency: currency, p_budget_cents: budgetCents, p_members: members }));

export const updateProject = (id, patch) => ok(sb.from('projects').update(patch).eq('id', id));

// ---------- members ----------
export const addMember = (projectId, name, email) =>
  ok(sb.from('project_members').insert({ project_id: projectId, name, email: email.toLowerCase() }));
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

export async function deleteReceipt(rec) {
  await ok(bucket().remove([rec.path, rec.thumb_path].filter(Boolean))); // file first, then the row
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

// ---------- live updates ----------
export function subscribe(pid, onChange) {
  const ch = sb.channel(`project-${pid}`);
  for (const table of ['expenses', 'payments', 'receipts', 'project_members']) {
    ch.on('postgres_changes', { event: '*', schema: 'public', table, filter: `project_id=eq.${pid}` }, onChange);
  }
  ch.on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${pid}` }, onChange);
  ch.subscribe();
  return () => sb.removeChannel(ch);
}
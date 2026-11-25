-- =====================================================================
-- Project Expense Tracker: database schema + security rules
-- Run this ONCE in Supabase: Dashboard > SQL Editor > New query > paste > Run
-- Safe to re-run: it only creates what is missing.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tables ----------

create table if not exists public.projects (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (length(trim(name)) > 0),
  currency      text not null default 'PHP',
  budget_cents  bigint check (budget_cents is null or budget_cents >= 0),
  categories    text[] not null default array['Components','Materials','Tools','Shipping','Fabrication/Printing','Software/Services','Other'],
  status        text not null default 'active' check (status in ('active','archived')),
  created_by    uuid not null default auth.uid(),
  created_at    timestamptz not null default now()
);

create table if not exists public.project_members (
  id          uuid primary key default gen_random_uuid(),
  project_id  uuid not null references public.projects(id) on delete cascade,
  name        text not null check (length(trim(name)) > 0),
  email       text not null,
  user_id     uuid,                       -- filled in when that person signs in with this email
  created_at  timestamptz not null default now(),
  unique (project_id, email)
);
create index if not exists project_members_user_idx on public.project_members(user_id);
-- A member can be added by name only ("temporary"); the owner assigns an email later.
alter table public.project_members alter column email drop not null;

create table if not exists public.expenses (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  name             text not null check (length(trim(name)) > 0),
  category         text,
  qty              integer not null default 1 check (qty >= 1),
  unit_price_cents bigint  not null default 0 check (unit_price_cents >= 0),
  fees_cents       bigint  not null default 0,   -- shipping/tax, or a negative number for a discount
  purchased_on     date    not null default current_date,
  paid_by          uuid    not null references public.project_members(id),
  store            text,
  link             text,
  status           text    not null default 'received' check (status in ('needed','ordered','received','used')),
  notes            text,
  created_by       uuid    not null default auth.uid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  updated_by       uuid,
  deleted_at       timestamptz,
  deleted_by       uuid
);
create index if not exists expenses_project_idx on public.expenses(project_id);

-- Receipt batches: several items bought on one receipt share a batch_id.
-- batch_total_cents is the whole receipt's total (the items' costs add up to exactly this).
alter table public.expenses add column if not exists batch_id uuid;
alter table public.expenses add column if not exists batch_total_cents bigint;
create index if not exists expenses_batch_idx on public.expenses(batch_id) where batch_id is not null;

-- Fees may now be negative (a discount spread over the items), as long as an item never costs less than zero.
alter table public.expenses drop constraint if exists expenses_fees_cents_check;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'expenses_total_nonneg') then
    alter table public.expenses add constraint expenses_total_nonneg check (qty * unit_price_cents + fees_cents >= 0);
  end if;
end $$;

create table if not exists public.expense_history (
  id          bigint generated always as identity primary key,
  expense_id  uuid not null,
  project_id  uuid not null,
  changed_by  uuid,
  changed_at  timestamptz not null default now(),
  old_row     jsonb not null,
  new_row     jsonb not null
);
create index if not exists expense_history_expense_idx on public.expense_history(expense_id);

create table if not exists public.receipts (
  id          uuid primary key default gen_random_uuid(),
  expense_id  uuid not null references public.expenses(id) on delete cascade,
  project_id  uuid not null references public.projects(id) on delete cascade,
  path        text not null,              -- full-size image in the "receipts" bucket
  thumb_path  text,                       -- small preview
  created_by  uuid not null default auth.uid(),
  created_at  timestamptz not null default now()
);
create index if not exists receipts_expense_idx on public.receipts(expense_id);
create index if not exists receipts_project_idx on public.receipts(project_id);

create table if not exists public.payments (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  from_member   uuid not null references public.project_members(id),
  to_member     uuid not null references public.project_members(id),
  amount_cents  bigint not null check (amount_cents > 0),
  paid_on       date not null default current_date,
  note          text,
  created_by    uuid not null default auth.uid(),
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  check (from_member <> to_member)
);
create index if not exists payments_project_idx on public.payments(project_id);

-- ---------- Helper functions (used by the security rules) ----------

create or replace function public.is_member(pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from project_members where project_id = pid and user_id = auth.uid());
$$;

create or replace function public.is_owner(pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from projects where id = pid and created_by = auth.uid());
$$;

create or replace function public.project_active(pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from projects where id = pid and status = 'active');
$$;

create or replace function public.is_me(mid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from project_members where id = mid and user_id = auth.uid());
$$;

create or replace function public.member_in_project(mid uuid, pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from project_members where id = mid and project_id = pid);
$$;

-- "Own" expense = one you added, or one you paid for.
create or replace function public.can_edit_expense(eid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from expenses e
    where e.id = eid
      and is_member(e.project_id) and project_active(e.project_id)
      and (e.created_by = auth.uid() or is_me(e.paid_by))
  );
$$;

-- ---------- Functions the app calls ----------

-- Links your sign-in to the member rows that were created with your email.
create or replace function public.claim_memberships() returns void
language plpgsql security definer set search_path = public as $$
declare my_email text := lower(auth.jwt() ->> 'email');
begin
  if auth.uid() is null or my_email is null then return; end if;
  update project_members set user_id = auth.uid()
   where lower(email) = my_email and user_id is null;
end $$;

-- Creates a project and its members in one step. Your own email must be in the list.
create or replace function public.create_project(
  p_name text, p_currency text, p_budget_cents bigint, p_members jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  pid uuid;
  m jsonb;
  my_email text := lower(auth.jwt() ->> 'email');
  linked boolean := false;
  em text;
begin
  if auth.uid() is null then raise exception 'Sign in first'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'Project name is required'; end if;
  if jsonb_array_length(coalesce(p_members, '[]'::jsonb)) < 1 then raise exception 'Add at least one member'; end if;

  insert into projects (name, currency, budget_cents, created_by)
  values (trim(p_name), coalesce(nullif(trim(p_currency), ''), 'PHP'), p_budget_cents, auth.uid())
  returning id into pid;

  for m in select * from jsonb_array_elements(p_members) loop
    em := nullif(lower(trim(m ->> 'email')), '');
    insert into project_members (project_id, name, email, user_id)
    values (pid, trim(m ->> 'name'), em, case when em = my_email then auth.uid() end);
    if em is not null and em = my_email then linked := true; end if;
  end loop;

  if not linked then raise exception 'Your own email (%) must be in the member list', my_email; end if;
  return pid;
end $$;

revoke all on function public.create_project(text, text, bigint, jsonb) from public, anon;
revoke all on function public.claim_memberships() from public, anon;
grant execute on function public.create_project(text, text, bigint, jsonb) to authenticated;
grant execute on function public.claim_memberships() to authenticated;

-- ---------- Triggers ----------

-- Keeps key columns fixed, stamps who/when, and records edit history.
create or replace function public.expenses_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.id <> old.id or new.project_id <> old.project_id or new.created_by <> old.created_by then
    raise exception 'id, project and creator cannot be changed';
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  if new.deleted_at is not null and old.deleted_at is null then new.deleted_by := auth.uid(); end if;
  if new.deleted_at is null then new.deleted_by := null; end if;
  insert into expense_history (expense_id, project_id, changed_by, old_row, new_row)
  values (old.id, old.project_id, auth.uid(), to_jsonb(old), to_jsonb(new));
  return new;
end $$;

drop trigger if exists expenses_before_update on public.expenses;
create trigger expenses_before_update before update on public.expenses
  for each row execute function public.expenses_before_update();

-- Members: tidy the email, and only the name (or a still-missing email) can be edited directly.
-- Linking a sign-in to a member happens only through claim_memberships(), so nobody can
-- attach (or steal) someone else's account.
create or replace function public.members_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  new.name := trim(new.name);
  new.email := nullif(lower(trim(coalesce(new.email, ''))), '');
  if tg_op = 'UPDATE' and current_user in ('authenticated', 'anon') then
    if new.user_id is distinct from old.user_id or new.project_id <> old.project_id
       or (old.email is not null and new.email is distinct from old.email) then
      raise exception 'Only the name of a member can be changed (an email can be added once, to a member that has none)';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists members_guard on public.project_members;
create trigger members_guard before insert or update on public.project_members
  for each row execute function public.members_guard();

-- ---------- Security rules (Row Level Security) ----------

alter table public.projects         enable row level security;
alter table public.project_members  enable row level security;
alter table public.expenses         enable row level security;
alter table public.expense_history  enable row level security;
alter table public.receipts         enable row level security;
alter table public.payments         enable row level security;

revoke all on public.projects, public.project_members, public.expenses,
              public.expense_history, public.receipts, public.payments from anon;
grant select, update on public.projects to authenticated;
grant select, insert, update, delete on public.project_members to authenticated;
grant select, insert, update on public.expenses to authenticated;
grant select on public.expense_history to authenticated;
grant select, insert, delete on public.receipts to authenticated;
grant select, insert, update on public.payments to authenticated;

-- projects: members can read; only the creator can change settings / archive
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects for select to authenticated
  using (is_member(id));
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects for update to authenticated
  using (created_by = auth.uid()) with check (created_by = auth.uid());

-- members: everyone in the project can read; only the creator manages the list
drop policy if exists members_select on public.project_members;
create policy members_select on public.project_members for select to authenticated
  using (is_member(project_id));
drop policy if exists members_insert on public.project_members;
create policy members_insert on public.project_members for insert to authenticated
  with check (is_owner(project_id) and user_id is null);
drop policy if exists members_update on public.project_members;
create policy members_update on public.project_members for update to authenticated
  using (is_owner(project_id)) with check (is_owner(project_id));
drop policy if exists members_delete on public.project_members;
create policy members_delete on public.project_members for delete to authenticated
  using (is_owner(project_id));

-- expenses: any member can add; you can edit only what you added or paid for
drop policy if exists expenses_select on public.expenses;
create policy expenses_select on public.expenses for select to authenticated
  using (is_member(project_id));
drop policy if exists expenses_insert on public.expenses;
create policy expenses_insert on public.expenses for insert to authenticated
  with check (is_member(project_id) and project_active(project_id)
              and created_by = auth.uid() and member_in_project(paid_by, project_id));
drop policy if exists expenses_update on public.expenses;
create policy expenses_update on public.expenses for update to authenticated
  using (is_member(project_id) and project_active(project_id) and (created_by = auth.uid() or is_me(paid_by)))
  with check (is_member(project_id) and project_active(project_id)
              and (created_by = auth.uid() or is_me(paid_by)) and member_in_project(paid_by, project_id));
-- (no delete policy on purpose: removal is a soft delete via deleted_at, so it can be restored)

-- edit history: read-only for members
drop policy if exists history_select on public.expense_history;
create policy history_select on public.expense_history for select to authenticated
  using (is_member(project_id));

-- receipts
drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts for select to authenticated
  using (is_member(project_id));
drop policy if exists receipts_insert on public.receipts;
create policy receipts_insert on public.receipts for insert to authenticated
  with check (created_by = auth.uid() and can_edit_expense(expense_id)
              and exists (select 1 from expenses e where e.id = expense_id and e.project_id = receipts.project_id));
drop policy if exists receipts_delete on public.receipts;
create policy receipts_delete on public.receipts for delete to authenticated
  using (can_edit_expense(expense_id));

-- payments: any member can record one; only its creator can undo it
drop policy if exists payments_select on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (is_member(project_id));
drop policy if exists payments_insert on public.payments;
create policy payments_insert on public.payments for insert to authenticated
  with check (is_member(project_id) and project_active(project_id) and created_by = auth.uid()
              and member_in_project(from_member, project_id) and member_in_project(to_member, project_id));
drop policy if exists payments_update on public.payments;
create policy payments_update on public.payments for update to authenticated
  using (created_by = auth.uid() and project_active(project_id))
  with check (created_by = auth.uid() and project_active(project_id));

-- ---------- Component owners and requests ----------
-- "Owner" of a component = the member who holds/keeps it (not necessarily who paid).
-- The project creator assigns it; any member can request an item; the creator approves.

create table if not exists public.component_assignments (
  expense_id   uuid primary key references public.expenses(id) on delete cascade,
  project_id   uuid not null references public.projects(id) on delete cascade,
  member_id    uuid not null references public.project_members(id) on delete cascade,
  assigned_by  uuid not null default auth.uid(),
  assigned_at  timestamptz not null default now()
);
create index if not exists component_assignments_project_idx on public.component_assignments(project_id);

create table if not exists public.component_requests (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  expense_id        uuid not null references public.expenses(id) on delete cascade,
  requester_member  uuid not null references public.project_members(id) on delete cascade,
  requested_by      uuid not null default auth.uid(),
  note              text,
  status            text not null default 'pending'
                    check (status in ('pending','approved','declined','cancelled','superseded')),
  created_at        timestamptz not null default now(),
  decided_by        uuid,
  decided_at        timestamptz
);
create index if not exists component_requests_project_idx on public.component_requests(project_id);
create unique index if not exists component_requests_one_pending
  on public.component_requests(expense_id, requester_member) where status = 'pending';

create or replace function public.expense_in_project(eid uuid, pid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from expenses where id = eid and project_id = pid and deleted_at is null);
$$;

create or replace function public.has_assignment(eid uuid, mid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from component_assignments where expense_id = eid and member_id = mid);
$$;

-- When an item is assigned (by approval or directly), settle the open requests for it.
create or replace function public.resolve_requests() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update component_requests
     set status = case when requester_member = new.member_id then 'approved' else 'superseded' end,
         decided_by = auth.uid(), decided_at = now()
   where expense_id = new.expense_id and status = 'pending';
  return new;
end $$;

drop trigger if exists resolve_requests on public.component_assignments;
create trigger resolve_requests after insert or update on public.component_assignments
  for each row execute function public.resolve_requests();

-- Owner approves or declines a request.
create or replace function public.decide_request(p_request uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare r component_requests;
begin
  select * into r from component_requests where id = p_request for update;
  if not found then raise exception 'Request not found'; end if;
  if not is_owner(r.project_id) then raise exception 'Only the project owner can decide requests'; end if;
  if not project_active(r.project_id) then raise exception 'This project is archived'; end if;
  if r.status <> 'pending' then raise exception 'This request was already decided or withdrawn'; end if;
  if not expense_in_project(r.expense_id, r.project_id) then raise exception 'That item was deleted'; end if;
  if p_approve then
    insert into component_assignments (expense_id, project_id, member_id, assigned_by)
    values (r.expense_id, r.project_id, r.requester_member, auth.uid())
    on conflict (expense_id) do update
      set member_id = excluded.member_id, assigned_by = excluded.assigned_by, assigned_at = now();
    -- the trigger marks this request approved and any others for the item superseded
  else
    update component_requests set status = 'declined', decided_by = auth.uid(), decided_at = now()
     where id = p_request;
  end if;
end $$;

revoke all on function public.decide_request(uuid, boolean) from public, anon;
grant execute on function public.decide_request(uuid, boolean) to authenticated;

alter table public.component_assignments enable row level security;
alter table public.component_requests    enable row level security;
revoke all on public.component_assignments, public.component_requests from anon;
grant select, insert, update, delete on public.component_assignments to authenticated;
grant select, insert on public.component_requests to authenticated;
grant update (status) on public.component_requests to authenticated;   -- only used to withdraw your own request

drop policy if exists assign_select on public.component_assignments;
create policy assign_select on public.component_assignments for select to authenticated
  using (is_member(project_id));
drop policy if exists assign_insert on public.component_assignments;
create policy assign_insert on public.component_assignments for insert to authenticated
  with check (is_owner(project_id) and project_active(project_id) and assigned_by = auth.uid()
              and expense_in_project(expense_id, project_id) and member_in_project(member_id, project_id));
drop policy if exists assign_update on public.component_assignments;
create policy assign_update on public.component_assignments for update to authenticated
  using (is_owner(project_id) and project_active(project_id))
  with check (is_owner(project_id) and project_active(project_id)
              and expense_in_project(expense_id, project_id) and member_in_project(member_id, project_id));
drop policy if exists assign_delete on public.component_assignments;
create policy assign_delete on public.component_assignments for delete to authenticated
  using (is_owner(project_id) and project_active(project_id));

drop policy if exists requests_select on public.component_requests;
create policy requests_select on public.component_requests for select to authenticated
  using (is_member(project_id));
drop policy if exists requests_insert on public.component_requests;
create policy requests_insert on public.component_requests for insert to authenticated
  with check (is_member(project_id) and project_active(project_id)
              and requested_by = auth.uid() and status = 'pending'
              and is_me(requester_member) and member_in_project(requester_member, project_id)
              and expense_in_project(expense_id, project_id)
              and not has_assignment(expense_id, requester_member));
drop policy if exists requests_withdraw on public.component_requests;
create policy requests_withdraw on public.component_requests for update to authenticated
  using (requested_by = auth.uid() and status = 'pending' and project_active(project_id))
  with check (requested_by = auth.uid() and status = 'cancelled');

-- ---------- Receipt photo storage (private bucket) ----------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do nothing;

-- Files live at  <project_id>/<expense_id>/<file>.jpg
drop policy if exists receipts_obj_select on storage.objects;
create policy receipts_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and is_member(((storage.foldername(name))[1])::uuid));

drop policy if exists receipts_obj_insert on storage.objects;
create policy receipts_obj_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts'
              and is_member(((storage.foldername(name))[1])::uuid)
              and project_active(((storage.foldername(name))[1])::uuid));

-- delete the file first, then the receipts row (the row proves you may edit that expense)
drop policy if exists receipts_obj_delete on storage.objects;
create policy receipts_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'receipts'
         and exists (select 1 from public.receipts r
                     where (r.path = storage.objects.name or r.thumb_path = storage.objects.name)
                       and can_edit_expense(r.expense_id)));

-- ---------- Live updates ----------
do $$ begin
  begin alter publication supabase_realtime add table public.expenses;        exception when others then null; end;
  begin alter publication supabase_realtime add table public.payments;        exception when others then null; end;
  begin alter publication supabase_realtime add table public.receipts;        exception when others then null; end;
  begin alter publication supabase_realtime add table public.project_members; exception when others then null; end;
  begin alter publication supabase_realtime add table public.projects;        exception when others then null; end;
  begin alter publication supabase_realtime add table public.component_assignments; exception when others then null; end;
  begin alter publication supabase_realtime add table public.component_requests;    exception when others then null; end;
end $$;

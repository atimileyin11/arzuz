-- Arzuz internal team task board
-- Run this in Supabase SQL Editor after the existing migrations.
-- Requires: supabase-team-roles.sql (auth.users reference)

create table if not exists public.team_tasks (
  id          uuid        primary key default gen_random_uuid(),
  title       text        not null,
  notes       text,
  status      text        not null default 'backlog'
                          check (status in ('backlog', 'active', 'review', 'done', 'blocked')),
  priority    text        not null default 'medium'
                          check (priority in ('low', 'medium', 'high', 'urgent')),
  category    text        not null default 'product'
                          check (category in ('product', 'ops', 'growth', 'tech', 'finance', 'legal')),
  owner       text,
  due_date    date,
  created_by  uuid        references auth.users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.team_tasks enable row level security;

-- Only authenticated users (admins) can read or write tasks
create policy "admins read tasks"
  on public.team_tasks for select
  using (auth.uid() is not null);

create policy "admins insert tasks"
  on public.team_tasks for insert
  with check (auth.uid() is not null);

create policy "admins update tasks"
  on public.team_tasks for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

create policy "creator or superadmin deletes tasks"
  on public.team_tasks for delete
  using (auth.uid() = created_by);

-- keep updated_at current
create trigger team_tasks_updated_at
  before update on public.team_tasks
  for each row execute function public.set_updated_at();

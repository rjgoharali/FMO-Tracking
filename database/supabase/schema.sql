-- FMO Tracking Supabase schema. Run this once in Supabase SQL Editor.
create extension if not exists pgcrypto;

create type public.app_role as enum ('SUPER_ADMIN','ADMIN','FMO');
create type public.duty_status as enum ('ACTIVE','COMPLETED');

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  role public.app_role not null default 'FMO',
  employee_code text unique,
  full_name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create table if not exists public.duty_sessions (
  id uuid primary key default gen_random_uuid(),
  fmo_id uuid not null references public.profiles(id),
  start_time timestamptz not null default now(),
  expected_end_time timestamptz not null,
  actual_end_time timestamptz,
  status public.duty_status not null default 'ACTIVE',
  created_at timestamptz not null default now()
);
create unique index if not exists one_active_duty_per_fmo on public.duty_sessions(fmo_id) where status = 'ACTIVE';
create table if not exists public.attendance (
  id uuid primary key default gen_random_uuid(),
  duty_session_id uuid not null unique references public.duty_sessions(id),
  fmo_id uuid not null references public.profiles(id),
  check_in_time timestamptz not null default now(),
  selfie_path text,
  latitude double precision not null,
  longitude double precision not null,
  accuracy double precision not null,
  created_at timestamptz not null default now()
);
create table if not exists public.location_logs (
  id uuid primary key default gen_random_uuid(),
  duty_session_id uuid not null references public.duty_sessions(id),
  fmo_id uuid not null references public.profiles(id),
  latitude double precision not null,
  longitude double precision not null,
  accuracy double precision not null,
  speed double precision,
  battery_level double precision,
  recorded_at timestamptz not null,
  received_at timestamptz not null default now(),
  client_point_id text unique
);
create index if not exists location_logs_session_time on public.location_logs(duty_session_id, recorded_at);
alter table public.profiles enable row level security;
alter table public.duty_sessions enable row level security;
alter table public.attendance enable row level security;
alter table public.location_logs enable row level security;
create policy "users read own profile" on public.profiles for select using (id = auth.uid() or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ADMIN','SUPER_ADMIN')));
create policy "fmos manage own duty" on public.duty_sessions for all using (fmo_id = auth.uid()) with check (fmo_id = auth.uid());
create policy "fmos manage own attendance" on public.attendance for all using (fmo_id = auth.uid()) with check (fmo_id = auth.uid());
create policy "fmos manage own locations" on public.location_logs for all using (fmo_id = auth.uid()) with check (fmo_id = auth.uid());
create policy "admins read all duty" on public.duty_sessions for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ADMIN','SUPER_ADMIN')));
create policy "admins read all attendance" on public.attendance for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ADMIN','SUPER_ADMIN')));
create policy "admins read all locations" on public.location_logs for select using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('ADMIN','SUPER_ADMIN')));

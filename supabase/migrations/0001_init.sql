-- Antero Atendimento — Ciclo 1: Fundação
-- Schema base: profiles, organizations, organization_members, whatsapp_accounts.
-- Funções auxiliares e gatilhos. As políticas de RLS ficam em 0002_rls.sql.

-- Extensão para gen_random_uuid()
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.organization_status as enum ('active', 'inactive');
create type public.member_role as enum ('owner', 'admin', 'attendant');
create type public.member_status as enum ('active', 'invited', 'disabled');
create type public.whatsapp_provider as enum ('development', 'cloud_api');
create type public.whatsapp_status as enum ('connected', 'disconnected');

-- ---------------------------------------------------------------------------
-- Utilitário: mantém updated_at
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles (espelha auth.users; guarda dados públicos do usuário)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  full_name text,
  is_platform_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
before update on public.profiles
for each row execute function public.set_updated_at();

-- Cria o profile automaticamente quando um usuário é criado no Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(
      new.raw_user_meta_data ->> 'full_name',
      new.raw_user_meta_data ->> 'name',
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  status public.organization_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger organizations_set_updated_at
before update on public.organizations
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- organization_members (vínculo usuário <-> organização + papel)
-- ---------------------------------------------------------------------------
create table public.organization_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null default 'attendant',
  status public.member_status not null default 'active',
  created_at timestamptz not null default now(),
  unique (organization_id, user_id)
);

create index organization_members_user_id_idx
  on public.organization_members (user_id);
create index organization_members_organization_id_idx
  on public.organization_members (organization_id);

-- ---------------------------------------------------------------------------
-- whatsapp_accounts (canal de atendimento por organização)
-- ---------------------------------------------------------------------------
create table public.whatsapp_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  provider public.whatsapp_provider not null default 'development',
  external_account_id text,
  phone_number text,
  display_name text,
  status public.whatsapp_status not null default 'disconnected',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index whatsapp_accounts_organization_id_idx
  on public.whatsapp_accounts (organization_id);

create trigger whatsapp_accounts_set_updated_at
before update on public.whatsapp_accounts
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Funções auxiliares de autorização.
-- SECURITY DEFINER para que a leitura de organization_members dentro das
-- políticas de RLS não cause recursão (a função roda como owner e ignora RLS).
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.shares_org_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members me
    join public.organization_members them
      on them.organization_id = me.organization_id
    where me.user_id = auth.uid()
      and me.status = 'active'
      and them.user_id = target_user
      and them.status = 'active'
  );
$$;

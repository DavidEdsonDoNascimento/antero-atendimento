-- migrate:up
-- Antero Atendimento — Ciclo 1: Fundação
-- Schema base: profiles, organizations, organization_members, whatsapp_accounts.
-- Funções auxiliares e gatilhos. As políticas de RLS ficam em 0002_rls.sql.
--
-- Porte para PostgreSQL próprio (Entrega 2) de supabase/migrations/0001_init.sql.
-- Tabelas, colunas, tipos, enums, constraints, índices e regras preservados.
-- Diferenças (só o que dependia do Supabase):
--   - sem `create extension pgcrypto`: gen_random_uuid() é nativa desde o
--     PostgreSQL 13 (chamada como pg_catalog.gen_random_uuid());
--   - profiles.id referencia auth.users(id) de 0000_identity.sql (Better Auth)
--     em vez do auth.users do Supabase;
--   - handle_new_user lê `name` do Better Auth em vez de raw_user_meta_data;
--   - novo gatilho handle_user_email_updated mantém profiles.email
--     sincronizado quando o e-mail muda em auth.users (no Supabase o e-mail
--     só era copiado na criação);
--   - auth.uid() -> app.current_user_id() (0000_identity.sql);
--   - search_path vazio também em set_updated_at e REVOKE EXECUTE explícito de
--     PUBLIC em todas as funções. Os GRANTs à aplicação ficam em 0002_rls.sql.

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
set search_path = ''
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

-- Cria o profile automaticamente quando um usuário é criado no Better Auth.
-- SECURITY DEFINER (dono: antero_owner): o INSERT em auth.users é feito por
-- antero_auth, que não tem — nem precisa ter — privilégio algum em `public`.
-- A função não recebe argumentos do chamador: só copia a linha recém-criada.
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
      nullif(pg_catalog.btrim(new.name), ''),
      pg_catalog.split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- Mantém o e-mail desnormalizado em profiles igual ao da identidade. Só o
-- e-mail: full_name é editável pelo próprio usuário (profiles_update_own) e
-- não é sobrescrito pelo nome do Better Auth.
create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.profiles
  set email = new.email
  where id = new.id;
  return new;
end;
$$;

create trigger on_auth_user_email_updated
after update of email on auth.users
for each row
when (old.email is distinct from new.email)
execute function public.handle_user_email_updated();

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create table public.organizations (
  id uuid primary key default pg_catalog.gen_random_uuid(),
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
  id uuid primary key default pg_catalog.gen_random_uuid(),
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
  id uuid primary key default pg_catalog.gen_random_uuid(),
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
-- Todas respondem APENAS sobre o usuário da transação
-- (app.current_user_id()); sem contexto, devolvem false. Nenhuma recebe o id
-- do chamador como parâmetro — não há como perguntar "e se eu fosse outro
-- usuário?".
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = app.current_user_id()),
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
      and m.user_id = app.current_user_id()
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
      and m.user_id = app.current_user_id()
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
    where me.user_id = app.current_user_id()
      and me.status = 'active'
      and them.user_id = target_user
      and them.status = 'active'
  );
$$;

-- Ninguém executa por PUBLIC. Os gatilhos não precisam de EXECUTE para
-- disparar; as funções de autorização recebem GRANT a antero_app em
-- 0002_rls.sql, junto com as políticas que as usam.
revoke all on function public.set_updated_at() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_user_email_updated() from public;
revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_org_member(uuid) from public;
revoke all on function public.is_org_admin(uuid) from public;
revoke all on function public.shares_org_with(uuid) from public;

-- migrate:down
-- Desfaz todos os efeitos acima. Recusa-se se houver dados em qualquer tabela
-- criada aqui (nada é apagado; a transação é revertida). Exige que
-- 0002..0005 já tenham sido revertidas (os DROP sem CASCADE falham caso
-- contrário).
do $$
begin
  if exists (select 1 from public.profiles)
     or exists (select 1 from public.organizations)
     or exists (select 1 from public.organization_members)
     or exists (select 1 from public.whatsapp_accounts) then
    raise exception 'rollback de 0001_init recusado: há dados em profiles/organizations/organization_members/whatsapp_accounts';
  end if;
end;
$$;

drop trigger on_auth_user_email_updated on auth.users;
drop trigger on_auth_user_created on auth.users;

drop function public.shares_org_with(uuid);
drop function public.is_org_admin(uuid);
drop function public.is_org_member(uuid);
drop function public.is_platform_admin();

drop table public.whatsapp_accounts;
drop table public.organization_members;
drop table public.organizations;
drop table public.profiles;

drop function public.handle_user_email_updated();
drop function public.handle_new_user();
drop function public.set_updated_at();

drop type public.whatsapp_status;
drop type public.whatsapp_provider;
drop type public.member_status;
drop type public.member_role;
drop type public.organization_status;

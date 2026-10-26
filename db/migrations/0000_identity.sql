-- migrate:up
-- Antero Atendimento — Entrega 2: identidade (Better Auth) e contexto do
-- usuário. Substitui o que o Supabase fornecia de fora das migrations
-- (schema `auth`, `auth.users`, `auth.uid()`, papéis anon/authenticated).
--
-- Precisa existir ANTES de 0001_init.sql: profiles.id referencia
-- auth.users(id) e as funções de autorização de 0001 leem
-- app.current_user_id().
--
-- Pré-requisito de infraestrutura: os papéis antero_owner, antero_app e
-- antero_auth (docker/postgres/initdb/10-roles.sh; `pnpm db:roles`).
--
-- ---------------------------------------------------------------------------
-- 1) Schema `auth` — tabelas do Better Auth 1.7.12
-- ---------------------------------------------------------------------------
-- SQL revisado a partir do gerador oficial (`getMigrations` de
-- better-auth/db/migration, o mesmo de `auth generate`), com a configuração
-- de src/lib/auth/better-auth-options.ts: generateId "uuid", tabelas no
-- plural e colunas em snake_case, schemaName "auth". Para reimprimir a
-- referência: `node scripts/infra.mjs auth-schema test print` num banco sem
-- esta migration. `pnpm db:test:auth-schema` confere que o resultado continua
-- idêntico ao esperado pelo Better Auth.
--
-- Única diferença intencional em relação ao gerado: `email_verified` ganha
-- `default false` (o mesmo default que o Better Auth aplica em memória), para
-- que um INSERT que omita a coluna não falhe. Não muda o contrato.
--
-- Separação de privilégios: só antero_auth (o papel do Better Auth) recebe
-- acesso a este schema. antero_app NÃO tem USAGE em `auth`, então não
-- consegue ler hashes de senha (accounts.password), tokens de sessão
-- (sessions.token), tokens OAuth nem valores de verificação — nem por SELECT
-- direto, nem por JOIN. A sincronização com public.profiles é feita por
-- gatilhos SECURITY DEFINER (0001_init.sql), sem conceder a antero_auth nada
-- em `public`.
create schema auth;
comment on schema auth is
  'Identidade (Better Auth). Acesso exclusivo de antero_auth; antero_app não tem USAGE.';
revoke all on schema auth from public;

create table auth.users (
  id uuid default pg_catalog.gen_random_uuid() not null primary key,
  name text not null,
  email text not null unique,
  email_verified boolean default false not null,
  image text,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz default current_timestamp not null
);

create table auth.sessions (
  id uuid default pg_catalog.gen_random_uuid() not null primary key,
  expires_at timestamptz not null,
  token text not null unique,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz not null,
  ip_address text,
  user_agent text,
  user_id uuid not null references auth.users (id) on delete cascade
);

create table auth.accounts (
  id uuid default pg_catalog.gen_random_uuid() not null primary key,
  account_id text not null,
  provider_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  password text,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz not null
);

create table auth.verifications (
  id uuid default pg_catalog.gen_random_uuid() not null primary key,
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz default current_timestamp not null,
  updated_at timestamptz default current_timestamp not null
);

create index sessions_user_id_idx on auth.sessions (user_id);
create index accounts_user_id_idx on auth.accounts (user_id);
create index verifications_identifier_idx on auth.verifications (identifier);

-- Mínimo que o Better Auth usa: CRUD nas suas quatro tabelas. Sem TRUNCATE,
-- REFERENCES, TRIGGER, sem CREATE no schema (migrations do Better Auth nunca
-- rodam com esta credencial) e nada fora de `auth`.
grant usage on schema auth to antero_auth;
grant select, insert, update, delete on
  auth.users,
  auth.sessions,
  auth.accounts,
  auth.verifications
to antero_auth;

-- ---------------------------------------------------------------------------
-- 2) Contexto do usuário — substitui auth.uid() do Supabase
-- ---------------------------------------------------------------------------
-- A aplicação conecta como antero_app (uma credencial para todos os usuários,
-- compatível com pool). Em CADA transação que atua em nome de um usuário, ela
-- chama app.set_user_context(<id da sessão validada pelo servidor>); as
-- políticas de RLS e as funções de autorização leem app.current_user_id().
--
-- O valor NÃO é autenticação: qualquer um que fale SQL como antero_app pode
-- escolhê-lo. Só a camada de servidor (Entrega 5) pode defini-lo, e somente a
-- partir de uma sessão do Better Auth já validada — nunca de um id enviado
-- pelo cliente.
--
-- Garantias aplicadas no banco:
--   - escopo de transação: set_config(..., is_local => true). COMMIT/ROLLBACK
--     descartam o contexto; a próxima transação da mesma conexão do pool
--     começa sem usuário.
--   - além disso, o contexto carrega uma marca da transação que o criou
--     (pid do backend + instante de início da transação). Se alguém gravar
--     app.user_id com SET/set_config de SESSÃO (persistente na conexão), a
--     marca não confere na transação seguinte e current_user_id() devolve
--     NULL: o contexto não sobrevive entre transações nem por engano. Um SET
--     direto de app.user_id, sem passar por set_user_context, também resulta
--     em NULL.
--   - ausência de contexto (ou contexto inválido) => NULL => as políticas e
--     funções de autorização negam acesso.
create schema app;
comment on schema app is 'Contexto de execução da aplicação (usuário da transação).';
revoke all on schema app from public;
grant usage on schema app to antero_app;

create function app.set_user_context(p_user_id uuid)
returns void
language plpgsql
volatile
set search_path = ''
as $$
begin
  if p_user_id is null then
    raise exception 'app.set_user_context: p_user_id é obrigatório'
      using errcode = '22004';
  end if;
  perform pg_catalog.set_config('app.user_id', p_user_id::text, true);
  perform pg_catalog.set_config(
    'app.user_context_tx',
    pg_catalog.pg_backend_pid()::text || ':'
      || (extract(epoch from pg_catalog.transaction_timestamp()) * 1000000)::bigint::text,
    true
  );
end;
$$;

comment on function app.set_user_context(uuid) is
  'Define o usuário da transação atual (escopo local). Chamar só com o id de uma sessão validada no servidor.';

create function app.current_user_id()
returns uuid
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user_id text := pg_catalog.current_setting('app.user_id', true);
  v_marker text := pg_catalog.current_setting('app.user_context_tx', true);
begin
  if v_user_id is null or v_user_id = '' then
    return null;
  end if;
  if v_marker is distinct from (
    pg_catalog.pg_backend_pid()::text || ':'
      || (extract(epoch from pg_catalog.transaction_timestamp()) * 1000000)::bigint::text
  ) then
    return null;
  end if;
  return v_user_id::uuid;
end;
$$;

comment on function app.current_user_id() is
  'Usuário da transação atual, ou NULL (nega acesso) sem contexto válido desta transação.';

-- Default privileges do cluster já removem EXECUTE de PUBLIC; explícito aqui
-- para não depender disso.
revoke all on function app.set_user_context(uuid) from public;
revoke all on function app.current_user_id() from public;
grant execute on function app.set_user_context(uuid) to antero_app;
grant execute on function app.current_user_id() to antero_app;

-- migrate:down
-- Rollback explícito e seguro: desfaz TODOS os efeitos acima, mas recusa-se a
-- apagar identidades. Se houver qualquer linha nas tabelas de `auth`, falha
-- sem alterar nada (a transação da migration é revertida). Para descartar
-- dados de propósito, faça isso antes, de forma consciente — nunca por
-- rollback. Os DROP sem CASCADE falham se outra migration ainda depender
-- destes objetos (ex.: 0001 não revertida).
do $$
begin
  if exists (select 1 from auth.users)
     or exists (select 1 from auth.sessions)
     or exists (select 1 from auth.accounts)
     or exists (select 1 from auth.verifications) then
    raise exception 'rollback de 0000_identity recusado: o schema auth contém dados';
  end if;
end;
$$;

drop function app.current_user_id();
drop function app.set_user_context(uuid);
drop schema app;

drop table auth.verifications;
drop table auth.accounts;
drop table auth.sessions;
drop table auth.users;
drop schema auth;

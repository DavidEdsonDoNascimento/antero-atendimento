-- Antero Atendimentos — Entrega 2: identidade (Better Auth) e separação de
-- privilégios entre antero_app e antero_auth.
--
-- Estrutura (uuid, FKs, unicidade) + comportamento: perfis criados e
-- sincronizados por gatilho a partir de inserts feitos COMO antero_auth, e
-- negação real (não só catálogo) de acesso de antero_app a hashes e tokens.
BEGIN;
\ir lib/helpers.psql
SELECT plan(54);

-- ---------------------------------------------------------------------------
-- Estrutura do schema auth (Better Auth 1.7.12, generateId "uuid")
-- ---------------------------------------------------------------------------
SELECT has_schema('auth', 'schema auth existe');
SELECT tables_are('auth', ARRAY['users', 'sessions', 'accounts', 'verifications'], 'schema auth tem exatamente as 4 tabelas do Better Auth');
SELECT col_type_is('auth', 'users', 'id', 'uuid', 'auth.users.id é uuid');
SELECT col_type_is('auth', 'sessions', 'id', 'uuid', 'auth.sessions.id é uuid');
SELECT col_type_is('auth', 'accounts', 'id', 'uuid', 'auth.accounts.id é uuid');
SELECT col_type_is('auth', 'verifications', 'id', 'uuid', 'auth.verifications.id é uuid');
SELECT col_type_is('auth', 'sessions', 'user_id', 'uuid', 'auth.sessions.user_id é uuid');
SELECT col_type_is('auth', 'accounts', 'user_id', 'uuid', 'auth.accounts.user_id é uuid');
SELECT fk_ok('auth', 'sessions', 'user_id', 'auth', 'users', 'id', 'sessions.user_id → auth.users.id');
SELECT fk_ok('auth', 'accounts', 'user_id', 'auth', 'users', 'id', 'accounts.user_id → auth.users.id');
SELECT col_is_unique('auth', 'users', 'email', 'auth.users.email é único');
SELECT col_is_unique('auth', 'sessions', 'token', 'auth.sessions.token é único');

-- Referências de usuário no domínio continuam uuid e apontam para a identidade.
SELECT fk_ok('public', 'profiles', 'id', 'auth', 'users', 'id', 'profiles.id → auth.users.id');
SELECT col_type_is('public', 'profiles', 'id', 'uuid', 'profiles.id é uuid');
SELECT col_type_is('public', 'organization_members', 'user_id', 'uuid', 'organization_members.user_id é uuid');
SELECT col_type_is('public', 'conversations', 'assigned_user_id', 'uuid', 'conversations.assigned_user_id é uuid');
SELECT col_type_is('public', 'messages', 'sender_user_id', 'uuid', 'messages.sender_user_id é uuid');

-- ---------------------------------------------------------------------------
-- antero_app NÃO acessa o schema auth (hashes de senha, tokens)
-- ---------------------------------------------------------------------------
SELECT ok(NOT has_schema_privilege('antero_app', 'auth', 'USAGE'), 'antero_app não tem USAGE no schema auth');
SELECT ok(NOT has_table_privilege('antero_app', 'auth.users', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'antero_app sem privilégio em auth.users');
SELECT ok(NOT has_table_privilege('antero_app', 'auth.sessions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'antero_app sem privilégio em auth.sessions');
SELECT ok(NOT has_table_privilege('antero_app', 'auth.accounts', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'antero_app sem privilégio em auth.accounts');
SELECT ok(NOT has_table_privilege('antero_app', 'auth.verifications', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'), 'antero_app sem privilégio em auth.verifications');
SELECT ok(NOT has_column_privilege('antero_app', 'auth.accounts', 'password', 'SELECT'), 'antero_app não lê accounts.password (catálogo)');
SELECT ok(NOT has_column_privilege('antero_app', 'auth.sessions', 'token', 'SELECT'), 'antero_app não lê sessions.token (catálogo)');

-- ---------------------------------------------------------------------------
-- antero_auth: só o necessário ao Better Auth
-- ---------------------------------------------------------------------------
SELECT ok(has_schema_privilege('antero_auth', 'auth', 'USAGE'), 'antero_auth tem USAGE no schema auth');
SELECT ok(NOT has_schema_privilege('antero_auth', 'auth', 'CREATE'), 'antero_auth NÃO tem CREATE no schema auth');
SELECT ok(
  (SELECT bool_and(
     has_table_privilege('antero_auth', t, 'SELECT') AND has_table_privilege('antero_auth', t, 'INSERT')
     AND has_table_privilege('antero_auth', t, 'UPDATE') AND has_table_privilege('antero_auth', t, 'DELETE'))
   FROM unnest(ARRAY['auth.users', 'auth.sessions', 'auth.accounts', 'auth.verifications']) t),
  'antero_auth tem SELECT/INSERT/UPDATE/DELETE nas 4 tabelas do Better Auth'
);
SELECT ok(
  NOT (SELECT bool_or(has_table_privilege('antero_auth', t, 'TRUNCATE,REFERENCES,TRIGGER'))
       FROM unnest(ARRAY['auth.users', 'auth.sessions', 'auth.accounts', 'auth.verifications']) t),
  'antero_auth sem TRUNCATE/REFERENCES/TRIGGER'
);
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE grantee = 'antero_auth' AND table_schema <> 'auth'),
  0,
  'antero_auth não tem privilégio em nenhuma tabela fora do schema auth'
);
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants
   WHERE grantee = 'antero_app' AND table_schema = 'auth'),
  0,
  'antero_app não tem privilégio em nenhuma tabela do schema auth'
);

-- ---------------------------------------------------------------------------
-- Gatilhos de perfil com identidades fictícias (inserts feitos por antero_auth)
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (name, slug) VALUES ('Org Identidade', 'org-identidade-010');
INSERT INTO ids SELECT 'org', id FROM public.organizations WHERE slug = 'org-identidade-010';

SELECT pg_temp.new_user('ana', 'ana.010@teste.local', 'Ana Souza');
SELECT pg_temp.new_user('bruno', 'bruno.010@teste.local', '   ');

SELECT is(
  (SELECT (email, full_name, is_platform_admin) FROM public.profiles WHERE id = pg_temp.id('ana')),
  ROW('ana.010@teste.local'::text, 'Ana Souza'::text, false),
  'profile criado pelo gatilho com e-mail, nome e is_platform_admin = false'
);
SELECT is(
  (SELECT full_name FROM public.profiles WHERE id = pg_temp.id('bruno')),
  'bruno.010',
  'nome vazio: full_name cai para a parte local do e-mail'
);

-- Login real e sessão: antero_auth grava credencial e sessão (sem tocar em public).
SELECT is(
  pg_temp.role_exec('antero_auth', format(
    $$INSERT INTO auth.accounts (account_id, provider_id, user_id, password, updated_at)
      VALUES (%L, 'credential', %L, 'hash-ficticio-nao-e-senha-real', now())$$,
    pg_temp.id('ana'), pg_temp.id('ana'))),
  1::bigint,
  'antero_auth grava credencial (accounts)'
);
SELECT is(
  pg_temp.role_exec('antero_auth', format(
    $$INSERT INTO auth.sessions (token, user_id, expires_at, updated_at)
      VALUES ('token-ficticio-010', %L, now() + interval '1 day', now())$$,
    pg_temp.id('ana'))),
  1::bigint,
  'antero_auth grava sessão (sessions)'
);
SELECT is(
  pg_temp.role_exec('antero_auth', $$INSERT INTO auth.verifications (identifier, value, expires_at) VALUES ('reset:ana', 'valor-ficticio', now() + interval '1 hour')$$),
  1::bigint,
  'antero_auth grava verificação (verifications)'
);

-- Negação REAL (não só catálogo): antero_app, mesmo com contexto de usuário.
SELECT throws_ok(
  format($$SELECT pg_temp.app_count(%L, 'SELECT password FROM auth.accounts')$$, pg_temp.id('ana')),
  '42501',
  NULL,
  'antero_app NÃO consegue consultar hashes de senha (auth.accounts.password)'
);
SELECT throws_ok(
  format($$SELECT pg_temp.app_count(%L, 'SELECT token FROM auth.sessions')$$, pg_temp.id('ana')),
  '42501',
  NULL,
  'antero_app NÃO consegue ler tokens de sessão (auth.sessions.token)'
);
SELECT throws_ok(
  format($$SELECT pg_temp.app_count(%L, 'SELECT value FROM auth.verifications')$$, pg_temp.id('ana')),
  '42501',
  NULL,
  'antero_app NÃO consegue ler valores de verificação (auth.verifications.value)'
);
SELECT throws_ok(
  format($$SELECT pg_temp.app_exec(%L, 'UPDATE auth.users SET email_verified = true')$$, pg_temp.id('ana')),
  '42501',
  NULL,
  'antero_app NÃO altera identidades (auth.users)'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_auth', 'SELECT count(*) FROM public.profiles')$$,
  '42501',
  NULL,
  'antero_auth NÃO lê tabelas de negócio (public.profiles)'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_auth', 'CREATE TABLE auth.intrusa (id int)')$$,
  '42501',
  NULL,
  'antero_auth NÃO cria objetos no schema auth (sem migrations do Better Auth em runtime)'
);
SELECT throws_ok(
  format($$SELECT pg_temp.app_exec(%L, %L)$$, pg_temp.id('ana'),
    format('INSERT INTO public.profiles (id, email) VALUES (%L, %L)', gen_random_uuid(), 'x@teste.local')),
  '42501',
  NULL,
  'antero_app NÃO cria profiles diretamente (só o gatilho cria)'
);

-- Sincronização de e-mail: só e-mail; full_name editável não é sobrescrito.
SELECT is(
  pg_temp.role_exec('antero_auth', format(
    $$UPDATE auth.users SET email = 'ana.nova.010@teste.local', name = 'Outro Nome' WHERE id = %L$$, pg_temp.id('ana'))),
  1::bigint,
  'antero_auth altera e-mail e nome da identidade'
);
SELECT is(
  (SELECT email FROM public.profiles WHERE id = pg_temp.id('ana')),
  'ana.nova.010@teste.local',
  'troca de e-mail em auth.users sincroniza profiles.email'
);
SELECT is(
  (SELECT full_name FROM public.profiles WHERE id = pg_temp.id('ana')),
  'Ana Souza',
  'troca de nome em auth.users NÃO sobrescreve profiles.full_name'
);

-- Integridade: ids precisam ser uuid; profile sem identidade é impossível.
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_auth', 'INSERT INTO auth.users (id, name, email) VALUES (''nao-e-uuid'', ''X'', ''x.010@teste.local'')')$$,
  '22P02',
  NULL,
  'auth.users rejeita id que não é uuid'
);
SELECT throws_ok(
  format('INSERT INTO public.profiles (id, email) VALUES (%L, %L)', gen_random_uuid(), 'orfao@teste.local'),
  '23503',
  NULL,
  'profile sem identidade correspondente em auth.users é rejeitado (FK)'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_auth', 'INSERT INTO auth.users (name, email) VALUES (''Dup'', ''bruno.010@teste.local'')')$$,
  '23505',
  NULL,
  'e-mail duplicado em auth.users é rejeitado'
);

-- Exclusão da identidade: cascata para sessões, contas, profile e vínculos.
INSERT INTO public.organization_members (organization_id, user_id, role, status)
VALUES (pg_temp.id('org'), pg_temp.id('ana'), 'attendant', 'active');

SELECT is(
  pg_temp.role_exec('antero_auth', format('DELETE FROM auth.users WHERE id = %L', pg_temp.id('ana'))),
  1::bigint,
  'antero_auth remove a identidade'
);
SELECT is((SELECT count(*)::int FROM public.profiles WHERE id = pg_temp.id('ana')), 0, 'profile removido em cascata');
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE user_id = pg_temp.id('ana')), 0, 'vínculo com organização removido em cascata');
SELECT is((SELECT count(*)::int FROM auth.sessions WHERE user_id = pg_temp.id('ana')), 0, 'sessões removidas em cascata');
SELECT is((SELECT count(*)::int FROM auth.accounts WHERE user_id = pg_temp.id('ana')), 0, 'credenciais removidas em cascata');

-- Funções de gatilho não são executáveis por ninguém além do dono.
SELECT ok(
  NOT has_function_privilege('antero_auth', 'public.handle_new_user()', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.handle_new_user()', 'EXECUTE')
  AND NOT has_function_privilege('antero_auth', 'public.handle_user_email_updated()', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.handle_user_email_updated()', 'EXECUTE'),
  'gatilhos de perfil disparam sem conceder EXECUTE a antero_auth/antero_app'
);

SELECT * FROM finish();
ROLLBACK;

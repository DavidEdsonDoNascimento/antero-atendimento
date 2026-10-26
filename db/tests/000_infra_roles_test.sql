-- Antero Atendimentos — teste de fumaça da infraestrutura (pgTAP).
-- Confere os papéis criados por docker/postgres/initdb/10-roles.sh. Não depende
-- de nenhuma migration. Roda só no banco de testes (`pnpm db:test:pgtap`).
BEGIN;
SELECT plan(15);

SELECT has_role('antero_owner', 'antero_owner existe');
SELECT has_role('antero_migrator', 'antero_migrator existe');
SELECT has_role('antero_app', 'antero_app existe');
SELECT has_role('antero_auth', 'antero_auth existe');

SELECT is(
  (SELECT count(*)::int FROM pg_roles
   WHERE rolname IN ('antero_owner', 'antero_migrator', 'antero_app', 'antero_auth')
     AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)),
  0,
  'nenhum papel do Antero é superusuário/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION'
);

SELECT is(
  (SELECT rolcanlogin FROM pg_roles WHERE rolname = 'antero_owner'),
  false,
  'antero_owner não faz login'
);

SELECT is(
  (SELECT pg_get_userbyid(datdba)::text FROM pg_database WHERE datname = current_database()),
  'antero_owner',
  'o banco pertence a antero_owner'
);

SELECT is(
  (SELECT pg_get_userbyid(nspowner)::text FROM pg_namespace WHERE nspname = 'public'),
  'antero_owner',
  'o schema public pertence a antero_owner'
);

SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname IN ('antero_app', 'antero_auth')),
  0,
  'antero_app e antero_auth não possuem objetos'
);

SELECT ok(
  NOT has_schema_privilege('antero_app', 'public', 'CREATE'),
  'antero_app não tem CREATE no schema public'
);

SELECT ok(
  has_schema_privilege('antero_app', 'public', 'USAGE'),
  'antero_app tem USAGE no schema public'
);

SELECT ok(
  NOT has_schema_privilege('public', 'public', 'USAGE'),
  'PUBLIC não tem USAGE no schema public'
);

SELECT ok(
  NOT has_schema_privilege('antero_auth', 'public', 'USAGE'),
  'antero_auth não tem USAGE no schema public (só enxerga o schema auth)'
);

SELECT ok(
  NOT has_database_privilege('antero_app', current_database(), 'TEMP')
    AND NOT has_database_privilege('antero_auth', current_database(), 'TEMP'),
  'antero_app e antero_auth não criam tabelas temporárias'
);

SELECT has_extension('pgtap', 'pgtap instalado no banco de testes');

SELECT * FROM finish();
ROLLBACK;

-- Antero Atendimentos — teste de fumaça da infraestrutura (pgTAP).
-- Confere os papéis criados por docker/postgres/initdb/10-roles.sh. Não depende
-- de nenhuma migration. Roda só no banco de testes (`pnpm db:test:pgtap`).
BEGIN;
SELECT plan(12);

SELECT has_role('antero_owner', 'antero_owner existe');
SELECT has_role('antero_migrator', 'antero_migrator existe');
SELECT has_role('antero_app', 'antero_app existe');

SELECT is(
  (SELECT count(*)::int FROM pg_roles
   WHERE rolname IN ('antero_owner', 'antero_migrator', 'antero_app')
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
  (SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'antero_app'),
  0,
  'antero_app não possui objetos'
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

SELECT has_extension('pgtap', 'pgtap instalado no banco de testes');

SELECT * FROM finish();
ROLLBACK;

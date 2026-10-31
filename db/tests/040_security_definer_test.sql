-- Antero Atendimentos — Entrega 2: revisão das funções SECURITY DEFINER.
--
-- Catálogo (dono, search_path, grants) + comportamento (autorização dentro
-- das funções, resistência a sombreamento por search_path, negação a quem
-- não tem EXECUTE). As funções da extensão pgTAP (só no banco de testes) são
-- ignoradas nas contagens.
BEGIN;
\ir lib/helpers.psql
SELECT plan(33);

CREATE TEMP VIEW our_functions AS
SELECT p.oid, n.nspname, p.proname, p.oid::regprocedure::text AS signature,
       p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'app', 'auth')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

-- ---------------------------------------------------------------------------
-- Catálogo
-- ---------------------------------------------------------------------------
SELECT set_eq(
  'SELECT signature FROM our_functions WHERE prosecdef',
  ARRAY[
    'is_platform_admin()', 'is_org_member(uuid)', 'is_org_admin(uuid)', 'shares_org_with(uuid)',
    'handle_new_user()', 'handle_user_email_updated()',
    'ingest_inbound_message(uuid,text,text,text,text)',
    'current_user_suspended_organizations()', 'set_organization_status(uuid,organization_status)',
    'set_organization_module(uuid,organization_module,boolean)'
  ],
  'conjunto exato de funções SECURITY DEFINER'
);
SELECT is(
  (SELECT count(*)::int FROM our_functions WHERE owner <> 'antero_owner'),
  0,
  'todas as funções pertencem a antero_owner'
);
SELECT is(
  (SELECT count(*)::int FROM our_functions WHERE prosecdef AND NOT (proconfig @> ARRAY['search_path=""'])),
  0,
  'toda função SECURITY DEFINER fixa search_path vazio'
);
SELECT is(
  (SELECT count(*)::int FROM our_functions WHERE NOT coalesce(proconfig @> ARRAY['search_path=""'], false)),
  0,
  'todas as funções do projeto (inclusive as não privilegiadas) fixam search_path vazio'
);
SELECT is(
  (SELECT count(*)::int FROM our_functions WHERE has_function_privilege('public', oid, 'EXECUTE')),
  0,
  'nenhuma função do projeto é executável por PUBLIC'
);
SELECT is(
  (SELECT count(*)::int FROM our_functions WHERE has_function_privilege('antero_auth', oid, 'EXECUTE')),
  0,
  'antero_auth não executa nenhuma função do projeto'
);
SELECT set_eq(
  $$SELECT nspname || '.' || signature FROM our_functions WHERE has_function_privilege('antero_app', oid, 'EXECUTE')$$,
  ARRAY[
    'app.app.set_user_context(uuid)', 'app.app.current_user_id()',
    'public.is_platform_admin()', 'public.is_org_member(uuid)', 'public.is_org_admin(uuid)',
    'public.shares_org_with(uuid)', 'public.ingest_inbound_message(uuid,text,text,text,text)',
    'public.current_user_suspended_organizations()', 'public.set_organization_status(uuid,organization_status)',
    'public.has_module(uuid,organization_module)', 'public.set_organization_module(uuid,organization_module,boolean)'
  ],
  'antero_app executa exatamente as funções necessárias (gatilhos e set_updated_at fora)'
);
SELECT ok(
  NOT has_function_privilege('antero_app', 'public.set_updated_at()', 'EXECUTE'),
  'set_updated_at não é executável pela aplicação'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-040'), ('Org B', 'org-b-040');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-040';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-040';
SELECT pg_temp.new_user('a_owner', 'a.owner.040@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.040@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.040@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.040@teste.local', 'A Admin Desativado');
SELECT pg_temp.new_user('a_invited', 'a.invited.040@teste.local', 'A Convidado');
SELECT pg_temp.new_user('b_owner', 'b.owner.040@teste.local', 'B Owner');
SELECT pg_temp.new_user('platform', 'platform.040@teste.local', 'Admin Plataforma');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'admin', 'disabled'),
  (pg_temp.id('org_a'), pg_temp.id('a_invited'), 'admin', 'invited'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active');

-- ---------------------------------------------------------------------------
-- Comportamento: as funções só respondem sobre o usuário da transação
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.app_value(NULL, 'public.is_platform_admin()'), 'false', 'sem contexto: is_platform_admin() = false');
SELECT is(pg_temp.app_value(NULL, pg_temp.fill('public.is_org_member({org_a})')), 'false', 'sem contexto: is_org_member() = false');
SELECT is(pg_temp.app_value(NULL, pg_temp.fill('public.is_org_admin({org_a})')), 'false', 'sem contexto: is_org_admin() = false');
SELECT is(pg_temp.app_value(NULL, pg_temp.fill('public.shares_org_with({a_owner})')), 'false', 'sem contexto: shares_org_with() = false');

SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.is_org_member({org_a})')), 'true', 'atendente ativo: is_org_member(A) = true');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.is_org_admin({org_a})')), 'false', 'atendente: is_org_admin(A) = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_admin'), pg_temp.fill('public.is_org_admin({org_a})')), 'true', 'admin ativo: is_org_admin(A) = true');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_admin({org_a})')), 'true', 'owner ativo: is_org_admin(A) = true');
SELECT is(pg_temp.app_value(pg_temp.id('a_disabled'), pg_temp.fill('public.is_org_member({org_a})')), 'false', 'admin desativado: is_org_member(A) = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_disabled'), pg_temp.fill('public.is_org_admin({org_a})')), 'false', 'admin desativado: is_org_admin(A) = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_invited'), pg_temp.fill('public.is_org_admin({org_a})')), 'false', 'admin apenas convidado: is_org_admin(A) = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_member({org_b})')), 'false', 'owner de A: is_org_member(B) = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_admin({org_b})')), 'false', 'owner de A: is_org_admin(B) = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.shares_org_with({a_owner})')), 'true', 'shares_org_with: colegas ativos = true');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.shares_org_with({b_owner})')), 'false', 'shares_org_with: outra organização = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.shares_org_with({a_disabled})')), 'false', 'shares_org_with: colega desativado = false');
SELECT is(pg_temp.app_value(pg_temp.id('platform'), 'public.is_platform_admin()'), 'true', 'admin da plataforma: is_platform_admin() = true');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), 'public.is_platform_admin()'), 'false', 'owner de organização: is_platform_admin() = false');
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill('public.is_org_member({org_a})')), 'false', 'admin da plataforma NÃO é membro implícito de organizações');

-- ---------------------------------------------------------------------------
-- Sombreamento por search_path: objetos falsos não mudam o resultado
-- ---------------------------------------------------------------------------
CREATE SCHEMA evil;
CREATE TABLE evil.organization_members (organization_id uuid, user_id uuid, status text, role text);
INSERT INTO evil.organization_members SELECT pg_temp.id('org_b'), pg_temp.id('a_att'), 'active', 'owner';
CREATE TABLE evil.profiles (id uuid, is_platform_admin boolean);
INSERT INTO evil.profiles SELECT pg_temp.id('a_att'), true;
GRANT USAGE ON SCHEMA evil TO antero_app;
GRANT SELECT ON evil.organization_members, evil.profiles TO antero_app;
SET LOCAL search_path = evil, public, pg_catalog;
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.is_org_admin({org_b})')), 'false', 'search_path malicioso: is_org_admin ignora tabela falsa');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), 'public.is_platform_admin()'), 'false', 'search_path malicioso: is_platform_admin ignora tabela falsa');
RESET search_path;

-- ---------------------------------------------------------------------------
-- Quem não tem EXECUTE não chama as funções privilegiadas
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  pg_temp.fill($$SELECT pg_temp.role_exec('antero_auth', $q$SELECT public.is_org_admin({org_a})$q$)$$),
  '42501', NULL, 'antero_auth NÃO executa is_org_admin'
);
SELECT throws_ok(
  pg_temp.fill($$SELECT pg_temp.role_exec('antero_auth', $q$SELECT * FROM public.ingest_inbound_message({org_a}, '+5511900000401', 'x', 'x')$q$)$$),
  '42501', NULL, 'antero_auth NÃO executa ingest_inbound_message'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_auth', 'SELECT app.set_user_context(gen_random_uuid())')$$,
  '42501', NULL, 'antero_auth NÃO define contexto de usuário da aplicação'
);

-- Gatilho de perfil chamado diretamente (fora de um gatilho) não faz nada útil.
SELECT throws_ok(
  'SELECT public.handle_new_user()',
  '0A000', NULL, 'handle_new_user só roda como gatilho'
);

SELECT * FROM finish();
ROLLBACK;

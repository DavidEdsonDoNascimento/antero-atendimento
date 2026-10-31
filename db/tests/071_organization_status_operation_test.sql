-- Antero Atendimentos — Entrega E1A: operações SECURITY DEFINER da suspensão.
--
-- set_organization_status: só o admin da plataforma, com validação explícita.
-- current_user_suspended_organizations: só vínculos ativos do próprio usuário.
BEGIN;
\ir lib/helpers.psql
SELECT plan(38);

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-071'), ('Org B', 'org-b-071');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-071';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-071';
SELECT pg_temp.new_user('a_owner', 'a.owner.071@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.071@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.071@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.071@teste.local', 'A Desativado');
SELECT pg_temp.new_user('a_invited', 'a.invited.071@teste.local', 'A Convidado');
SELECT pg_temp.new_user('multi', 'multi.071@teste.local', 'Multi');
SELECT pg_temp.new_user('b_owner', 'b.owner.071@teste.local', 'B Owner');
SELECT pg_temp.new_user('nobody', 'nobody.071@teste.local', 'Sem Organização');
SELECT pg_temp.new_user('platform', 'platform.071@teste.local', 'Plataforma');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'owner', 'disabled'),
  (pg_temp.id('org_a'), pg_temp.id('a_invited'), 'owner', 'invited'),
  (pg_temp.id('org_a'), pg_temp.id('multi'), 'attendant', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('multi'), 'attendant', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active');

CREATE FUNCTION pg_temp.status_of(p_key text) RETURNS text
LANGUAGE sql STABLE AS $$ SELECT status::text FROM public.organizations WHERE id = pg_temp.id(p_key) $$;

-- ---------------------------------------------------------------------------
-- Catálogo: dono, search_path, grants
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.set_organization_status(uuid, public.organization_status)'::regprocedure),
  'antero_owner', 'set_organization_status pertence a antero_owner'
);
SELECT is(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.current_user_suspended_organizations()'::regprocedure),
  'antero_owner', 'current_user_suspended_organizations pertence a antero_owner'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'public.set_organization_status(uuid, public.organization_status)'::regprocedure),
  'set_organization_status: SECURITY DEFINER com search_path vazio'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'public.current_user_suspended_organizations()'::regprocedure),
  'current_user_suspended_organizations: SECURITY DEFINER com search_path vazio'
);
SELECT ok(NOT has_function_privilege('public', 'public.set_organization_status(uuid, public.organization_status)', 'EXECUTE'), 'PUBLIC não executa set_organization_status');
SELECT ok(NOT has_function_privilege('antero_auth', 'public.set_organization_status(uuid, public.organization_status)', 'EXECUTE'), 'antero_auth não executa set_organization_status');
SELECT ok(NOT has_function_privilege('antero_auth', 'public.current_user_suspended_organizations()', 'EXECUTE'), 'antero_auth não executa current_user_suspended_organizations');
SELECT ok(has_function_privilege('antero_app', 'public.set_organization_status(uuid, public.organization_status)', 'EXECUTE'), 'antero_app executa set_organization_status (autorização é interna)');

-- Privilégios efetivos de antero_app, sem BYPASSRLS.
SELECT ok(NOT (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'antero_app'), 'antero_app sem BYPASSRLS e sem superusuário');
SELECT ok(has_column_privilege('antero_app', 'public.organizations', 'name', 'UPDATE'), 'antero_app: UPDATE em organizations.name');
SELECT ok(
  NOT (has_column_privilege('antero_app', 'public.organizations', 'status', 'UPDATE')
    OR has_column_privilege('antero_app', 'public.organizations', 'slug', 'UPDATE')
    OR has_column_privilege('antero_app', 'public.organizations', 'id', 'UPDATE')
    OR has_table_privilege('antero_app', 'public.organizations', 'UPDATE')),
  'antero_app: sem UPDATE em status, slug, id ou na tabela inteira'
);
SELECT ok(NOT has_table_privilege('antero_app', 'public.whatsapp_accounts', 'INSERT,UPDATE,DELETE'), 'antero_app: sem escrita em whatsapp_accounts');
SELECT ok(has_table_privilege('antero_app', 'public.whatsapp_accounts', 'SELECT'), 'antero_app: leitura de whatsapp_accounts preservada');

-- ---------------------------------------------------------------------------
-- set_organization_status: negações
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$SELECT public.set_organization_status({org_a}, 'inactive')$q$)$$, '42501', NULL, 'owner NÃO suspende a própria organização');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$SELECT public.set_organization_status({org_a}, 'inactive')$q$)$$, '42501', NULL, 'admin NÃO suspende');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$SELECT public.set_organization_status({org_a}, 'inactive')$q$)$$, '42501', NULL, 'atendente NÃO suspende');
SELECT throws_ok($$SELECT pg_temp.does('b_owner', $q$SELECT public.set_organization_status({org_a}, 'inactive')$q$)$$, '42501', NULL, 'owner de outra empresa NÃO suspende');
SELECT throws_ok($$SELECT pg_temp.does('nobody', $q$SELECT public.set_organization_status({org_a}, 'inactive')$q$)$$, '42501', NULL, 'usuário sem organização NÃO suspende');
SELECT throws_ok(pg_temp.fill($$SELECT pg_temp.app_value(NULL, $q$public.set_organization_status({org_a}, 'inactive')$q$)$$), '42501', NULL, 'sem contexto NÃO suspende');
SELECT is(pg_temp.status_of('org_a'), 'active', 'status intacto após as tentativas');

-- ---------------------------------------------------------------------------
-- Suspensão autorizada e tentativas de reativação
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_status({org_a}, 'inactive')$q$)), 'inactive', 'plataforma suspende e recebe o novo status');
SELECT is(pg_temp.status_of('org_a'), 'inactive', 'organização gravada como inactive');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$SELECT public.set_organization_status({org_a}, 'active')$q$)$$, '42501', NULL, 'owner NÃO reativa pela operação');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$SELECT public.set_organization_status({org_a}, 'active')$q$)$$, '42501', NULL, 'admin NÃO reativa pela operação');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$SELECT public.set_organization_status({org_a}, 'active')$q$)$$, '42501', NULL, 'atendente NÃO reativa pela operação');
SELECT is(pg_temp.status_of('org_a'), 'inactive', 'continua suspensa');

-- ---------------------------------------------------------------------------
-- current_user_suspended_organizations: distingue suspensa de sem vínculo
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_owner', 'SELECT * FROM public.current_user_suspended_organizations()'), 1::bigint, 'membro ativo vê a própria suspensa');
SELECT is(pg_temp.sees('multi', 'SELECT * FROM public.current_user_suspended_organizations()'), 1::bigint, 'multi: só a suspensa, não a ativa');
SELECT is(pg_temp.sees('a_disabled', 'SELECT * FROM public.current_user_suspended_organizations()'), 0::bigint, 'vínculo desativado não aparece');
SELECT is(pg_temp.sees('a_invited', 'SELECT * FROM public.current_user_suspended_organizations()'), 0::bigint, 'convite não aparece');
SELECT is(pg_temp.sees('nobody', 'SELECT * FROM public.current_user_suspended_organizations()'), 0::bigint, 'sem vínculo: vazio (outra situação)');
SELECT is(pg_temp.app_count(NULL, 'SELECT * FROM public.current_user_suspended_organizations()'), 0::bigint, 'sem contexto: vazio');

-- ---------------------------------------------------------------------------
-- Reativação autorizada e validação de entrada
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_status({org_a}, 'active')$q$)), 'active', 'plataforma reativa');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.organization_members'), 6::bigint, 'reativada: owner volta a ver os vínculos, todos preservados');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_status(gen_random_uuid(), 'inactive')$q$)$$, 'P0002', NULL, 'organização inexistente: erro explícito');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_status(NULL, 'inactive')$q$)$$, '22004', NULL, 'organização nula: recusada');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_status({org_a}, NULL)$q$)$$, '22004', NULL, 'status nulo: recusado');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_status({org_a}, 'bloqueada')$q$)$$, '22P02', NULL, 'status fora do enum: recusado');

SELECT * FROM finish();
ROLLBACK;

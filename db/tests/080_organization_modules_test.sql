-- Antero Atendimentos — Entrega E1B: módulos habilitáveis por organização.
--
-- Tabela, RLS, has_module e set_organization_module, sempre como antero_app,
-- com o contexto de usuário definido como a aplicação faz.
BEGIN;
\ir lib/helpers.psql
SELECT plan(90);

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-080'), ('Org B', 'org-b-080');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-080';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-080';
SELECT pg_temp.new_user('a_owner', 'a.owner.080@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.080@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.080@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.080@teste.local', 'A Desativado');
SELECT pg_temp.new_user('multi', 'multi.080@teste.local', 'Multi');
SELECT pg_temp.new_user('b_owner', 'b.owner.080@teste.local', 'B Owner');
SELECT pg_temp.new_user('nobody', 'nobody.080@teste.local', 'Sem Organização');
SELECT pg_temp.new_user('platform', 'platform.080@teste.local', 'Plataforma');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'owner', 'disabled'),
  (pg_temp.id('org_a'), pg_temp.id('multi'), 'attendant', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('multi'), 'attendant', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active');

-- Situação gravada de um módulo: 't', 'f' ou NULL sem linha.
CREATE FUNCTION pg_temp.module_state(p_org text, p_module text) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT enabled FROM public.organization_modules
  WHERE organization_id = pg_temp.id(p_org) AND module = p_module::public.organization_module
$$;

CREATE FUNCTION pg_temp.set_module(p_user text, p_org text, p_module text, p_enabled boolean) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.app_value(
    pg_temp.id(p_user),
    format('public.set_organization_module(%L, %L, %L)', pg_temp.id(p_org), p_module, p_enabled)
  )
$$;

CREATE FUNCTION pg_temp.has(p_user text, p_org text, p_module text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.app_value(
    pg_temp.id(p_user),
    format('public.has_module(%L, %L)', pg_temp.id(p_org), p_module)
  )
$$;

-- ---------------------------------------------------------------------------
-- Catálogo: enum, tabela, dono, search_path, grants
-- ---------------------------------------------------------------------------
SELECT enum_has_labels('public', 'organization_module', ARRAY['atendimento', 'automacoes', 'campanhas', 'contatos'], 'enum com os 4 módulos');
SELECT has_table('public', 'organization_modules', 'tabela organization_modules existe');
SELECT columns_are('public', 'organization_modules', ARRAY['id', 'organization_id', 'module', 'enabled', 'updated_by', 'updated_at'], 'colunas exatas');
SELECT col_is_unique('public', 'organization_modules', ARRAY['organization_id', 'module'], 'UNIQUE (organization_id, module)');
SELECT col_type_is('public', 'organization_modules', 'module', 'organization_module', 'module usa o enum');
SELECT col_default_is('public', 'organization_modules', 'enabled', 'false', 'padrão: desabilitado');
SELECT fk_ok('public', 'organization_modules', 'organization_id', 'public', 'organizations', 'id', 'FK para organizations');
SELECT fk_ok('public', 'organization_modules', 'updated_by', 'public', 'profiles', 'id', 'FK para profiles');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.organization_modules'::regclass), 'RLS habilitada');
SELECT is((SELECT count(*)::int FROM pg_policies WHERE tablename = 'organization_modules'), 1, 'uma única política');
SELECT is((SELECT cmd::text FROM pg_policies WHERE tablename = 'organization_modules'), 'SELECT', 'só de leitura');

SELECT ok(has_table_privilege('antero_app', 'public.organization_modules', 'SELECT'), 'antero_app lê');
SELECT ok(NOT has_table_privilege('antero_app', 'public.organization_modules', 'INSERT,UPDATE,DELETE,TRUNCATE'), 'antero_app não escreve');
SELECT ok(NOT has_table_privilege('antero_auth', 'public.organization_modules', 'SELECT,INSERT,UPDATE,DELETE'), 'antero_auth sem acesso');
SELECT is(pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.organization_modules'::regclass)), 'antero_owner', 'tabela pertence a antero_owner');

SELECT is(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.set_organization_module(uuid, public.organization_module, boolean)'::regprocedure),
  'antero_owner', 'set_organization_module pertence a antero_owner'
);
SELECT ok(
  (SELECT prosecdef AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'public.set_organization_module(uuid, public.organization_module, boolean)'::regprocedure),
  'set_organization_module: SECURITY DEFINER com search_path vazio'
);
SELECT ok(
  (SELECT NOT prosecdef AND provolatile = 's' AND proconfig @> ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'public.has_module(uuid, public.organization_module)'::regprocedure),
  'has_module: SECURITY INVOKER, STABLE, search_path vazio'
);
SELECT ok(NOT has_function_privilege('public', 'public.has_module(uuid, public.organization_module)', 'EXECUTE'), 'PUBLIC não executa has_module');
SELECT ok(NOT has_function_privilege('public', 'public.set_organization_module(uuid, public.organization_module, boolean)', 'EXECUTE'), 'PUBLIC não executa set_organization_module');
SELECT ok(NOT has_function_privilege('antero_auth', 'public.set_organization_module(uuid, public.organization_module, boolean)', 'EXECUTE'), 'antero_auth não executa set_organization_module');
SELECT ok(has_function_privilege('antero_app', 'public.set_organization_module(uuid, public.organization_module, boolean)', 'EXECUTE'), 'antero_app executa (autorização é interna)');

-- ---------------------------------------------------------------------------
-- Organização nova: nenhum módulo
-- ---------------------------------------------------------------------------
SELECT is((SELECT count(*)::int FROM public.organization_modules WHERE organization_id = pg_temp.id('org_a')), 0, 'organização nova nasce sem linhas');
SELECT is(pg_temp.has('a_owner', 'org_a', 'atendimento'), 'false', 'organização nova: Atendimento desabilitado');
SELECT is(pg_temp.has('a_owner', 'org_a', 'contatos'), 'false', 'organização nova: Contatos desabilitado');

-- ---------------------------------------------------------------------------
-- Alteração: só o admin da plataforma
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$SELECT public.set_organization_module({org_a}, 'atendimento', true)$q$)$$, '42501', NULL, 'owner NÃO habilita');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$SELECT public.set_organization_module({org_a}, 'atendimento', true)$q$)$$, '42501', NULL, 'admin da organização NÃO habilita');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$SELECT public.set_organization_module({org_a}, 'atendimento', true)$q$)$$, '42501', NULL, 'atendente NÃO habilita');
SELECT throws_ok($$SELECT pg_temp.does('b_owner', $q$SELECT public.set_organization_module({org_a}, 'atendimento', true)$q$)$$, '42501', NULL, 'owner de outra empresa NÃO habilita');
SELECT throws_ok($$SELECT pg_temp.does('nobody', $q$SELECT public.set_organization_module({org_a}, 'atendimento', true)$q$)$$, '42501', NULL, 'usuário sem organização NÃO habilita');
SELECT throws_ok(pg_temp.fill($$SELECT pg_temp.app_value(NULL, $q$public.set_organization_module({org_a}, 'atendimento', true)$q$)$$), '42501', NULL, 'sem sessão NÃO habilita');
SELECT is(pg_temp.module_state('org_a', 'atendimento'), NULL, 'nada gravado após as tentativas');

SELECT is(pg_temp.set_module('platform', 'org_a', 'atendimento', true), 'true', 'plataforma habilita, sem pertencer à organização');
SELECT is(pg_temp.module_state('org_a', 'atendimento'), true, 'gravado como habilitado');
SELECT is(
  (SELECT updated_by FROM public.organization_modules WHERE organization_id = pg_temp.id('org_a') AND module = 'atendimento'),
  pg_temp.id('platform'), 'registra o responsável'
);
SELECT ok(
  (SELECT updated_at IS NOT NULL FROM public.organization_modules WHERE organization_id = pg_temp.id('org_a') AND module = 'atendimento'),
  'registra o horário'
);
SELECT is(pg_temp.has('a_att', 'org_a', 'atendimento'), 'true', 'atendente passa a ter o módulo');
SELECT is(pg_temp.has('a_owner', 'org_a', 'automacoes'), 'false', 'os demais módulos seguem desabilitados');
SELECT is(pg_temp.has('b_owner', 'org_b', 'atendimento'), 'false', 'habilitar em A não habilita em B');

-- Repetir não duplica, e desabilitar persiste a linha.
SELECT is(pg_temp.set_module('platform', 'org_a', 'atendimento', true), 'true', 'repetir a operação é aceito');
SELECT is((SELECT count(*)::int FROM public.organization_modules WHERE organization_id = pg_temp.id('org_a') AND module = 'atendimento'), 1, 'repetir não duplica o registro');
SELECT is(pg_temp.set_module('platform', 'org_a', 'atendimento', false), 'false', 'plataforma desabilita');
SELECT is(pg_temp.has('a_owner', 'org_a', 'atendimento'), 'false', 'desabilitado vale na consulta seguinte');
SELECT is(pg_temp.set_module('platform', 'org_a', 'atendimento', true), 'true', 'plataforma habilita de novo');

-- ---------------------------------------------------------------------------
-- Escrita direta: bloqueada para todos, inclusive o admin da plataforma
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ({org_a}, 'campanhas', true)$q$)$$, '42501', NULL, 'owner: INSERT direto negado');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organization_modules SET enabled = true WHERE organization_id = {org_a}$q$)$$, '42501', NULL, 'owner: UPDATE direto negado');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$DELETE FROM public.organization_modules WHERE organization_id = {org_a}$q$)$$, '42501', NULL, 'owner: DELETE direto negado');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ({org_a}, 'campanhas', true)$q$)$$, '42501', NULL, 'plataforma: INSERT direto negado');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$UPDATE public.organization_modules SET enabled = false WHERE organization_id = {org_a}$q$)$$, '42501', NULL, 'plataforma: UPDATE direto negado');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$TRUNCATE public.organization_modules$q$)$$, '42501', NULL, 'plataforma: TRUNCATE negado');

-- ---------------------------------------------------------------------------
-- Dependência: Campanhas exige Contatos
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.set_module('platform', 'org_a', 'campanhas', true)$$, '23514', NULL, 'Campanhas sem Contatos: recusado');
SELECT is(pg_temp.module_state('org_a', 'campanhas'), NULL, 'Campanhas não foi gravado');
SELECT is(pg_temp.set_module('platform', 'org_a', 'contatos', true), 'true', 'Contatos habilitado');
SELECT is(pg_temp.set_module('platform', 'org_a', 'campanhas', true), 'true', 'Campanhas com Contatos: aceito');
SELECT throws_ok($$SELECT pg_temp.set_module('platform', 'org_a', 'contatos', false)$$, '23514', NULL, 'desligar Contatos com Campanhas ligado: recusado');
SELECT is(pg_temp.module_state('org_a', 'contatos'), true, 'Contatos continua habilitado');
SELECT is(pg_temp.set_module('platform', 'org_a', 'campanhas', false), 'false', 'desliga Campanhas primeiro');
SELECT is(pg_temp.set_module('platform', 'org_a', 'contatos', false), 'false', 'depois desliga Contatos');
SELECT is(pg_temp.set_module('platform', 'org_a', 'contatos', true), 'true', 'Contatos religado');
SELECT is(pg_temp.set_module('platform', 'org_a', 'campanhas', true), 'true', 'Campanhas religado');
SELECT throws_ok($$SELECT pg_temp.set_module('platform', 'org_b', 'campanhas', true)$$, '23514', NULL, 'Contatos de A não libera Campanhas em B');
SELECT is(pg_temp.set_module('platform', 'org_a', 'automacoes', true), 'true', 'Automações não depende de Atendimento');

-- ---------------------------------------------------------------------------
-- Isolamento entre organizações
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.has('b_owner', 'org_a', 'atendimento'), 'false', 'owner de B não obtém módulo de A informando o id');
SELECT is(pg_temp.has('nobody', 'org_a', 'atendimento'), 'false', 'sem organização: false');
SELECT is(pg_temp.has('a_disabled', 'org_a', 'atendimento'), 'false', 'vínculo desativado: false');
SELECT is(pg_temp.app_value(NULL, pg_temp.fill($q$public.has_module({org_a}, 'atendimento')$q$)), 'false', 'sem sessão: false');
SELECT is(pg_temp.has('platform', 'org_a', 'atendimento'), 'false', 'admin da plataforma não é membro implícito');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.organization_modules WHERE organization_id = {org_a}'), 0::bigint, 'owner de B não lê a configuração de A');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.organization_modules'), 4::bigint, 'owner de A lê só a própria configuração');
SELECT is(pg_temp.sees('nobody', 'SELECT 1 FROM public.organization_modules'), 0::bigint, 'sem organização: não lê nada');
SELECT is(pg_temp.app_count(NULL, 'SELECT 1 FROM public.organization_modules'), 0::bigint, 'sem sessão: não lê nada');
SELECT ok(pg_temp.sees('platform', 'SELECT 1 FROM public.organization_modules WHERE organization_id = {org_a}') = 4, 'admin da plataforma lê a configuração');

-- Vínculos em duas organizações: a resposta depende da organização informada.
SELECT is(pg_temp.has('multi', 'org_a', 'atendimento'), 'true', 'multi: Atendimento em A');
SELECT is(pg_temp.has('multi', 'org_b', 'atendimento'), 'false', 'multi: sem Atendimento em B');

-- ---------------------------------------------------------------------------
-- Suspensão: não usa módulos; a configuração sobrevive
-- ---------------------------------------------------------------------------
SELECT pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_status({org_a}, 'inactive')$q$));
SELECT is(pg_temp.has('a_owner', 'org_a', 'atendimento'), 'false', 'suspensa: owner sem módulo');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.organization_modules'), 0::bigint, 'suspensa: membro não lê a configuração');
SELECT is(pg_temp.has('multi', 'org_a', 'atendimento'), 'false', 'multi: módulo de A bloqueado');
SELECT is(pg_temp.module_state('org_a', 'campanhas'), true, 'suspensa: configuração preservada');
SELECT is(pg_temp.set_module('platform', 'org_a', 'automacoes', false), 'false', 'plataforma ajusta a configuração da suspensa');
SELECT pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_status({org_a}, 'active')$q$));
SELECT is(pg_temp.has('a_owner', 'org_a', 'campanhas'), 'true', 'reativada: módulos voltam como estavam');
SELECT is(pg_temp.has('a_owner', 'org_a', 'automacoes'), 'false', 'reativada: vale o ajuste feito durante a suspensão');

-- ---------------------------------------------------------------------------
-- Uso previsto em tabela nova de um módulo: is_org_member AND has_module
-- ---------------------------------------------------------------------------
CREATE TABLE public.probe_080 (organization_id uuid NOT NULL);
ALTER TABLE public.probe_080 ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.probe_080 TO antero_app;
CREATE POLICY probe_080_select ON public.probe_080 FOR SELECT TO antero_app
  USING (public.is_org_member(organization_id) AND public.has_module(organization_id, 'campanhas'));
INSERT INTO public.probe_080 VALUES (pg_temp.id('org_a')), (pg_temp.id('org_b'));
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.probe_080'), 1::bigint, 'política nova: só a própria organização com o módulo');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.probe_080'), 0::bigint, 'política nova: organização sem o módulo não lê');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.probe_080'), 0::bigint, 'política nova: admin da plataforma não lê dados operacionais');
SELECT is(
  (SELECT has_function_privilege('antero_owner', 'public.has_module(uuid, public.organization_module)', 'EXECUTE')),
  true, 'antero_owner executa has_module'
);

-- ---------------------------------------------------------------------------
-- Validação de entrada
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_module(gen_random_uuid(), 'atendimento', true)$q$)$$, 'P0002', NULL, 'organização inexistente: erro explícito');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_module(NULL, 'atendimento', true)$q$)$$, '22004', NULL, 'organização nula: recusada');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_module({org_a}, NULL, true)$q$)$$, '22004', NULL, 'módulo nulo: recusado');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_module({org_a}, 'atendimento', NULL)$q$)$$, '22004', NULL, 'situação nula: recusada');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$SELECT public.set_organization_module({org_a}, 'financeiro', true)$q$)$$, '22P02', NULL, 'módulo fora do enum: recusado');

SELECT * FROM finish();
ROLLBACK;

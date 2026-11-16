-- Antero Atendimentos — Entrega G2A: segurança dos vínculos e das organizações.
--
-- 1) Os ataques reproduzidos na investigação, como antero_app com o contexto de
--    cada usuário: todos recusados pelo privilégio, sem alterar nada.
-- 2) A garantia de owner ativo, exercida como operação de manutenção (o
--    superusuário do banco descartável faz o papel do dono das tabelas): o
--    gatilho vale para qualquer papel. Concorrência e REPEATABLE READ ficam em
--    tests/db/member-rules.test.ts (precisam de duas conexões).
-- 3) O que precisa continuar: leitura dos vínculos (membro e admin global),
--    suspender/reativar e módulos pelo admin da plataforma.
--
-- Cenário: A (owner, admin, atendente, admin desativado), B (owner), C (sem
-- owner, só atendente), outsider sem vínculo e platform (admin da plataforma sem vínculo).
BEGIN;
\ir lib/helpers.psql
SELECT plan(70);

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-120'), ('Org B', 'org-b-120'), ('Org C', 'org-c-120');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-120';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-120';
INSERT INTO ids SELECT 'org_c', id FROM public.organizations WHERE slug = 'org-c-120';

SELECT pg_temp.new_user('a_owner', 'a.owner.120@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_owner2', 'a.owner2.120@teste.local', 'A Owner 2');
SELECT pg_temp.new_user('a_admin', 'a.admin.120@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.120@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.120@teste.local', 'A Admin Desativado');
SELECT pg_temp.new_user('b_owner', 'b.owner.120@teste.local', 'B Owner');
SELECT pg_temp.new_user('c_att', 'c.att.120@teste.local', 'C Atendente');
SELECT pg_temp.new_user('outsider', 'outsider.120@teste.local', 'Sem Vínculo');
SELECT pg_temp.new_user('platform', 'platform.120@teste.local', 'Plataforma');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');

INSERT INTO public.organization_members (organization_id, user_id, role, status, created_at) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active', '2026-01-01 00:00:00+00'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active', '2026-01-02 00:00:00+00'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active', '2026-01-03 00:00:00+00'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'admin', 'disabled', '2026-01-04 00:00:00+00'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active', '2026-01-01 00:00:00+00'),
  (pg_temp.id('org_c'), pg_temp.id('c_att'), 'attendant', 'active', '2026-01-01 00:00:00+00');
INSERT INTO ids SELECT 'm_a_owner', id FROM public.organization_members WHERE user_id = pg_temp.id('a_owner');
INSERT INTO ids SELECT 'm_a_admin', id FROM public.organization_members WHERE user_id = pg_temp.id('a_admin');
INSERT INTO ids SELECT 'm_a_att', id FROM public.organization_members WHERE user_id = pg_temp.id('a_att');

-- Fotografia de vínculos e organizações para provar que nada mudou.
CREATE TEMP TABLE before_snapshot AS
  SELECT 'm' AS kind, id, organization_id, user_id, role::text, status::text, created_at FROM public.organization_members
  UNION ALL
  SELECT 'o', id, id, NULL, name, status::text, created_at FROM public.organizations;
CREATE FUNCTION pg_temp.unchanged() RETURNS boolean LANGUAGE sql AS $$
  SELECT NOT EXISTS (
    (SELECT * FROM before_snapshot
     EXCEPT
     SELECT 'm', id, organization_id, user_id, role::text, status::text, created_at FROM public.organization_members
     EXCEPT
     SELECT 'o', id, id, NULL, name, status::text, created_at FROM public.organizations)
  ) AND (SELECT count(*) FROM public.organization_members) + (SELECT count(*) FROM public.organizations)
      = (SELECT count(*) FROM before_snapshot)
$$;

-- ---------------------------------------------------------------------------
-- Estrutura: privilégios, políticas, gatilho
-- ---------------------------------------------------------------------------
SELECT table_privs_are('public', 'organization_members', 'antero_app', ARRAY['SELECT'], 'antero_app só lê organization_members');
SELECT table_privs_are('public', 'organizations', 'antero_app', ARRAY['SELECT'], 'antero_app sem INSERT/UPDATE/DELETE de tabela em organizations');
SELECT ok(NOT has_column_privilege('antero_app', 'public.organizations', 'name', 'UPDATE'), 'organizations: nem renomear (sem UPDATE em name)');
SELECT ok(
  NOT has_column_privilege('antero_app', 'public.organizations', 'status', 'UPDATE')
  AND NOT has_column_privilege('antero_app', 'public.organizations', 'slug', 'UPDATE')
  AND NOT has_column_privilege('antero_app', 'public.organizations', 'created_at', 'UPDATE'),
  'organizations: status, slug e created_at não são alteráveis pela aplicação'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.column_privileges
    WHERE grantee IN ('antero_app', 'PUBLIC') AND table_schema = 'public' AND table_name = 'organization_members'
      AND privilege_type IN ('INSERT', 'UPDATE')
  ),
  'organization_members: nenhum privilégio de coluna de escrita para antero_app nem PUBLIC'
);
SELECT ok(
  NOT has_table_privilege('public', 'public.organization_members', 'INSERT, UPDATE, DELETE, TRUNCATE')
  AND NOT has_table_privilege('public', 'public.organizations', 'INSERT, UPDATE, DELETE, TRUNCATE'),
  'PUBLIC não escreve em vínculos nem organizações'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'antero_app'),
  'antero_app não herda privilégios de nenhum papel'
);
SELECT policies_are('public', 'organization_members', ARRAY['organization_members_select'], 'organization_members: só a política de leitura');
SELECT policies_are('public', 'organizations', ARRAY['organizations_select'], 'organizations: só a política de leitura');
SELECT has_trigger('public', 'organization_members', 'organization_members_ensure_active_owner', 'gatilho de owner ativo existe');
SELECT is_definer('public', 'ensure_active_owner', ARRAY[]::name[], 'ensure_active_owner é SECURITY DEFINER');
SELECT is(
  (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = 'public.ensure_active_owner()'::regprocedure),
  'antero_owner', 'ensure_active_owner pertence a antero_owner'
);
SELECT ok(
  (SELECT proconfig = ARRAY['search_path=""'] FROM pg_proc WHERE oid = 'public.ensure_active_owner()'::regprocedure),
  'ensure_active_owner com search_path vazio'
);
SELECT ok(
  NOT has_function_privilege('antero_app', 'public.ensure_active_owner()', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.ensure_active_owner()', 'EXECUTE'),
  'ninguém executa ensure_active_owner diretamente'
);

-- ---------------------------------------------------------------------------
-- 1) Ataques da investigação: todos recusados pelo privilégio
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.organization_members SET role = 'owner' WHERE id = {m_a_admin}$q$)$$,
  '42501', NULL, 'admin NÃO se promove a owner');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.organization_members SET status = 'disabled' WHERE id = {m_a_owner}$q$)$$,
  '42501', NULL, 'admin NÃO desativa o owner');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.organization_members SET role = 'attendant' WHERE id = {m_a_owner}$q$)$$,
  '42501', NULL, 'admin NÃO rebaixa o owner');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', 'DELETE FROM public.organization_members WHERE id = {m_a_owner}')$$,
  '42501', NULL, 'admin NÃO exclui o owner');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', 'UPDATE public.organization_members SET user_id = {outsider} WHERE id = {m_a_att}')$$,
  '42501', NULL, 'admin NÃO troca o usuário de um vínculo');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$INSERT INTO public.organization_members (organization_id, user_id, role, created_at) VALUES ({org_a}, {b_owner}, 'attendant', '1900-01-01')$q$)$$,
  '42501', NULL, 'admin NÃO vincula usuário de outra empresa (nem com created_at antigo)');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.organization_members SET created_at = '1900-01-01' WHERE id = {m_a_att}$q$)$$,
  '42501', NULL, 'admin NÃO altera a data do vínculo (organização ativa)');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {outsider}, 'admin')$q$)$$,
  '42501', NULL, 'nem o owner cria vínculo por INSERT direto');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organization_members SET role = 'admin' WHERE id = {m_a_att}$q$)$$,
  '42501', NULL, 'nem o owner altera papel por UPDATE direto');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', 'UPDATE public.organization_members SET organization_id = {org_b} WHERE id = {m_a_att}')$$,
  '42501', NULL, 'admin NÃO move vínculo para outra organização');
SELECT throws_ok($$SELECT pg_temp.does('b_owner', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {outsider}, 'owner')$q$)$$,
  '42501', NULL, 'owner de B NÃO cria vínculo em A');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_b}, {platform}, 'owner')$q$)$$,
  '42501', NULL, 'admin da plataforma sem vínculo NÃO se vincula a uma organização');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$UPDATE public.organization_members SET role = 'owner' WHERE id = {m_a_att}$q$)$$,
  '42501', NULL, 'admin da plataforma NÃO altera vínculos por UPDATE direto');
SELECT throws_ok($$SELECT pg_temp.does('platform', 'DELETE FROM public.organization_members WHERE organization_id = {org_a}')$$,
  '42501', NULL, 'admin da plataforma NÃO exclui vínculos por DELETE direto');
SELECT throws_ok($$SELECT pg_temp.does('platform', 'DELETE FROM public.organizations WHERE id = {org_a}')$$,
  '42501', NULL, 'admin da plataforma NÃO exclui organização (cascata)');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$INSERT INTO public.organizations (name, slug, status) VALUES ('Nova', 'nova-120', 'active')$q$)$$,
  '42501', NULL, 'admin da plataforma NÃO cria organização por INSERT direto');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.organizations (name, slug) VALUES ('Nova', 'nova-owner-120')$q$)$$,
  '42501', NULL, 'owner NÃO cria organização');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', 'DELETE FROM public.organizations WHERE id = {org_a}')$$,
  '42501', NULL, 'owner NÃO exclui a própria organização');
SELECT throws_ok($$SELECT pg_temp.does('a_disabled', $q$UPDATE public.organization_members SET role = 'owner' WHERE id = {m_a_att}$q$)$$,
  '42501', NULL, 'admin desativado NÃO altera vínculos');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$UPDATE public.organization_members SET role = 'admin' WHERE id = {m_a_att}$q$)$$,
  '42501', NULL, 'atendente NÃO se promove');
SELECT throws_ok($$SELECT pg_temp.does('outsider', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {outsider}, 'owner')$q$)$$,
  '42501', NULL, 'usuário sem vínculo NÃO se vincula');
SELECT throws_ok($$SELECT pg_temp.does(NULL, 'DELETE FROM public.organization_members')$$,
  '42501', NULL, 'sem contexto: nenhuma escrita');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$UPDATE public.organizations SET status = 'inactive' WHERE id = {org_a}$q$)$$,
  '42501', NULL, 'status só muda por set_organization_status (nem o admin da plataforma por UPDATE direto)');
SELECT ok(pg_temp.unchanged(), 'depois de todas as tentativas, vínculos e organizações estão intactos');

-- ---------------------------------------------------------------------------
-- 2) Pelo menos um owner ativo (manutenção como dono das tabelas)
-- ---------------------------------------------------------------------------
SELECT throws_ok($$UPDATE public.organization_members SET role = 'admin' WHERE id = pg_temp.id('m_a_owner')$$,
  '23514', NULL, 'rebaixar o último owner ativo: recusado');
SELECT throws_ok($$UPDATE public.organization_members SET status = 'disabled' WHERE id = pg_temp.id('m_a_owner')$$,
  '23514', NULL, 'desativar o último owner ativo: recusado');
SELECT throws_ok($$UPDATE public.organization_members SET status = 'invited' WHERE id = pg_temp.id('m_a_owner')$$,
  '23514', NULL, 'tornar convite o último owner ativo: recusado');
SELECT throws_ok($$DELETE FROM public.organization_members WHERE id = pg_temp.id('m_a_owner')$$,
  '23514', NULL, 'excluir o último owner ativo: recusado');
SELECT throws_ok($$UPDATE public.organization_members SET organization_id = pg_temp.id('org_c') WHERE id = pg_temp.id('m_a_owner')$$,
  '23514', NULL, 'mover o último owner para outra organização: recusado');
SELECT throws_ok($$DELETE FROM auth.users WHERE id = pg_temp.id('a_owner')$$,
  '23514', NULL, 'excluir a identidade do último owner (cascata até o vínculo): recusado');
SELECT is((SELECT role::text || '/' || status::text FROM public.organization_members WHERE id = pg_temp.id('m_a_owner')), 'owner/active', 'o owner continua owner ativo');

-- Com dois owners, um pode sair; o último, não. Um comando que tira todos de uma vez também não passa.
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES (pg_temp.id('org_a'), pg_temp.id('a_owner2'), 'owner', 'active');
INSERT INTO ids SELECT 'm_a_owner2', id FROM public.organization_members WHERE user_id = pg_temp.id('a_owner2');
SELECT throws_ok($$UPDATE public.organization_members SET status = 'disabled' WHERE organization_id = pg_temp.id('org_a') AND role = 'owner'$$,
  '23514', NULL, 'desativar todos os owners num só comando: recusado');
SELECT lives_ok($$UPDATE public.organization_members SET role = 'admin' WHERE id = pg_temp.id('m_a_owner')$$, 'com outro owner ativo, rebaixar um owner é permitido');
SELECT throws_ok($$DELETE FROM public.organization_members WHERE id = pg_temp.id('m_a_owner2')$$,
  '23514', NULL, 'o novo último owner também é protegido');
SELECT lives_ok($$UPDATE public.organization_members SET role = 'owner' WHERE id = pg_temp.id('m_a_owner')$$, 'promover de volta é permitido');
SELECT lives_ok($$UPDATE public.organization_members SET status = 'disabled' WHERE id = pg_temp.id('m_a_owner2')$$, 'com dois owners, desativar um é permitido');
SELECT lives_ok($$UPDATE public.organization_members SET created_at = created_at WHERE id = pg_temp.id('m_a_owner')$$, 'alterar outra coluna do owner (continua owner ativo) é permitido');
SELECT lives_ok($$UPDATE public.organization_members SET status = 'active' WHERE id = pg_temp.id('m_a_owner2')$$, 'reativar um owner é permitido');

-- Alterações em quem não é owner ativo não passam pela regra.
SELECT lives_ok($$UPDATE public.organization_members SET role = 'admin' WHERE id = pg_temp.id('m_a_att')$$, 'alterar um atendente é permitido');
SELECT lives_ok($$DELETE FROM public.organization_members WHERE user_id = pg_temp.id('a_disabled')$$, 'excluir um vínculo desativado é permitido');

-- Organização que JÁ não tinha owner ativo não fica travada (dados existentes).
SELECT lives_ok($$UPDATE public.organization_members SET role = 'admin' WHERE user_id = pg_temp.id('c_att')$$, 'organização sem owner: alterar vínculos continua possível');
SELECT lives_ok($$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (pg_temp.id('org_c'), pg_temp.id('outsider'), 'owner')$$, 'organização sem owner: incluir o primeiro owner é possível');

-- Excluir a organização inteira: a cascata leva os owners junto, sem bloqueio.
INSERT INTO public.organizations (name, slug) VALUES ('Org D', 'org-d-120');
INSERT INTO ids SELECT 'org_d', id FROM public.organizations WHERE slug = 'org-d-120';
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES (pg_temp.id('org_d'), pg_temp.id('outsider'), 'owner');
SELECT lives_ok($$DELETE FROM public.organizations WHERE id = pg_temp.id('org_d')$$, 'excluir a organização (manutenção) remove o último owner em cascata');
SELECT is((SELECT count(*)::int FROM public.organization_members WHERE organization_id = pg_temp.id('org_d')), 0, 'vínculos da organização excluída foram removidos');

-- Owner de B intacto o tempo todo (as regras são por organização).
SELECT is((SELECT role::text || '/' || status::text FROM public.organization_members WHERE user_id = pg_temp.id('b_owner')), 'owner/active', 'B não é afetado');

-- ---------------------------------------------------------------------------
-- 3) O que precisa continuar funcionando
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organization_members WHERE organization_id = {org_a}'), 4::bigint, 'membro ativo lê os vínculos da própria organização');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organization_members WHERE organization_id = {org_b}'), 0::bigint, 'membro de A não lê vínculos de B');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.organization_members WHERE organization_id IN ({org_a}, {org_b})'), 5::bigint, 'admin da plataforma lê os vínculos de todas');
SELECT is(pg_temp.sees('outsider', 'SELECT 1 FROM public.organization_members WHERE organization_id = {org_a}'), 0::bigint, 'sem vínculo em A: não lê');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET name = 'Org A renomeada' WHERE id = {org_a}$q$)$$, '42501', NULL, 'owner NÃO renomeia a própria organização por UPDATE direto');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_b}$q$)$$, '42501', NULL, 'admin da plataforma NÃO renomeia por UPDATE direto');
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_status({org_b}, 'inactive')$q$)), 'inactive', 'admin da plataforma suspende pela função');
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_status({org_b}, 'active')$q$)), 'active', 'admin da plataforma reativa pela função');
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_module({org_b}, 'automacoes', true)$q$)), 'true', 'admin da plataforma habilita módulo pela função');
SELECT is(pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill($q$public.set_organization_module({org_b}, 'automacoes', false)$q$)), 'false', 'admin da plataforma desabilita módulo pela função');
SELECT throws_ok($$SELECT pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill($q$public.set_organization_status({org_a}, 'inactive')$q$))$$,
  '42501', NULL, 'owner continua sem suspender pela função');

SELECT * FROM finish();
ROLLBACK;

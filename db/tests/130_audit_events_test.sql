-- Antero Atendimentos — Entrega G2B: auditoria administrativa (0013).
--
-- 1) Estrutura, privilégios, RLS e imutabilidade.
-- 2) Eventos pelas funções administrativas, como antero_app no contexto do
--    admin da plataforma (como a aplicação faz): autor, organização, de/para,
--    nenhum evento quando nada muda.
-- 3) Manutenção por SQL (o superusuário do banco descartável faz o papel do
--    operador): evento `maintenance` com o papel de login; contexto forjado ou
--    de quem não é admin da plataforma recusa a alteração.
-- 4) Atomicidade: falha ao gravar o evento desfaz a alteração; ROLLBACK leva os dois.
-- Concorrência: tests/db/audit-events.test.ts (precisa de duas conexões).
BEGIN;
\ir lib/helpers.psql
SELECT plan(89);

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-130'), ('Org B', 'org-b-130');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-130';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-130';

SELECT pg_temp.new_user('platform', 'platform.130@teste.local', 'Plataforma');
SELECT pg_temp.new_user('a_owner', 'a.owner.130@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.130@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.130@teste.local', 'A Atendente');
SELECT pg_temp.new_user('b_owner', 'b.owner.130@teste.local', 'B Owner');
SELECT pg_temp.new_user('outsider', 'outsider.130@teste.local', 'Sem Vínculo');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active');

-- Eventos das organizações deste teste (como superusuário: ignora a RLS).
CREATE FUNCTION pg_temp.events(p_org text) RETURNS bigint LANGUAGE sql AS $$
  SELECT count(*) FROM public.audit_events WHERE organization_id = pg_temp.id(p_org)
$$;
-- O evento mais recente da organização, numa linha legível.
CREATE FUNCTION pg_temp.last_event(p_org text) RETURNS text LANGUAGE sql AS $$
  SELECT action || '|' || actor_kind || '|' || coalesce(actor_user_id::text, '-') || '|' || details::text
  FROM public.audit_events WHERE organization_id = pg_temp.id(p_org)
  ORDER BY occurred_at DESC, id DESC LIMIT 1
$$;
CREATE FUNCTION pg_temp.platform_call(p_expr text) RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id('platform'), pg_temp.fill(p_expr))
$$;
CREATE FUNCTION pg_temp.status_of(p_org text) RETURNS text LANGUAGE sql AS $$
  SELECT status::text FROM public.organizations WHERE id = pg_temp.id(p_org)
$$;

-- ---------------------------------------------------------------------------
-- 1) Estrutura, privilégios, RLS, imutabilidade
-- ---------------------------------------------------------------------------
SELECT has_table('public', 'audit_events', 'tabela audit_events existe');
SELECT columns_are('public', 'audit_events',
  ARRAY['id', 'occurred_at', 'organization_id', 'actor_user_id', 'actor_kind', 'action', 'details'], 'colunas exatas');
SELECT is((SELECT attidentity::text FROM pg_attribute WHERE attrelid = 'public.audit_events'::regclass AND attname = 'id'), 'a', 'id é GENERATED ALWAYS (não se escolhe o id)');
SELECT is((SELECT count(*)::int FROM pg_constraint WHERE confrelid <> 0 AND conrelid = 'public.audit_events'::regclass), 0, 'sem FKs: o evento sobrevive à exclusão de organização e usuário');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.audit_events'::regclass), 'RLS habilitada');
SELECT policies_are('public', 'audit_events', ARRAY['audit_events_select'], 'só a política de leitura');
SELECT table_privs_are('public', 'audit_events', 'antero_app', ARRAY['SELECT'], 'antero_app só lê');
SELECT table_privs_are('public', 'audit_events', 'antero_auth', ARRAY[]::text[], 'antero_auth sem acesso');
SELECT ok(NOT has_table_privilege('public', 'public.audit_events', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'), 'PUBLIC sem acesso');
SELECT has_index('public', 'audit_events', 'audit_events_organization_idx', 'índice por organização e período');
SELECT has_index('public', 'audit_events', 'audit_events_occurred_idx', 'índice por período');
SELECT has_trigger('public', 'audit_events', 'audit_events_immutable', 'gatilho de imutabilidade (linha)');
SELECT has_trigger('public', 'audit_events', 'audit_events_no_truncate', 'gatilho de imutabilidade (TRUNCATE)');
SELECT has_trigger('public', 'organizations', 'organizations_audit_status', 'gatilho de status');
SELECT has_trigger('public', 'organization_modules', 'organization_modules_audit_insert', 'gatilho de módulo (INSERT)');
SELECT has_trigger('public', 'organization_modules', 'organization_modules_audit_update', 'gatilho de módulo (UPDATE)');
SELECT has_trigger('public', 'organization_modules', 'organization_modules_audit_delete', 'gatilho de módulo (DELETE)');
SELECT ok(
  NOT (SELECT bool_or(prosecdef) FROM pg_proc WHERE proname IN ('record_audit_event', 'audit_organization_status', 'audit_organization_module', 'prevent_audit_event_change')),
  'funções da auditoria são SECURITY INVOKER (rodam com o papel de quem alterou)'
);
SELECT ok(
  (SELECT bool_and(proconfig = ARRAY['search_path=""'] AND pg_get_userbyid(proowner) = 'antero_owner')
   FROM pg_proc WHERE proname IN ('record_audit_event', 'audit_organization_status', 'audit_organization_module', 'prevent_audit_event_change')),
  'funções da auditoria: dono antero_owner e search_path vazio'
);
SELECT ok(
  NOT has_function_privilege('antero_app', 'public.record_audit_event(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('antero_auth', 'public.record_audit_event(uuid, text, jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.record_audit_event(uuid, text, jsonb)', 'EXECUTE'),
  'ninguém da aplicação executa record_audit_event'
);
SELECT throws_ok(
  $$SELECT pg_temp.platform_call($q$public.record_audit_event({org_a}, 'organization.suspended', '{}'::jsonb)$q$)$$,
  '42501', NULL, 'admin da plataforma NÃO chama a gravação diretamente (evento forjado)'
);

-- ---------------------------------------------------------------------------
-- 2) Pelas funções administrativas, como a aplicação
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.events('org_a'), 0::bigint, 'A começa sem eventos');

CREATE TEMP TABLE stamp AS SELECT updated_at FROM public.organizations WHERE id = pg_temp.id('org_a');
SELECT is(pg_temp.platform_call($q$public.set_organization_status({org_a}, 'active')$q$), 'active', 'reativar organização já ativa devolve active');
SELECT is(pg_temp.events('org_a'), 0::bigint, 'ativa → ativa: nenhum evento');
SELECT is((SELECT updated_at FROM public.organizations WHERE id = pg_temp.id('org_a')), (SELECT updated_at FROM stamp), 'ativa → ativa: updated_at não muda (sem regravação)');

SELECT is(pg_temp.platform_call($q$public.set_organization_status({org_a}, 'inactive')$q$), 'inactive', 'suspender devolve inactive');
SELECT is(pg_temp.events('org_a'), 1::bigint, 'suspender: exatamente um evento');
SELECT is(
  pg_temp.last_event('org_a'),
  'organization.suspended|platform_admin|' || pg_temp.id('platform') || '|{"to": "inactive", "from": "active"}',
  'suspender: ação, admin da plataforma como autor e de/para'
);
SELECT is(pg_temp.status_of('org_a'), 'inactive', 'A está suspensa');
SELECT is(pg_temp.platform_call($q$public.set_organization_status({org_a}, 'inactive')$q$), 'inactive', 'suspender de novo devolve inactive');
SELECT is(pg_temp.events('org_a'), 1::bigint, 'suspensa → suspensa: nenhum evento');
SELECT is(pg_temp.platform_call($q$public.set_organization_status({org_a}, 'active')$q$), 'active', 'reativar devolve active');
SELECT is(pg_temp.events('org_a'), 2::bigint, 'reativar: exatamente um evento');
SELECT is(
  pg_temp.last_event('org_a'),
  'organization.reactivated|platform_admin|' || pg_temp.id('platform') || '|{"to": "active", "from": "inactive"}',
  'reativar: ação, autor e de/para'
);

SELECT is(pg_temp.platform_call($q$public.set_organization_module({org_a}, 'automacoes', true)$q$), 'true', 'habilitar módulo');
SELECT is(pg_temp.events('org_a'), 3::bigint, 'habilitar: exatamente um evento');
SELECT is(
  pg_temp.last_event('org_a'),
  'module.enabled|platform_admin|' || pg_temp.id('platform') || '|{"to": true, "from": false, "module": "automacoes"}',
  'habilitar: módulo, autor e de/para'
);
SELECT is(pg_temp.platform_call($q$public.set_organization_module({org_a}, 'automacoes', true)$q$), 'true', 'habilitar de novo');
SELECT is(pg_temp.events('org_a'), 3::bigint, 'habilitado → habilitado: nenhum evento');
SELECT is(pg_temp.platform_call($q$public.set_organization_module({org_a}, 'automacoes', false)$q$), 'false', 'desabilitar módulo');
SELECT is(pg_temp.events('org_a'), 4::bigint, 'desabilitar: exatamente um evento');
SELECT is(
  pg_temp.last_event('org_a'),
  'module.disabled|platform_admin|' || pg_temp.id('platform') || '|{"to": false, "from": true, "module": "automacoes"}',
  'desabilitar: módulo, autor e de/para'
);
SELECT is(pg_temp.platform_call($q$public.set_organization_module({org_b}, 'campanhas', false)$q$), 'false', 'desabilitar módulo nunca habilitado é aceito');
SELECT is(pg_temp.events('org_b'), 0::bigint, 'sem linha → desabilitado: nenhum evento (estado efetivo já era desabilitado)');
SELECT is(pg_temp.events('org_a'), 4::bigint, 'operações em B não geram eventos em A');

-- Recusas não deixam evento (a transação da operação é desfeita).
SELECT throws_ok($$SELECT pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill($q$public.set_organization_status({org_a}, 'inactive')$q$))$$,
  '42501', NULL, 'owner não suspende');
SELECT throws_ok($$SELECT pg_temp.app_value(pg_temp.id('a_admin'), pg_temp.fill($q$public.set_organization_module({org_a}, 'contatos', true)$q$))$$,
  '42501', NULL, 'admin da organização não liga módulo');
SELECT throws_ok($$SELECT pg_temp.platform_call($q$public.set_organization_module({org_a}, 'campanhas', true)$q$)$$,
  '23514', NULL, 'regra de dependência continua recusando Campanhas sem Contatos');
SELECT throws_ok($$SELECT pg_temp.platform_call($q$public.set_organization_status('00000000-0000-4000-8000-000000000000', 'inactive')$q$)$$,
  'P0002', NULL, 'organização inexistente continua P0002');
SELECT is(pg_temp.events('org_a'), 4::bigint, 'recusas não geram eventos');

-- ---------------------------------------------------------------------------
-- Leitura e escrita pela aplicação
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.audit_events WHERE organization_id = {org_a}'), 4::bigint, 'admin da plataforma lê os eventos');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.audit_events'), 0::bigint, 'owner da organização afetada NÃO lê');
SELECT is(pg_temp.sees('a_admin', 'SELECT 1 FROM public.audit_events'), 0::bigint, 'admin da organização afetada NÃO lê');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.audit_events'), 0::bigint, 'atendente NÃO lê');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.audit_events'), 0::bigint, 'usuário de outra organização NÃO lê');
SELECT is(pg_temp.sees('outsider', 'SELECT 1 FROM public.audit_events'), 0::bigint, 'usuário sem vínculo NÃO lê');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.audit_events'), 0::bigint, 'sem contexto: nada');

SELECT throws_ok($$SELECT pg_temp.does('platform', $q$INSERT INTO public.audit_events (organization_id, actor_user_id, actor_kind, action) VALUES ({org_a}, {a_owner}, 'platform_admin', 'organization.suspended')$q$)$$,
  '42501', NULL, 'admin da plataforma NÃO insere evento (nem forjando o autor)');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.audit_events (organization_id, actor_kind, action) VALUES ({org_a}, 'maintenance', 'module.enabled')$q$)$$,
  '42501', NULL, 'owner NÃO insere evento');
SELECT throws_ok($$SELECT pg_temp.does('platform', 'UPDATE public.audit_events SET actor_user_id = NULL')$$,
  '42501', NULL, 'admin da plataforma NÃO altera eventos');
SELECT throws_ok($$SELECT pg_temp.does('platform', 'DELETE FROM public.audit_events')$$,
  '42501', NULL, 'admin da plataforma NÃO apaga eventos');
SELECT throws_ok($$SELECT pg_temp.does('platform', 'TRUNCATE public.audit_events')$$,
  '42501', NULL, 'admin da plataforma NÃO trunca eventos');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', 'DELETE FROM public.audit_events')$$,
  '42501', NULL, 'owner NÃO apaga eventos');

-- Imutável também para o dono das tabelas (aqui, o superusuário).
SELECT throws_ok($$UPDATE public.audit_events SET details = '{}' WHERE organization_id = pg_temp.id('org_a')$$,
  '42501', NULL, 'manutenção NÃO altera eventos (gatilho)');
SELECT throws_ok($$DELETE FROM public.audit_events WHERE organization_id = pg_temp.id('org_a')$$,
  '42501', NULL, 'manutenção NÃO apaga eventos (gatilho)');
SELECT throws_ok($$TRUNCATE public.audit_events$$, '42501', NULL, 'manutenção NÃO trunca eventos (gatilho)');
SELECT is(pg_temp.events('org_a'), 4::bigint, 'eventos intactos');

-- ---------------------------------------------------------------------------
-- 3) Manutenção por SQL e contexto inválido
-- ---------------------------------------------------------------------------
UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_b');
SELECT is(
  pg_temp.last_event('org_b'),
  'organization.suspended|maintenance|-|{"to": "inactive", "from": "active", "db_role": "antero_admin"}',
  'manutenção: sem autor de aplicação, com o papel de login do banco'
);
UPDATE public.organizations SET status = 'active' WHERE id = pg_temp.id('org_b');
SELECT is(pg_temp.events('org_b'), 2::bigint, 'manutenção: suspender e reativar geram dois eventos');
UPDATE public.organizations SET name = 'Org B renomeada' WHERE id = pg_temp.id('org_b');
SELECT is(pg_temp.events('org_b'), 2::bigint, 'alterar outra coluna não gera evento de status');

INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES (pg_temp.id('org_b'), 'contatos', true);
SELECT is(pg_temp.last_event('org_b'), 'module.enabled|maintenance|-|{"to": true, "from": false, "module": "contatos", "db_role": "antero_admin"}', 'manutenção: inserir módulo habilitado gera module.enabled');
INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES (pg_temp.id('org_b'), 'automacoes', false);
SELECT is(pg_temp.events('org_b'), 3::bigint, 'manutenção: inserir módulo já desabilitado não gera evento');
DELETE FROM public.organization_modules WHERE organization_id = pg_temp.id('org_b') AND module = 'contatos';
SELECT is(pg_temp.last_event('org_b'), 'module.disabled|maintenance|-|{"to": false, "from": true, "module": "contatos", "db_role": "antero_admin"}', 'manutenção: excluir módulo habilitado gera module.disabled');
DELETE FROM public.organization_modules WHERE organization_id = pg_temp.id('org_b') AND module = 'automacoes';
SELECT is(pg_temp.events('org_b'), 4::bigint, 'manutenção: excluir linha desabilitada não gera evento');

-- Excluir a organização inteira: os módulos vão em cascata sem eventos de módulo; os eventos anteriores ficam.
INSERT INTO public.organizations (name, slug) VALUES ('Org D', 'org-d-130');
INSERT INTO ids SELECT 'org_d', id FROM public.organizations WHERE slug = 'org-d-130';
INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES (pg_temp.id('org_d'), 'atendimento', true);
SELECT is(pg_temp.events('org_d'), 1::bigint, 'organização D: módulo habilitado registrado');
SELECT lives_ok($$DELETE FROM public.organizations WHERE id = pg_temp.id('org_d')$$, 'excluir a organização (manutenção) funciona');
SELECT is(pg_temp.events('org_d'), 1::bigint, 'cascata não gera evento de módulo, e o histórico da organização excluída permanece');

-- Contexto forjado (valor sem a marca da transação): a alteração é recusada.
SELECT set_config('app.user_id', pg_temp.id('platform')::text, true) \g /dev/null
SELECT throws_ok($$UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_b')$$,
  '42501', NULL, 'contexto forjado não vira manutenção: alteração recusada');
SELECT pg_temp.clear_context();
SELECT is(pg_temp.status_of('org_b'), 'active', 'B continua ativa');

-- Contexto válido de quem não é admin da plataforma, mexendo como manutenção: recusado.
SELECT app.set_user_context(pg_temp.id('a_owner'));
SELECT throws_ok($$UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_a')$$,
  '42501', NULL, 'contexto de usuário que não é admin da plataforma: alteração recusada');
SELECT pg_temp.clear_context();
SELECT is(pg_temp.status_of('org_a'), 'active', 'A continua ativa');
SELECT is(pg_temp.events('org_a'), 4::bigint, 'nenhum evento das tentativas recusadas');

-- ---------------------------------------------------------------------------
-- 4) Atomicidade
-- ---------------------------------------------------------------------------
-- ROLLBACK leva a alteração e o evento.
SAVEPOINT before_rollback;
SELECT pg_temp.platform_call($q$public.set_organization_status({org_a}, 'inactive')$q$) \g /dev/null
ROLLBACK TO SAVEPOINT before_rollback;
SELECT is(pg_temp.status_of('org_a'), 'active', 'ROLLBACK: a suspensão foi desfeita');
SELECT is(pg_temp.events('org_a'), 4::bigint, 'ROLLBACK: nenhum evento persistido');

-- Falha ao gravar o evento desfaz a alteração.
ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_test_failure CHECK (action <> 'organization.suspended') NOT VALID;
SELECT throws_ok($$SELECT pg_temp.platform_call($q$public.set_organization_status({org_a}, 'inactive')$q$)$$,
  '23514', NULL, 'falha na gravação do evento: a suspensão é recusada');
SELECT is(pg_temp.status_of('org_a'), 'active', 'falha na auditoria: a organização continua ativa');
ALTER TABLE public.audit_events ADD CONSTRAINT audit_events_test_failure_module CHECK (action <> 'module.enabled') NOT VALID;
SELECT throws_ok($$SELECT pg_temp.platform_call($q$public.set_organization_module({org_a}, 'contatos', true)$q$)$$,
  '23514', NULL, 'falha na gravação do evento: habilitar o módulo é recusado');
SELECT is((SELECT count(*)::int FROM public.organization_modules WHERE organization_id = pg_temp.id('org_a') AND module = 'contatos' AND enabled), 0, 'falha na auditoria: o módulo continua desabilitado');
ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_test_failure;
ALTER TABLE public.audit_events DROP CONSTRAINT audit_events_test_failure_module;
SELECT is(pg_temp.events('org_a'), 4::bigint, 'nenhum evento das operações que falharam');

SELECT * FROM finish();
ROLLBACK;

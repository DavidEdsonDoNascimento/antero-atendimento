-- Antero Atendimentos — Entrega E3A: motor de automações (0009/0010).
--
-- Configuração de fluxos (owner/admin + módulo), versões imutáveis, porta de
-- desenvolvimento (dev_automation_*), quando o motor pode agir, idempotência,
-- encaminhamento, interrupções (atendente, módulo, fluxo pausado, suspensão),
-- sessão presa à versão e isolamento entre organizações. Tudo como antero_app
-- com o contexto que a aplicação define. O motor (TypeScript) não roda aqui: o
-- resultado dele é passado pronto a dev_automation_commit.
--
-- Dentro desta transação now() é constante: as mensagens recebidas ganham
-- created_at explícito (pg_temp.inbound) para que a ordem seja determinística.
-- A disputa real entre duas conexões está em tests/db/automations.test.ts.
BEGIN;
\ir lib/helpers.psql
SELECT plan(110);

INSERT INTO public.organizations (name, slug) VALUES
  ('Org A', 'org-a-100'), ('Org B', 'org-b-100'), ('Org C', 'org-c-100');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-100';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-100';
INSERT INTO ids SELECT 'org_c', id FROM public.organizations WHERE slug = 'org-c-100';
-- A: Atendimento + Automações. B: só Automações. C: só Atendimento.
INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES
  (pg_temp.id('org_a'), 'atendimento', true), (pg_temp.id('org_a'), 'automacoes', true),
  (pg_temp.id('org_b'), 'automacoes', true),
  (pg_temp.id('org_c'), 'atendimento', true);

SELECT pg_temp.new_user('a_owner', 'a.owner.100@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.100@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.100@teste.local', 'A Atendente');
SELECT pg_temp.new_user('b_owner', 'b.owner.100@teste.local', 'B Owner');
SELECT pg_temp.new_user('c_owner', 'c.owner.100@teste.local', 'C Owner');
SELECT pg_temp.new_user('nobody', 'nobody.100@teste.local', 'Sem Organização');
INSERT INTO public.organization_members (organization_id, user_id, role) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner'),
  (pg_temp.id('org_c'), pg_temp.id('c_owner'), 'owner');

INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name) VALUES
  (pg_temp.id('org_a'), 'development', 'connected', 'Canal A 100'),
  (pg_temp.id('org_a'), 'cloud_api', 'connected', 'Canal A Cloud 100'),
  (pg_temp.id('org_b'), 'development', 'connected', 'Canal B 100'),
  (pg_temp.id('org_c'), 'development', 'connected', 'Canal C 100');
INSERT INTO ids SELECT 'acc_a', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A 100';
INSERT INTO ids SELECT 'acc_cloud', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A Cloud 100';
INSERT INTO ids SELECT 'acc_b', id FROM public.whatsapp_accounts WHERE display_name = 'Canal B 100';
INSERT INTO ids SELECT 'acc_c', id FROM public.whatsapp_accounts WHERE display_name = 'Canal C 100';

-- Mensagem recebida pela ingestão real, com created_at = now() + p_offset s.
-- ids[p_key] = mensagem; ids[p_conv] = conversa.
CREATE FUNCTION pg_temp.inbound(p_key text, p_conv text, p_user text, p_acc text, p_phone text, p_offset int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM pg_temp.ingest_as(pg_temp.id(p_user), pg_temp.id(p_acc), p_phone, 'Olá ' || p_key, 'e3a-' || p_key);
  INSERT INTO ids VALUES (p_key, r.message_id);
  INSERT INTO ids VALUES (p_conv, r.conversation_id) ON CONFLICT (k) DO NOTHING;
  UPDATE public.messages SET created_at = now() + make_interval(secs => p_offset) WHERE id = r.message_id;
END;
$$;

CREATE FUNCTION pg_temp.prep(p_user text, p_msg text)
RETURNS TABLE (action text, reason text, session_id uuid, session_revision integer, flow_version_id uuid,
               attendance boolean, step text, version_entry text, input uuid)
LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := pg_temp.id(p_user);
  v_msg uuid := pg_temp.id(p_msg);
BEGIN
  -- ids é lida antes de trocar de papel: antero_app não a enxerga.
  PERFORM pg_temp.become('antero_app', v_user);
  RETURN QUERY
  SELECT p.action, p.reason, p.session_id, p.session_revision, p.flow_version_id, p.attendance_enabled,
         p.state ->> 'stepId', p.definition ->> 'entryStepId', p.input_message_id
  FROM public.dev_automation_prepare(v_msg) p;
  PERFORM pg_temp.unbecome();
END;
$$;

CREATE TEMP TABLE outputs (k text PRIMARY KEY, v jsonb NOT NULL);
INSERT INTO outputs VALUES
  ('two', '[{"message_type":"text","content":"Olá!","payload":{"type":"text","text":"Olá!"}},
            {"message_type":"interactive","content":"Menu\n\n1. A","payload":{"type":"list","body":"Menu","button":"Ver","sections":[{"rows":[{"id":"a","title":"A"}]}]}}]'),
  ('one', '[{"message_type":"text","content":"Certo!","payload":{"type":"text","text":"Certo!"}}]'),
  ('none', '[]');

-- Prepara e grava o resultado como o servidor faria (a entrada é a que o prepare
-- escolheu: a pendente mais antiga); devolve quantas respostas saíram.
CREATE FUNCTION pg_temp.run(p_user text, p_msg text, p_status text, p_step text, p_reason text, p_outputs text DEFAULT 'one')
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  r record;
  n integer;
  v_user uuid := pg_temp.id(p_user);
  v_msg uuid := pg_temp.id(p_msg);
  v_outputs jsonb := (SELECT v FROM outputs WHERE k = p_outputs);
BEGIN
  SELECT * INTO r FROM pg_temp.prep(p_user, p_msg);
  PERFORM pg_temp.become('antero_app', v_user);
  SELECT count(*) INTO n
  FROM public.dev_automation_commit(
    coalesce(r.input, v_msg), r.session_id, r.session_revision, r.flow_version_id,
    p_status::public.automation_session_status, p_step,
    jsonb_build_object('stepId', coalesce(p_step, 'fim'), 'answers', jsonb_build_array(jsonb_build_object('key', 'nome', 'label', 'Nome', 'value', 'Maria'))),
    p_reason, v_outputs);
  PERFORM pg_temp.unbecome();
  RETURN n;
END;
$$;

CREATE TEMP TABLE defs (k text PRIMARY KEY, v jsonb NOT NULL);
INSERT INTO defs VALUES
  ('v1', '{"schemaVersion":1,"entryStepId":"menu","steps":[{"type":"menu","id":"menu","text":"Menu","options":[{"id":"a","title":"A","next":"fim"}]},{"type":"end","id":"fim"}]}'),
  ('v2', '{"schemaVersion":1,"entryStepId":"menu-v2","steps":[{"type":"menu","id":"menu-v2","text":"Menu 2","options":[{"id":"a","title":"A","next":"fim"}]},{"type":"end","id":"fim"}]}'),
  ('bad', '{"schemaVersion":2,"steps":[]}');

CREATE FUNCTION pg_temp.save(p_user text, p_org text, p_slug text, p_def text, p_entry boolean DEFAULT true)
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id(p_user), format(
    '(SELECT row(flow_id, draft_revision, created)::text FROM public.save_automation_flow(%L, %L, %L, %L::jsonb, %L))',
    pg_temp.id(p_org), p_slug, 'Fluxo ' || p_slug, (SELECT v FROM defs WHERE k = p_def), p_entry));
$$;

-- SQL que avalia p_expr como antero_app no contexto de p_user (chave; NULL = sem
-- contexto), com os {ids} já substituídos — para throws_ok.
CREATE FUNCTION pg_temp.as_sql(p_user text, p_expr text) RETURNS text
LANGUAGE sql AS $$
  SELECT format('SELECT pg_temp.app_value(%L::uuid, %L)', pg_temp.id(p_user), pg_temp.fill(p_expr));
$$;

-- ---------------------------------------------------------------------------
-- Estrutura e privilégios
-- ---------------------------------------------------------------------------
SELECT tables_are('public', ARRAY[
  'profiles', 'organizations', 'organization_members', 'whatsapp_accounts', 'organization_modules',
  'contacts', 'conversations', 'messages', 'conversation_events', 'schema_migrations',
  'automation_flows', 'automation_flow_versions', 'automation_sessions', 'automation_executions'
], 'tabelas de public (as 4 da automação, nenhuma tabela paralela de mensagens)');
SELECT enum_has_labels('public', 'message_type', ARRAY['text', 'image', 'interactive'], 'tipos de mensagem');
SELECT ok(
  NOT has_table_privilege('antero_app', 'public.automation_flows', 'INSERT, UPDATE, DELETE')
  AND NOT has_table_privilege('antero_app', 'public.automation_flow_versions', 'INSERT, UPDATE, DELETE')
  AND NOT has_table_privilege('antero_app', 'public.automation_sessions', 'INSERT, UPDATE, DELETE')
  AND NOT has_table_privilege('antero_app', 'public.automation_executions', 'INSERT, UPDATE, DELETE'),
  'antero_app não escreve direto em nenhuma tabela da automação'
);
SELECT ok(
  NOT has_function_privilege('antero_app', 'public.automation_prepare_internal(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.automation_commit_internal(uuid,uuid,integer,uuid,automation_session_status,text,jsonb,text,jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.automation_record_delivery_internal(uuid,message_delivery_status,text)', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.automation_interrupt_internal(uuid,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.automation_begin_delivery_internal(uuid)', 'EXECUTE'),
  'as funções internas de execução não são executáveis pela aplicação'
);

-- ---------------------------------------------------------------------------
-- Configuração: owner/admin com o módulo Automações
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.save('a_att', 'org_a', 'entrada', 'v1')$$, '42501', NULL, 'atendente não configura fluxo');
SELECT throws_ok($$SELECT pg_temp.save('c_owner', 'org_c', 'entrada', 'v1')$$, '42501', NULL, 'owner sem o módulo Automações não configura');
SELECT throws_ok($$SELECT pg_temp.save('a_owner', 'org_b', 'entrada', 'v1')$$, '42501', NULL, 'owner de A não configura fluxo de B');
SELECT throws_ok($$SELECT pg_temp.save('nobody', 'org_a', 'entrada', 'v1')$$, '42501', NULL, 'sem vínculo não configura');
SELECT throws_ok($$SELECT pg_temp.save('a_owner', 'org_a', 'entrada', 'bad')$$, 'AU003', NULL, 'definição malformada é recusada');
SELECT throws_ok($$SELECT pg_temp.save('a_owner', 'org_a', 'Entrada Errada', 'v1')$$, '23514', NULL, 'identificador fora do formato');

SELECT matches(pg_temp.save('a_owner', 'org_a', 'entrada', 'v1'), ',1,t\)$', 'owner cria o rascunho (revisão 1)');
INSERT INTO ids SELECT 'flow_a', id FROM public.automation_flows WHERE organization_id = pg_temp.id('org_a') AND slug = 'entrada';
SELECT matches(pg_temp.save('a_admin', 'org_a', 'entrada', 'v1'), ',2,f\)$', 'admin grava de novo: mesma linha, revisão 2');
SELECT is((SELECT status::text FROM public.automation_flows WHERE id = pg_temp.id('flow_a')), 'draft', 'rascunho nasce sem versão publicada');
SELECT throws_ok($$SELECT pg_temp.save('a_owner', 'org_a', 'outro', 'v1', true)$$, 'AU001', NULL, 'só um fluxo de entrada por organização');

SELECT throws_ok(
  pg_temp.as_sql('a_owner', 'public.set_automation_flow_status({org_a}, {flow_a}, ''active'')'),
  'AU004', NULL, 'rascunho não publicado não é ativado');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT version FROM public.publish_automation_flow({org_a}, {flow_a}, 1))'),
  'AU002', NULL, 'publicar com a revisão errada do rascunho é recusado');
SELECT throws_ok(
  pg_temp.as_sql('a_att', '(SELECT version FROM public.publish_automation_flow({org_a}, {flow_a}, 2))'),
  '42501', NULL, 'atendente não publica');
SELECT is(
  pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('(SELECT version FROM public.publish_automation_flow({org_a}, {flow_a}, 2))')),
  '1', 'publica a versão 1');
INSERT INTO ids SELECT 'ver_a1', id FROM public.automation_flow_versions WHERE flow_id = pg_temp.id('flow_a') AND version = 1;
SELECT is((SELECT status::text FROM public.automation_flows WHERE id = pg_temp.id('flow_a')), 'active', 'publicar ativa o fluxo');
SELECT throws_ok(
  pg_temp.fill($$UPDATE public.automation_flow_versions SET definition = '{"schemaVersion":1}' WHERE id = {ver_a1}$$),
  'AU010', NULL, 'versão publicada é imutável, inclusive para o dono das tabelas');

SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.automation_flows'), 1::bigint, 'membro de A com o módulo lê os fluxos de A');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.automation_flows WHERE organization_id = {org_a}'), 0::bigint, 'B não lê fluxos de A');
SELECT is(pg_temp.sees('c_owner', 'SELECT 1 FROM public.automation_flow_versions'), 0::bigint, 'C não lê versões de ninguém');

-- ---------------------------------------------------------------------------
-- Porta de desenvolvimento: quem pode disparar
-- ---------------------------------------------------------------------------
SELECT pg_temp.inbound('m1', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 0);

SELECT throws_ok($$SELECT * FROM pg_temp.prep('a_att', 'm1')$$, '42501', NULL, 'atendente não dispara a automação');
SELECT throws_ok($$SELECT * FROM pg_temp.prep('b_owner', 'm1')$$, '42501', NULL, 'owner de outra organização não dispara');
SELECT throws_ok($$SELECT * FROM pg_temp.prep('nobody', 'm1')$$, '42501', NULL, 'sem vínculo não dispara');
SELECT throws_ok(
  pg_temp.as_sql(NULL, '(SELECT action FROM public.dev_automation_prepare({m1}))'),
  '28000', NULL, 'sem contexto de usuário não dispara');

-- Mensagem num canal real (gravada pelo dono das tabelas: a ingestão não a aceitaria).
INSERT INTO public.contacts (organization_id, phone_number) VALUES (pg_temp.id('org_a'), '+5511977770099');
INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id)
SELECT pg_temp.id('org_a'), pg_temp.id('acc_cloud'), id FROM public.contacts WHERE phone_number = '+5511977770099';
INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content)
SELECT c.organization_id, c.id, c.whatsapp_account_id, 'inbound', 'contact', 'Olá pela Meta'
FROM public.conversations c WHERE c.whatsapp_account_id = pg_temp.id('acc_cloud');
INSERT INTO ids SELECT 'm_cloud', id FROM public.messages WHERE content = 'Olá pela Meta';
SELECT throws_ok($$SELECT * FROM pg_temp.prep('a_owner', 'm_cloud')$$, 'AU009', NULL, 'canal cloud_api: a porta de desenvolvimento recusa');

-- ---------------------------------------------------------------------------
-- Início, idempotência e avanço
-- ---------------------------------------------------------------------------
SELECT is((SELECT action || '/' || attendance::text FROM pg_temp.prep('a_owner', 'm1')), 'start/true',
  'conversa nova, fluxo de entrada ativo: começa; Atendimento disponível');
SELECT is((SELECT flow_version_id FROM pg_temp.prep('a_owner', 'm1')), pg_temp.id('ver_a1'), 'começa na versão publicada');
SELECT is(pg_temp.run('a_owner', 'm1', 'active', 'menu', NULL, 'two'), 2, 'grava as duas respostas');

SELECT is((SELECT status::text FROM public.conversations WHERE id = pg_temp.id('conv1')), 'bot', 'conversa passa para bot');
SELECT is(
  (SELECT string_agg(message_type::text || ':' || delivery_status::text || ':' || sender_type::text || ':' || (sender_user_id IS NULL)::text, ',' ORDER BY created_at, id)
   FROM public.messages WHERE conversation_id = pg_temp.id('conv1') AND direction = 'outbound'),
  'text:pending:bot:true,interactive:pending:bot:true',
  'respostas na ordem, pending, como bot, sem usuário');
SELECT is(
  (SELECT payload ->> 'type' FROM public.messages WHERE conversation_id = pg_temp.id('conv1') AND message_type = 'interactive'),
  'list', 'payload guarda a ação completa');
SELECT is(
  (SELECT string_agg(event_type::text || ':' || (user_id IS NULL)::text, ',')
   FROM public.conversation_events WHERE conversation_id = pg_temp.id('conv1')),
  'automation_started:true', 'evento de início, sem usuário');
SELECT is(
  (SELECT outcome::text || ':' || status::text || ':' || revision FROM public.automation_executions e
   JOIN public.automation_sessions s ON s.id = e.session_id WHERE e.message_id = pg_temp.id('m1')),
  'started:active:1', 'execução e sessão registradas');
INSERT INTO ids SELECT 'sess1', id FROM public.automation_sessions WHERE conversation_id = pg_temp.id('conv1');

SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'm1')), 'none/already_processed',
  'mesma mensagem de novo: nada a fazer');
SELECT throws_ok($$SELECT pg_temp.run('a_owner', 'm1', 'active', 'menu', NULL)$$, 'AU006', NULL,
  'gravar de novo a mesma mensagem é recusado (sem respostas duplicadas)');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = pg_temp.id('conv1') AND direction = 'outbound'), 2,
  'continua com duas respostas');

SELECT pg_temp.inbound('m2', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 10);
SELECT is((SELECT action || '/' || session_revision || '/' || step FROM pg_temp.prep('a_owner', 'm2')), 'advance/1/menu',
  'mensagem seguinte avança a sessão, a partir do estado gravado');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT count(*) FROM public.dev_automation_commit({m2}, {sess1}, 0, {ver_a1}, ''active'', ''menu'', ''{}'', NULL, ''[]''))'),
  'AU005', NULL, 'revisão desatualizada é recusada');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT count(*) FROM public.dev_automation_commit({m2}, {sess1}, 1, {ver_a1}, ''active'', ''menu'', ''{}'', NULL, ''[1,2,3,4,5,6,7]''))'),
  'AU007', NULL, 'mais de 6 respostas numa execução é recusado');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT count(*) FROM public.dev_automation_commit({m2}, {sess1}, 1, {ver_a1}, ''active'', ''menu'', ''{}'', NULL, ''[{"message_type":"audio","content":"x","payload":{}}]''))'),
  'AU007', NULL, 'tipo de resposta desconhecido é recusado');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT count(*) FROM public.dev_automation_commit({m2}, {sess1}, 1, {ver_a1}, ''interrupted'', NULL, ''{}'', ''x'', ''[]''))'),
  'AU007', NULL, 'o motor não grava "interrompida"');
SELECT is(pg_temp.run('a_owner', 'm2', 'active', 'pergunta', NULL), 1, 'avança para a pergunta');
SELECT is((SELECT revision || '/' || current_step_id FROM public.automation_sessions WHERE id = pg_temp.id('sess1')), '2/pergunta',
  'revisão e etapa atualizadas');

-- Rajada: m_late tem created_at ANTERIOR ao de m2, mas foi gravada depois; m3
-- chega em seguida. A ordem é a de gravação (arrival_order), e a entrada é
-- sempre a pendente mais antiga, mesmo quando quem pede é o executor de m3.
SELECT pg_temp.inbound('m_late', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 5);
SELECT pg_temp.inbound('m3', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 20);
SELECT is((SELECT action || '/' || (input = pg_temp.id('m_late'))::text FROM pg_temp.prep('a_owner', 'm3')), 'advance/true',
  'a entrada é a pendente mais antiga pela ordem de gravação, seja de quem for o pedido');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT count(*) FROM public.dev_automation_commit({m3}, {sess1}, 2, {ver_a1}, ''active'', ''x'', ''{}'', NULL, ''[]''))'),
  'AU005', NULL, 'gravar a mais nova antes da pendente mais antiga é recusado');
SELECT is(pg_temp.run('a_owner', 'm3', 'active', 'pergunta-2', NULL), 1, 'o pedido de m3 processa m_late primeiro');
SELECT is((SELECT last_message_id FROM public.automation_sessions WHERE id = pg_temp.id('sess1')), pg_temp.id('m_late'),
  'm_late é a última processada; m3 continua pendente');

-- ---------------------------------------------------------------------------
-- Encaminhamento humano
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.run('a_owner', 'm3', 'handed_off', NULL, 'handoff_step'), 1, 'encaminha, com a mensagem de passagem');
SELECT is(
  (SELECT status::text || '/' || (assigned_user_id IS NULL)::text FROM public.conversations WHERE id = pg_temp.id('conv1')),
  'waiting/true', 'conversa aguarda a equipe, sem responsável');
SELECT is(
  (SELECT status::text || '/' || end_reason || '/' || (ended_at IS NOT NULL)::text FROM public.automation_sessions WHERE id = pg_temp.id('sess1')),
  'handed_off/handoff_step/true', 'sessão encerrada como encaminhada');
-- now() é constante nesta transação: os eventos são conferidos por tipo, não pela ordem.
SELECT is(
  (SELECT string_agg(event_type::text || ':' || (user_id IS NULL)::text, ',' ORDER BY event_type::text)
   FROM public.conversation_events WHERE conversation_id = pg_temp.id('conv1')),
  'automation_started:true,handed_off:true', 'evento de encaminhamento, sem usuário');

SELECT pg_temp.inbound('m4', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 30);
SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'm4')), 'none/not_eligible',
  'aguardando depois do encaminhamento: o robô não recomeça');

SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('(SELECT changed FROM public.claim_conversation({org_a}, {conv1}))')), 'true',
  'atendente assume normalmente');
SELECT pg_temp.inbound('m5', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 31);
SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'm5')), 'none/not_eligible', 'em atendimento humano: nada');
SELECT is(
  pg_temp.sees('a_att', 'SELECT 1 FROM public.automation_sessions WHERE conversation_id = {conv1} AND state -> ''answers'' @> ''[{"key":"nome","value":"Maria"}]'''),
  1::bigint, 'o atendente lê a sessão e os dados coletados');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.automation_sessions'), 0::bigint, 'outra organização não lê a sessão');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.automation_executions WHERE session_id = {sess1}'), 4::bigint,
  'execuções: início, dois avanços e encaminhamento — uma por mensagem, nenhuma perdida');

-- Resolver e o cliente voltar: novo ciclo, a automação recomeça.
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('(SELECT changed FROM public.resolve_conversation({org_a}, {conv1}))')), 'true', 'resolve');
SELECT pg_temp.inbound('m6', 'conv1', 'a_owner', 'acc_a', '+5511977770001', 40);
UPDATE public.conversation_events SET created_at = now() + interval '35 seconds'
WHERE conversation_id = pg_temp.id('conv1') AND event_type = 'reopened';
SELECT is((SELECT action FROM pg_temp.prep('a_owner', 'm6')), 'start', 'conversa reaberta pelo cliente: novo ciclo, recomeça');

-- ---------------------------------------------------------------------------
-- Atendente assume uma conversa em bot: a sessão é interrompida
-- ---------------------------------------------------------------------------
SELECT pg_temp.inbound('n1', 'conv2', 'a_owner', 'acc_a', '+5511977770002', 0);
SELECT is(pg_temp.run('a_owner', 'n1', 'active', 'menu', NULL), 1, 'conversa 2 em bot');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('(SELECT changed FROM public.claim_conversation({org_a}, {conv2}))')), 'true',
  'atendente assume a conversa em bot');
SELECT is(
  (SELECT status::text || '/' || end_reason FROM public.automation_sessions WHERE conversation_id = pg_temp.id('conv2')),
  'interrupted/human_takeover', 'a sessão para no mesmo instante');
SELECT pg_temp.inbound('n2', 'conv2', 'a_owner', 'acc_a', '+5511977770002', 10);
SELECT is((SELECT action FROM pg_temp.prep('a_owner', 'n2')), 'none', 'o robô não responde por cima do atendente');

-- ---------------------------------------------------------------------------
-- Módulo desligado e fluxo pausado: a sessão é interrompida, nada é enviado
-- ---------------------------------------------------------------------------
SELECT pg_temp.inbound('p1', 'conv3', 'a_owner', 'acc_a', '+5511977770003', 0);
SELECT is(pg_temp.run('a_owner', 'p1', 'active', 'menu', NULL), 1, 'conversa 3 em bot');
UPDATE public.organization_modules SET enabled = false WHERE organization_id = pg_temp.id('org_a') AND module = 'automacoes';
SELECT pg_temp.inbound('p2', 'conv3', 'a_owner', 'acc_a', '+5511977770003', 10);
SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'p2')), 'none/module_disabled', 'Automações desligado: não avança');
SELECT is(
  (SELECT s.status::text || '/' || s.end_reason || '/' || c.status::text
   FROM public.automation_sessions s JOIN public.conversations c ON c.id = s.conversation_id WHERE s.conversation_id = pg_temp.id('conv3')),
  'interrupted/module_disabled/waiting', 'sessão interrompida e conversa devolvida à equipe');
SELECT is((SELECT count(*)::int FROM public.messages WHERE conversation_id = pg_temp.id('conv3') AND direction = 'outbound'), 1,
  'nenhuma resposta nova');
SELECT pg_temp.inbound('p3', 'conv4', 'a_owner', 'acc_a', '+5511977770004', 0);
SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'p3')), 'none/module_disabled', 'Automações desligado: não começa');
SELECT is((SELECT status::text FROM public.conversations WHERE id = pg_temp.id('conv4')), 'waiting', 'conversa nova fica aguardando');
UPDATE public.organization_modules SET enabled = true WHERE organization_id = pg_temp.id('org_a') AND module = 'automacoes';

SELECT pg_temp.inbound('q1', 'conv5', 'a_owner', 'acc_a', '+5511977770005', 0);
SELECT is(pg_temp.run('a_owner', 'q1', 'active', 'menu', NULL), 1, 'conversa 5 em bot');
SELECT is(pg_temp.app_value(pg_temp.id('a_admin'), pg_temp.fill('public.set_automation_flow_status({org_a}, {flow_a}, ''paused'')')), 'paused', 'admin pausa o fluxo');
SELECT pg_temp.inbound('q2', 'conv5', 'a_owner', 'acc_a', '+5511977770005', 10);
SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'q2')), 'none/flow_paused', 'fluxo pausado: a sessão para');
SELECT pg_temp.inbound('q3', 'conv6', 'a_owner', 'acc_a', '+5511977770006', 0);
SELECT is((SELECT action || '/' || reason FROM pg_temp.prep('a_owner', 'q3')), 'none/no_flow', 'fluxo pausado: conversa nova não começa');
SELECT is(pg_temp.app_value(pg_temp.id('a_admin'), pg_temp.fill('public.set_automation_flow_status({org_a}, {flow_a}, ''active'')')), 'active', 'reativa');

-- ---------------------------------------------------------------------------
-- Versionamento: sessão presa à versão em que começou
-- ---------------------------------------------------------------------------
SELECT pg_temp.inbound('v1a', 'conv7', 'a_owner', 'acc_a', '+5511977770007', 0);
SELECT is(pg_temp.run('a_owner', 'v1a', 'active', 'menu', NULL), 1, 'conversa 7 começa na versão 1');
SELECT matches(pg_temp.save('a_owner', 'org_a', 'entrada', 'v2'), ',3,f\)$', 'novo rascunho');
SELECT is(
  pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('(SELECT version FROM public.publish_automation_flow({org_a}, {flow_a}, 3))')),
  '2', 'publica a versão 2');
SELECT pg_temp.inbound('v1b', 'conv7', 'a_owner', 'acc_a', '+5511977770007', 10);
SELECT is((SELECT flow_version_id::text || '/' || version_entry FROM pg_temp.prep('a_owner', 'v1b')),
  pg_temp.id('ver_a1')::text || '/menu', 'sessão em andamento continua na versão 1');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', '(SELECT count(*) FROM public.dev_automation_commit({v1b}, (SELECT id FROM public.automation_sessions WHERE conversation_id = {conv7}), 1, (SELECT published_version_id FROM public.automation_flows WHERE id = {flow_a}), ''active'', ''menu'', ''{}'', NULL, ''[]''))'),
  'AU005', NULL, 'gravar a sessão antiga com a versão nova é recusado');
SELECT pg_temp.inbound('v2a', 'conv8', 'a_owner', 'acc_a', '+5511977770008', 0);
SELECT is((SELECT version_entry FROM pg_temp.prep('a_owner', 'v2a')), 'menu-v2', 'conversa nova começa na versão 2');

-- ---------------------------------------------------------------------------
-- Sem Atendimento (org B): encaminhar é impossível; concluir resolve
-- ---------------------------------------------------------------------------
SELECT matches(pg_temp.save('b_owner', 'org_b', 'entrada', 'v1'), ',1,t\)$', 'B cria o fluxo');
INSERT INTO ids SELECT 'flow_b', id FROM public.automation_flows WHERE organization_id = pg_temp.id('org_b');
SELECT is(pg_temp.app_value(pg_temp.id('b_owner'), pg_temp.fill('(SELECT version FROM public.publish_automation_flow({org_b}, {flow_b}, 1))')), '1', 'B publica');
SELECT pg_temp.inbound('b1', 'conv_b', 'b_owner', 'acc_b', '+5511977770101', 0);
SELECT is((SELECT action || '/' || attendance::text FROM pg_temp.prep('b_owner', 'b1')), 'start/false', 'B começa, sem Atendimento');
SELECT throws_ok($$SELECT pg_temp.run('b_owner', 'b1', 'handed_off', NULL, 'handoff_step')$$, 'AU008', NULL,
  'sem Atendimento o banco recusa encaminhar para humano');
SELECT is(pg_temp.run('b_owner', 'b1', 'completed', NULL, 'handoff_unavailable'), 1, 'conclui com o aviso de indisponível');
SELECT is(
  (SELECT status::text || '/' || (resolved_at IS NOT NULL)::text FROM public.conversations WHERE id = pg_temp.id('conv_b')),
  'resolved/true', 'conversa concluída fica resolvida (a próxima mensagem recomeça)');
SELECT is(
  (SELECT string_agg(event_type::text || ':' || (user_id IS NULL)::text, ',' ORDER BY event_type::text)
   FROM public.conversation_events WHERE conversation_id = pg_temp.id('conv_b')),
  'automation_started:true,resolved:true', 'conclusão registrada sem usuário');

-- Falha do motor com Atendimento: volta para a equipe; sem Atendimento: resolvida.
SELECT pg_temp.inbound('f1', 'conv_f', 'a_owner', 'acc_a', '+5511977770009', 0);
SELECT is(pg_temp.run('a_owner', 'f1', 'failed', NULL, 'invalid_state', 'none'), 0, 'falha: nada é enviado');
SELECT is(
  (SELECT s.status::text || '/' || c.status::text FROM public.automation_sessions s
   JOIN public.conversations c ON c.id = s.conversation_id WHERE s.conversation_id = pg_temp.id('conv_f')),
  'failed/waiting', 'falha com Atendimento: a conversa fica para a equipe');

-- ---------------------------------------------------------------------------
-- Resultado do envio
-- ---------------------------------------------------------------------------
INSERT INTO ids SELECT 'bot_msg', id FROM public.messages WHERE conversation_id = pg_temp.id('conv2') AND sender_type = 'bot';
SELECT is(
  pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.dev_automation_record_delivery({bot_msg}, ''sent'', ''sim-out-1'')')),
  'sent', 'grava o envio simulado');
SELECT is(
  pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.dev_automation_record_delivery({bot_msg}, ''failed'')')),
  'sent', 'resultado repetido não muda o que foi gravado');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', 'public.dev_automation_record_delivery({m1}, ''sent'', ''x'')'),
  'P0002', NULL, 'mensagem do cliente não recebe resultado de envio');
SELECT throws_ok(
  pg_temp.as_sql('a_att', 'public.dev_automation_record_delivery({bot_msg}, ''sent'', ''x'')'),
  '42501', NULL, 'atendente não grava resultado da automação');
SELECT throws_ok(
  pg_temp.as_sql('a_owner', 'public.record_outbound_result({org_a}, {bot_msg}, ''sent'', ''x'')'),
  'P0002', NULL, 'record_outbound_result (atendente) não alcança respostas da automação');

-- ---------------------------------------------------------------------------
-- Trava do envio: entre o commit e o envio, o que mudou impede a saída
-- ---------------------------------------------------------------------------
SELECT pg_temp.inbound('d1', 'conv_d', 'a_owner', 'acc_a', '+5511977770011', 0);
SELECT is(pg_temp.run('a_owner', 'd1', 'active', 'menu', NULL, 'two'), 2, 'duas respostas pendentes');
INSERT INTO ids SELECT 'd_text', id FROM public.messages WHERE conversation_id = pg_temp.id('conv_d') AND message_type = 'text' AND sender_type = 'bot';
INSERT INTO ids SELECT 'd_list', id FROM public.messages WHERE conversation_id = pg_temp.id('conv_d') AND message_type = 'interactive';
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.dev_automation_begin_delivery({d_text})')), 'true',
  'organização, módulo, canal e conversa em ordem: pode enviar');
SELECT throws_ok(pg_temp.as_sql('a_att', 'public.dev_automation_begin_delivery({d_text})'), '42501', NULL,
  'atendente não libera envio da automação');
UPDATE public.organization_modules SET enabled = false WHERE organization_id = pg_temp.id('org_a') AND module = 'automacoes';
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.dev_automation_begin_delivery({d_list})')), 'false',
  'Automações desligado depois do commit: a resposta não sai');
SELECT is((SELECT delivery_status::text FROM public.messages WHERE id = pg_temp.id('d_list')), 'failed', 'e fica registrada como não enviada');
UPDATE public.organization_modules SET enabled = true WHERE organization_id = pg_temp.id('org_a') AND module = 'automacoes';
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('(SELECT changed FROM public.claim_conversation({org_a}, {conv_d}))')), 'true',
  'atendente assume antes do envio');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.dev_automation_begin_delivery({d_text})')), 'false',
  'conversa com atendente: a resposta do robô não sai');

-- ---------------------------------------------------------------------------
-- Organização suspensa: nada roda
-- ---------------------------------------------------------------------------
SELECT pg_temp.inbound('s1', 'conv_s', 'a_owner', 'acc_a', '+5511977770010', 0);
UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_a');
SELECT throws_ok($$SELECT * FROM pg_temp.prep('a_owner', 's1')$$, '42501', NULL, 'suspensa: a porta recusa');
SELECT throws_ok(pg_temp.as_sql('a_owner', 'public.dev_automation_begin_delivery({bot_msg})'), '42501', NULL,
  'suspensa: nenhuma resposta pendente é liberada para envio');
SELECT is(public.automation_begin_delivery_internal(pg_temp.id('bot_msg')), false,
  'suspensa: a trava interna (futuro worker) também não libera');
SELECT is((SELECT action || '/' || reason FROM public.automation_prepare_internal(pg_temp.id('s1'))), 'none/organization_inactive',
  'suspensa: a decisão interna (futuro worker) também não age');
UPDATE public.organizations SET status = 'active' WHERE id = pg_temp.id('org_a');
SELECT is((SELECT action FROM pg_temp.prep('a_owner', 's1')), 'start', 'reativada: volta a funcionar');

-- ---------------------------------------------------------------------------
-- Rollback de 0010 recusa com fluxos gravados
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT count(*) FROM public.automation_flows) >= 2,
  'há fluxos: o migrate:down de 0010 se recusaria (conferido no ciclo de rollback do banco vazio)'
);

SELECT * FROM finish();
ROLLBACK;

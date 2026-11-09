-- Antero Atendimentos — Entrega E2A: assumir, responder, resolver e reabrir.
--
-- Funções de 0008 e o registro em conversation_events, sempre como antero_app
-- com o contexto de usuário definido como a aplicação faz. As conversas nascem
-- pela ingestão real (pg_temp.ingest_as), como no simulador. Dentro desta
-- transação now() é constante: "mensagem antiga" é feita recuando created_at.
-- A disputa real entre duas conexões está em tests/db/conversation-actions.test.ts.
BEGIN;
\ir lib/helpers.psql
SELECT plan(109);

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-090'), ('Org B', 'org-b-090');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-090';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-090';
INSERT INTO public.organization_modules (organization_id, module, enabled)
VALUES (pg_temp.id('org_a'), 'atendimento', true), (pg_temp.id('org_b'), 'atendimento', true);

SELECT pg_temp.new_user('a_owner', 'a.owner.090@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.090@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.090@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_att2', 'a.att2.090@teste.local', 'A Atendente 2');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.090@teste.local', 'A Desativado');
SELECT pg_temp.new_user('b_owner', 'b.owner.090@teste.local', 'B Owner');
SELECT pg_temp.new_user('nobody', 'nobody.090@teste.local', 'Sem Organização');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att2'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'attendant', 'disabled'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active');

INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name) VALUES
  (pg_temp.id('org_a'), 'development', 'connected', 'Canal A 090'),
  (pg_temp.id('org_a'), 'development', 'connected', 'Canal A2 090'),
  (pg_temp.id('org_a'), 'cloud_api', 'connected', 'Canal A Cloud 090'),
  (pg_temp.id('org_b'), 'development', 'connected', 'Canal B 090');
INSERT INTO ids SELECT 'acc_a', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A 090';
INSERT INTO ids SELECT 'acc_a2', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A2 090';
INSERT INTO ids SELECT 'acc_cloud', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A Cloud 090';
INSERT INTO ids SELECT 'acc_b', id FROM public.whatsapp_accounts WHERE display_name = 'Canal B 090';

-- Conversas pela ingestão (owner/admin, canal development).
CREATE FUNCTION pg_temp.inbound(p_key text, p_user text, p_acc text, p_phone text, p_external text, p_content text DEFAULT 'Olá')
RETURNS void LANGUAGE sql AS $$
  INSERT INTO ids
  SELECT p_key, conversation_id
  FROM pg_temp.ingest_as(pg_temp.id(p_user), pg_temp.id(p_acc), p_phone, p_content, p_external)
  ON CONFLICT (k) DO NOTHING;
$$;
SELECT pg_temp.inbound('conv1', 'a_owner', 'acc_a', '+5511966660001', 'e2a-1');
SELECT pg_temp.inbound('conv2', 'a_owner', 'acc_a', '+5511966660002', 'e2a-2');
SELECT pg_temp.inbound('conv_bot', 'a_owner', 'acc_a', '+5511966660003', 'e2a-3');
SELECT pg_temp.inbound('conv_old', 'a_owner', 'acc_a', '+5511966660004', 'e2a-4');
SELECT pg_temp.inbound('conv_disc', 'a_owner', 'acc_a2', '+5511966660005', 'e2a-5');
SELECT pg_temp.inbound('conv_b', 'b_owner', 'acc_b', '+5511966660009', 'e2a-b');
UPDATE public.conversations SET status = 'bot' WHERE id = pg_temp.id('conv_bot');
UPDATE public.messages SET created_at = now() - interval '24 hours 1 second'
WHERE conversation_id = pg_temp.id('conv_old');

-- Conversa sem nenhuma mensagem recebida e conversa em canal cloud_api (a
-- ingestão só aceita development: montadas como dono das tabelas).
INSERT INTO public.contacts (organization_id, phone_number) VALUES
  (pg_temp.id('org_a'), '+5511966660006'), (pg_temp.id('org_a'), '+5511966660007');
INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id)
SELECT pg_temp.id('org_a'), pg_temp.id('acc_a'), id FROM public.contacts WHERE phone_number = '+5511966660006';
INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id)
SELECT pg_temp.id('org_a'), pg_temp.id('acc_cloud'), id FROM public.contacts WHERE phone_number = '+5511966660007';
INSERT INTO ids SELECT 'conv_empty', c.id FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.phone_number = '+5511966660006';
INSERT INTO ids SELECT 'conv_cloud', c.id FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.phone_number = '+5511966660007';
INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content)
VALUES (pg_temp.id('org_a'), pg_temp.id('conv_cloud'), pg_temp.id('acc_cloud'), 'inbound', 'contact', 'Oi pela Cloud API');

-- Atalhos: usuário, organização e conversa são CHAVES de ids.
CREATE FUNCTION pg_temp.claim(p_user text, p_org text, p_conv text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id(p_user),
    format('(SELECT changed FROM public.claim_conversation(%L, %L))', pg_temp.id(p_org), pg_temp.id(p_conv)))::boolean
$$;
CREATE FUNCTION pg_temp.resolve(p_user text, p_org text, p_conv text) RETURNS boolean
LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id(p_user),
    format('(SELECT changed FROM public.resolve_conversation(%L, %L))', pg_temp.id(p_org), pg_temp.id(p_conv)))::boolean
$$;
CREATE FUNCTION pg_temp.reply(p_user text, p_org text, p_conv text, p_content text, p_key uuid) RETURNS json
LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id(p_user),
    format('(SELECT row_to_json(r) FROM public.send_conversation_reply(%L, %L, %L, %L) r)',
      pg_temp.id(p_org), pg_temp.id(p_conv), p_content, p_key))::json
$$;
CREATE FUNCTION pg_temp.result(p_user text, p_org text, p_message uuid, p_status text, p_external text) RETURNS text
LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id(p_user),
    format('public.record_outbound_result(%L, %L, %L, %L)', pg_temp.id(p_org), p_message, p_status, p_external))
$$;
CREATE FUNCTION pg_temp.conv(p_conv text) RETURNS public.conversations
LANGUAGE sql AS $$ SELECT * FROM public.conversations WHERE id = pg_temp.id(p_conv) $$;
CREATE FUNCTION pg_temp.events(p_conv text) RETURNS text
LANGUAGE sql AS $$
  -- Ordem do enum (assigned < resolved < reopened): dentro desta transação
  -- todos os eventos têm o mesmo created_at.
  SELECT coalesce(string_agg(event_type::text, ',' ORDER BY event_type), '')
  FROM public.conversation_events WHERE conversation_id = pg_temp.id(p_conv)
$$;

-- ---------------------------------------------------------------------------
-- Catálogo e privilégios
-- ---------------------------------------------------------------------------
SELECT has_table('public', 'conversation_events', 'tabela conversation_events existe');
SELECT columns_are('public', 'conversation_events', ARRAY['id', 'organization_id', 'conversation_id', 'event_type', 'user_id', 'created_at'], 'colunas exatas');
SELECT enum_has_labels('public', 'conversation_event_type', ARRAY['assigned', 'resolved', 'reopened'], 'tipos de evento');
SELECT fk_ok('public', 'conversation_events', ARRAY['organization_id', 'conversation_id'], 'public', 'conversations', ARRAY['organization_id', 'id'], 'FK composta para conversations');
SELECT fk_ok('public', 'conversation_events', ARRAY['organization_id', 'user_id'], 'public', 'organization_members', ARRAY['organization_id', 'user_id'], 'FK composta para organization_members');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.conversation_events'::regclass), 'RLS habilitada em conversation_events');
SELECT is((SELECT string_agg(cmd, ',') FROM pg_policies WHERE tablename = 'conversation_events'), 'SELECT', 'uma política, só de leitura');
SELECT ok(has_table_privilege('antero_app', 'public.conversation_events', 'SELECT'), 'antero_app lê conversation_events');
SELECT ok(NOT has_table_privilege('antero_app', 'public.conversation_events', 'INSERT,UPDATE,DELETE,TRUNCATE'), 'antero_app não escreve em conversation_events');
SELECT ok(NOT has_table_privilege('antero_app', 'public.conversations', 'INSERT,UPDATE,DELETE,TRUNCATE'), 'antero_app continua sem escrita direta em conversations');
SELECT ok(NOT has_table_privilege('antero_app', 'public.messages', 'INSERT,UPDATE,DELETE,TRUNCATE'), 'antero_app continua sem escrita direta em messages');
SELECT has_column('public', 'messages', 'client_message_id', 'messages.client_message_id existe');
SELECT has_index('public', 'messages', 'messages_conversation_client_message_id_key', 'índice único da chave de envio');

SELECT is(
  (SELECT count(*)::int FROM pg_proc
   WHERE oid IN ('public.claim_conversation(uuid, uuid)'::regprocedure,
                 'public.resolve_conversation(uuid, uuid)'::regprocedure,
                 'public.send_conversation_reply(uuid, uuid, text, uuid)'::regprocedure,
                 'public.record_outbound_result(uuid, uuid, public.message_delivery_status, text)'::regprocedure,
                 'public.assert_attendance_access(uuid)'::regprocedure)
     AND prosecdef AND proconfig @> ARRAY['search_path=""'] AND pg_get_userbyid(proowner) = 'antero_owner'),
  5, 'funções de atendimento: SECURITY DEFINER, search_path vazio, dono antero_owner'
);
SELECT ok(
  has_function_privilege('antero_app', 'public.claim_conversation(uuid, uuid)', 'EXECUTE')
  AND has_function_privilege('antero_app', 'public.resolve_conversation(uuid, uuid)', 'EXECUTE')
  AND has_function_privilege('antero_app', 'public.send_conversation_reply(uuid, uuid, text, uuid)', 'EXECUTE')
  AND has_function_privilege('antero_app', 'public.record_outbound_result(uuid, uuid, public.message_delivery_status, text)', 'EXECUTE'),
  'antero_app executa as quatro operações'
);
SELECT ok(
  NOT has_function_privilege('antero_auth', 'public.claim_conversation(uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('antero_auth', 'public.send_conversation_reply(uuid, uuid, text, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.claim_conversation(uuid, uuid)', 'EXECUTE')
  AND NOT has_function_privilege('public', 'public.record_outbound_result(uuid, uuid, public.message_delivery_status, text)', 'EXECUTE'),
  'antero_auth e PUBLIC não executam'
);
SELECT ok(
  NOT has_function_privilege('antero_app', 'public.assert_attendance_access(uuid)', 'EXECUTE')
  AND NOT has_function_privilege('antero_app', 'public.record_conversation_event()', 'EXECUTE'),
  'funções internas sem EXECUTE para antero_app'
);

-- ---------------------------------------------------------------------------
-- Assumir: quem não pode
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.claim(NULL, 'org_a', 'conv1')$$, '28000', NULL, 'sem sessão não assume');
SELECT throws_ok($$SELECT pg_temp.claim('nobody', 'org_a', 'conv1')$$, '42501', NULL, 'usuário sem organização não assume');
SELECT throws_ok($$SELECT pg_temp.claim('b_owner', 'org_a', 'conv1')$$, '42501', NULL, 'owner de outra organização não assume (org alheia)');
SELECT throws_ok($$SELECT pg_temp.claim('b_owner', 'org_b', 'conv1')$$, 'P0002', NULL, 'conversa de outra organização não é encontrada no contexto próprio');
SELECT throws_ok($$SELECT pg_temp.claim('a_disabled', 'org_a', 'conv1')$$, '42501', NULL, 'vínculo desativado não assume');

UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_a');
SELECT throws_ok($$SELECT pg_temp.claim('a_att', 'org_a', 'conv1')$$, '42501', NULL, 'organização suspensa não assume');
UPDATE public.organizations SET status = 'active' WHERE id = pg_temp.id('org_a');

UPDATE public.organization_modules SET enabled = false WHERE organization_id = pg_temp.id('org_a');
SELECT throws_ok($$SELECT pg_temp.claim('a_att', 'org_a', 'conv1')$$, '42501', NULL, 'sem módulo Atendimento não assume');
UPDATE public.organization_modules SET enabled = true WHERE organization_id = pg_temp.id('org_a');

SELECT is((pg_temp.conv('conv1')).status::text, 'waiting', 'tentativas negadas não alteram a conversa');
SELECT is(pg_temp.events('conv1'), '', 'tentativas negadas não registram evento');
SELECT throws_ok($$SELECT pg_temp.claim('a_att', 'org_a', NULL)$$, 'P0002', NULL, 'conversa nula não é encontrada');

-- ---------------------------------------------------------------------------
-- Assumir: fluxo, repetição e conflito
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.claim('a_att', 'org_a', 'conv1'), true, 'atendente assume conversa aguardando');
SELECT is((pg_temp.conv('conv1')).status::text, 'human', 'conversa passa a human');
SELECT is((pg_temp.conv('conv1')).assigned_user_id, pg_temp.id('a_att'), 'responsável = quem assumiu');
SELECT is((pg_temp.conv('conv1')).assigned_at, now(), 'assigned_at registrado');
SELECT is(pg_temp.claim('a_att', 'org_a', 'conv1'), false, 'assumir de novo: sem efeito');
SELECT throws_ok($$SELECT pg_temp.claim('a_att2', 'org_a', 'conv1')$$, 'AT001', NULL, 'outro atendente recebe conflito');
SELECT throws_ok($$SELECT pg_temp.claim('a_owner', 'org_a', 'conv1')$$, 'AT001', NULL, 'nem o owner toma a conversa (sem transferência)');
SELECT is((pg_temp.conv('conv1')).assigned_user_id, pg_temp.id('a_att'), 'responsável preservado após o conflito');
SELECT is(pg_temp.events('conv1'), 'assigned', 'um único evento assigned');
SELECT is(
  (SELECT user_id FROM public.conversation_events WHERE conversation_id = pg_temp.id('conv1')),
  pg_temp.id('a_att'), 'evento registra quem assumiu'
);
SELECT is(pg_temp.claim('a_att2', 'org_a', 'conv_bot'), true, 'conversa em bot pode ser assumida');
SELECT is((pg_temp.conv('conv_bot')).status::text, 'human', 'bot -> human');

-- ---------------------------------------------------------------------------
-- Responder
-- ---------------------------------------------------------------------------
SELECT is(
  (pg_temp.reply('a_att', 'org_a', 'conv1', '  Olá! Como posso ajudar?  ', '00000000-0000-4000-8000-000000000001')->>'created')::boolean,
  true, 'responsável responde dentro da janela'
);
INSERT INTO ids SELECT 'msg1', id FROM public.messages WHERE client_message_id = '00000000-0000-4000-8000-000000000001';
SELECT is(
  (SELECT (direction, sender_type, sender_user_id, content, delivery_status, external_message_id)::text
   FROM public.messages WHERE id = pg_temp.id('msg1')),
  (SELECT ('outbound', 'user', pg_temp.id('a_att'), 'Olá! Como posso ajudar?', 'pending', NULL::text)::text),
  'mensagem outbound do atendente, conteúdo aparado, pending, sem id externo'
);
SELECT is(
  pg_temp.reply('a_att', 'org_a', 'conv1', 'outro texto', '00000000-0000-4000-8000-000000000001')->>'message_id',
  pg_temp.id('msg1')::text, 'mesma chave: devolve a mensagem já gravada'
);
SELECT is(
  (pg_temp.reply('a_att', 'org_a', 'conv1', 'outro texto', '00000000-0000-4000-8000-000000000001')->>'created')::boolean,
  false, 'mesma chave: created = false'
);
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE conversation_id = pg_temp.id('conv1') AND direction = 'outbound'),
  1, 'envio repetido não duplica a mensagem'
);
SELECT throws_ok($$SELECT pg_temp.reply('a_att2', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000001')$$, 'AT006', NULL, 'chave de outro autor: conflito de idempotência');
SELECT throws_ok($$SELECT pg_temp.reply('a_att2', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000002')$$, 'AT003', NULL, 'quem não é responsável não responde');
SELECT throws_ok($$SELECT pg_temp.reply('a_owner', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000003')$$, 'AT003', NULL, 'nem o owner responde conversa de outro');
SELECT throws_ok($$SELECT pg_temp.reply('b_owner', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000004')$$, '42501', NULL, 'outra organização não responde');
SELECT throws_ok($$SELECT pg_temp.reply('b_owner', 'org_b', 'conv1', 'x', '00000000-0000-4000-8000-000000000005')$$, 'P0002', NULL, 'conversa alheia não existe no contexto de B');
SELECT throws_ok($$SELECT pg_temp.reply(NULL, 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000006')$$, '28000', NULL, 'sem sessão não responde');
SELECT throws_ok($$SELECT pg_temp.reply('a_disabled', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000007')$$, '42501', NULL, 'desativado não responde');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv1', '   ', '00000000-0000-4000-8000-000000000008')$$, 'AT005', NULL, 'conteúdo vazio recusado');
SELECT throws_ok(format('SELECT pg_temp.reply(%L, %L, %L, %L, %L)', 'a_att', 'org_a', 'conv1', repeat('a', 4097), '00000000-0000-4000-8000-000000000009'), 'AT005', NULL, 'conteúdo acima de 4096 recusado');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv1', 'x', NULL)$$, '22004', NULL, 'sem chave de idempotência recusado');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv2', 'x', '00000000-0000-4000-8000-000000000010')$$, 'AT002', NULL, 'conversa aguardando não recebe resposta (assumir antes)');

SELECT is(pg_temp.claim('a_att', 'org_a', 'conv_old'), true, 'atendente assume conversa com última mensagem antiga');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv_old', 'x', '00000000-0000-4000-8000-000000000011')$$, 'AT004', NULL, 'última mensagem recebida há mais de 24 h: janela encerrada');
UPDATE public.messages SET created_at = now() - interval '23 hours 59 minutes' WHERE conversation_id = pg_temp.id('conv_old');
SELECT is(
  (pg_temp.reply('a_att', 'org_a', 'conv_old', 'Ainda dá tempo', '00000000-0000-4000-8000-000000000012')->>'created')::boolean,
  true, 'dentro de 24 h a resposta é aceita'
);
SELECT is(pg_temp.claim('a_att', 'org_a', 'conv_empty'), true, 'assume conversa sem mensagem recebida');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv_empty', 'x', '00000000-0000-4000-8000-000000000013')$$, 'AT004', NULL, 'sem mensagem do cliente não há janela');

SELECT is(pg_temp.claim('a_att', 'org_a', 'conv_disc'), true, 'assume conversa do segundo canal');
UPDATE public.whatsapp_accounts SET status = 'disconnected' WHERE id = pg_temp.id('acc_a2');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv_disc', 'x', '00000000-0000-4000-8000-000000000014')$$, 'AT007', NULL, 'canal desconectado não envia');
UPDATE public.whatsapp_accounts SET status = 'connected' WHERE id = pg_temp.id('acc_a2');

-- Resultado do envio
SELECT throws_ok(format('SELECT pg_temp.result(%L, %L, %L, %L, %L)', 'a_att', 'org_a', pg_temp.id('msg1'), 'sent', NULL), '22023', NULL, 'sent sem id externo recusado');
SELECT throws_ok(format('SELECT pg_temp.result(%L, %L, %L, %L, %L)', 'a_att', 'org_a', pg_temp.id('msg1'), 'failed', 'sim-x'), '22023', NULL, 'failed com id externo recusado');
SELECT throws_ok(format('SELECT pg_temp.result(%L, %L, %L, %L, %L)', 'a_att', 'org_a', pg_temp.id('msg1'), 'delivered', 'sim-x'), '22023', NULL, 'delivered não é gravado pelo usuário');
SELECT throws_ok(format('SELECT pg_temp.result(%L, %L, %L, %L, %L)', 'a_att2', 'org_a', pg_temp.id('msg1'), 'sent', 'sim-x'), 'P0002', NULL, 'outro usuário não grava o resultado da mensagem');
SELECT throws_ok(format('SELECT pg_temp.result(%L, %L, %L, %L, %L)', 'b_owner', 'org_b', pg_temp.id('msg1'), 'sent', 'sim-x'), 'P0002', NULL, 'outra organização não grava o resultado');
SELECT is(pg_temp.result('a_att', 'org_a', pg_temp.id('msg1'), 'sent', 'sim-out-1'), 'sent', 'autor grava sent com o id externo simulado');
SELECT is(
  (SELECT (delivery_status, external_message_id)::text FROM public.messages WHERE id = pg_temp.id('msg1')),
  '(sent,sim-out-1)', 'mensagem marcada como enviada'
);
SELECT is(pg_temp.result('a_att', 'org_a', pg_temp.id('msg1'), 'failed', NULL), 'sent', 'resultado posterior diferente é ignorado');
SELECT is(pg_temp.result('a_att', 'org_a', pg_temp.id('msg1'), 'sent', 'sim-out-1'), 'sent', 'repetir o resultado não muda nada');

-- Canal cloud_api: a mensagem pode ser gravada, mas o usuário não marca como
-- enviada (isso virá do provedor real, na E2B).
SELECT is(pg_temp.claim('a_att', 'org_a', 'conv_cloud'), true, 'assume conversa de canal cloud_api');
SELECT is(
  (pg_temp.reply('a_att', 'org_a', 'conv_cloud', 'Resposta', '00000000-0000-4000-8000-000000000015')->>'provider'),
  'cloud_api', 'envio devolve o provedor do canal'
);
SELECT throws_ok(
  format('SELECT pg_temp.result(%L, %L, %L, %L, %L)', 'a_att', 'org_a',
    (SELECT id FROM public.messages WHERE client_message_id = '00000000-0000-4000-8000-000000000015'), 'sent', 'wamid.falso'),
  'AT008', NULL, 'usuário não marca como enviada mensagem de canal real'
);

-- Escrita direta continua negada
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$UPDATE public.messages SET delivery_status = 'read' WHERE id = {msg1}$q$)$$, '42501', NULL, 'UPDATE direto em messages negado');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$UPDATE public.conversations SET status = 'resolved', resolved_at = now() WHERE id = {conv1}$q$)$$, '42501', NULL, 'UPDATE direto em conversations negado');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$INSERT INTO public.conversation_events (organization_id, conversation_id, event_type) VALUES ({org_a}, {conv1}, 'reopened')$q$)$$, '42501', NULL, 'INSERT direto em conversation_events negado');

-- ---------------------------------------------------------------------------
-- Resolver
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.resolve('a_att', 'org_a', 'conv2')$$, 'AT002', NULL, 'conversa aguardando não é resolvida');
SELECT throws_ok($$SELECT pg_temp.resolve('a_att2', 'org_a', 'conv1')$$, 'AT003', NULL, 'atendente que não é responsável não resolve');
SELECT throws_ok($$SELECT pg_temp.resolve('b_owner', 'org_a', 'conv1')$$, '42501', NULL, 'outra organização não resolve');
SELECT throws_ok($$SELECT pg_temp.resolve(NULL, 'org_a', 'conv1')$$, '28000', NULL, 'sem sessão não resolve');
SELECT is(pg_temp.resolve('a_att', 'org_a', 'conv1'), true, 'responsável resolve');
SELECT is(
  ((pg_temp.conv('conv1')).status::text, (pg_temp.conv('conv1')).resolved_at, (pg_temp.conv('conv1')).assigned_user_id),
  ('resolved'::text, now(), pg_temp.id('a_att')),
  'resolvida, com resolved_at e o responsável preservado'
);
SELECT is(pg_temp.resolve('a_att', 'org_a', 'conv1'), false, 'resolver de novo: sem efeito');
SELECT is(pg_temp.events('conv1'), 'assigned,resolved', 'evento resolved registrado uma vez');
SELECT is(
  (SELECT user_id FROM public.conversation_events WHERE conversation_id = pg_temp.id('conv1') AND event_type = 'resolved'),
  pg_temp.id('a_att'), 'evento registra quem resolveu'
);
SELECT is(pg_temp.resolve('a_admin', 'org_a', 'conv_bot'), true, 'admin resolve conversa de outro atendente');
SELECT throws_ok($$SELECT pg_temp.claim('a_att2', 'org_a', 'conv1')$$, 'AT002', NULL, 'resolvida não pode ser assumida');
SELECT throws_ok($$SELECT pg_temp.reply('a_att', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000016')$$, 'AT002', NULL, 'resolvida não recebe resposta');
SELECT is(
  pg_temp.reply('a_att', 'org_a', 'conv1', 'x', '00000000-0000-4000-8000-000000000001')->>'message_id',
  pg_temp.id('msg1')::text, 'pedido repetido após resolver ainda devolve a mensagem original'
);

-- ---------------------------------------------------------------------------
-- Reabrir (ingestão) e idempotência
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT reopened FROM pg_temp.ingest_as(pg_temp.id('a_owner'), pg_temp.id('acc_a'), '+5511966660001', 'Voltei', 'e2a-1b')),
  true, 'nova mensagem do cliente reabre a resolvida'
);
SELECT is(
  ((pg_temp.conv('conv1')).status::text, (pg_temp.conv('conv1')).assigned_user_id, (pg_temp.conv('conv1')).resolved_at),
  ('waiting'::text, NULL::uuid, NULL::timestamptz),
  'reaberta: aguardando, sem responsável'
);
SELECT is(pg_temp.events('conv1'), 'assigned,resolved,reopened', 'evento reopened registrado');
SELECT is(
  (SELECT user_id FROM public.conversation_events WHERE conversation_id = pg_temp.id('conv1') AND event_type = 'reopened'),
  NULL, 'reopened não tem usuário (foi o cliente)'
);
SELECT is(
  (SELECT duplicate FROM pg_temp.ingest_as(pg_temp.id('a_owner'), pg_temp.id('acc_a'), '+5511966660001', 'Voltei', 'e2a-1b')),
  true, 'mesma mensagem recebida de novo: duplicata'
);
SELECT pg_temp.inbound('conv1', 'a_owner', 'acc_a', '+5511966660001', 'e2a-1c', 'Mais uma');
SELECT is(pg_temp.events('conv1'), 'assigned,resolved,reopened', 'duplicata e mensagem em conversa aberta não geram transição');
SELECT is(
  (SELECT string_agg(direction || ':' || content, '|' ORDER BY content) FROM public.messages WHERE conversation_id = pg_temp.id('conv1')),
  'inbound:Mais uma|inbound:Olá|outbound:Olá! Como posso ajudar?|inbound:Voltei',
  'histórico anterior íntegro após resolver e reabrir'
);
SELECT is(pg_temp.claim('a_att2', 'org_a', 'conv1'), true, 'reaberta pode ser assumida por outro atendente');
SELECT is(pg_temp.events('conv1'), 'assigned,assigned,resolved,reopened', 'novo assigned no histórico');
SELECT is(
  (pg_temp.reply('a_att2', 'org_a', 'conv1', 'Oi de novo', '00000000-0000-4000-8000-000000000017')->>'created')::boolean,
  true, 'novo responsável responde: janela contada da nova mensagem'
);

-- ---------------------------------------------------------------------------
-- RLS de conversation_events
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', $$SELECT 1 FROM public.conversation_events WHERE conversation_id = {conv1}$$), 4::bigint, 'membro ativo lê os eventos da própria organização');
SELECT is(pg_temp.sees('b_owner', $$SELECT 1 FROM public.conversation_events WHERE organization_id = {org_a}$$), 0::bigint, 'outra organização não lê');
SELECT is(pg_temp.sees('nobody', $$SELECT 1 FROM public.conversation_events$$), 0::bigint, 'sem organização não lê');
SELECT is(pg_temp.sees('a_disabled', $$SELECT 1 FROM public.conversation_events$$), 0::bigint, 'desativado não lê');
SELECT is(pg_temp.app_count(NULL, 'SELECT 1 FROM public.conversation_events'), 0::bigint, 'sem contexto não lê');
UPDATE public.organization_modules SET enabled = false WHERE organization_id = pg_temp.id('org_a');
SELECT is(pg_temp.sees('a_att', $$SELECT 1 FROM public.conversation_events$$), 0::bigint, 'sem módulo Atendimento não lê os eventos');
UPDATE public.organization_modules SET enabled = true WHERE organization_id = pg_temp.id('org_a');
UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_a');
SELECT is(pg_temp.sees('a_att', $$SELECT 1 FROM public.conversation_events$$), 0::bigint, 'organização suspensa não lê os eventos');
UPDATE public.organizations SET status = 'active' WHERE id = pg_temp.id('org_a');

-- Organização B intacta
SELECT is(((pg_temp.conv('conv_b')).status::text), 'waiting', 'conversa de B não foi tocada');
SELECT is(pg_temp.events('conv_b'), '', 'B sem eventos');

SELECT * FROM finish();
ROLLBACK;

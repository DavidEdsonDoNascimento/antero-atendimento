-- Antero Atendimentos — Entrega E2B-2a: ingestão das mensagens do webhook (0015).
--
-- 1) Estrutura e privilégios: retenções sem acesso para a aplicação; só o
--    antero_worker executa webhook_ingest_message; a função interna e a de
--    conteúdo não são de ninguém.
-- 2) Conteúdo: texto, respostas de lista/botão, marcadores e legendas,
--    reação/sistema ignoradas, estrutura inválida.
-- 3) Porta do worker: evento reivindicado, token, prazo, wamid do evento,
--    canal/organização/módulos atuais, duplicidade entre eventos, várias
--    mensagens por evento.
-- 4) Retenções: sem telefone, telefone inválido, conteúdo inválido ou longo,
--    conflito de identidade; sobrevivem à exclusão do evento; consistência por
--    FK; mensagens extensas e elementos acima do limite (cópia limitada).
-- 5) BSUID: gravado só quando o campo está vazio, nunca sobrescrito, qualquer
--    divergência retida (política conservadora), isolado por organização.
-- 6) Horário da Meta e janela de 24 h (cloud_api), ancorados na chegada do
--    webhook; canal development com a regra anterior.
-- Concorrência real (várias conexões): tests/db/whatsapp-ingest.test.ts.
BEGIN;
\ir lib/helpers.psql
SELECT plan(196);

DELETE FROM public.webhook_message_holds;
DELETE FROM public.webhook_events;

INSERT INTO public.organizations (name, slug) VALUES
  ('Org A', 'org-a-150'), ('Org B', 'org-b-150'), ('Org D', 'org-d-150'), ('Org E', 'org-e-150');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-150';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-150';
INSERT INTO ids SELECT 'org_d', id FROM public.organizations WHERE slug = 'org-d-150';
INSERT INTO ids SELECT 'org_e', id FROM public.organizations WHERE slug = 'org-e-150';
-- A: Atendimento + Automações; B: só Automações; D: nenhum módulo; E: só Atendimento.
INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES
  (pg_temp.id('org_a'), 'atendimento', true), (pg_temp.id('org_a'), 'automacoes', true),
  (pg_temp.id('org_b'), 'automacoes', true), (pg_temp.id('org_e'), 'atendimento', true);

SELECT pg_temp.new_user('a_owner', 'a.owner.150@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_att', 'a.att.150@teste.local', 'A Atendente');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active');

INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, external_business_account_id) VALUES
  (pg_temp.id('org_a'), 'cloud_api', 'connected', 'A1 150', '15500150001', '25500150001'),
  (pg_temp.id('org_a'), 'cloud_api', 'connected', 'A2 150', '15500150002', '25500150001'),
  (pg_temp.id('org_a'), 'development', 'connected', 'A dev 150', NULL, NULL),
  (pg_temp.id('org_b'), 'cloud_api', 'connected', 'B1 150', '15500150011', '25500150011'),
  (pg_temp.id('org_d'), 'cloud_api', 'connected', 'D1 150', '15500150021', '25500150021'),
  (pg_temp.id('org_e'), 'cloud_api', 'connected', 'E1 150', '15500150031', '25500150031');
INSERT INTO ids SELECT 'acc_a1', id FROM public.whatsapp_accounts WHERE display_name = 'A1 150';
INSERT INTO ids SELECT 'acc_a2', id FROM public.whatsapp_accounts WHERE display_name = 'A2 150';
INSERT INTO ids SELECT 'acc_dev', id FROM public.whatsapp_accounts WHERE display_name = 'A dev 150';
INSERT INTO ids SELECT 'acc_b1', id FROM public.whatsapp_accounts WHERE display_name = 'B1 150';
INSERT INTO ids SELECT 'acc_d1', id FROM public.whatsapp_accounts WHERE display_name = 'D1 150';
INSERT INTO ids SELECT 'acc_e1', id FROM public.whatsapp_accounts WHERE display_name = 'E1 150';

-- ---------------------------------------------------------------------------
-- Construção das notificações (formato da Meta, dados fictícios)
-- ---------------------------------------------------------------------------
-- Segundos Unix em texto, como a Meta envia.
CREATE FUNCTION pg_temp.ts(p_offset interval DEFAULT '0') RETURNS text
LANGUAGE sql AS $$ SELECT floor(extract(epoch FROM clock_timestamp() + p_offset))::bigint::text $$;

-- Mensagem de texto; p_extra substitui/acrescenta chaves (null remove).
CREATE FUNCTION pg_temp.msg(p_wamid text, p_from text DEFAULT '5511988880001', p_extra jsonb DEFAULT '{}') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'from', p_from, 'id', p_wamid, 'timestamp', pg_temp.ts(), 'type', 'text',
    'text', jsonb_build_object('body', 'Oi')) || p_extra)
$$;
CREATE FUNCTION pg_temp.contact(p_wa_id text, p_user_id text DEFAULT NULL, p_name text DEFAULT 'Cliente 150') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('wa_id', p_wa_id, 'user_id', p_user_id, 'profile', jsonb_build_object('name', p_name)))
$$;

-- Grava a notificação como o webhook (antero_worker) e reivindica tudo o que
-- estiver pendente, guardando os tokens.
CREATE TEMP TABLE claims (event_id bigint PRIMARY KEY, claim_token uuid NOT NULL);
CREATE FUNCTION pg_temp.receive(p_channel text, p_messages jsonb, p_contacts jsonb DEFAULT NULL, p_salt text DEFAULT NULL) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_phone text;
  v_waba text;
  v_value jsonb;
  v_claimed jsonb;
BEGIN
  SELECT external_account_id, external_business_account_id INTO v_phone, v_waba
  FROM public.whatsapp_accounts WHERE id = pg_temp.id(p_channel);
  v_value := jsonb_strip_nulls(jsonb_build_object(
    'messaging_product', 'whatsapp',
    'metadata', jsonb_build_object('display_phone_number', '15550000000', 'phone_number_id', v_phone),
    'contacts', p_contacts, 'messages', p_messages, 'salt', p_salt));
  PERFORM pg_temp.become('antero_worker', NULL);
  PERFORM public.webhook_record_delivery(jsonb_build_object(
    'object', 'whatsapp_business_account',
    'entry', jsonb_build_array(jsonb_build_object('id', v_waba, 'changes',
      jsonb_build_array(jsonb_build_object('field', 'messages', 'value', v_value))))));
  SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') INTO v_claimed FROM public.webhook_claim_events(100, 600) c;
  PERFORM pg_temp.unbecome();
  INSERT INTO claims
  SELECT r.event_id, r.claim_token FROM jsonb_to_recordset(v_claimed) AS r(event_id bigint, claim_token uuid)
  ON CONFLICT (event_id) DO UPDATE SET claim_token = excluded.claim_token;
END;
$$;

-- Evento mais recente que contém o wamid.
CREATE FUNCTION pg_temp.ev(p_wamid text) RETURNS bigint
LANGUAGE sql AS $$
  SELECT e.id FROM public.webhook_events e
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(e.payload #> '{value,messages}', '[]')) m WHERE m ->> 'id' = p_wamid)
  ORDER BY e.id DESC LIMIT 1
$$;

-- Ingestão como antero_worker; o resultado fica em `results` pela etiqueta.
CREATE TEMP TABLE results (label text PRIMARY KEY, r jsonb NOT NULL);
CREATE FUNCTION pg_temp.ingest_raw(p_event bigint, p_token uuid, p_wamid text) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE v jsonb;
BEGIN
  PERFORM pg_temp.become('antero_worker', NULL);
  SELECT to_jsonb(r) INTO v FROM public.webhook_ingest_message(p_event, p_token, p_wamid) r;
  PERFORM pg_temp.unbecome();
  RETURN v;
END;
$$;
CREATE FUNCTION pg_temp.run(p_label text, p_wamid text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_event bigint := pg_temp.ev(p_wamid);
  v jsonb;
BEGIN
  v := pg_temp.ingest_raw(v_event, (SELECT claim_token FROM claims WHERE event_id = v_event), p_wamid);
  INSERT INTO results VALUES (p_label, v);
  RETURN (v ->> 'outcome') || '|' || coalesce(v ->> 'reason', '-');
END;
$$;
CREATE FUNCTION pg_temp.finish(p_wamid text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_event bigint := pg_temp.ev(p_wamid);
  v_token uuid := (SELECT claim_token FROM claims WHERE event_id = v_event);
  v text;
BEGIN
  PERFORM pg_temp.become('antero_worker', NULL);
  v := public.webhook_finish_event(v_event, v_token, 'processed', NULL)::text;
  PERFORM pg_temp.unbecome();
  RETURN v;
END;
$$;
CREATE FUNCTION pg_temp.r(p_label text, p_key text) RETURNS text
LANGUAGE sql AS $$ SELECT r ->> p_key FROM results WHERE label = p_label $$;
CREATE FUNCTION pg_temp.m(p_wamid text) RETURNS public.messages
LANGUAGE sql AS $$ SELECT * FROM public.messages WHERE external_message_id = p_wamid $$;
CREATE FUNCTION pg_temp.hold(p_wamid text) RETURNS public.webhook_message_holds
LANGUAGE sql AS $$ SELECT * FROM public.webhook_message_holds WHERE wamid = p_wamid $$;

-- Atendente da Org A assume e responde (antero_app, como a Inbox).
CREATE FUNCTION pg_temp.take_and_reply(p_conversation uuid) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v text;
  v_org uuid := pg_temp.id('org_a');
  v_user uuid := pg_temp.id('a_att');
BEGIN
  PERFORM pg_temp.become('antero_app', v_user);
  PERFORM public.claim_conversation(v_org, p_conversation);
  SELECT r.delivery_status::text INTO v
  FROM public.send_conversation_reply(v_org, p_conversation, 'Resposta', gen_random_uuid()) r;
  PERFORM pg_temp.unbecome();
  RETURN v;
END;
$$;

CREATE FUNCTION pg_temp.sim(p_phone text, p_content text, p_wamid text) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v text;
  v_user uuid := pg_temp.id('a_owner');
  v_account uuid := pg_temp.id('acc_dev');
BEGIN
  PERFORM pg_temp.become('antero_app', v_user);
  SELECT created::text || '|' || duplicate::text INTO v
  FROM public.ingest_inbound_message(v_account, p_phone, p_content, p_wamid);
  PERFORM pg_temp.unbecome();
  RETURN v;
END;
$$;

CREATE TEMP VIEW our_functions AS
SELECT p.oid, n.nspname || '.' || p.oid::regprocedure::text AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'app', 'auth')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

-- ---------------------------------------------------------------------------
-- 1) Estrutura e privilégios
-- ---------------------------------------------------------------------------
SELECT has_table('public', 'webhook_message_holds', 'tabela de retenções existe');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_message_holds'::regclass), 'retenções com RLS');
SELECT policies_are('public', 'webhook_message_holds', ARRAY[]::name[], 'retenções sem política nenhuma');
SELECT table_privs_are('public', 'webhook_message_holds', 'antero_app', ARRAY[]::text[], 'antero_app sem acesso às retenções');
SELECT table_privs_are('public', 'webhook_message_holds', 'antero_auth', ARRAY[]::text[], 'antero_auth sem acesso às retenções');
SELECT table_privs_are('public', 'webhook_message_holds', 'antero_worker', ARRAY[]::text[], 'antero_worker sem acesso direto às retenções');
SELECT columns_are('public', 'webhook_message_holds', ARRAY[
  'id', 'organization_id', 'whatsapp_account_id', 'event_id', 'wamid', 'reason', 'status', 'provider_message_type',
  'provider_user_id', 'provider_sent_at', 'webhook_received_at', 'message', 'message_storage', 'message_original_bytes',
  'message_sha256', 'contact', 'contact_storage', 'contact_original_bytes', 'created_at', 'resolved_at',
  'resolved_message_id'], 'colunas da retenção (sem a notificação inteira)');
SELECT has_column('public', 'messages', 'provider_message_type', 'messages.provider_message_type');
SELECT has_column('public', 'messages', 'provider_sent_at', 'messages.provider_sent_at');
SELECT has_column('public', 'messages', 'webhook_received_at', 'messages.webhook_received_at');
SELECT has_column('public', 'messages', 'interaction_reply_id', 'messages.interaction_reply_id');
SELECT has_column('public', 'contacts', 'whatsapp_user_id', 'contacts.whatsapp_user_id');
SELECT ok(
  NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
              WHERE i.indrelid = 'public.contacts'::regclass AND i.indisunique AND a.attname = 'whatsapp_user_id'),
  'BSUID sem índice único (o escopo da Meta é o portfólio, não a organização)'
);
SELECT ok(has_function_privilege('antero_worker', 'public.webhook_ingest_message(bigint,uuid,text)', 'EXECUTE'), 'worker executa a porta de ingestão');
SELECT is(
  (SELECT count(*)::int FROM our_functions
   WHERE signature IN ('public.ingest_inbound_internal(uuid,uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text)',
                       'public.webhook_message_content(jsonb)', 'public.webhook_hold_copy(text,jsonb)')
     AND (has_function_privilege('antero_app', oid, 'EXECUTE') OR has_function_privilege('antero_auth', oid, 'EXECUTE')
          OR has_function_privilege('antero_worker', oid, 'EXECUTE') OR has_function_privilege('public', oid, 'EXECUTE'))),
  0, 'ingestão interna, conteúdo e cópia da retenção: nenhum papel executa'
);
SELECT ok(NOT has_function_privilege('antero_app', 'public.webhook_ingest_message(bigint,uuid,text)', 'EXECUTE'), 'antero_app NÃO executa a porta do worker');
SELECT ok(NOT has_function_privilege('antero_auth', 'public.webhook_ingest_message(bigint,uuid,text)', 'EXECUTE'), 'antero_auth NÃO executa a porta do worker');
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_worker', 'SELECT * FROM public.ingest_inbound_internal(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)')$$,
  '42501', NULL, 'worker NÃO chama a ingestão interna'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_app', 'SELECT * FROM public.ingest_inbound_internal(NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)')$$,
  '42501', NULL, 'antero_app NÃO chama a ingestão interna'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_worker', 'SELECT * FROM public.ingest_inbound_message(NULL, NULL, NULL, NULL)')$$,
  '42501', NULL, 'worker continua sem a porta do simulador'
);
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM public.webhook_message_holds')$$, '42501', NULL, 'worker NÃO lê retenções');
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_app', 'SELECT * FROM public.webhook_ingest_message(1, gen_random_uuid(), ''x'')')$$,
  '42501', NULL, 'antero_app NÃO ingere pelo webhook'
);
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee = 'antero_worker'),
  0, 'antero_worker continua sem privilégio em tabela'
);

-- ---------------------------------------------------------------------------
-- 2) Conteúdo (função pura)
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.content(p_message jsonb) RETURNS text
LANGUAGE sql AS $$
  SELECT outcome || '|' || coalesce(reason, '-') || '|' || coalesce(provider_message_type, '-') || '|'
         || coalesce(content, '-') || '|' || coalesce(interaction_reply_id, '-')
  FROM public.webhook_message_content(p_message)
$$;
SELECT is(pg_temp.content('{"type":"text","text":{"body":"  Olá  "}}'), 'ok|-|text|Olá|-', 'texto: corpo sem espaços nas pontas');
SELECT is(pg_temp.content('{"type":"text","text":{"body":"   "}}'), 'invalid|invalid_content|text|-|-', 'texto vazio: inválido');
SELECT is(pg_temp.content(jsonb_build_object('type', 'text', 'text', jsonb_build_object('body', repeat('a', 4097)))),
  'invalid|content_too_long|text|-|-', 'texto acima de 4096: content_too_long (retido, nunca cortado)');
SELECT is(pg_temp.content(jsonb_build_object('type', 'text', 'text', jsonb_build_object('body', repeat('a', 4096)))),
  'ok|-|text|' || repeat('a', 4096) || '|-', 'texto com exatamente 4096: ok');
SELECT is(pg_temp.content('{"type":"interactive","interactive":{"type":"list_reply","list_reply":{"id":"op_2","title":"Horários","description":"x"}}}'),
  'ok|-|interactive|Horários|op_2', 'lista: título como conteúdo, id escolhido');
SELECT is(pg_temp.content('{"type":"interactive","interactive":{"type":"button_reply","button_reply":{"id":"sim","title":"Sim"}}}'),
  'ok|-|interactive|Sim|sim', 'botão: título e id');
SELECT is(pg_temp.content('{"type":"interactive","interactive":{"type":"list_reply","list_reply":{"title":"Sem id"}}}'),
  'invalid|invalid_content|interactive|-|-', 'resposta de lista sem id: inválida');
SELECT is(pg_temp.content('{"type":"interactive","interactive":{"type":"nfm_reply","nfm_reply":{}}}'),
  'ok|-|interactive|[Mensagem recebida — formato não suportado]|-', 'outro interativo: marcador genérico, sem id');
SELECT is(pg_temp.content('{"type":"audio","audio":{"id":"1"}}'), 'ok|-|audio|[Áudio recebido — conteúdo indisponível no Antero]|-', 'áudio: marcador');
SELECT is(pg_temp.content('{"type":"image","image":{"id":"1","caption":" Meu pedido "}}'),
  E'ok|-|image|[Imagem recebida — conteúdo indisponível no Antero]\nMeu pedido|-', 'imagem: marcador + legenda');
SELECT is(pg_temp.content('{"type":"image","image":{"id":"1"}}'), 'ok|-|image|[Imagem recebida — conteúdo indisponível no Antero]|-', 'imagem sem legenda');
SELECT is(pg_temp.content('{"type":"video","video":{"id":"1"}}'), 'ok|-|video|[Vídeo recebido — conteúdo indisponível no Antero]|-', 'vídeo: marcador');
SELECT is(
  (SELECT char_length(content) || '|' || (content LIKE '[Documento recebido — conteúdo indisponível no Antero]' || E'\n' || 'bbb%')
   FROM public.webhook_message_content(jsonb_build_object('type', 'document', 'document', jsonb_build_object('caption', repeat('b', 5000))))),
  '4096|true', 'legenda longa: cortada para caber em 4096, marcador preservado'
);
SELECT is(pg_temp.content('{"type":"sticker","sticker":{"id":"1"}}'), 'ok|-|sticker|[Figurinha recebida — conteúdo indisponível no Antero]|-', 'figurinha: marcador');
SELECT is(pg_temp.content('{"type":"location","location":{"latitude":1,"longitude":2}}'), 'ok|-|location|[Localização recebida — conteúdo indisponível no Antero]|-', 'localização: marcador');
SELECT is(pg_temp.content('{"type":"button","button":{"text":"Quero","payload":"p"}}'), 'ok|-|button|[Mensagem recebida — formato não suportado]|-', 'resposta rápida de template: não suportada');
SELECT is(pg_temp.content('{"type":"contacts","contacts":[]}'), 'ok|-|contacts|[Mensagem recebida — formato não suportado]|-', 'contatos compartilhados: não suportado');
SELECT is(pg_temp.content('{"type":"unsupported"}'), 'ok|-|unsupported|[Mensagem recebida — formato não suportado]|-', 'unsupported da Meta: marcador genérico');
SELECT is(pg_temp.content('{"type":"reaction","reaction":{"emoji":"👍"}}'), 'ignored|reaction|reaction|-|-', 'reação: ignorada');
SELECT is(pg_temp.content('{"type":"system","system":{}}'), 'ignored|system|system|-|-', 'mensagem de sistema: ignorada');
SELECT is(pg_temp.content('{"type":"Texto!"}'), 'invalid|invalid_content|-|-|-', 'tipo fora do formato: inválido');
SELECT is(pg_temp.content('{"text":{"body":"sem tipo"}}'), 'invalid|invalid_content|-|-|-', 'sem tipo: inválido');

-- ---------------------------------------------------------------------------
-- 3) Porta do worker
-- ---------------------------------------------------------------------------
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.1', '5511988880001', jsonb_build_object('from_user_id', 'BR.111'))),
  jsonb_build_array(pg_temp.contact('5511988880001', 'BR.111', 'Maria 150')));
SELECT is(pg_temp.run('first', 'wamid.150.1'), 'created|-', 'mensagem nova: created');
SELECT is(pg_temp.r('first', 'organization_id')::uuid, pg_temp.id('org_a'), 'organização do canal do evento');
SELECT is(pg_temp.r('first', 'whatsapp_account_id')::uuid, pg_temp.id('acc_a1'), 'canal do evento');
SELECT is(
  (SELECT phone_number || '|' || coalesce(name, '-') || '|' || coalesce(whatsapp_user_id, '-') FROM public.contacts WHERE id = pg_temp.r('first', 'contact_id')::uuid),
  '+5511988880001|Maria 150|BR.111', 'contato pelo telefone, com o nome e o BSUID da notificação'
);
SELECT is(
  (SELECT direction || '|' || sender_type || '|' || message_type || '|' || content || '|' || delivery_status || '|' || provider_message_type
   FROM public.messages WHERE id = pg_temp.r('first', 'message_id')::uuid),
  'inbound|contact|text|Oi|delivered|text', 'mensagem recebida gravada com o tipo da Meta'
);
SELECT is(pg_temp.r('first', 'provider_time_status'), 'valid', 'horário da Meta válido');
SELECT is(
  (SELECT m.webhook_received_at = e.received_at AND m.provider_sent_at IS NOT NULL
   FROM public.messages m, public.webhook_events e WHERE m.id = pg_temp.r('first', 'message_id')::uuid AND e.id = pg_temp.ev('wamid.150.1')),
  true, 'chegada do webhook e horário da Meta preservados'
);
SELECT is((SELECT status::text FROM public.conversations WHERE id = pg_temp.r('first', 'conversation_id')::uuid), 'waiting', 'conversa nova aguardando');

SELECT is(pg_temp.run('first_again', 'wamid.150.1'), 'duplicate|-', 'mesma mensagem de novo: duplicate');
SELECT is(pg_temp.r('first_again', 'message_id'), pg_temp.r('first', 'message_id'), 'duplicate devolve a mensagem original');

-- Outra notificação (formatação diferente: outra chave) com o mesmo wamid.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.1')), NULL, 'reformatada');
SELECT isnt(pg_temp.ev('wamid.150.1'), (SELECT event_id FROM claims ORDER BY event_id LIMIT 1), 'a reentrega diferente virou outro evento');
SELECT is(pg_temp.run('other_event', 'wamid.150.1'), 'duplicate|-', 'mesmo wamid em outro evento: duplicate');
SELECT is((SELECT count(*)::int FROM public.messages WHERE external_message_id = 'wamid.150.1'), 1, 'uma única mensagem');

-- Evento com duas mensagens.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(
  pg_temp.msg('wamid.150.2a', '5511988880002', '{"text":{"body":"primeira"}}'),
  pg_temp.msg('wamid.150.2b', '5511988880002', '{"text":{"body":"segunda"}}')));
SELECT is(pg_temp.run('multi_a', 'wamid.150.2a') || ' ' || pg_temp.run('multi_b', 'wamid.150.2b'), 'created|- created|-', 'várias mensagens no mesmo evento');
SELECT ok((pg_temp.m('wamid.150.2a')).arrival_order < (pg_temp.m('wamid.150.2b')).arrival_order, 'ordem de chegada preservada');
SELECT is(pg_temp.r('multi_a', 'conversation_id'), pg_temp.r('multi_b', 'conversation_id'), 'mesma conversa');

-- Validações da reivindicação.
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.2a'), (SELECT claim_token FROM claims WHERE event_id = pg_temp.ev('wamid.150.1')), 'wamid.150.2a'),
  'WH001', NULL, 'token de outro evento: claim_lost'
);
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.2a'), (SELECT claim_token FROM claims WHERE event_id = pg_temp.ev('wamid.150.2a')), 'wamid.150.1'),
  'WH002', NULL, 'wamid de outro evento: message_not_in_event'
);
SELECT throws_ok('SELECT pg_temp.ingest_raw(999999999, gen_random_uuid(), ''x'')', 'P0002', NULL, 'evento inexistente');
SELECT throws_ok('SELECT pg_temp.ingest_raw(1, NULL, ''x'')', '22023', NULL, 'token ausente');
SELECT throws_ok('SELECT pg_temp.ingest_raw(1, gen_random_uuid(), '' wamid.x'')', '22023', NULL, 'wamid com espaço nas pontas');
SELECT throws_ok(format('SELECT pg_temp.ingest_raw(1, gen_random_uuid(), %L)', repeat('w', 257)), '22023', NULL, 'wamid acima de 256');

-- Prazo vencido: recusa; nova reivindicação ingere; o token antigo não serve mais.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.3', '5511988880003')));
INSERT INTO ids SELECT 'old_token', claim_token FROM claims WHERE event_id = pg_temp.ev('wamid.150.3');
UPDATE public.webhook_events SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = pg_temp.ev('wamid.150.3');
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.3'), pg_temp.id('old_token'), 'wamid.150.3'),
  'WH001', NULL, 'prazo vencido: claim_lost'
);
SELECT is((SELECT count(*)::int FROM public.messages WHERE external_message_id = 'wamid.150.3'), 0, 'nada gravado com prazo vencido');
SELECT pg_temp.receive('acc_a1', '[]'::jsonb, NULL, 'reclamar');
SELECT isnt((SELECT claim_token FROM claims WHERE event_id = pg_temp.ev('wamid.150.3')), pg_temp.id('old_token'), 'nova reivindicação, token novo');
SELECT is(pg_temp.run('reclaimed', 'wamid.150.3'), 'created|-', 'depois da nova reivindicação: created');
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.3'), pg_temp.id('old_token'), 'wamid.150.3'),
  'WH001', NULL, 'o token substituído não serve mais'
);

-- Evento já encerrado.
SELECT is(pg_temp.finish('wamid.150.2a'), 'processed', 'evento encerrado pelo worker');
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.2a'), (SELECT claim_token FROM claims WHERE event_id = pg_temp.ev('wamid.150.2a')), 'wamid.150.2a'),
  'WH001', NULL, 'evento processado: claim_lost'
);

-- Campo diferente de messages e canal development (montados como dono).
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.4', '5511988880004')));
UPDATE public.webhook_events SET field = 'account_update' WHERE id = pg_temp.ev('wamid.150.4');
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.4'), (SELECT claim_token FROM claims WHERE event_id = pg_temp.ev('wamid.150.4')), 'wamid.150.4'),
  'WH003', NULL, 'evento de outro campo: unsupported_field'
);
INSERT INTO public.webhook_events (dedupe_key, field, organization_id, whatsapp_account_id, payload, claim_token, claimed_until)
VALUES (sha256('150-dev'::bytea), 'messages', pg_temp.id('org_a'), pg_temp.id('acc_dev'),
        jsonb_build_object('field', 'messages', 'value', jsonb_build_object('messages', jsonb_build_array(pg_temp.msg('wamid.150.dev')))),
        '00000000-0000-4000-8000-000000000150', clock_timestamp() + interval '10 minutes');
SELECT throws_ok(
  format('SELECT pg_temp.ingest_raw(%s, %L, %L)', pg_temp.ev('wamid.150.dev'), '00000000-0000-4000-8000-000000000150', 'wamid.150.dev'),
  'WH004', NULL, 'canal development recusado nesta porta'
);

-- Situação atual: canal desconectado, organização suspensa, módulos desligados.
CREATE TEMP TABLE snapshot AS
SELECT (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.messages x) AS m,
       (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.contacts x) AS c,
       (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.conversations x) AS v,
       (SELECT count(*) FROM public.webhook_message_holds) AS h;
SELECT pg_temp.receive('acc_a2', jsonb_build_array(pg_temp.msg('wamid.150.5', '5511988880005')));
UPDATE public.whatsapp_accounts SET status = 'disconnected' WHERE id = pg_temp.id('acc_a2');
SELECT is(pg_temp.run('disconnected', 'wamid.150.5'), 'rejected|channel_disconnected', 'canal desconectado depois da chegada: rejected');
UPDATE public.whatsapp_accounts SET status = 'connected' WHERE id = pg_temp.id('acc_a2');
SELECT pg_temp.receive('acc_e1', jsonb_build_array(pg_temp.msg('wamid.150.6', '5511988880006')));
UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_e');
SELECT is(pg_temp.run('suspended', 'wamid.150.6'), 'rejected|organization_inactive', 'organização suspensa depois da chegada: rejected');
SELECT pg_temp.receive('acc_d1', jsonb_build_array(pg_temp.msg('wamid.150.7', '5511988880007')));
SELECT is(pg_temp.run('no_modules', 'wamid.150.7'), 'rejected|modules_disabled', 'sem Atendimento nem Automações: rejected');
-- Ids do evento diferentes dos do canal: impossível pelos fluxos normais (0014:
-- canal reconhecido por Phone Number ID + WABA, identidade imutável); montado
-- como dono, como o campo acima, sem desligar gatilho nem constraint.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.15', '5511988880015'), pg_temp.msg('wamid.150.16', '5511988880016')));
UPDATE public.webhook_events SET phone_number_id = '15500150099' WHERE id = pg_temp.ev('wamid.150.15');
SELECT is(pg_temp.run('mismatch_phone', 'wamid.150.15'), 'rejected|channel_mismatch', 'Phone Number ID do evento diferente do canal: rejected');
UPDATE public.webhook_events SET phone_number_id = '15500150001', waba_id = '25500150099' WHERE id = pg_temp.ev('wamid.150.16');
SELECT is(pg_temp.run('mismatch_waba', 'wamid.150.16'), 'rejected|channel_mismatch', 'WABA do evento diferente do canal: rejected');
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.8', '5511988880008', '{"type":"reaction","reaction":{"emoji":"👍"},"text":null}')));
SELECT is(pg_temp.run('reaction', 'wamid.150.8'), 'ignored|reaction', 'reação: ignored');
SELECT ok(
  (SELECT m = (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.messages x)
      AND c = (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.contacts x)
      AND v = (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.conversations x)
      AND h = (SELECT count(*) FROM public.webhook_message_holds)
   FROM snapshot),
  'recusas e reação não gravaram nada (mensagens, contatos, conversas, retenções)'
);
SELECT pg_temp.receive('acc_b1', jsonb_build_array(pg_temp.msg('wamid.150.9', '5511988880001')));
SELECT is(pg_temp.run('only_automations', 'wamid.150.9'), 'created|-', 'só Automações ligado: ingere');

-- ---------------------------------------------------------------------------
-- Isolamento entre organizações e canais
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.r('only_automations', 'organization_id')::uuid, pg_temp.id('org_b'), 'canal da Org B grava na Org B');
SELECT isnt(pg_temp.r('only_automations', 'contact_id'), pg_temp.r('first', 'contact_id'), 'mesmo telefone em outra organização: outro contato');
SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE phone_number = '+5511988880001' AND organization_id = pg_temp.id('org_b')
     AND whatsapp_user_id IS NULL),
  1, 'contato da Org B não herda o BSUID da Org A'
);
SELECT pg_temp.receive('acc_b1', jsonb_build_array(pg_temp.msg('wamid.150.14', '5511988880014', '{"from_user_id":"BR.111"}')));
SELECT is(pg_temp.run('bsuid_org_b', 'wamid.150.14'), 'created|-', 'o BSUID da Org A em outro telefone da Org B: sem conflito (escopo da organização)');
SELECT is((SELECT whatsapp_user_id FROM public.contacts WHERE id = pg_temp.r('bsuid_org_b', 'contact_id')::uuid), 'BR.111', 'contato da Org B com o BSUID');
SELECT pg_temp.receive('acc_a2', jsonb_build_array(pg_temp.msg('wamid.150.10', '5511988880001')));
SELECT is(pg_temp.run('second_channel', 'wamid.150.10'), 'created|-', 'mesmo telefone em outro canal da mesma organização');
SELECT is(pg_temp.r('second_channel', 'contact_id'), pg_temp.r('first', 'contact_id'), 'mesmo contato');
SELECT isnt(pg_temp.r('second_channel', 'conversation_id'), pg_temp.r('first', 'conversation_id'), 'outra conversa (uma por canal)');

-- ---------------------------------------------------------------------------
-- Tipos gravados
-- ---------------------------------------------------------------------------
SELECT pg_temp.receive('acc_a1', jsonb_build_array(
  pg_temp.msg('wamid.150.11', '5511988880011', '{"type":"interactive","text":null,"interactive":{"type":"list_reply","list_reply":{"id":"op_1","title":"Cardápio"}}}'),
  pg_temp.msg('wamid.150.12', '5511988880011', '{"type":"image","text":null,"image":{"id":"9","caption":"foto"}}')));
SELECT is(pg_temp.run('list', 'wamid.150.11'), 'created|-', 'resposta de lista ingerida');
SELECT is(
  (SELECT content || '|' || provider_message_type || '|' || interaction_reply_id || '|' || message_type FROM public.messages WHERE external_message_id = 'wamid.150.11'),
  'Cardápio|interactive|op_1|text', 'lista: título, tipo original e id escolhido'
);
SELECT is(pg_temp.run('image', 'wamid.150.12'), 'created|-', 'imagem ingerida como marcador');
SELECT is(
  (SELECT content || '|' || provider_message_type || '|' || (interaction_reply_id IS NULL) FROM public.messages WHERE external_message_id = 'wamid.150.12'),
  E'[Imagem recebida — conteúdo indisponível no Antero]\nfoto|image|true', 'imagem: marcador + legenda, tipo image'
);

-- Reabertura de conversa resolvida.
UPDATE public.conversations SET status = 'resolved', resolved_at = now() WHERE id = pg_temp.r('list', 'conversation_id')::uuid;
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.13', '5511988880011')));
SELECT is(pg_temp.run('reopen', 'wamid.150.13') || '|' || pg_temp.r('reopen', 'reopened'), 'created|-|true', 'mensagem nova reabre conversa resolvida');
SELECT is((SELECT status::text FROM public.conversations WHERE id = pg_temp.r('list', 'conversation_id')::uuid), 'waiting', 'conversa reaberta aguardando');

-- ---------------------------------------------------------------------------
-- 4) Retenções
-- ---------------------------------------------------------------------------
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.20', NULL, '{"from_user_id":"BR.220"}')),
  jsonb_build_array(jsonb_build_object('user_id', 'BR.220', 'profile', jsonb_build_object('name', 'Sem Telefone'))));
SELECT is(pg_temp.run('no_phone', 'wamid.150.20'), 'held|missing_phone', 'sem telefone: retida');
SELECT is(
  (SELECT status || '|' || provider_user_id || '|' || (message ->> 'id') || '|' || (contact #>> '{profile,name}') || '|' || (event_id = pg_temp.ev('wamid.150.20'))
   FROM public.webhook_message_holds WHERE wamid = 'wamid.150.20'),
  'held|BR.220|wamid.150.20|Sem Telefone|true', 'retenção guarda BSUID, elemento da mensagem, contato e evento'
);
SELECT ok(
  NOT EXISTS (SELECT 1 FROM public.contacts WHERE whatsapp_user_id = 'BR.220')
  AND NOT EXISTS (SELECT 1 FROM public.messages WHERE external_message_id = 'wamid.150.20'),
  'nenhum contato fictício nem mensagem'
);
SELECT is(pg_temp.run('no_phone_again', 'wamid.150.20') || '|' || pg_temp.r('no_phone_again', 'duplicate'), 'held|missing_phone|true', 'retida de novo: a mesma retenção');
SELECT is(pg_temp.r('no_phone_again', 'hold_id'), pg_temp.r('no_phone', 'hold_id'), 'mesmo id de retenção');
-- A mesma mensagem chega depois COM telefone: continua retida (sem recuperação automática).
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.20', '5511988880020')), NULL, 'com-telefone');
SELECT is(pg_temp.run('held_then_phone', 'wamid.150.20'), 'held|missing_phone', 'mensagem já retida não vira conversa por outro caminho');
SELECT is((SELECT count(*)::int FROM public.messages WHERE external_message_id = 'wamid.150.20'), 0, 'nem retida e criada ao mesmo tempo');

SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.21', '0123')));
SELECT is(pg_temp.run('bad_phone', 'wamid.150.21'), 'held|invalid_phone', 'telefone fora do E.164: retida');
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.22', '5511988880022', '{"text":{"body":"  "}}')));
SELECT is(pg_temp.run('bad_content', 'wamid.150.22'), 'held|invalid_content', 'texto vazio: retida');
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.23', '5511988880023', '{"from_user_id":"BR.231"}')),
  jsonb_build_array(pg_temp.contact('5511988880023', 'BR.232')));
SELECT is(pg_temp.run('self_conflict', 'wamid.150.23') || '|' || pg_temp.r('self_conflict', 'identity_note'), 'held|identity_conflict|bsuid_contradiction',
  'BSUID da mensagem diferente do contato da notificação: retida');
SELECT is(
  (SELECT message_storage || '|' || contact_storage || '|' || (message_original_bytes = octet_length(convert_to(message::text, 'UTF8')))
          || '|' || (message_sha256 = sha256(convert_to(message::text, 'UTF8')))
   FROM public.webhook_message_holds WHERE wamid = 'wamid.150.23'),
  'complete|complete|true|true', 'cópia completa: tamanho e sha256 do próprio elemento'
);

-- Mensagens extensas: `messages.content` continua com 4096; acima disso,
-- retida inteira (até 512 KiB), nunca cortada nem erro de constraint.
CREATE FUNCTION pg_temp.body_msg(p_wamid text, p_phone text, p_body text) RETURNS jsonb
LANGUAGE sql AS $$ SELECT pg_temp.msg(p_wamid, p_phone, jsonb_build_object('text', jsonb_build_object('body', p_body))) $$;
-- O elemento como está no evento (para comparar com a cópia da retenção).
CREATE FUNCTION pg_temp.element(p_wamid text) RETURNS jsonb
LANGUAGE sql AS $$
  SELECT m FROM public.webhook_events e, jsonb_array_elements(e.payload #> '{value,messages}') m
  WHERE e.id = pg_temp.ev(p_wamid) AND m ->> 'id' = p_wamid
$$;
SELECT pg_temp.receive('acc_a1', jsonb_build_array(
  pg_temp.body_msg('wamid.150.25', '5511988880025', repeat('a', 4096)),
  pg_temp.body_msg('wamid.150.26', '5511988880026', repeat('a', 4097)),
  pg_temp.body_msg('wamid.150.27', '5511988880027', repeat('a', 65536)),
  pg_temp.body_msg('wamid.150.28', '5511988880028', repeat('😀', 17000)),
  pg_temp.body_msg('wamid.150.29', '5511988880029', repeat('ç', 4096)),
  pg_temp.body_msg('wamid.150.35', '5511988880035', repeat('ç', 4097))));
SELECT is(pg_temp.run('len_4096', 'wamid.150.25'), 'created|-', 'texto com exatamente 4096: ingerido');
SELECT is(char_length((pg_temp.m('wamid.150.25')).content), 4096, 'conteúdo inteiro (4096)');
SELECT is(pg_temp.run('len_4097', 'wamid.150.26'), 'held|content_too_long', '4097 caracteres: retida');
SELECT is(pg_temp.run('len_65536', 'wamid.150.27'), 'held|content_too_long', '65.536 caracteres ASCII: retida, sem 23514');
SELECT is(pg_temp.run('emoji_17000', 'wamid.150.28'), 'held|content_too_long', '17.000 emojis (≈68 KB): retida, sem 23514');
SELECT is(pg_temp.run('mb_4096', 'wamid.150.29'), 'created|-', 'multibyte: o limite é de caracteres (4096 ç entram)');
SELECT is(pg_temp.run('mb_4097', 'wamid.150.35'), 'held|content_too_long', 'multibyte: 4097 ç retida');
SELECT is(
  (SELECT string_agg(wamid || '=' || message_storage || ':' || (message = pg_temp.element(wamid)), ',' ORDER BY wamid)
   FROM public.webhook_message_holds WHERE wamid IN ('wamid.150.26', 'wamid.150.27', 'wamid.150.28', 'wamid.150.35')),
  'wamid.150.26=complete:true,wamid.150.27=complete:true,wamid.150.28=complete:true,wamid.150.35=complete:true',
  'mensagens extensas retidas INTEIRAS (elemento idêntico ao do evento)'
);
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE external_message_id IN ('wamid.150.26', 'wamid.150.27', 'wamid.150.28', 'wamid.150.35')),
  0, 'nenhum conteúdo cortado virou mensagem'
);
SELECT is(pg_temp.run('len_65536_again', 'wamid.150.27') || '|' || pg_temp.r('len_65536_again', 'duplicate'), 'held|content_too_long|true',
  'reentrega da mensagem extensa: a mesma retenção');
SELECT is(pg_temp.r('len_65536_again', 'hold_id'), pg_temp.r('len_65536', 'hold_id'), 'mesmo id de retenção');

-- Limite da cópia (512 KiB, medido como a constraint: pg_column_size).
CREATE TEMP TABLE near_limit AS
SELECT 524288 - pg_column_size(pg_temp.body_msg('wamid.150.36', '5511988880036', '')) AS n;
SELECT pg_temp.receive('acc_a1', jsonb_build_array(
  pg_temp.body_msg('wamid.150.36', '5511988880036', repeat('b', (SELECT n FROM near_limit))),
  pg_temp.body_msg('wamid.150.37', '5511988880037', repeat('b', (SELECT n FROM near_limit) + 1))));
SELECT is(pg_column_size(pg_temp.element('wamid.150.36')), 524288, 'elemento exatamente no limite');
SELECT is(pg_temp.run('at_limit', 'wamid.150.36'), 'held|content_too_long', 'no limite: retida');
SELECT is((pg_temp.hold('wamid.150.36')).message_storage, 'complete', 'no limite: cópia completa');
SELECT is(pg_column_size(pg_temp.element('wamid.150.37')), 524289, 'elemento 1 byte acima do limite');
SELECT is(pg_temp.run('over_limit', 'wamid.150.37'), 'held|content_too_long', 'acima do limite: retida, sem 23514');
SELECT is(
  (SELECT message_storage || '|' || (message ->> 'id') || '|' || (message ->> 'from') || '|' || (message ->> 'type') || '|'
          || char_length(message ->> 'text_body_prefix') || '|' || (message ? 'text')
   FROM public.webhook_message_holds WHERE wamid = 'wamid.150.37'),
  'size_limited|wamid.150.37|5511988880037|text|4096|false', 'cópia limitada: identificação e começo do texto, marcada como incompleta'
);
SELECT is(
  (SELECT (message_original_bytes = octet_length(convert_to(pg_temp.element('wamid.150.37')::text, 'UTF8')))
          || '|' || (message_sha256 = sha256(convert_to(pg_temp.element('wamid.150.37')::text, 'UTF8')))
          || '|' || (message_original_bytes > pg_column_size(message))
   FROM public.webhook_message_holds WHERE wamid = 'wamid.150.37'),
  'true|true|true', 'cópia limitada guarda tamanho e sha256 do ORIGINAL'
);
SELECT is(
  (SELECT outcome || '|' || reason FROM public.webhook_message_content((pg_temp.hold('wamid.150.37')).message)),
  'invalid|invalid_content', 'cópia limitada não é lida como mensagem (fora do formato da Meta)'
);
-- Contato acima de 16 KiB numa retenção: cópia limitada do contato.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.38', NULL, '{"from_user_id":"BR.238"}')),
  jsonb_build_array(jsonb_build_object('user_id', 'BR.238', 'profile', jsonb_build_object('name', repeat('n', 20000)))));
SELECT is(pg_temp.run('big_contact', 'wamid.150.38'), 'held|missing_phone', 'contato enorme: retida, sem 23514');
SELECT is(
  (SELECT contact_storage || '|' || (contact ->> 'user_id') || '|' || char_length(contact ->> 'profile_name_prefix') || '|'
          || (contact_original_bytes > 16384) || '|' || message_storage
   FROM public.webhook_message_holds WHERE wamid = 'wamid.150.38'),
  'size_limited|BR.238|256|true|complete', 'contato limitado e marcado; a mensagem continua completa'
);
SELECT throws_ok($$SELECT * FROM public.webhook_hold_copy('message', '[]')$$, '22023', NULL, 'cópia só de objeto');
SELECT throws_ok($$SELECT * FROM public.webhook_hold_copy('outro', '{}')$$, '22023', NULL, 'cópia só de message/contact');
-- A purga do evento não leva a mensagem extensa.
SELECT is(pg_temp.finish('wamid.150.27'), 'processed', 'evento da mensagem extensa encerrado');
SELECT lives_ok(format('DELETE FROM public.webhook_events WHERE id = %s', pg_temp.ev('wamid.150.27')), 'evento da mensagem extensa apagado');
SELECT is(
  (SELECT (event_id IS NULL) || '|' || message_storage || '|' || char_length(message #>> '{text,body}') FROM public.webhook_message_holds WHERE wamid = 'wamid.150.27'),
  'true|complete|65536', 'mensagem extensa sobrevive inteira à exclusão do evento'
);

-- Consistência da retenção (FKs compostas) e retenção depois do evento.
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, event_id, wamid, reason, webhook_received_at, message, message_original_bytes, message_sha256)
            VALUES (%L, %L, %s, 'x.cross', 'missing_phone', now(), '{}', 2, sha256('{}'))$q$,
         pg_temp.id('org_b'), pg_temp.id('acc_a1'), pg_temp.ev('wamid.150.20')),
  '23503', NULL, 'retenção não liga organização a canal de outra'
);
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, event_id, wamid, reason, webhook_received_at, message, message_original_bytes, message_sha256)
            VALUES (%L, %L, %s, 'x.cross2', 'missing_phone', now(), '{}', 2, sha256('{}'))$q$,
         pg_temp.id('org_b'), pg_temp.id('acc_b1'), pg_temp.ev('wamid.150.20')),
  '23503', NULL, 'retenção não aponta para evento de outra organização'
);
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, wamid, reason, status, resolved_at, resolved_message_id, webhook_received_at, message, message_original_bytes, message_sha256)
            VALUES (%L, %L, 'x.cross3', 'missing_phone', 'resolved', now(), %L, now(), '{}', 2, sha256('{}'))$q$,
         pg_temp.id('org_a'), pg_temp.id('acc_a2'), pg_temp.r('first', 'message_id')),
  '23503', NULL, 'retenção resolvida não aponta para mensagem de outro canal'
);
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, wamid, reason, status, webhook_received_at, message, message_original_bytes, message_sha256)
            VALUES (%L, %L, 'x.state', 'missing_phone', 'resolved', now(), '{}', 2, sha256('{}'))$q$, pg_temp.id('org_a'), pg_temp.id('acc_a1')),
  '23514', NULL, 'resolvida exige data de resolução'
);
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, wamid, reason, webhook_received_at, message, message_original_bytes, message_sha256)
            VALUES (%L, %L, 'x.reason', 'outro_motivo', now(), '{}', 2, sha256('{}'))$q$, pg_temp.id('org_a'), pg_temp.id('acc_a1')),
  '23514', NULL, 'motivo fora da lista'
);
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, wamid, reason, webhook_received_at, message, message_original_bytes, message_sha256)
            VALUES (%L, %L, 'x.big', 'missing_phone', now(), jsonb_build_object('b', repeat('x', 600000)), 600010, sha256('x'))$q$, pg_temp.id('org_a'), pg_temp.id('acc_a1')),
  '23514', NULL, 'a constraint de 512 KiB continua valendo (última defesa)'
);
SELECT throws_ok(
  format($q$INSERT INTO public.webhook_message_holds (organization_id, whatsapp_account_id, wamid, reason, webhook_received_at, message, message_original_bytes, message_sha256, contact)
            VALUES (%L, %L, 'x.contact', 'missing_phone', now(), '{}', 2, sha256('{}'), '{}')$q$, pg_temp.id('org_a'), pg_temp.id('acc_a1')),
  '23514', NULL, 'contato exige modo de cópia e tamanho original'
);
-- Futura purga: o evento encerrado pode ser apagado; a retenção fica, sem o evento.
SELECT is(pg_temp.finish('wamid.150.21'), 'processed', 'evento da retenção encerrado');
SELECT lives_ok(format('DELETE FROM public.webhook_events WHERE id = %s AND status <> %L', pg_temp.ev('wamid.150.21'), 'received'),
  'evento encerrado com retenção pode ser apagado (purga viável)');
SELECT is(
  (SELECT (event_id IS NULL) || '|' || status || '|' || (message ->> 'from') FROM public.webhook_message_holds WHERE wamid = 'wamid.150.21'),
  'true|held|0123', 'retenção sobrevive ao evento, com a cópia da mensagem'
);
-- Apagar a organização leva as retenções dela.
SELECT pg_temp.receive('acc_b1', jsonb_build_array(pg_temp.msg('wamid.150.24', NULL)));
SELECT is(pg_temp.run('hold_b', 'wamid.150.24'), 'held|missing_phone', 'retenção na Org B');
SELECT lives_ok(format('DELETE FROM public.organizations WHERE id = %L', pg_temp.id('org_b')), 'organização com retenções e eventos pode ser apagada');
SELECT is((SELECT count(*)::int FROM public.webhook_message_holds WHERE wamid = 'wamid.150.24'), 0, 'retenções da organização apagada somem junto');
SELECT throws_ok(
  $$SELECT pg_temp.app_count(pg_temp.id('a_owner'), 'SELECT 1 FROM public.webhook_message_holds')$$,
  '42501', NULL, 'owner da organização NÃO lê retenções'
);

-- ---------------------------------------------------------------------------
-- 5) BSUID
-- ---------------------------------------------------------------------------
-- Contatos da Org A antes dos conflitos: nenhum conflito altera um contato existente.
CREATE TEMP TABLE contacts_before AS
SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) AS h FROM public.contacts x WHERE x.organization_id = pg_temp.id('org_a');
-- Telefone com o MESMO BSUID já gravado: compatível, ingestão normal.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.39', '5511988880001', '{"from_user_id":"BR.111"}')));
SELECT is(pg_temp.run('bsuid_same', 'wamid.150.39') || '|' || coalesce(pg_temp.r('bsuid_same', 'identity_note'), '-'), 'created|-|-', 'mesmo telefone, mesmo BSUID: ingere');
SELECT is(pg_temp.r('bsuid_same', 'contact_id'), pg_temp.r('first', 'contact_id'), 'no contato do telefone');
-- O BSUID BR.111 já é do contato +5511988880001: outro telefone com ele é retido.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.30', '5511988880030', '{"from_user_id":"BR.111"}')));
SELECT is(pg_temp.run('bsuid_taken', 'wamid.150.30') || '|' || pg_temp.r('bsuid_taken', 'identity_note'), 'held|identity_conflict|bsuid_in_use', 'BSUID de outro contato: retida');
SELECT is((SELECT count(*)::int FROM public.contacts WHERE phone_number = '+5511988880030'), 0, 'nenhum contato criado no conflito');
-- O telefone já tem OUTRO BSUID: política conservadora, retida (não entra no histórico).
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.31', '5511988880001', '{"from_user_id":"BR.999"}')));
SELECT is(pg_temp.run('bsuid_other', 'wamid.150.31') || '|' || pg_temp.r('bsuid_other', 'identity_note'), 'held|identity_conflict|bsuid_mismatch',
  'BSUID diferente no mesmo telefone: retida por identity_conflict');
SELECT is((SELECT count(*)::int FROM public.messages WHERE external_message_id = 'wamid.150.31'), 0, 'nada no histórico do contato do telefone');
SELECT is((SELECT whatsapp_user_id FROM public.contacts WHERE id = pg_temp.r('first', 'contact_id')::uuid), 'BR.111', 'BSUID existente não é sobrescrito');
SELECT is((pg_temp.hold('wamid.150.31')).provider_user_id, 'BR.999', 'o BSUID recebido fica na retenção (não é descartado)');
SELECT is(pg_temp.run('bsuid_other_again', 'wamid.150.31') || '|' || pg_temp.r('bsuid_other_again', 'duplicate'), 'held|identity_conflict|true', 'reentrega do conflito: a mesma retenção');
SELECT is(
  (SELECT md5(string_agg(to_jsonb(x)::text, '' ORDER BY x.id)) FROM public.contacts x WHERE x.organization_id = pg_temp.id('org_a')),
  (SELECT h FROM contacts_before), 'conflitos não alteram nenhum contato existente (nome, telefone, BSUID)'
);
-- Mensagem SEM BSUID para um telefone com BSUID: comportamento anterior (telefone).
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.34', '5511988880001')));
SELECT is(pg_temp.run('no_bsuid', 'wamid.150.34'), 'created|-', 'sem BSUID: ingere pelo telefone');
SELECT is(pg_temp.r('no_bsuid', 'contact_id'), pg_temp.r('first', 'contact_id'), 'no contato do telefone, sem unir contatos');
-- Contato existente com o campo vazio: recebe o BSUID (não é sobrescrita).
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.32', '5511988880002', '{"from_user_id":"BR.322"}')));
SELECT is(pg_temp.run('bsuid_existing', 'wamid.150.32'), 'created|-', 'contato existente: ingere');
SELECT is((SELECT whatsapp_user_id FROM public.contacts WHERE id = pg_temp.r('multi_a', 'contact_id')::uuid), 'BR.322', 'contato existente sem BSUID recebe o primeiro (campo vazio)');
-- Formato fora do documentado: descartado, mensagem entra.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.33', '5511988880033', '{"from_user_id":"BR-1/2"}')));
SELECT is(pg_temp.run('bsuid_bad', 'wamid.150.33') || '|' || pg_temp.r('bsuid_bad', 'identity_note'), 'created|-|bsuid_invalid', 'BSUID inválido: ingere sem ele');
SELECT is((SELECT whatsapp_user_id FROM public.contacts WHERE id = pg_temp.r('bsuid_bad', 'contact_id')::uuid), NULL, 'contato sem BSUID inválido');
SELECT throws_ok(
  format('UPDATE public.contacts SET whatsapp_user_id = %L WHERE id = %L', 'BR 1', pg_temp.r('bsuid_bad', 'contact_id')),
  '23514', NULL, 'formato do BSUID conferido na coluna'
);

-- ---------------------------------------------------------------------------
-- 6) Horário da Meta e janela de 24 h
-- ---------------------------------------------------------------------------
SELECT pg_temp.receive('acc_a1', jsonb_build_array(
  pg_temp.msg('wamid.150.40', '5511988880040', '{"timestamp":null}'),
  pg_temp.msg('wamid.150.41', '5511988880041', '{"timestamp":"ontem"}'),
  pg_temp.msg('wamid.150.42', '5511988880042', jsonb_build_object('timestamp', pg_temp.ts('10 minutes'))),
  pg_temp.msg('wamid.150.43', '5511988880043', jsonb_build_object('timestamp', pg_temp.ts('2 minutes'))),
  pg_temp.msg('wamid.150.44', '5511988880044', jsonb_build_object('timestamp', pg_temp.ts('-31 days'))),
  pg_temp.msg('wamid.150.45', '5511988880045', jsonb_build_object('timestamp', pg_temp.ts('-25 hours'))),
  pg_temp.msg('wamid.150.46', '5511988880046', jsonb_build_object('timestamp', pg_temp.ts('-1 hour')))));
SELECT is(pg_temp.run('t_missing', 'wamid.150.40') || '|' || pg_temp.r('t_missing', 'provider_time_status'), 'created|-|missing', 'sem horário: ingere, missing');
SELECT is(pg_temp.run('t_invalid', 'wamid.150.41') || '|' || pg_temp.r('t_invalid', 'provider_time_status'), 'created|-|invalid', 'horário inválido: ingere, invalid');
SELECT is(pg_temp.run('t_future', 'wamid.150.42') || '|' || pg_temp.r('t_future', 'provider_time_status'), 'created|-|out_of_range', 'horário 10 min no futuro: out_of_range');
SELECT is(pg_temp.run('t_skew', 'wamid.150.43') || '|' || pg_temp.r('t_skew', 'provider_time_status'), 'created|-|valid', 'horário 2 min no futuro (relógio): valid');
SELECT is(pg_temp.run('t_old', 'wamid.150.44') || '|' || pg_temp.r('t_old', 'provider_time_status'), 'created|-|out_of_range', 'horário de 31 dias atrás: out_of_range');
SELECT is(pg_temp.run('t_late', 'wamid.150.45') || '|' || pg_temp.r('t_late', 'provider_time_status'), 'created|-|valid', 'mensagem atrasada (25 h): valid');
SELECT is(pg_temp.run('t_ok', 'wamid.150.46'), 'created|-', 'mensagem de 1 h atrás');
SELECT is(
  (SELECT string_agg(external_message_id || '=' || (provider_sent_at IS NULL), ',' ORDER BY external_message_id)
   FROM public.messages WHERE external_message_id IN ('wamid.150.40', 'wamid.150.41', 'wamid.150.42', 'wamid.150.44')),
  'wamid.150.40=true,wamid.150.41=true,wamid.150.42=true,wamid.150.44=true', 'horário não confiável não é gravado'
);
SELECT ok((pg_temp.m('wamid.150.45')).provider_sent_at < now() - interval '24 hours', 'horário original da Meta preservado na mensagem atrasada');
SELECT ok(
  (SELECT last_message_at >= now() FROM public.conversations WHERE id = pg_temp.r('t_late', 'conversation_id')::uuid),
  'mensagem atrasada não faz a conversa regredir na Inbox (last_message_at = chegada)'
);
-- Janela: só horário válido da Meta abre; nunca além da chegada.
SELECT is(pg_temp.take_and_reply(pg_temp.r('t_ok', 'conversation_id')::uuid), 'pending', 'horário válido recente: janela aberta');
SELECT throws_ok(format('SELECT pg_temp.take_and_reply(%L)', pg_temp.r('t_missing', 'conversation_id')), 'AT004', NULL, 'sem horário: não abre janela');
SELECT throws_ok(format('SELECT pg_temp.take_and_reply(%L)', pg_temp.r('t_invalid', 'conversation_id')), 'AT004', NULL, 'horário inválido: não abre janela');
SELECT throws_ok(format('SELECT pg_temp.take_and_reply(%L)', pg_temp.r('t_future', 'conversation_id')), 'AT004', NULL, 'horário futuro demais: não abre janela');
SELECT throws_ok(format('SELECT pg_temp.take_and_reply(%L)', pg_temp.r('t_late', 'conversation_id')), 'AT004', NULL, 'atrasada de 25 h: vale o horário da Meta, janela fechada');
SELECT is(pg_temp.take_and_reply(pg_temp.r('t_skew', 'conversation_id')::uuid), 'pending', 'relógio adiantado: janela pela chegada');
SELECT is(
  (SELECT least(provider_sent_at, webhook_received_at) = webhook_received_at FROM public.messages WHERE external_message_id = 'wamid.150.43'),
  true, 'horário adiantado limitado à chegada do webhook'
);

-- Fora de ordem: a recente chega antes, a antiga depois; vale a maior.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.50', '5511988880050', jsonb_build_object('timestamp', pg_temp.ts('-1 hour')))));
SELECT is(pg_temp.run('ooo_recent', 'wamid.150.50'), 'created|-', 'recente chega primeiro');
SELECT pg_temp.receive('acc_a1', jsonb_build_array(pg_temp.msg('wamid.150.51', '5511988880050', jsonb_build_object('timestamp', pg_temp.ts('-30 hours')))));
SELECT is(pg_temp.run('ooo_old', 'wamid.150.51'), 'created|-', 'antiga chega depois da recente');
SELECT ok((pg_temp.m('wamid.150.50')).arrival_order < (pg_temp.m('wamid.150.51')).arrival_order, 'fila e Inbox seguem a chegada');
SELECT is(pg_temp.take_and_reply(pg_temp.r('ooo_recent', 'conversation_id')::uuid), 'pending', 'mensagem antiga tardia não encurta a janela');

-- Evento processado muito depois da chegada: o horário é conferido contra a chegada.
SELECT pg_temp.receive('acc_a1', jsonb_build_array(
  pg_temp.msg('wamid.150.60', '5511988880060', jsonb_build_object('timestamp', pg_temp.ts('-40 days'))),
  pg_temp.msg('wamid.150.61', '5511988880061', jsonb_build_object('timestamp', pg_temp.ts()))));
UPDATE public.webhook_events SET received_at = clock_timestamp() - interval '35 days' WHERE id = pg_temp.ev('wamid.150.60');
SELECT is(pg_temp.run('slow_old', 'wamid.150.60') || '|' || pg_temp.r('slow_old', 'provider_time_status'), 'created|-|valid',
  'horário 40 dias atrás, chegada 35 dias atrás: valid pela chegada (não pelo processamento)');
SELECT is(pg_temp.run('slow_new', 'wamid.150.61') || '|' || pg_temp.r('slow_new', 'provider_time_status'), 'created|-|out_of_range',
  'horário de agora com chegada há 35 dias: out_of_range');
SELECT ok(
  (SELECT webhook_received_at < now() - interval '34 days' AND created_at >= now() FROM public.messages WHERE external_message_id = 'wamid.150.61'),
  'chegada do webhook preservada, diferente do processamento'
);
SELECT throws_ok(format('SELECT pg_temp.take_and_reply(%L)', pg_temp.r('slow_old', 'conversation_id')), 'AT004', NULL, 'evento antigo processado agora não abre janela');

-- Canal development: regra anterior (created_at), simulador inalterado.
SELECT is(pg_temp.sim('+5511988880070', 'oi dev', 'sim-in-150-1'), 'true|false', 'simulador continua ingerindo');
SELECT is(
  (SELECT (provider_message_type IS NULL AND provider_sent_at IS NULL AND webhook_received_at IS NULL AND interaction_reply_id IS NULL)
   FROM public.messages WHERE external_message_id = 'sim-in-150-1'),
  true, 'mensagem do simulador sem campos da Meta'
);
SELECT is(pg_temp.take_and_reply((pg_temp.m('sim-in-150-1')).conversation_id), 'pending', 'canal development: janela por created_at, como antes');
SELECT throws_ok(
  format('UPDATE public.messages SET provider_message_type = %L WHERE external_message_id = %L', 'text', 'sim-in-150-1'),
  '23514', NULL, 'tipo da Meta exige a chegada do webhook'
);
SELECT throws_ok(
  format('UPDATE public.messages SET interaction_reply_id = %L WHERE external_message_id = %L', 'x', 'wamid.150.46'),
  '23514', NULL, 'id de resposta só em mensagem interativa'
);

SELECT * FROM finish();
ROLLBACK;

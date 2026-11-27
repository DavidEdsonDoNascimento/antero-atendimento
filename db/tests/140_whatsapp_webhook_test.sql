-- Antero Atendimentos — Entrega E2B-1: canal Cloud API e eventos do webhook (0014).
--
-- 1) Estrutura, RLS e privilégios: antero_worker só executa as três funções
--    `webhook_*`; antero_app e antero_auth não leem os eventos nem executam nada.
-- 2) Regras do canal cloud_api: ids numéricos, Phone Number ID único entre
--    organizações, WABA de uma só organização, identidade imutável.
-- 3) Registro como antero_worker: organização só pelo canal registrado (Phone
--    Number ID + WABA), rejeições com motivo, duplicidade, lote com várias
--    organizações, estrutura inválida, nada alterado fora de webhook_events.
-- 4) Fila: reivindicação por prazo, token, retry, prazo vencido, tentativas.
-- Concorrência (duas conexões): tests/db/whatsapp-webhook.test.ts.
BEGIN;
\ir lib/helpers.psql
SELECT plan(104);

-- Estado limpo dentro desta transação (desfeito no ROLLBACK).
DELETE FROM public.webhook_events;

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-140'), ('Org B', 'org-b-140');
INSERT INTO public.organizations (name, slug, status) VALUES ('Org C', 'org-c-140', 'inactive');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-140';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-140';
INSERT INTO ids SELECT 'org_c', id FROM public.organizations WHERE slug = 'org-c-140';

SELECT pg_temp.new_user('a_owner', 'a.owner.140@teste.local', 'A Owner');
SELECT pg_temp.new_user('platform', 'platform.140@teste.local', 'Plataforma');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active');

INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, external_business_account_id) VALUES
  (pg_temp.id('org_a'), 'cloud_api', 'connected', 'A1 140', '15550001001', '25550001001'),
  (pg_temp.id('org_a'), 'cloud_api', 'connected', 'A2 140', '15550001002', '25550001001'),
  (pg_temp.id('org_a'), 'cloud_api', 'disconnected', 'A3 140', '15550001003', '25550001001'),
  (pg_temp.id('org_a'), 'development', 'connected', 'A dev 140', NULL, NULL),
  (pg_temp.id('org_b'), 'cloud_api', 'connected', 'B1 140', '15550002001', '25550002001'),
  (pg_temp.id('org_c'), 'cloud_api', 'connected', 'C1 140', '15550003001', '25550003001');
INSERT INTO ids SELECT 'acc_a1', id FROM public.whatsapp_accounts WHERE display_name = 'A1 140';
INSERT INTO ids SELECT 'acc_a3', id FROM public.whatsapp_accounts WHERE display_name = 'A3 140';
INSERT INTO ids SELECT 'acc_dev', id FROM public.whatsapp_accounts WHERE display_name = 'A dev 140';
INSERT INTO ids SELECT 'acc_b1', id FROM public.whatsapp_accounts WHERE display_name = 'B1 140';
INSERT INTO ids SELECT 'acc_c1', id FROM public.whatsapp_accounts WHERE display_name = 'C1 140';

-- Notificação sintética no formato da Meta (dados fictícios).
CREATE FUNCTION pg_temp.change(p_phone text, p_wamid text, p_field text DEFAULT 'messages') RETURNS jsonb
LANGUAGE sql AS $$
  SELECT jsonb_build_object('field', p_field, 'value', jsonb_build_object(
    'messaging_product', 'whatsapp',
    'metadata', jsonb_build_object('display_phone_number', '15550000000', 'phone_number_id', p_phone),
    'contacts', jsonb_build_array(jsonb_build_object('wa_id', '5511999990000', 'profile', jsonb_build_object('name', 'Cliente Ficticio'))),
    'messages', jsonb_build_array(jsonb_build_object(
      'from', '5511999990000', 'id', p_wamid, 'timestamp', '1763550000', 'type', 'text',
      'text', jsonb_build_object('body', 'Oi')))))
$$;
CREATE FUNCTION pg_temp.entry(p_waba text, VARIADIC p_changes jsonb[]) RETURNS jsonb
LANGUAGE sql AS $$ SELECT jsonb_build_object('id', p_waba, 'changes', to_jsonb(p_changes)) $$;
CREATE FUNCTION pg_temp.delivery(VARIADIC p_entries jsonb[]) RETURNS jsonb
LANGUAGE sql AS $$ SELECT jsonb_build_object('object', 'whatsapp_business_account', 'entry', to_jsonb(p_entries)) $$;

-- Chamadas como antero_worker (sem contexto de usuário), como o webhook fará.
CREATE FUNCTION pg_temp.record(p_payload jsonb) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.become('antero_worker', NULL);
  SELECT received || '|' || rejected || '|' || duplicates INTO v FROM public.webhook_record_delivery(p_payload);
  PERFORM pg_temp.unbecome();
  RETURN v;
END;
$$;
CREATE TEMP TABLE claimed (event_id bigint, claim_token uuid, organization_id uuid, whatsapp_account_id uuid, attempts integer);
CREATE FUNCTION pg_temp.claim(p_limit integer DEFAULT 50, p_lease integer DEFAULT 60) RETURNS integer
LANGUAGE plpgsql AS $$
DECLARE
  v jsonb;
  n integer;
BEGIN
  DELETE FROM claimed;
  -- O worker não grava na tabela temporária: guarda o resultado e grava depois.
  PERFORM pg_temp.become('antero_worker', NULL);
  SELECT coalesce(jsonb_agg(to_jsonb(c)), '[]') INTO v FROM public.webhook_claim_events(p_limit, p_lease) c;
  PERFORM pg_temp.unbecome();
  INSERT INTO claimed
  SELECT * FROM jsonb_to_recordset(v) AS r(event_id bigint, claim_token uuid, organization_id uuid, whatsapp_account_id uuid, attempts integer);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
CREATE FUNCTION pg_temp.finish(p_event bigint, p_token uuid, p_outcome text, p_reason text DEFAULT NULL) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v text;
BEGIN
  PERFORM pg_temp.become('antero_worker', NULL);
  v := public.webhook_finish_event(p_event, p_token, p_outcome, p_reason)::text;
  PERFORM pg_temp.unbecome();
  RETURN v;
END;
$$;
-- O evento de uma mensagem (wamid) numa linha legível.
CREATE FUNCTION pg_temp.event_of(p_wamid text) RETURNS text
LANGUAGE sql AS $$
  SELECT status || '|' || coalesce(reason, '-') || '|' || coalesce(organization_id::text, '-') || '|'
         || coalesce(whatsapp_account_id::text, '-') || '|' || (finished_at IS NOT NULL)
  FROM public.webhook_events WHERE payload #>> '{value,messages,0,id}' = p_wamid
$$;
CREATE FUNCTION pg_temp.id_of(p_wamid text) RETURNS bigint
LANGUAGE sql AS $$ SELECT id FROM public.webhook_events WHERE payload #>> '{value,messages,0,id}' = p_wamid $$;
CREATE FUNCTION pg_temp.total() RETURNS bigint LANGUAGE sql AS $$ SELECT count(*) FROM public.webhook_events $$;

CREATE TEMP VIEW our_functions AS
SELECT p.oid, n.nspname || '.' || p.oid::regprocedure::text AS signature
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname IN ('public', 'app', 'auth')
  AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e');

-- ---------------------------------------------------------------------------
-- 1) Estrutura, RLS e privilégios
-- ---------------------------------------------------------------------------
SELECT has_table('public', 'webhook_events', 'tabela webhook_events existe');
SELECT ok((SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_events'::regclass), 'RLS habilitada');
SELECT policies_are('public', 'webhook_events', ARRAY[]::name[], 'sem nenhuma política: nenhum papel da aplicação lê pela RLS');
SELECT table_privs_are('public', 'webhook_events', 'antero_app', ARRAY[]::text[], 'antero_app sem acesso aos eventos brutos');
SELECT table_privs_are('public', 'webhook_events', 'antero_auth', ARRAY[]::text[], 'antero_auth sem acesso');
SELECT table_privs_are('public', 'webhook_events', 'antero_worker', ARRAY[]::text[], 'antero_worker sem acesso direto (só pelas funções)');
SELECT ok(NOT has_table_privilege('public', 'public.webhook_events', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE'), 'PUBLIC sem acesso');
SELECT is((SELECT attidentity::text FROM pg_attribute WHERE attrelid = 'public.webhook_events'::regclass AND attname = 'id'), 'a', 'id é GENERATED ALWAYS');
SELECT has_index('public', 'webhook_events', 'webhook_events_pending_idx', 'índice da fila (pendentes)');
SELECT has_index('public', 'webhook_events', 'webhook_events_finished_idx', 'índice da retenção (finalizados)');
SELECT has_index('public', 'whatsapp_accounts', 'whatsapp_accounts_cloud_api_phone_number_id_key', 'Phone Number ID único (cloud_api)');
SELECT has_trigger('public', 'whatsapp_accounts', 'whatsapp_accounts_channel_rules', 'gatilho das regras do canal');
SELECT enum_has_labels('public', 'webhook_event_status', ARRAY['received', 'processed', 'rejected', 'failed'], 'estados do evento');

SELECT set_eq(
  $$SELECT signature FROM our_functions WHERE has_function_privilege('antero_worker', oid, 'EXECUTE')$$,
  ARRAY['public.webhook_record_delivery(jsonb)', 'public.webhook_claim_events(integer,integer)',
        'public.webhook_finish_event(bigint,uuid,text,text)', 'public.webhook_ingest_message(bigint,uuid,text)'],
  'antero_worker executa SÓ as quatro funções do webhook (a quarta, de ingestão, é da E2B-2a)'
);
SELECT is(
  (SELECT count(*)::int FROM our_functions
   WHERE signature LIKE 'public.webhook\_%' AND (has_function_privilege('antero_app', oid, 'EXECUTE') OR has_function_privilege('antero_auth', oid, 'EXECUTE'))),
  0,
  'antero_app e antero_auth não executam nenhuma função do webhook'
);
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants WHERE grantee = 'antero_worker'),
  0,
  'antero_worker não tem privilégio em nenhuma tabela'
);
SELECT is((SELECT rolbypassrls FROM pg_roles WHERE rolname = 'antero_worker'), false, 'antero_worker sem BYPASSRLS');

-- O worker não lê nem grava tabelas de clientes, nem chama outras funções.
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM public.whatsapp_accounts')$$, '42501', NULL, 'worker NÃO lê whatsapp_accounts');
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM public.organizations')$$, '42501', NULL, 'worker NÃO lê organizations');
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM public.messages')$$, '42501', NULL, 'worker NÃO lê messages');
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM public.contacts')$$, '42501', NULL, 'worker NÃO lê contacts');
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM public.webhook_events')$$, '42501', NULL, 'worker NÃO lê webhook_events direto');
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_worker', 'SELECT 1 FROM auth.users')$$, '42501', NULL, 'worker NÃO lê identidades');
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_worker', pg_temp.fill('UPDATE public.organization_members SET role = ''attendant'' WHERE organization_id = {org_a}'))$$,
  '42501', NULL, 'worker NÃO altera vínculos'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_worker', pg_temp.fill('INSERT INTO public.webhook_events (dedupe_key, payload, status, reason, finished_at) VALUES (sha256(''x''), ''{}'', ''rejected'', ''x'', now())'))$$,
  '42501', NULL, 'worker NÃO grava webhook_events direto'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_worker', pg_temp.fill('SELECT public.set_organization_status({org_a}, ''inactive'')'))$$,
  '42501', NULL, 'worker NÃO executa funções administrativas'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_worker', pg_temp.fill('SELECT * FROM public.ingest_inbound_message({acc_dev}, ''+5511900000001'', ''oi'', ''x'')'))$$,
  '42501', NULL, 'worker NÃO executa a ingestão do simulador'
);
SELECT throws_ok(
  $$SELECT pg_temp.role_exec('antero_app', 'SELECT * FROM public.webhook_record_delivery(''{}''::jsonb)')$$,
  '42501', NULL, 'antero_app NÃO grava eventos do webhook'
);

-- ---------------------------------------------------------------------------
-- 2) Regras do canal cloud_api
-- ---------------------------------------------------------------------------
SELECT throws_ok(
  $$INSERT INTO public.whatsapp_accounts (organization_id, provider, status) VALUES (pg_temp.id('org_b'), 'cloud_api', 'connected')$$,
  '23514', NULL, 'canal cloud_api sem Phone Number ID nem WABA é recusado'
);
SELECT throws_ok(
  $$INSERT INTO public.whatsapp_accounts (organization_id, provider, status, external_account_id, external_business_account_id)
    VALUES (pg_temp.id('org_b'), 'cloud_api', 'connected', 'phone-id', '25550002001')$$,
  '23514', NULL, 'Phone Number ID não numérico é recusado'
);
SELECT throws_ok(
  $$INSERT INTO public.whatsapp_accounts (organization_id, provider, status, external_business_account_id)
    VALUES (pg_temp.id('org_b'), 'development', 'connected', '25550002001')$$,
  '23514', NULL, 'canal development não tem WABA'
);
SELECT throws_ok(
  $$INSERT INTO public.whatsapp_accounts (organization_id, provider, status, external_account_id, external_business_account_id)
    VALUES (pg_temp.id('org_b'), 'cloud_api', 'connected', '15550001001', '25550002001')$$,
  '23505', NULL, 'Phone Number ID de outra organização é recusado (único entre organizações)'
);
SELECT throws_ok(
  $$INSERT INTO public.whatsapp_accounts (organization_id, provider, status, external_account_id, external_business_account_id)
    VALUES (pg_temp.id('org_b'), 'cloud_api', 'connected', '15550002999', '25550001001')$$,
  'WH010', NULL, 'WABA de outra organização é recusada'
);
SELECT lives_ok(
  $$INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, external_business_account_id)
    VALUES (pg_temp.id('org_b'), 'cloud_api', 'disconnected', 'B2 140', '15550002002', '25550002001')$$,
  'segundo número na WABA da própria organização é aceito'
);
SELECT throws_ok(
  $$UPDATE public.whatsapp_accounts SET organization_id = pg_temp.id('org_b') WHERE id = pg_temp.id('acc_a1')$$,
  'WH011', NULL, 'canal cloud_api não muda de organização'
);
SELECT throws_ok(
  $$UPDATE public.whatsapp_accounts SET external_account_id = '15550001999' WHERE id = pg_temp.id('acc_a1')$$,
  'WH011', NULL, 'Phone Number ID de um canal cloud_api não muda'
);
SELECT throws_ok(
  $$UPDATE public.whatsapp_accounts SET external_business_account_id = '25550001999' WHERE id = pg_temp.id('acc_a1')$$,
  'WH011', NULL, 'WABA de um canal cloud_api não muda'
);
SELECT throws_ok(
  $$UPDATE public.whatsapp_accounts SET provider = 'cloud_api', external_account_id = '15550001998', external_business_account_id = '25550001001'
    WHERE id = pg_temp.id('acc_dev')$$,
  'WH011', NULL, 'canal development não vira cloud_api (cadastre outro canal)'
);
SELECT lives_ok(
  $$UPDATE public.whatsapp_accounts SET status = 'disconnected' WHERE id = pg_temp.id('acc_a1');
    UPDATE public.whatsapp_accounts SET status = 'connected', display_name = 'A1 140' WHERE id = pg_temp.id('acc_a1')$$,
  'desconectar e reconectar o canal continua permitido'
);
SELECT lives_ok(
  $$UPDATE public.whatsapp_accounts SET display_name = 'A dev 140' WHERE id = pg_temp.id('acc_dev')$$,
  'canais development seguem como antes'
);

-- ---------------------------------------------------------------------------
-- 3) Registro (antero_worker)
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE before_tables AS
SELECT (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM public.whatsapp_accounts t) AS accounts,
       (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM public.organizations t) AS organizations,
       (SELECT count(*) FROM public.contacts) AS contacts,
       (SELECT count(*) FROM public.conversations) AS conversations,
       (SELECT count(*) FROM public.messages) AS messages,
       (SELECT count(*) FROM public.audit_events) AS audit;

SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001001', 'wamid.a1')))), '1|0|0', 'notificação válida: 1 pendente');
SELECT is(pg_temp.event_of('wamid.a1'), 'received|-|' || pg_temp.id('org_a') || '|' || pg_temp.id('acc_a1') || '|false', 'pendente, da organização e do canal certos');
SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001001', 'wamid.a1')))), '0|0|1', 'reentrega idêntica: duplicata');
SELECT is(
  pg_temp.record((pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001001', 'wamid.a1')))::text)::jsonb),
  '0|0|1', 'mesma notificação com outra formatação: duplicata (forma canônica)'
);
SELECT is(pg_temp.total(), 1::bigint, 'nenhuma linha a mais por reentrega');

SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550009999', pg_temp.change('15550009999', 'wamid.unknown')))), '0|1|0', 'canal inexistente: rejeitado');
SELECT is(pg_temp.event_of('wamid.unknown'), 'rejected|unknown_channel|-|-|true', 'canal inexistente: sem organização');
SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550002001', pg_temp.change('15550001001', 'wamid.mismatch')))), '0|1|0', 'WABA divergente: rejeitado');
SELECT is(pg_temp.event_of('wamid.mismatch'), 'rejected|waba_mismatch|-|-|true', 'número de A com WABA de B: sem organização (nem A nem B)');
SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001003', 'wamid.disc')))), '0|1|0', 'canal desconectado: rejeitado');
SELECT is(pg_temp.event_of('wamid.disc'), 'rejected|channel_disconnected|' || pg_temp.id('org_a') || '|' || pg_temp.id('acc_a3') || '|true', 'canal desconectado: registrado na organização dele');
SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550003001', pg_temp.change('15550003001', 'wamid.susp')))), '0|1|0', 'organização suspensa: rejeitado');
SELECT is(pg_temp.event_of('wamid.susp'), 'rejected|organization_inactive|' || pg_temp.id('org_c') || '|' || pg_temp.id('acc_c1') || '|true', 'organização suspensa: motivo registrado');
SELECT is(
  pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001001', 'wamid.field', 'account_update')))),
  '0|1|0', 'campo que não é `messages`: rejeitado'
);
SELECT is((SELECT reason FROM public.webhook_events WHERE field = 'account_update'), 'unsupported_field', 'motivo: campo não suportado');
SELECT is(
  pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001001', 'wamid.nophone') #- '{value,metadata,phone_number_id}'))),
  '0|1|0', 'sem Phone Number ID: rejeitado'
);
SELECT is(pg_temp.event_of('wamid.nophone'), 'rejected|missing_phone_number_id|-|-|true', 'sem Phone Number ID: sem organização');

-- Lote com números de duas organizações: cada alteração na sua.
SELECT is(
  pg_temp.record(pg_temp.delivery(
    pg_temp.entry('25550001001', pg_temp.change('15550001002', 'wamid.batch.a')),
    pg_temp.entry('25550002001', pg_temp.change('15550002001', 'wamid.batch.b')))),
  '2|0|0', 'lote com duas organizações: duas pendentes'
);
SELECT is(pg_temp.event_of('wamid.batch.b'), 'received|-|' || pg_temp.id('org_b') || '|' || pg_temp.id('acc_b1') || '|false', 'alteração de B fica em B');
SELECT is((SELECT organization_id FROM public.webhook_events WHERE payload #>> '{value,messages,0,id}' = 'wamid.batch.a'), pg_temp.id('org_a'), 'alteração de A fica em A');

-- Estrutura inválida: uma linha rejeitada, sem organização.
SELECT is(pg_temp.record('{"object":"page","entry":[]}'), '0|1|0', 'objeto que não é WhatsApp: rejeitado');
SELECT is(pg_temp.record('{"object":"page","entry":[]}'), '0|0|1', 'repetido: duplicata');
SELECT is(pg_temp.record('[1,2,3]'), '0|1|0', 'corpo que não é objeto: rejeitado');
SELECT is(pg_temp.record('{"object":"whatsapp_business_account","entry":[{"id":"25550001001"}]}'), '0|1|0', 'entrada sem changes: rejeitada');
SELECT is(pg_temp.record('{"object":"whatsapp_business_account","entry":[{"id":"abc","changes":[{"field":"messages","value":{}}]}]}'), '0|1|0', 'WABA não numérica: rejeitada');
SELECT is(
  (SELECT count(*)::int FROM public.webhook_events WHERE reason = 'invalid_payload' AND organization_id IS NULL AND status = 'rejected'),
  4, 'estruturas inválidas: rejeitadas com motivo e sem organização'
);
SELECT is(
  pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001',
    VARIADIC (SELECT array_agg(pg_temp.change('15550001001', 'wamid.many.' || i)) FROM generate_series(1, 1001) i)))),
  '0|1|0', 'mais de 1000 alterações: rejeitado inteiro'
);
SELECT is((SELECT count(*)::int FROM public.webhook_events WHERE reason = 'too_many_changes'), 1, 'motivo: lote grande demais');
SELECT throws_ok($$SELECT pg_temp.record(NULL)$$, '22004', NULL, 'notificação nula é recusada');

SELECT is(
  (SELECT row(accounts, organizations, contacts, conversations, messages, audit)::text FROM before_tables),
  (SELECT row(
     (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM public.whatsapp_accounts t),
     (SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) FROM public.organizations t),
     (SELECT count(*) FROM public.contacts), (SELECT count(*) FROM public.conversations),
     (SELECT count(*) FROM public.messages), (SELECT count(*) FROM public.audit_events))::text),
  'o registro não altera canais, organizações, contatos, conversas, mensagens nem auditoria'
);

-- A aplicação não lê os eventos, nem como dona da organização nem como admin da plataforma.
SELECT throws_ok($$SELECT pg_temp.sees('a_owner', 'SELECT 1 FROM public.webhook_events')$$, '42501', NULL, 'owner da organização NÃO lê os eventos brutos');
SELECT throws_ok($$SELECT pg_temp.sees('platform', 'SELECT 1 FROM public.webhook_events')$$, '42501', NULL, 'admin da plataforma NÃO lê os eventos brutos');

-- ---------------------------------------------------------------------------
-- 4) Fila
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.claim(), 3, 'reivindica as 3 pendentes (rejeitadas ficam fora)');
SELECT is(
  (SELECT count(*)::int FROM claimed WHERE attempts = 1 AND claim_token IS NOT NULL AND organization_id IS NOT NULL AND whatsapp_account_id IS NOT NULL),
  3, 'cada uma com token, organização, canal e 1ª tentativa'
);
CREATE TEMP TABLE first_claim AS SELECT * FROM claimed;
SELECT is(pg_temp.claim(), 0, 'reivindicadas não voltam enquanto o prazo vale');

SELECT throws_ok(
  $$SELECT pg_temp.finish(pg_temp.id_of('wamid.a1'), gen_random_uuid(), 'processed')$$,
  'WH001', NULL, 'token de outra reivindicação: recusado'
);
SELECT is(
  pg_temp.finish(pg_temp.id_of('wamid.a1'), (SELECT claim_token FROM first_claim WHERE event_id = pg_temp.id_of('wamid.a1')), 'processed'),
  'processed', 'encerrada como processada'
);
SELECT is(pg_temp.event_of('wamid.a1'), 'processed|-|' || pg_temp.id('org_a') || '|' || pg_temp.id('acc_a1') || '|true', 'processada: finished_at preenchido');
SELECT is(
  pg_temp.finish(pg_temp.id_of('wamid.a1'), (SELECT claim_token FROM first_claim WHERE event_id = pg_temp.id_of('wamid.a1')), 'processed'),
  'processed', 'repetir o encerramento com o mesmo token não muda nada'
);

SELECT is(
  pg_temp.finish(pg_temp.id_of('wamid.batch.a'), (SELECT claim_token FROM first_claim WHERE event_id = pg_temp.id_of('wamid.batch.a')), 'retry', 'db_timeout'),
  'received', 'retry: volta à fila'
);
SELECT ok(
  (SELECT next_attempt_at > clock_timestamp() AND claimed_until IS NULL AND last_error = 'db_timeout'
   FROM public.webhook_events WHERE id = pg_temp.id_of('wamid.batch.a')),
  'retry: espera antes da próxima tentativa, sem prazo e com o erro registrado'
);
SELECT throws_ok(
  $$SELECT pg_temp.finish(pg_temp.id_of('wamid.batch.a'), (SELECT claim_token FROM first_claim WHERE event_id = pg_temp.id_of('wamid.batch.a')), 'retry', 'db_timeout')$$,
  'WH001', NULL, 'retry repetido com o mesmo token: a reivindicação já acabou'
);
SELECT is(pg_temp.claim(), 0, 'em espera: não é reivindicada antes da hora');

-- Prazo vencido (processo que caiu): outra execução reivindica; o token antigo perde.
UPDATE public.webhook_events SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = pg_temp.id_of('wamid.batch.b');
SELECT is(pg_temp.claim(), 1, 'prazo vencido: reivindicada de novo');
SELECT is((SELECT attempts FROM claimed), 2, 'segunda tentativa contada');
SELECT throws_ok(
  $$SELECT pg_temp.finish(pg_temp.id_of('wamid.batch.b'), (SELECT claim_token FROM first_claim WHERE event_id = pg_temp.id_of('wamid.batch.b')), 'processed')$$,
  'WH001', NULL, 'quem perdeu o prazo não encerra o trabalho de outro'
);
SELECT is(
  pg_temp.finish(pg_temp.id_of('wamid.batch.b'), (SELECT claim_token FROM claimed), 'rejected', 'unsupported_message'),
  'rejected', 'encerrada como rejeitada, com motivo'
);
SELECT is(pg_temp.event_of('wamid.batch.b'), 'rejected|unsupported_message|' || pg_temp.id('org_b') || '|' || pg_temp.id('acc_b1') || '|true', 'rejeitada: motivo e encerramento');

-- Tentativas esgotadas.
UPDATE public.webhook_events SET next_attempt_at = clock_timestamp() - interval '1 second', attempts = 9 WHERE id = pg_temp.id_of('wamid.batch.a');
SELECT is(pg_temp.claim(), 1, 'última tentativa reivindicada');
SELECT is(
  pg_temp.finish(pg_temp.id_of('wamid.batch.a'), (SELECT claim_token FROM claimed), 'retry', 'db_timeout'),
  'failed', 'retry na 10ª tentativa: falha definitiva'
);
SELECT is(
  (SELECT status || '|' || reason || '|' || last_error FROM public.webhook_events WHERE id = pg_temp.id_of('wamid.batch.a')),
  'failed|max_attempts|db_timeout', 'falha: motivo max_attempts e último erro'
);
SELECT is(pg_temp.record(pg_temp.delivery(pg_temp.entry('25550001001', pg_temp.change('15550001001', 'wamid.crash')))), '1|0|0', 'nova pendente');
UPDATE public.webhook_events SET attempts = 10, claim_token = gen_random_uuid(), claimed_until = clock_timestamp() - interval '1 second' WHERE id = pg_temp.id_of('wamid.crash');
SELECT is(pg_temp.claim(), 0, 'prazo vencido sem tentativas restantes: não é reivindicada');
SELECT is((SELECT status || '|' || reason FROM public.webhook_events WHERE id = pg_temp.id_of('wamid.crash')), 'failed|max_attempts', 'e vira falha definitiva');

-- Entradas inválidas.
SELECT throws_ok($$SELECT pg_temp.claim(0, 60)$$, '22023', NULL, 'limite 0 é recusado');
SELECT throws_ok($$SELECT pg_temp.claim(10, 5)$$, '22023', NULL, 'prazo curto demais é recusado');
SELECT throws_ok($$SELECT pg_temp.finish(1, gen_random_uuid(), 'processed', 'motivo')$$, '22023', NULL, 'processed com motivo é recusado');
SELECT throws_ok($$SELECT pg_temp.finish(1, gen_random_uuid(), 'rejected')$$, '22023', NULL, 'rejected sem motivo é recusado');
SELECT throws_ok($$SELECT pg_temp.finish(1, gen_random_uuid(), 'rejected', 'Texto Livre')$$, '22023', NULL, 'motivo fora do formato de código é recusado');
SELECT throws_ok($$SELECT pg_temp.finish(-1, gen_random_uuid(), 'processed')$$, 'P0002', NULL, 'evento inexistente');
SELECT throws_ok($$SELECT pg_temp.role_exec('antero_app', 'SELECT * FROM public.webhook_claim_events(10, 60)')$$, '42501', NULL, 'antero_app NÃO reivindica eventos');

-- Exclusões: o canal com eventos fica; a organização inteira leva canais e eventos.
SELECT throws_ok($$DELETE FROM public.whatsapp_accounts WHERE id = pg_temp.id('acc_a1')$$, '23503', NULL, 'canal com eventos não é removido');
SELECT lives_ok($$DELETE FROM public.organizations WHERE id = pg_temp.id('org_b')$$, 'excluir a organização remove os canais e os eventos dela');
SELECT is((SELECT count(*)::int FROM public.webhook_events WHERE waba_id = '25550002001' AND organization_id IS NOT NULL), 0, 'nenhum evento da organização excluída');

SELECT * FROM finish();
ROLLBACK;

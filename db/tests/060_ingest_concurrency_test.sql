-- Antero Atendimentos — Entrega 2: concorrência REAL em ingest_inbound_message.
--
-- Duas conexões independentes como antero_app (dblink, schema test_tools, só
-- no banco de testes), cada uma com o próprio contexto de usuário. A segunda
-- chamada é disparada enquanto a primeira transação ainda está aberta; o
-- teste confirma (pg_stat_activity) que ela ficou BLOQUEADA e, depois do
-- COMMIT/ROLLBACK da primeira, verifica o resultado:
--   A) mesma (conta, external_message_id) com payload divergente -> duplicata;
--   B) primeira mensagem simultânea do mesmo telefone novo -> um só contato e
--      uma só conversa;
--   C) duas mensagens novas para a mesma conversa resolvida -> só uma reabre;
--   D) a primeira transação faz ROLLBACK -> a segunda grava normalmente.
--
-- As conexões dblink só enxergam dados COMMITADOS, então este arquivo não
-- roda num BEGIN...ROLLBACK único: os fixtures (sufixo aleatório) são
-- commitados e removidos explicitamente no final.
\set QUIET 1
\ir lib/helpers.psql
SELECT plan(20);

SELECT substr(md5(random()::text), 1, 10) AS sfx, current_database() AS dbname \gset

BEGIN;
INSERT INTO public.organizations (name, slug) VALUES ('Org Concorrência', 'org-conc-' || :'sfx');
INSERT INTO ids SELECT 'org', id FROM public.organizations WHERE slug = 'org-conc-' || :'sfx';
INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
VALUES (pg_temp.id('org'), 'development', 'connected', 'Canal Concorrência ' || :'sfx');
INSERT INTO ids SELECT 'acc', id FROM public.whatsapp_accounts WHERE display_name = 'Canal Concorrência ' || :'sfx';
SELECT pg_temp.new_user('owner', 'owner.conc.' || :'sfx' || '@teste.local');
INSERT INTO public.organization_members (organization_id, user_id, role, status)
VALUES (pg_temp.id('org'), pg_temp.id('owner'), 'owner', 'active');
COMMIT;

SELECT pg_temp.id('owner') AS owner, pg_temp.id('acc') AS acc, pg_temp.id('org') AS org \gset

-- Espera (até 10 s) a conexão `pid` ficar bloqueada aguardando um lock.
CREATE FUNCTION pg_temp.wait_blocked(p_pid int) RETURNS boolean
LANGUAGE plpgsql AS $$
BEGIN
  FOR i IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    IF EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = p_pid AND wait_event_type = 'Lock') THEN
      RETURN true;
    END IF;
    PERFORM pg_sleep(0.05);
  END LOOP;
  RETURN false;
END;
$$;

-- Texto da chamada à ingestão (mesma forma que a aplicação usará).
CREATE FUNCTION pg_temp.ingest_sql(p_phone text, p_content text, p_external_id text) RETURNS text
LANGUAGE sql AS $$
  SELECT format(
    'SELECT created, duplicate, reopened, message_id, contact_id, conversation_id '
    'FROM public.ingest_inbound_message(%L::uuid, %L, %L, %L)',
    pg_temp.id('acc'), p_phone, p_content, p_external_id)
$$;

SELECT test_tools.dblink_connect('c1', format('dbname=%s user=antero_app', :'dbname')) \g /dev/null
SELECT test_tools.dblink_connect('c2', format('dbname=%s user=antero_app', :'dbname')) \g /dev/null
SELECT pid AS c2_pid FROM test_tools.dblink('c2', 'SELECT pg_backend_pid()') AS t(pid int) \gset

-- Abre transação + contexto do owner nas duas conexões.
CREATE FUNCTION pg_temp.begin_as_owner(p_conn text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM test_tools.dblink_exec(p_conn, 'BEGIN');
  PERFORM * FROM test_tools.dblink(p_conn, format('SELECT 1 FROM app.set_user_context(%L)', pg_temp.id('owner'))) AS t(ok int);
END;
$$;

CREATE TEMP TABLE results (
  scenario text, conn text,
  created boolean, duplicate boolean, reopened boolean,
  message_id uuid, contact_id uuid, conversation_id uuid
);

-- Executa a ingestão em c1 (síncrono, transação fica aberta), dispara a de
-- c2 (assíncrona), mede o bloqueio, termina c1 com p_c1_end e coleta c2.
CREATE FUNCTION pg_temp.race(p_scenario text, p_c1_sql text, p_c2_sql text, p_c2_pid int, p_c1_end text DEFAULT 'COMMIT')
RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE
  v_blocked boolean;
BEGIN
  PERFORM pg_temp.begin_as_owner('c1');
  INSERT INTO results
  SELECT p_scenario, 'c1', t.* FROM test_tools.dblink('c1', p_c1_sql)
    AS t(created boolean, duplicate boolean, reopened boolean, message_id uuid, contact_id uuid, conversation_id uuid);

  PERFORM pg_temp.begin_as_owner('c2');
  PERFORM test_tools.dblink_send_query('c2', p_c2_sql);
  v_blocked := pg_temp.wait_blocked(p_c2_pid);

  PERFORM test_tools.dblink_exec('c1', p_c1_end);

  INSERT INTO results
  SELECT p_scenario, 'c2', t.* FROM test_tools.dblink_get_result('c2')
    AS t(created boolean, duplicate boolean, reopened boolean, message_id uuid, contact_id uuid, conversation_id uuid);
  -- Consome o fim do resultado assíncrono antes de reutilizar a conexão.
  PERFORM * FROM test_tools.dblink_get_result('c2')
    AS t(created boolean, duplicate boolean, reopened boolean, message_id uuid, contact_id uuid, conversation_id uuid);
  PERFORM test_tools.dblink_exec('c2', 'COMMIT');
  RETURN v_blocked;
END;
$$;

CREATE FUNCTION pg_temp.r(p_scenario text, p_conn text) RETURNS results
LANGUAGE sql AS $$ SELECT * FROM results WHERE scenario = p_scenario AND conn = p_conn $$;

-- ---------------------------------------------------------------------------
-- A) Mesma (conta, external_message_id), telefone/conteúdo divergentes
-- ---------------------------------------------------------------------------
SELECT ok(
  pg_temp.race('A',
    pg_temp.ingest_sql('+5511977770001', 'original', 'conc-ext-A'),
    pg_temp.ingest_sql('+5511977770002', 'reentrega divergente', 'conc-ext-A'),
    :c2_pid),
  'A: a segunda entrega fica bloqueada até a primeira terminar'
);
SELECT is((pg_temp.r('A', 'c1')).created, true, 'A: a primeira cria a mensagem');
SELECT is(
  ((pg_temp.r('A', 'c2')).created, (pg_temp.r('A', 'c2')).duplicate),
  (false, true),
  'A: a segunda recebe duplicate = true, created = false'
);
SELECT is((pg_temp.r('A', 'c2')).message_id, (pg_temp.r('A', 'c1')).message_id, 'A: a segunda devolve o id da mensagem original');
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE whatsapp_account_id = :'acc' AND external_message_id = 'conc-ext-A'),
  1, 'A: existe exatamente 1 mensagem para o external_message_id'
);
SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE organization_id = :'org' AND phone_number = '+5511977770002'),
  0, 'A: nenhum contato criado para o telefone da reentrega'
);

-- ---------------------------------------------------------------------------
-- B) Primeiras mensagens simultâneas do mesmo telefone novo
-- ---------------------------------------------------------------------------
SELECT ok(
  pg_temp.race('B',
    pg_temp.ingest_sql('+5511977770003', 'primeira', 'conc-ext-B1'),
    pg_temp.ingest_sql('+5511977770003', 'segunda', 'conc-ext-B2'),
    :c2_pid),
  'B: a segunda fica bloqueada na criação do contato'
);
SELECT is((pg_temp.r('B', 'c2')).created, true, 'B: a segunda mensagem também é criada');
SELECT is((pg_temp.r('B', 'c2')).contact_id, (pg_temp.r('B', 'c1')).contact_id, 'B: ambas usam o mesmo contato');
SELECT is((pg_temp.r('B', 'c2')).conversation_id, (pg_temp.r('B', 'c1')).conversation_id, 'B: ambas usam a mesma conversa');
SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE organization_id = :'org' AND phone_number = '+5511977770003'),
  1, 'B: exatamente 1 contato para o telefone'
);
SELECT is(
  (SELECT count(*)::int FROM public.conversations WHERE organization_id = :'org' AND contact_id = (pg_temp.r('B', 'c1')).contact_id),
  1, 'B: exatamente 1 conversa para (conta, contato)'
);
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE conversation_id = (pg_temp.r('B', 'c1')).conversation_id),
  2, 'B: as 2 mensagens estão na conversa'
);

-- ---------------------------------------------------------------------------
-- C) Duas mensagens novas para a mesma conversa resolvida: só uma reabre
-- ---------------------------------------------------------------------------
UPDATE public.conversations
SET status = 'resolved', resolved_at = now(), assigned_user_id = :'owner', assigned_at = now()
WHERE id = (pg_temp.r('B', 'c1')).conversation_id;

SELECT ok(
  pg_temp.race('C',
    pg_temp.ingest_sql('+5511977770003', 'reabre 1', 'conc-ext-C1'),
    pg_temp.ingest_sql('+5511977770003', 'reabre 2', 'conc-ext-C2'),
    :c2_pid),
  'C: a segunda fica bloqueada no FOR UPDATE da conversa'
);
SELECT is((pg_temp.r('C', 'c1')).reopened, true, 'C: a primeira reabre a conversa');
SELECT is(
  ((pg_temp.r('C', 'c2')).created, (pg_temp.r('C', 'c2')).reopened),
  (true, false),
  'C: a segunda é criada mas NÃO reabre de novo'
);
SELECT is(
  (SELECT (status, resolved_at IS NULL, assigned_user_id IS NULL) FROM public.conversations WHERE id = (pg_temp.r('B', 'c1')).conversation_id),
  ROW('waiting'::public.conversation_status, true, true),
  'C: conversa em waiting, sem resolved_at e sem atribuição'
);

-- ---------------------------------------------------------------------------
-- D) A primeira transação desiste (ROLLBACK): a segunda grava normalmente
-- ---------------------------------------------------------------------------
SELECT ok(
  pg_temp.race('D',
    pg_temp.ingest_sql('+5511977770004', 'vai ser desfeita', 'conc-ext-D'),
    pg_temp.ingest_sql('+5511977770004', 'esta fica', 'conc-ext-D'),
    :c2_pid,
    'ROLLBACK'),
  'D: a segunda fica bloqueada enquanto a primeira está aberta'
);
SELECT is(
  ((pg_temp.r('D', 'c2')).created, (pg_temp.r('D', 'c2')).duplicate),
  (true, false),
  'D: após o ROLLBACK da primeira, a segunda cria a mensagem (não é duplicata fantasma)'
);
SELECT is(
  (SELECT content FROM public.messages WHERE whatsapp_account_id = :'acc' AND external_message_id = 'conc-ext-D'),
  'esta fica',
  'D: a mensagem persistida é a da segunda entrega'
);

SELECT test_tools.dblink_disconnect('c1') \g /dev/null
SELECT test_tools.dblink_disconnect('c2') \g /dev/null

-- Limpeza dos fixtures commitados (ordem respeita as FKs RESTRICT).
BEGIN;
DELETE FROM public.messages WHERE organization_id = :'org';
DELETE FROM public.conversations WHERE organization_id = :'org';
DELETE FROM public.contacts WHERE organization_id = :'org';
DELETE FROM public.whatsapp_accounts WHERE organization_id = :'org';
DELETE FROM public.organizations WHERE id = :'org';
DELETE FROM auth.users WHERE id = :'owner';
COMMIT;

SELECT * FROM finish();

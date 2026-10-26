-- Antero Atendimento — Ciclo 2, Etapa 3
-- Testes pgTAP de public.ingest_inbound_message().
--
-- Porte (Entrega 2) de supabase/tests/0005_ingest_inbound_message_test.sql
-- para o PostgreSQL próprio. As 69 asserções originais foram mantidas, na
-- mesma ordem e com as mesmas descrições; mudou só o modelo de identidade:
--   - usuários: INSERT em auth.users do Better Auth feito por antero_auth
--     (pg_temp.new_user), em vez do auth.users do Supabase;
--   - chamador: `SET LOCAL ROLE authenticated` + `request.jwt.claim.sub`
--     viraram pg_temp.ingest_as(p_user => ...), que chama a função como
--     antero_app com app.set_user_context(p_user) — p_user NULL = sem
--     contexto (antes: claim vazio);
--   - asserções de EXECUTE: authenticated -> antero_app; anon (não existe
--     mais) -> antero_auth, o outro papel com login que NÃO deve executar;
--   - leituras de verificação (contacts/conversations/messages) rodam como o
--     superusuário do banco descartável, não sob RLS — a visibilidade por RLS
--     está coberta em 030_rls_policies_test.sql.
-- Asserção nova (70): owner de uma organização não ingere em conta de outra.
--
-- Roda inteiro dentro de uma transação (BEGIN...ROLLBACK): nenhum dado fica
-- no banco de testes.
--
-- Concorrência: este arquivo roda numa única sessão/transação; a seção 13
-- simula o RESULTADO de uma corrida vencida por "outra transação",
-- pré-inserindo a linha contestada. A prova com duas conexões reais está em
-- 060_ingest_concurrency_test.sql (dblink).

BEGIN;
\ir lib/helpers.psql
SELECT plan(70);

-- ---------------------------------------------------------------------------
-- Auditoria estática: a autoridade contra duplicidade é a constraint, não
-- uma query prévia da função.
-- ---------------------------------------------------------------------------
SELECT has_index(
  'public', 'messages', 'messages_whatsapp_account_external_id_key',
  'messages_whatsapp_account_external_id_key deve existir (autoridade de idempotência)'
);

-- ---------------------------------------------------------------------------
-- Segurança de EXECUTE: só antero_app.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('antero_app', 'public.ingest_inbound_message(uuid, text, text, text, text)', 'EXECUTE'),
  'antero_app tem EXECUTE em ingest_inbound_message'
);
SELECT ok(
  not has_function_privilege('antero_auth', 'public.ingest_inbound_message(uuid, text, text, text, text)', 'EXECUTE'),
  'antero_auth NÃO tem EXECUTE em ingest_inbound_message'
);
SELECT ok(
  not has_function_privilege('public', 'public.ingest_inbound_message(uuid, text, text, text, text)', 'EXECUTE'),
  'public NÃO tem EXECUTE em ingest_inbound_message'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- (a tabela temporária `ids` vem de lib/helpers.psql)

WITH new_org AS (
  INSERT INTO public.organizations (name, slug) VALUES ('Org A Teste 0005', 'org-a-teste-0005') RETURNING id
)
INSERT INTO ids SELECT 'org_a', id FROM new_org;

WITH new_org AS (
  INSERT INTO public.organizations (name, slug) VALUES ('Org B Teste 0005', 'org-b-teste-0005') RETURNING id
)
INSERT INTO ids SELECT 'org_b', id FROM new_org;

-- Contas de WhatsApp: duas contas dev/connected na Org A (separação entre
-- contas + fixture das corridas), uma disconnected e uma cloud_api (contas
-- inválidas), e uma dev/connected na Org B (não usada diretamente nos
-- asserts, mas prova que a Org B existe isolada).
WITH new_acc AS (
  INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), 'development', 'connected', 'Org A Canal 1')
  RETURNING id
)
INSERT INTO ids SELECT 'account_a1', id FROM new_acc;

WITH new_acc AS (
  INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), 'development', 'connected', 'Org A Canal 2')
  RETURNING id
)
INSERT INTO ids SELECT 'account_a2', id FROM new_acc;

WITH new_acc AS (
  INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), 'development', 'disconnected', 'Org A Canal Inativo')
  RETURNING id
)
INSERT INTO ids SELECT 'account_a_inactive', id FROM new_acc;

WITH new_acc AS (
  INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), 'cloud_api', 'connected', 'Org A Canal Cloud API')
  RETURNING id
)
INSERT INTO ids SELECT 'account_a_cloud', id FROM new_acc;

WITH new_acc AS (
  INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_b'), 'development', 'connected', 'Org B Canal 1')
  RETURNING id
)
INSERT INTO ids SELECT 'account_b1', id FROM new_acc;

-- Usuários (auth.users do Better Auth -> profiles via handle_new_user). Um
-- por papel/status necessário nos cenários, mais um usuário sem vínculo algum.
SELECT pg_temp.new_user('user_owner', 'owner-0005@teste.local');
SELECT pg_temp.new_user('user_admin_disabled', 'admin-disabled-0005@teste.local');
SELECT pg_temp.new_user('user_attendant', 'attendant-0005@teste.local');
SELECT pg_temp.new_user('user_no_membership', 'no-membership-0005@teste.local');

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'user_owner'), 'owner', 'active'),
  ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'user_admin_disabled'), 'admin', 'disabled'),
  ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'user_attendant'), 'attendant', 'active');
-- user_no_membership propositalmente sem linha em organization_members.

-- ---------------------------------------------------------------------------
-- 1) Fluxo completo: contato, conversa e mensagem novos.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE r1 AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999990001',
  p_content => '  Olá, preciso de ajuda  ',
  p_external_message_id => 'wa-msg-001',
  p_contact_name => '  Cliente Um  '
);

SELECT is((SELECT created FROM r1), true, 'fluxo completo: created = true');
SELECT is((SELECT duplicate FROM r1), false, 'fluxo completo: duplicate = false');
SELECT is((SELECT reopened FROM r1), false, 'fluxo completo: reopened = false (conversa nova nasce waiting)');
SELECT is((SELECT organization_id FROM r1), (SELECT v FROM ids WHERE k = 'org_a'), 'fluxo completo: organization_id derivado da conta');

SELECT is(
  (SELECT name FROM public.contacts WHERE id = (SELECT contact_id FROM r1)),
  'Cliente Um',
  'contato criado com nome já trimado'
);
SELECT is(
  (SELECT phone_number FROM public.contacts WHERE id = (SELECT contact_id FROM r1)),
  '+5511999990001',
  'contato criado com o telefone informado'
);

SELECT is(
  (SELECT status FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)),
  'waiting'::public.conversation_status,
  'conversa nova nasce em waiting'
);

SELECT is(
  (SELECT content FROM public.messages WHERE id = (SELECT message_id FROM r1)),
  'Olá, preciso de ajuda',
  'conteúdo da mensagem gravado após trim'
);
SELECT is((SELECT direction FROM public.messages WHERE id = (SELECT message_id FROM r1)), 'inbound'::public.message_direction, 'direction = inbound');
SELECT is((SELECT sender_type FROM public.messages WHERE id = (SELECT message_id FROM r1)), 'contact'::public.message_sender, 'sender_type = contact');
SELECT ok((SELECT sender_user_id FROM public.messages WHERE id = (SELECT message_id FROM r1)) IS NULL, 'sender_user_id = null');
SELECT is((SELECT message_type FROM public.messages WHERE id = (SELECT message_id FROM r1)), 'text'::public.message_type, 'message_type = text');
SELECT is((SELECT delivery_status FROM public.messages WHERE id = (SELECT message_id FROM r1)), 'delivered'::public.message_delivery_status, 'delivery_status = delivered');

-- ---------------------------------------------------------------------------
-- 2) Reutilização de contato e conversa: segunda mensagem, mesmo telefone e
-- mesma conta, external_message_id diferente.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE r2 AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999990001',
  p_content => 'segunda mensagem',
  p_external_message_id => 'wa-msg-002'
);

SELECT is((SELECT contact_id FROM r2), (SELECT contact_id FROM r1), 'reutiliza o mesmo contato');
SELECT is((SELECT conversation_id FROM r2), (SELECT conversation_id FROM r1), 'reutiliza a mesma conversa');
SELECT is((SELECT created FROM r2), true, 'segunda mensagem real: created = true');
SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE organization_id = (SELECT v FROM ids WHERE k = 'org_a') AND phone_number = '+5511999990001'),
  1,
  'nenhum contato duplicado foi criado'
);

-- ---------------------------------------------------------------------------
-- 3) Separação entre contas: mesmo telefone, conta diferente na mesma org
-- -> mesmo contato, conversa DIFERENTE.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE r3 AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a2'),
  p_phone_number => '+5511999990001',
  p_content => 'mensagem pelo canal 2',
  p_external_message_id => 'wa-msg-003'
);

SELECT is((SELECT contact_id FROM r3), (SELECT contact_id FROM r1), 'mesmo contato entre contas da mesma organização');
SELECT isnt((SELECT conversation_id FROM r3), (SELECT conversation_id FROM r1), 'conversa diferente para conta diferente');

-- ---------------------------------------------------------------------------
-- 4) Idempotência: mesma (conta, external_message_id) duas vezes.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE r4 AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999990001',
  p_content => 'tentativa duplicada da mensagem 2',
  p_external_message_id => 'wa-msg-002'
);

SELECT is((SELECT created FROM r4), false, 'idempotência: created = false na repetição');
SELECT is((SELECT duplicate FROM r4), true, 'idempotência: duplicate = true na repetição');
SELECT is((SELECT reopened FROM r4), false, 'idempotência: reopened = false na repetição');
SELECT is((SELECT message_id FROM r4), (SELECT message_id FROM r2), 'idempotência: retorna o id da mensagem já existente');
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE whatsapp_account_id = (SELECT v FROM ids WHERE k = 'account_a1') AND external_message_id = 'wa-msg-002'),
  1,
  'idempotência: nenhuma mensagem duplicada foi criada'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM (
      SELECT created, duplicate FROM r1
      UNION ALL SELECT created, duplicate FROM r2
      UNION ALL SELECT created, duplicate FROM r3
      UNION ALL SELECT created, duplicate FROM r4
    ) x WHERE created AND duplicate
  ),
  'created e duplicate nunca são true ao mesmo tempo'
);

-- ---------------------------------------------------------------------------
-- 4b) Payload divergente no mesmo (conta, external_message_id): telefone,
-- nome e conteúdo diferentes do original. Deve devolver a mensagem original
-- como duplicata SEM criar contato/conversa para o telefone novo e SEM
-- alterar o contato/conversa originais. Reproduz o cenário do relatório de
-- correção pontual da Etapa 3.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE original_contact_snapshot AS
SELECT id, organization_id, name, phone_number, updated_at
FROM public.contacts WHERE id = (SELECT contact_id FROM r1);

CREATE TEMP TABLE original_conversation_snapshot AS
SELECT id, status, assigned_user_id, assigned_at, resolved_at, last_message_at, updated_at
FROM public.conversations WHERE id = (SELECT conversation_id FROM r1);

CREATE TEMP TABLE r4b AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999990088',
  p_content => 'conteúdo completamente diferente do original',
  p_external_message_id => 'wa-msg-002',
  p_contact_name => 'Cliente Divergente'
);

SELECT is((SELECT message_id FROM r4b), (SELECT message_id FROM r2), 'payload divergente: retorna o message_id ORIGINAL, não cria outro');
SELECT is((SELECT created FROM r4b), false, 'payload divergente: created = false');
SELECT is((SELECT duplicate FROM r4b), true, 'payload divergente: duplicate = true');
SELECT is((SELECT reopened FROM r4b), false, 'payload divergente: reopened = false');
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE whatsapp_account_id = (SELECT v FROM ids WHERE k = 'account_a1') AND external_message_id = 'wa-msg-002'),
  1,
  'payload divergente: continua existindo exatamente 1 mensagem para o external_message_id'
);
SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE organization_id = (SELECT v FROM ids WHERE k = 'org_a') AND phone_number = '+5511999990088'),
  0,
  'payload divergente: NÃO cria contato para o telefone divergente'
);
SELECT is(
  (SELECT count(*)::int FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE c.organization_id = (SELECT v FROM ids WHERE k = 'org_a') AND ct.phone_number = '+5511999990088'),
  0,
  'payload divergente: NÃO cria conversa para o telefone divergente'
);
SELECT is(
  (SELECT (id, organization_id, name, phone_number, updated_at) FROM public.contacts WHERE id = (SELECT contact_id FROM r1)),
  (SELECT (id, organization_id, name, phone_number, updated_at) FROM original_contact_snapshot),
  'payload divergente: contato original inalterado'
);
SELECT is(
  (SELECT (id, status, assigned_user_id, assigned_at, resolved_at, last_message_at, updated_at) FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)),
  (SELECT (id, status, assigned_user_id, assigned_at, resolved_at, last_message_at, updated_at) FROM original_conversation_snapshot),
  'payload divergente: conversa original inalterada (last_message_at não avança)'
);

-- ---------------------------------------------------------------------------
-- 5) Duplicidade após resolução: NÃO reabre.
-- Marca a conversa de r1 como resolved (fixture administrativa, fora da
-- função sob teste) com uma atribuição prévia, para provar que a duplicata
-- não mexe em nada disso.
-- ---------------------------------------------------------------------------
UPDATE public.conversations
SET status = 'resolved', resolved_at = now(),
    assigned_user_id = (SELECT v FROM ids WHERE k = 'user_owner'),
    assigned_at = now()
WHERE id = (SELECT conversation_id FROM r1);

CREATE TEMP TABLE snapshot_before_dup AS
SELECT status, resolved_at, assigned_user_id, assigned_at, last_message_at
FROM public.conversations WHERE id = (SELECT conversation_id FROM r1);


CREATE TEMP TABLE r5 AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999990001',
  p_content => 'reentrega pós-resolução',
  p_external_message_id => 'wa-msg-001'
);

SELECT is((SELECT duplicate FROM r5), true, 'duplicata pós-resolução: duplicate = true');
SELECT is((SELECT reopened FROM r5), false, 'duplicata pós-resolução: NÃO reabre');
SELECT is(
  (SELECT status FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)),
  'resolved'::public.conversation_status,
  'duplicata pós-resolução: conversa continua resolved'
);
SELECT is(
  (SELECT (resolved_at, assigned_user_id, assigned_at, last_message_at) FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)),
  (SELECT (resolved_at, assigned_user_id, assigned_at, last_message_at) FROM snapshot_before_dup),
  'duplicata pós-resolução: resolved_at/atribuição/last_message_at inalterados'
);

-- ---------------------------------------------------------------------------
-- 6) Mensagem nova após resolução: reabre a MESMA conversa e limpa atribuição.
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE r6 AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999990001',
  p_content => 'nova mensagem pós-resolução',
  p_external_message_id => 'wa-msg-004'
);

SELECT is((SELECT created FROM r6), true, 'reabertura: created = true');
SELECT is((SELECT duplicate FROM r6), false, 'reabertura: duplicate = false');
SELECT is((SELECT reopened FROM r6), true, 'reabertura: reopened = true');
SELECT is((SELECT conversation_id FROM r6), (SELECT conversation_id FROM r1), 'reabertura: é a MESMA linha de conversa, não uma nova');
SELECT is(
  (SELECT status FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)),
  'waiting'::public.conversation_status,
  'reabertura: status volta para waiting'
);
SELECT ok((SELECT resolved_at FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)) IS NULL, 'reabertura: resolved_at limpo');
SELECT ok((SELECT assigned_user_id FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)) IS NULL, 'reabertura: assigned_user_id limpo');
SELECT ok((SELECT assigned_at FROM public.conversations WHERE id = (SELECT conversation_id FROM r1)) IS NULL, 'reabertura: assigned_at limpo');

-- ---------------------------------------------------------------------------
-- 7) Entradas inválidas (chamador válido e autorizado: owner de org_a).
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '5511999991001', p_content => 'x', p_external_message_id => 'inv-1') $$,
  'antero_ingest: invalid_phone_number%',
  'entrada inválida: telefone sem "+" é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+0511999991001', p_content => 'x', p_external_message_id => 'inv-2') $$,
  'antero_ingest: invalid_phone_number%',
  'entrada inválida: telefone com código de país iniciando em 0 é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999991002', p_content => '    ', p_external_message_id => 'inv-3') $$,
  'antero_ingest: empty_content%',
  'entrada inválida: conteúdo só com espaços é rejeitado após trim'
);

SELECT throws_like(
  format(
    $fmt$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => %L::uuid, p_phone_number => '+5511999991003', p_content => %L, p_external_message_id => 'inv-4') $fmt$,
    (SELECT v FROM ids WHERE k = 'account_a1'),
    repeat('a', 4097)
  ),
  'antero_ingest: content_too_long%',
  'entrada inválida: conteúdo acima de 4096 caracteres é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999991004', p_content => 'x', p_external_message_id => null) $$,
  'antero_ingest: missing_external_message_id%',
  'entrada inválida: external_message_id nulo é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999991005', p_content => 'x', p_external_message_id => '   ') $$,
  'antero_ingest: missing_external_message_id%',
  'entrada inválida: external_message_id só com espaços é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 8) Conta inativa (disconnected).
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a_inactive'), p_phone_number => '+5511999992001', p_content => 'x', p_external_message_id => 'inactive-1') $$,
  'antero_ingest: account_inactive%',
  'conta inativa (disconnected) é rejeitada'
);

-- ---------------------------------------------------------------------------
-- 9) Conta com provider diferente de development.
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a_cloud'), p_phone_number => '+5511999992002', p_content => 'x', p_external_message_id => 'cloud-1') $$,
  'antero_ingest: account_wrong_provider%',
  'conta com provider cloud_api é rejeitada nesta etapa'
);

-- ---------------------------------------------------------------------------
-- 10) Usuário sem vínculo com a organização.
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_no_membership'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993001', p_content => 'x', p_external_message_id => 'no-member-1') $$,
  'antero_ingest: not_authorized%',
  'usuário sem vínculo com a organização é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 11) attendant (não owner/admin).
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_attendant'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993002', p_content => 'x', p_external_message_id => 'attendant-1') $$,
  'antero_ingest: not_authorized%',
  'attendant (não owner/admin) é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 12) Membro com status disabled (mesmo sendo role admin).
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_admin_disabled'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993003', p_content => 'x', p_external_message_id => 'disabled-1') $$,
  'antero_ingest: not_authorized%',
  'admin com status disabled é rejeitado'
);

-- ---------------------------------------------------------------------------
-- Bônus: chamador sem sessão (auth.uid() nulo) — validação explícita exigida
-- mesmo não sendo um dos 13 itens de corrida/cenário enumerados.
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => NULL, p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993004', p_content => 'x', p_external_message_id => 'anon-1') $$,
  'antero_ingest: not_authenticated%',
  'chamador sem auth.uid() (sessão anônima) é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 13) Simulação de corrida: contenção pré-existente "vencida por outra
-- transação". Ver nota no cabeçalho do arquivo sobre o limite de uma única
-- sessão pgTAP.
-- ---------------------------------------------------------------------------

-- 13a) duas primeiras mensagens simultâneas do mesmo telefone / criação
-- concorrente de contato.
WITH new_contact AS (
  INSERT INTO public.contacts (organization_id, phone_number, name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), '+5511999994001', 'Vencedor da Corrida')
  RETURNING id
)
INSERT INTO ids SELECT 'contact_race', id FROM new_contact;


CREATE TEMP TABLE r13a AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'),
  p_phone_number => '+5511999994001',
  p_content => 'primeira mensagem real após a corrida de contato',
  p_external_message_id => 'race-contact-1'
);

SELECT is((SELECT contact_id FROM r13a), (SELECT v FROM ids WHERE k = 'contact_race'), 'corrida de contato: usa o contato que já existia, não cria outro');
SELECT is(
  (SELECT count(*)::int FROM public.contacts WHERE organization_id = (SELECT v FROM ids WHERE k = 'org_a') AND phone_number = '+5511999994001'),
  1,
  'corrida de contato: continua existindo exatamente 1 contato para o telefone'
);

-- 13b) criação concorrente de conversa (contato já existe; a conversa em um
-- canal novo é o objeto da corrida desta vez).
WITH new_conv AS (
  INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'account_a2'), (SELECT v FROM ids WHERE k = 'contact_race'))
  RETURNING id
)
INSERT INTO ids SELECT 'conversation_race', id FROM new_conv;


CREATE TEMP TABLE r13b AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a2'),
  p_phone_number => '+5511999994001',
  p_content => 'primeira mensagem real após a corrida de conversa',
  p_external_message_id => 'race-conversation-1'
);

SELECT is((SELECT conversation_id FROM r13b), (SELECT v FROM ids WHERE k = 'conversation_race'), 'corrida de conversa: usa a conversa que já existia, não cria outra');
SELECT is(
  (SELECT count(*)::int FROM public.conversations WHERE organization_id = (SELECT v FROM ids WHERE k = 'org_a') AND whatsapp_account_id = (SELECT v FROM ids WHERE k = 'account_a2') AND contact_id = (SELECT v FROM ids WHERE k = 'contact_race')),
  1,
  'corrida de conversa: continua existindo exatamente 1 conversa para (conta, contato)'
);

-- 13c) duas entregas simultâneas com o mesmo external_message_id.
WITH new_msg AS (
  INSERT INTO public.messages (
    organization_id, conversation_id, whatsapp_account_id,
    external_message_id, direction, sender_type, sender_user_id,
    message_type, content, delivery_status
  )
  VALUES (
    (SELECT v FROM ids WHERE k = 'org_a'),
    (SELECT v FROM ids WHERE k = 'conversation_race'),
    (SELECT v FROM ids WHERE k = 'account_a2'),
    'race-external-id-1', 'inbound', 'contact', null, 'text',
    'mensagem que venceu a corrida de external_message_id', 'delivered'
  )
  RETURNING id
)
INSERT INTO ids SELECT 'message_race', id FROM new_msg;


CREATE TEMP TABLE r13c AS
SELECT * FROM pg_temp.ingest_as(
  p_user => pg_temp.id('user_owner'),
  p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a2'),
  p_phone_number => '+5511999994001',
  p_content => 'mensagem perdedora da corrida de external_message_id',
  p_external_message_id => 'race-external-id-1'
);

SELECT is((SELECT duplicate FROM r13c), true, 'corrida de external_message_id: quem perde a corrida recebe duplicate = true');
SELECT is((SELECT message_id FROM r13c), (SELECT v FROM ids WHERE k = 'message_race'), 'corrida de external_message_id: retorna o id da mensagem que venceu a corrida');
SELECT is(
  (SELECT count(*)::int FROM public.messages WHERE whatsapp_account_id = (SELECT v FROM ids WHERE k = 'account_a2') AND external_message_id = 'race-external-id-1'),
  1,
  'corrida de external_message_id: continua existindo exatamente 1 mensagem para o id externo'
);

-- Nota: o item 13 "duplicata recebida depois da conversa ser resolvida" já
-- está coberto pela seção 5 acima (mensagem que perderia a corrida contra o
-- fechamento da conversa produz o mesmo efeito de "duplicate = true, sem
-- reabrir").

-- ---------------------------------------------------------------------------
-- 14) Isolamento entre organizações (novo na Entrega 2): owner ativo da Org A
-- não consegue ingerir mensagem numa conta da Org B.
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM pg_temp.ingest_as(p_user => pg_temp.id('user_owner'), p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_b1'), p_phone_number => '+5511999995001', p_content => 'x', p_external_message_id => 'cross-org-1') $$,
  'antero_ingest: not_authorized%',
  'owner da Org A NÃO ingere em conta da Org B'
);

SELECT * FROM finish();
ROLLBACK;

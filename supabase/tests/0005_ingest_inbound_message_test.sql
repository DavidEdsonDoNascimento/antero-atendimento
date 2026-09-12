-- Antero Atendimento — Ciclo 2, Etapa 3
-- Testes pgTAP de public.ingest_inbound_message().
--
-- Roda inteiro dentro de uma transação (BEGIN...ROLLBACK): nenhum dado fica
-- permanente no banco após `supabase test db`. Fixtures ficam em uma tabela
-- temporária (ids) para evitar `\set` do psql, mantendo o arquivo portável
-- para o runner do Supabase CLI.
--
-- Convenção de papel: fixtures administrativas (criar organização, conta,
-- vínculo, marcar conversa como resolvida "manualmente" para montar um
-- cenário, ou pré-inserir uma linha para simular quem "venceu" uma corrida)
-- rodam com o role padrão da sessão de teste (dono das tabelas, ignora RLS
-- e os GRANTs do Ciclo 2). A chamada à função sob teste roda como
-- `authenticated`, com `request.jwt.claim.sub` apontando para o usuário do
-- cenário — é assim que auth.uid() enxerga "quem está chamando" dentro da
-- função SECURITY DEFINER.
--
-- Concorrência (item 13 do Ciclo 2): pgTAP roda em uma única sessão/
-- transação, então não há como abrir duas conexões concorrentes de verdade
-- neste arquivo. Os testes de corrida (seção 13 abaixo) simulam o RESULTADO
-- de uma corrida vencida por "outra transação", pré-inserindo a linha
-- contestada antes de chamar a função, e verificam que a função cai no
-- ramo de fallback (SELECT após ON CONFLICT DO NOTHING) em vez de duplicar
-- ou falhar. A garantia real contra concorrência é a UNIQUE constraint/
-- índice de cada tabela (auditada logo abaixo), não uma verificação prévia
-- da função — uma prova com duas conexões reais exigiria um harness
-- multi-sessão (dblink/pg_background ou dois processos psql), fora do
-- escopo desta etapa por não estar instalado no projeto.

BEGIN;
SELECT plan(60);

-- ---------------------------------------------------------------------------
-- Auditoria estática: a autoridade contra duplicidade é a constraint, não
-- uma query prévia da função.
-- ---------------------------------------------------------------------------
SELECT has_index(
  'public', 'messages', 'messages_whatsapp_account_external_id_key',
  'messages_whatsapp_account_external_id_key deve existir (autoridade de idempotência)'
);

-- ---------------------------------------------------------------------------
-- Segurança de EXECUTE: só authenticated.
-- ---------------------------------------------------------------------------
SELECT ok(
  has_function_privilege('authenticated', 'public.ingest_inbound_message(uuid, text, text, text, text)', 'EXECUTE'),
  'authenticated tem EXECUTE em ingest_inbound_message'
);
SELECT ok(
  not has_function_privilege('anon', 'public.ingest_inbound_message(uuid, text, text, text, text)', 'EXECUTE'),
  'anon NÃO tem EXECUTE em ingest_inbound_message'
);
SELECT ok(
  not has_function_privilege('public', 'public.ingest_inbound_message(uuid, text, text, text, text)', 'EXECUTE'),
  'public NÃO tem EXECUTE em ingest_inbound_message'
);

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
-- Criada como o role de conexão do teste (superusuário local); precisa de
-- GRANT explícito para continuar legível depois de "SET LOCAL ROLE
-- authenticated" — SET ROLE troca o current_user para fins de checagem de
-- privilégio, então deixa de valer o bypass de superusuário.
GRANT SELECT ON ids TO authenticated;

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

-- Usuários (auth.users -> profiles via handle_new_user). Um por papel/status
-- necessário nos cenários, mais um usuário sem vínculo algum.
WITH new_user AS (
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'owner-0005@teste.local', 'x', now(), now(), now(), '{}', '{}'
  ) RETURNING id
)
INSERT INTO ids SELECT 'user_owner', id FROM new_user;

WITH new_user AS (
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'admin-disabled-0005@teste.local', 'x', now(), now(), now(), '{}', '{}'
  ) RETURNING id
)
INSERT INTO ids SELECT 'user_admin_disabled', id FROM new_user;

WITH new_user AS (
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'attendant-0005@teste.local', 'x', now(), now(), now(), '{}', '{}'
  ) RETURNING id
)
INSERT INTO ids SELECT 'user_attendant', id FROM new_user;

WITH new_user AS (
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    'no-membership-0005@teste.local', 'x', now(), now(), now(), '{}', '{}'
  ) RETURNING id
)
INSERT INTO ids SELECT 'user_no_membership', id FROM new_user;

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'user_owner'), 'owner', 'active'),
  ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'user_admin_disabled'), 'admin', 'disabled'),
  ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'user_attendant'), 'attendant', 'active');
-- user_no_membership propositalmente sem linha em organization_members.

-- ---------------------------------------------------------------------------
-- 1) Fluxo completo: contato, conversa e mensagem novos.
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_owner'), true);

CREATE TEMP TABLE r1 AS
SELECT * FROM public.ingest_inbound_message(
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
SELECT * FROM public.ingest_inbound_message(
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
SELECT * FROM public.ingest_inbound_message(
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
SELECT * FROM public.ingest_inbound_message(
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
-- 5) Duplicidade após resolução: NÃO reabre.
-- Marca a conversa de r1 como resolved (fixture administrativa, fora da
-- função sob teste) com uma atribuição prévia, para provar que a duplicata
-- não mexe em nada disso.
-- ---------------------------------------------------------------------------
RESET ROLE;
UPDATE public.conversations
SET status = 'resolved', resolved_at = now(),
    assigned_user_id = (SELECT v FROM ids WHERE k = 'user_owner'),
    assigned_at = now()
WHERE id = (SELECT conversation_id FROM r1);

CREATE TEMP TABLE snapshot_before_dup AS
SELECT status, resolved_at, assigned_user_id, assigned_at, last_message_at
FROM public.conversations WHERE id = (SELECT conversation_id FROM r1);
GRANT SELECT ON snapshot_before_dup TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_owner'), true);

CREATE TEMP TABLE r5 AS
SELECT * FROM public.ingest_inbound_message(
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
SELECT * FROM public.ingest_inbound_message(
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
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '5511999991001', p_content => 'x', p_external_message_id => 'inv-1') $$,
  'antero_ingest: invalid_phone_number%',
  'entrada inválida: telefone sem "+" é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+0511999991001', p_content => 'x', p_external_message_id => 'inv-2') $$,
  'antero_ingest: invalid_phone_number%',
  'entrada inválida: telefone com código de país iniciando em 0 é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999991002', p_content => '    ', p_external_message_id => 'inv-3') $$,
  'antero_ingest: empty_content%',
  'entrada inválida: conteúdo só com espaços é rejeitado após trim'
);

SELECT throws_like(
  format(
    $fmt$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => %L::uuid, p_phone_number => '+5511999991003', p_content => %L, p_external_message_id => 'inv-4') $fmt$,
    (SELECT v FROM ids WHERE k = 'account_a1'),
    repeat('a', 4097)
  ),
  'antero_ingest: content_too_long%',
  'entrada inválida: conteúdo acima de 4096 caracteres é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999991004', p_content => 'x', p_external_message_id => null) $$,
  'antero_ingest: missing_external_message_id%',
  'entrada inválida: external_message_id nulo é rejeitado'
);

SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999991005', p_content => 'x', p_external_message_id => '   ') $$,
  'antero_ingest: missing_external_message_id%',
  'entrada inválida: external_message_id só com espaços é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 8) Conta inativa (disconnected).
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a_inactive'), p_phone_number => '+5511999992001', p_content => 'x', p_external_message_id => 'inactive-1') $$,
  'antero_ingest: account_inactive%',
  'conta inativa (disconnected) é rejeitada'
);

-- ---------------------------------------------------------------------------
-- 9) Conta com provider diferente de development.
-- ---------------------------------------------------------------------------
SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a_cloud'), p_phone_number => '+5511999992002', p_content => 'x', p_external_message_id => 'cloud-1') $$,
  'antero_ingest: account_wrong_provider%',
  'conta com provider cloud_api é rejeitada nesta etapa'
);

-- ---------------------------------------------------------------------------
-- 10) Usuário sem vínculo com a organização.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_no_membership'), true);
SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993001', p_content => 'x', p_external_message_id => 'no-member-1') $$,
  'antero_ingest: not_authorized%',
  'usuário sem vínculo com a organização é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 11) attendant (não owner/admin).
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_attendant'), true);
SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993002', p_content => 'x', p_external_message_id => 'attendant-1') $$,
  'antero_ingest: not_authorized%',
  'attendant (não owner/admin) é rejeitado'
);

-- ---------------------------------------------------------------------------
-- 12) Membro com status disabled (mesmo sendo role admin).
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_admin_disabled'), true);
SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993003', p_content => 'x', p_external_message_id => 'disabled-1') $$,
  'antero_ingest: not_authorized%',
  'admin com status disabled é rejeitado'
);

-- ---------------------------------------------------------------------------
-- Bônus: chamador sem sessão (auth.uid() nulo) — validação explícita exigida
-- mesmo não sendo um dos 13 itens de corrida/cenário enumerados.
-- ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT throws_like(
  $$ SELECT * FROM public.ingest_inbound_message(p_whatsapp_account_id => (SELECT v FROM ids WHERE k = 'account_a1'), p_phone_number => '+5511999993004', p_content => 'x', p_external_message_id => 'anon-1') $$,
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
RESET ROLE;
WITH new_contact AS (
  INSERT INTO public.contacts (organization_id, phone_number, name)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), '+5511999994001', 'Vencedor da Corrida')
  RETURNING id
)
INSERT INTO ids SELECT 'contact_race', id FROM new_contact;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_owner'), true);

CREATE TEMP TABLE r13a AS
SELECT * FROM public.ingest_inbound_message(
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
RESET ROLE;
WITH new_conv AS (
  INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id)
  VALUES ((SELECT v FROM ids WHERE k = 'org_a'), (SELECT v FROM ids WHERE k = 'account_a2'), (SELECT v FROM ids WHERE k = 'contact_race'))
  RETURNING id
)
INSERT INTO ids SELECT 'conversation_race', id FROM new_conv;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_owner'), true);

CREATE TEMP TABLE r13b AS
SELECT * FROM public.ingest_inbound_message(
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
RESET ROLE;
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

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', (SELECT v::text FROM ids WHERE k = 'user_owner'), true);

CREATE TEMP TABLE r13c AS
SELECT * FROM public.ingest_inbound_message(
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

RESET ROLE;
SELECT * FROM finish();
ROLLBACK;

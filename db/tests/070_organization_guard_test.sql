-- Antero Atendimentos — Entrega E1A: guarda da organização.
--
-- Comportamento com os papéis reais: toda asserção de acesso roda como
-- antero_app (sem BYPASSRLS) com o contexto do usuário. O status é alterado
-- aqui como superusuário do banco descartável, só para montar cada cenário; a
-- operação oficial de suspensão é testada em 071.
--
-- Cenário: A (será suspensa) e B (sempre ativa); multi é membro ativo das
-- duas; platform é admin da plataforma sem vínculo; platform_member é admin
-- da plataforma E membro ativo de A.
BEGIN;
\ir lib/helpers.psql
SELECT plan(80);

INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-070'), ('Org B', 'org-b-070');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-070';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-070';

SELECT pg_temp.new_user('a_owner', 'a.owner.070@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.070@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.070@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.070@teste.local', 'A Desativado');
SELECT pg_temp.new_user('b_owner', 'b.owner.070@teste.local', 'B Owner');
SELECT pg_temp.new_user('multi', 'multi.070@teste.local', 'Multi');
SELECT pg_temp.new_user('platform', 'platform.070@teste.local', 'Plataforma');
SELECT pg_temp.new_user('platform_member', 'platform.member.070@teste.local', 'Plataforma Membro');
SELECT pg_temp.new_user('recruit', 'recruit.070@teste.local', 'Recruta');
UPDATE public.profiles SET is_platform_admin = true WHERE id IN (pg_temp.id('platform'), pg_temp.id('platform_member'));

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'admin', 'disabled'),
  (pg_temp.id('org_a'), pg_temp.id('multi'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('platform_member'), 'owner', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active'),
  (pg_temp.id('org_b'), pg_temp.id('multi'), 'attendant', 'active');

INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, phone_number) VALUES
  (pg_temp.id('org_a'), 'development', 'connected', 'Canal A 070', 'phone-id-a-070', '+5511900000701'),
  (pg_temp.id('org_b'), 'cloud_api', 'connected', 'Canal B 070', 'phone-id-b-070', '+5511900000702');
INSERT INTO ids SELECT 'wa_a', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A 070';
INSERT INTO ids SELECT 'wa_b', id FROM public.whatsapp_accounts WHERE display_name = 'Canal B 070';

INSERT INTO public.contacts (organization_id, phone_number, name) VALUES
  (pg_temp.id('org_a'), '+5511900000711', 'Cliente A'),
  (pg_temp.id('org_b'), '+5511900000712', 'Cliente B');
INSERT INTO ids SELECT 'ct_a', id FROM public.contacts WHERE name = 'Cliente A';
INSERT INTO ids SELECT 'ct_b', id FROM public.contacts WHERE name = 'Cliente B';

INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id) VALUES
  (pg_temp.id('org_a'), pg_temp.id('wa_a'), pg_temp.id('ct_a')),
  (pg_temp.id('org_b'), pg_temp.id('wa_b'), pg_temp.id('ct_b'));
INSERT INTO ids SELECT 'cv_a', id FROM public.conversations WHERE contact_id = pg_temp.id('ct_a');
INSERT INTO ids SELECT 'cv_b', id FROM public.conversations WHERE contact_id = pg_temp.id('ct_b');

INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content) VALUES
  (pg_temp.id('org_a'), pg_temp.id('cv_a'), pg_temp.id('wa_a'), 'inbound', 'contact', 'mensagem A'),
  (pg_temp.id('org_b'), pg_temp.id('cv_b'), pg_temp.id('wa_b'), 'inbound', 'contact', 'mensagem B');

-- ---------------------------------------------------------------------------
-- Organização ATIVA: o acesso normal continua igual
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organizations WHERE id = {org_a}'), 1::bigint, 'ativa: membro vê a organização');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.contacts'), 1::bigint, 'ativa: membro vê contatos');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.conversations'), 1::bigint, 'ativa: membro vê conversas');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.messages'), 1::bigint, 'ativa: membro vê mensagens');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.whatsapp_accounts'), 1::bigint, 'ativa: membro vê o canal');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.profiles WHERE id = {a_owner}'), 1::bigint, 'ativa: membro vê colega');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_member({org_a})')), 'true', 'ativa: is_org_member = true');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_admin({org_a})')), 'true', 'ativa: is_org_admin = true');

-- ---------------------------------------------------------------------------
-- organizations: campos protegidos, mesmo com a organização ativa
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET status = 'inactive' WHERE id = {org_a}$q$)$$, '42501', NULL, 'owner NÃO altera status da própria organização');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.organizations SET status = 'inactive' WHERE id = {org_a}$q$)$$, '42501', NULL, 'admin NÃO altera status da própria organização');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$UPDATE public.organizations SET status = 'inactive' WHERE id = {org_a}$q$)$$, '42501', NULL, 'atendente NÃO altera status');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET slug = 'hack-070' WHERE id = {org_a}$q$)$$, '42501', NULL, 'owner NÃO altera slug');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET id = gen_random_uuid() WHERE id = {org_a}$q$)$$, '42501', NULL, 'owner NÃO altera id');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET created_at = now() WHERE id = {org_a}$q$)$$, '42501', NULL, 'owner NÃO altera created_at');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET updated_at = now() WHERE id = {org_a}$q$)$$, '42501', NULL, 'owner NÃO altera updated_at diretamente');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$UPDATE public.organizations SET status = 'inactive' WHERE id = {org_a}$q$)$$, '42501', NULL, 'nem o admin da plataforma altera status sem a operação oficial');
SELECT is(pg_temp.does('a_admin', $q$UPDATE public.organizations SET name = 'Org A' WHERE id = {org_a}$q$), 1::bigint, 'admin ainda altera o nome da própria organização');
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.organizations SET name = 'Org A' WHERE id = {org_a}$q$), 1::bigint, 'owner ainda altera o nome da própria organização');
SELECT is(pg_temp.does('a_att', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_a}$q$), 0::bigint, 'atendente NÃO altera o nome');
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_b}$q$), 0::bigint, 'owner de A NÃO altera o nome de B');
SELECT is(pg_temp.does('platform', $q$UPDATE public.organizations SET name = 'Org B' WHERE id = {org_b}$q$), 1::bigint, 'admin da plataforma altera o nome de qualquer organização');

-- ---------------------------------------------------------------------------
-- whatsapp_accounts: nenhuma escrita direta pela aplicação
-- ---------------------------------------------------------------------------
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET external_account_id = 'phone-id-b-070' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'owner NÃO aponta o canal para o identificador de outra empresa');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.whatsapp_accounts SET external_account_id = 'qualquer' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'admin NÃO altera external_account_id');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET provider = 'cloud_api' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'owner NÃO altera provider');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET status = 'disconnected' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'owner NÃO altera status do canal');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET phone_number = '+5511900000799' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'owner NÃO altera phone_number');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET organization_id = {org_b} WHERE id = {wa_a}$q$)$$, '42501', NULL, 'owner NÃO move o canal de organização');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET display_name = 'Novo' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'owner NÃO altera display_name diretamente');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$UPDATE public.whatsapp_accounts SET external_account_id = 'x' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'atendente NÃO altera o canal');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.whatsapp_accounts (organization_id, provider, status, external_account_id) VALUES ({org_a}, 'cloud_api', 'connected', 'phone-id-b-070')$q$)$$, '42501', NULL, 'owner NÃO cria canal com identificador de outra empresa');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', 'DELETE FROM public.whatsapp_accounts WHERE id = {wa_a}')$$, '42501', NULL, 'owner NÃO apaga canal');
SELECT throws_ok($$SELECT pg_temp.does('platform', $q$UPDATE public.whatsapp_accounts SET external_account_id = 'x' WHERE id = {wa_a}$q$)$$, '42501', NULL, 'admin da plataforma também não grava canal sem operação explícita');
SELECT is((SELECT external_account_id FROM public.whatsapp_accounts WHERE id = pg_temp.id('wa_a')), 'phone-id-a-070', 'identificador do canal A intacto');
SELECT is(pg_temp.sees('a_owner', 'SELECT id, external_account_id, provider, phone_number, display_name, status FROM public.whatsapp_accounts'), 1::bigint, 'leitura do canal preservada');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.whatsapp_accounts WHERE organization_id IN ({org_a}, {org_b})'), 2::bigint, 'admin da plataforma ainda lê os canais');

-- ---------------------------------------------------------------------------
-- Organização SUSPENSA: sessão existente deixa de operar na requisição seguinte
-- ---------------------------------------------------------------------------
UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_a');

SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_member({org_a})')), 'false', 'suspensa: is_org_member = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_owner'), pg_temp.fill('public.is_org_admin({org_a})')), 'false', 'suspensa: is_org_admin = false');
SELECT is(pg_temp.app_value(pg_temp.id('a_att'), pg_temp.fill('public.shares_org_with({a_owner})')), 'false', 'suspensa: colegas deixam de se ver por shares_org_with');

SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.organizations'), 0::bigint, 'suspensa: owner não lê organizations');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.organization_members'), 0::bigint, 'suspensa: owner não lê organization_members');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.whatsapp_accounts'), 0::bigint, 'suspensa: owner não lê whatsapp_accounts');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.contacts'), 0::bigint, 'suspensa: owner não lê contacts');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.conversations'), 0::bigint, 'suspensa: owner não lê conversations');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.messages'), 0::bigint, 'suspensa: owner não lê messages');
SELECT is(pg_temp.sees('a_admin', 'SELECT 1 FROM public.messages'), 0::bigint, 'suspensa: admin não lê messages');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.conversations'), 0::bigint, 'suspensa: atendente não lê conversations');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.profiles WHERE id = {a_owner}'), 0::bigint, 'suspensa: atendente não lê perfil de colega');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.profiles WHERE id = {a_att}'), 1::bigint, 'suspensa: usuário ainda lê o próprio perfil (identidade separada da autorização)');

-- Tentativas de escrita após a suspensão.
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_a}$q$), 0::bigint, 'suspensa: owner NÃO altera o nome');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.organizations SET status = 'active' WHERE id = {org_a}$q$)$$, '42501', NULL, 'suspensa: owner NÃO reativa');
SELECT throws_ok($$SELECT pg_temp.does('a_admin', $q$UPDATE public.organizations SET status = 'active' WHERE id = {org_a}$q$)$$, '42501', NULL, 'suspensa: admin NÃO reativa');
SELECT throws_ok($$SELECT pg_temp.does('a_att', $q$UPDATE public.organizations SET status = 'active' WHERE id = {org_a}$q$)$$, '42501', NULL, 'suspensa: atendente NÃO reativa');
SELECT is((SELECT status::text FROM public.organizations WHERE id = pg_temp.id('org_a')), 'inactive', 'suspensa: status permanece inactive');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {recruit}, 'owner')$q$)$$, '42501', NULL, 'suspensa: owner NÃO adiciona membro');
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.organization_members SET role = 'attendant' WHERE user_id = {a_att}$q$), 0::bigint, 'suspensa: owner NÃO altera vínculo');
SELECT is(pg_temp.does('a_owner', 'DELETE FROM public.organization_members WHERE user_id = {a_att}'), 0::bigint, 'suspensa: owner NÃO remove vínculo');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.conversations SET status = 'resolved', resolved_at = now() WHERE id = {cv_a}$q$)$$, '42501', NULL, 'suspensa: owner NÃO altera conversa');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', $q$UPDATE public.contacts SET name = 'Hack' WHERE id = {ct_a}$q$)$$, '42501', NULL, 'suspensa: owner NÃO altera contato');
SELECT throws_ok($$SELECT pg_temp.does('a_owner', 'DELETE FROM public.messages')$$, '42501', NULL, 'suspensa: owner NÃO apaga mensagem');

-- Função privilegiada não contorna a suspensão.
SELECT throws_ok(
  $$SELECT * FROM pg_temp.ingest_as(pg_temp.id('a_owner'), pg_temp.id('wa_a'), '+5511900000720', 'via ingestão', 'ext-070-1')$$,
  '42501', NULL, 'suspensa: ingest_inbound_message recusa o owner'
);
SELECT is((SELECT count(*)::int FROM public.messages WHERE organization_id = pg_temp.id('org_a')), 1, 'suspensa: ingestão recusada não gravou mensagem');

-- Vínculos com várias organizações e outras empresas não são afetados.
SELECT is(pg_temp.app_value(pg_temp.id('multi'), pg_temp.fill('public.is_org_member({org_a})')), 'false', 'multi: sem acesso à organização suspensa');
SELECT is(pg_temp.app_value(pg_temp.id('multi'), pg_temp.fill('public.is_org_member({org_b})')), 'true', 'multi: acesso à organização ativa mantido');
SELECT is(pg_temp.sees('multi', 'SELECT 1 FROM public.conversations WHERE id = {cv_a}'), 0::bigint, 'multi: não lê conversa da suspensa');
SELECT is(pg_temp.sees('multi', 'SELECT 1 FROM public.conversations WHERE id = {cv_b}'), 1::bigint, 'multi: lê conversa da ativa');
SELECT is(pg_temp.sees('multi', 'SELECT 1 FROM public.profiles WHERE id = {a_owner}'), 0::bigint, 'multi: não vê colega só da suspensa');
SELECT is(pg_temp.sees('multi', 'SELECT 1 FROM public.profiles WHERE id = {b_owner}'), 1::bigint, 'multi: vê colega da ativa');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.conversations'), 1::bigint, 'outra empresa: B continua operando');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.conversations WHERE id = {cv_a}'), 0::bigint, 'outra empresa: B não enxerga A');

-- Admin da plataforma: vê a organização e o status, não o conteúdo.
SELECT is(pg_temp.sees('platform', $q$SELECT 1 FROM public.organizations WHERE id = {org_a} AND status = 'inactive'$q$), 1::bigint, 'plataforma: vê a organização suspensa e o status');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.organization_members WHERE organization_id = {org_a}'), 6::bigint, 'plataforma: vê os vínculos');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.whatsapp_accounts WHERE id = {wa_a}'), 1::bigint, 'plataforma: vê o canal');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.messages WHERE organization_id = {org_a}'), 0::bigint, 'plataforma: continua sem ler mensagens');
SELECT is(pg_temp.app_value(pg_temp.id('platform_member'), pg_temp.fill('public.is_org_member({org_a})')), 'false', 'plataforma + membro: vínculo não opera na suspensa');
SELECT is(pg_temp.sees('platform_member', 'SELECT 1 FROM public.conversations WHERE organization_id = {org_a}'), 0::bigint, 'plataforma + membro: sem conversas da suspensa');

-- Vínculo desativado continua sem acesso, ativa ou não.
SELECT is(pg_temp.sees('a_disabled', 'SELECT 1 FROM public.conversations'), 0::bigint, 'desativado: sem conversas');

-- ---------------------------------------------------------------------------
-- Reativação: nada foi apagado e as permissões voltam
-- ---------------------------------------------------------------------------
UPDATE public.organizations SET status = 'active' WHERE id = pg_temp.id('org_a');

SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.messages'), 1::bigint, 'reativada: atendente lê as mesmas mensagens');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.organization_members'), 6::bigint, 'reativada: vínculos preservados');
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.organizations SET name = 'Org A' WHERE id = {org_a}$q$), 1::bigint, 'reativada: owner volta a editar o nome');
SELECT is(pg_temp.sees('a_disabled', 'SELECT 1 FROM public.conversations'), 0::bigint, 'reativada: desativado continua sem acesso');

SELECT * FROM finish();
ROLLBACK;

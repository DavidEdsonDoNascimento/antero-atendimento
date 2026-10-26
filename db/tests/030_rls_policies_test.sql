-- Antero Atendimentos — Entrega 2: as 17 políticas de RLS, testadas por
-- COMPORTAMENTO (não basta a política existir).
--
-- Cenário: duas organizações (A e B), membros de A em todos os papéis e
-- status, dono de B, usuário sem organização e admin da plataforma. Todas as
-- consultas sob teste rodam como antero_app com o contexto do usuário
-- (app.set_user_context), como a aplicação fará; NULL = sem contexto.
BEGIN;
\ir lib/helpers.psql
SELECT plan(103);

-- ---------------------------------------------------------------------------
-- Fixtures (como superusuário do banco descartável; identidades via antero_auth)
-- ---------------------------------------------------------------------------
INSERT INTO public.organizations (name, slug) VALUES ('Org A', 'org-a-030'), ('Org B', 'org-b-030');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-030';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-030';

SELECT pg_temp.new_user('a_owner', 'a.owner.030@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.030@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.030@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_disabled', 'a.disabled.030@teste.local', 'A Admin Desativado');
SELECT pg_temp.new_user('a_invited', 'a.invited.030@teste.local', 'A Convidado');
SELECT pg_temp.new_user('b_owner', 'b.owner.030@teste.local', 'B Owner');
SELECT pg_temp.new_user('nobody', 'nobody.030@teste.local', 'Sem Organização');
SELECT pg_temp.new_user('platform', 'platform.030@teste.local', 'Admin Plataforma');
-- Sem vínculo no início; adicionados durante os testes de INSERT.
SELECT pg_temp.new_user('a_recruit', 'a.recruit.030@teste.local', 'A Recruta');
SELECT pg_temp.new_user('b_recruit', 'b.recruit.030@teste.local', 'B Recruta');
UPDATE public.profiles SET is_platform_admin = true WHERE id = pg_temp.id('platform');

INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_disabled'), 'admin', 'disabled'),
  (pg_temp.id('org_a'), pg_temp.id('a_invited'), 'attendant', 'invited'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active');
INSERT INTO ids SELECT 'm_a_att', id FROM public.organization_members WHERE user_id = pg_temp.id('a_att');
INSERT INTO ids SELECT 'm_a_invited', id FROM public.organization_members WHERE user_id = pg_temp.id('a_invited');

INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name) VALUES
  (pg_temp.id('org_a'), 'development', 'connected', 'Canal A'),
  (pg_temp.id('org_b'), 'development', 'connected', 'Canal B');
INSERT INTO ids SELECT 'wa_a', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A';
INSERT INTO ids SELECT 'wa_b', id FROM public.whatsapp_accounts WHERE display_name = 'Canal B';

INSERT INTO public.contacts (organization_id, phone_number, name) VALUES
  (pg_temp.id('org_a'), '+5511900000301', 'Cliente A'),
  (pg_temp.id('org_b'), '+5511900000302', 'Cliente B');
INSERT INTO ids SELECT 'ct_a', id FROM public.contacts WHERE name = 'Cliente A';
INSERT INTO ids SELECT 'ct_b', id FROM public.contacts WHERE name = 'Cliente B';

INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id) VALUES
  (pg_temp.id('org_a'), pg_temp.id('wa_a'), pg_temp.id('ct_a')),
  (pg_temp.id('org_b'), pg_temp.id('wa_b'), pg_temp.id('ct_b'));
INSERT INTO ids SELECT 'cv_a', id FROM public.conversations WHERE contact_id = pg_temp.id('ct_a');
INSERT INTO ids SELECT 'cv_b', id FROM public.conversations WHERE contact_id = pg_temp.id('ct_b');

INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content)
VALUES
  (pg_temp.id('org_a'), pg_temp.id('cv_a'), pg_temp.id('wa_a'), 'inbound', 'contact', 'mensagem da org A'),
  (pg_temp.id('org_b'), pg_temp.id('cv_b'), pg_temp.id('wa_b'), 'inbound', 'contact', 'mensagem da org B');

-- ---------------------------------------------------------------------------
-- Estrutura: RLS ligada, 17 políticas exatas, todas só para antero_app
-- ---------------------------------------------------------------------------
SELECT ok(
  (SELECT bool_and(c.relrowsecurity) FROM pg_class c
   WHERE c.oid IN ('public.profiles'::regclass, 'public.organizations'::regclass,
                   'public.organization_members'::regclass, 'public.whatsapp_accounts'::regclass,
                   'public.contacts'::regclass, 'public.conversations'::regclass, 'public.messages'::regclass)),
  'RLS habilitada nas 7 tabelas de negócio'
);
SELECT is((SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'), 17, 'existem exatamente 17 políticas em public');
SELECT set_eq(
  $$SELECT tablename::text, policyname::text, cmd::text FROM pg_policies WHERE schemaname = 'public'$$,
  $$VALUES
    ('profiles', 'profiles_select', 'SELECT'), ('profiles', 'profiles_update_own', 'UPDATE'),
    ('organizations', 'organizations_select', 'SELECT'), ('organizations', 'organizations_insert', 'INSERT'),
    ('organizations', 'organizations_update', 'UPDATE'), ('organizations', 'organizations_delete', 'DELETE'),
    ('organization_members', 'organization_members_select', 'SELECT'), ('organization_members', 'organization_members_insert', 'INSERT'),
    ('organization_members', 'organization_members_update', 'UPDATE'), ('organization_members', 'organization_members_delete', 'DELETE'),
    ('whatsapp_accounts', 'whatsapp_accounts_select', 'SELECT'), ('whatsapp_accounts', 'whatsapp_accounts_insert', 'INSERT'),
    ('whatsapp_accounts', 'whatsapp_accounts_update', 'UPDATE'), ('whatsapp_accounts', 'whatsapp_accounts_delete', 'DELETE'),
    ('contacts', 'contacts_select', 'SELECT'), ('conversations', 'conversations_select', 'SELECT'),
    ('messages', 'messages_select', 'SELECT')$$,
  'as 17 políticas da auditoria, com o comando correto'
);
SELECT ok(
  (SELECT bool_and(roles = ARRAY['antero_app']::name[] AND permissive = 'PERMISSIVE') FROM pg_policies WHERE schemaname = 'public'),
  'todas as políticas são PERMISSIVE e aplicam-se só a antero_app'
);
SELECT is(
  (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public'
     AND (coalesce(qual, '') || coalesce(with_check, '')) ~ 'auth\.uid|request\.jwt|authenticated|anon'),
  0,
  'nenhuma política depende de auth.uid(), claims JWT ou papéis do Supabase'
);
SELECT set_eq(
  $$SELECT table_name::text, privilege_type::text FROM information_schema.role_table_grants
    WHERE grantee = 'antero_app' AND table_schema = 'public'$$,
  $$VALUES ('profiles', 'SELECT'),
           ('organizations', 'SELECT'), ('organizations', 'INSERT'), ('organizations', 'UPDATE'), ('organizations', 'DELETE'),
           ('organization_members', 'SELECT'), ('organization_members', 'INSERT'), ('organization_members', 'UPDATE'), ('organization_members', 'DELETE'),
           ('whatsapp_accounts', 'SELECT'), ('whatsapp_accounts', 'INSERT'), ('whatsapp_accounts', 'UPDATE'), ('whatsapp_accounts', 'DELETE'),
           ('contacts', 'SELECT'), ('conversations', 'SELECT'), ('messages', 'SELECT')$$,
  'antero_app tem exatamente os privilégios de tabela esperados (sem TRUNCATE/REFERENCES/TRIGGER)'
);
SELECT set_eq(
  $$SELECT column_name::text FROM information_schema.column_privileges
    WHERE grantee = 'antero_app' AND table_schema = 'public' AND table_name = 'profiles' AND privilege_type = 'UPDATE'$$,
  ARRAY['full_name'],
  'em profiles, antero_app só pode alterar full_name'
);
-- Membros de extensões (as views do pgTAP, só no banco de testes) não contam.
SELECT is(
  (SELECT count(*)::int FROM information_schema.role_table_grants g
   WHERE g.grantee = 'PUBLIC' AND g.table_schema IN ('public', 'auth', 'app')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                     WHERE d.objid = format('%I.%I', g.table_schema, g.table_name)::regclass AND d.deptype = 'e')),
  0,
  'PUBLIC não tem privilégio em nenhuma tabela'
);

-- ---------------------------------------------------------------------------
-- Sem contexto autenticado: nada visível, nada gravável
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.profiles'), 0::bigint, 'sem contexto: 0 profiles');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.organizations'), 0::bigint, 'sem contexto: 0 organizations');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.organization_members'), 0::bigint, 'sem contexto: 0 organization_members');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.whatsapp_accounts'), 0::bigint, 'sem contexto: 0 whatsapp_accounts');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.contacts'), 0::bigint, 'sem contexto: 0 contacts');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.conversations'), 0::bigint, 'sem contexto: 0 conversations');
SELECT is(pg_temp.sees(NULL, 'SELECT 1 FROM public.messages'), 0::bigint, 'sem contexto: 0 messages');
SELECT is(pg_temp.does(NULL, 'UPDATE public.organizations SET name = name'), 0::bigint, 'sem contexto: UPDATE não atinge nenhuma organização');
SELECT throws_ok(
  $$SELECT pg_temp.does(NULL, $q$INSERT INTO public.organizations (name, slug) VALUES ('X', 'x-sem-contexto')$q$)$$,
  '42501', NULL, 'sem contexto: INSERT em organizations é negado'
);
-- Um usuário que não existe (id arbitrário) também não vê nada.
SELECT is(
  pg_temp.app_count(gen_random_uuid(), 'SELECT 1 FROM public.organizations'),
  0::bigint,
  'contexto com id inexistente: 0 organizations'
);

-- ---------------------------------------------------------------------------
-- profiles_select
-- ---------------------------------------------------------------------------
SELECT is(
  pg_temp.app_value(pg_temp.id('a_att'), $q$(SELECT string_agg(email, ',' ORDER BY email) FROM public.profiles)$q$),
  'a.admin.030@teste.local,a.att.030@teste.local,a.owner.030@teste.local',
  'profiles_select: atendente vê exatamente a si e aos membros ATIVOS de A'
);
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.profiles'), 3::bigint, 'profiles_select: atendente vê a si e aos 2 colegas ATIVOS de A');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.profiles WHERE id IN ({a_disabled}, {a_invited})'), 0::bigint, 'profiles_select: não vê colegas desativados/convidados');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.profiles WHERE id = {b_owner}'), 0::bigint, 'profiles_select: não vê usuário de outra organização');
SELECT is(pg_temp.sees('a_disabled', 'SELECT 1 FROM public.profiles'), 1::bigint, 'profiles_select: membro desativado vê só o próprio profile');
SELECT is(pg_temp.sees('nobody', 'SELECT 1 FROM public.profiles WHERE id = {nobody}'), 1::bigint, 'profiles_select: usuário sem organização vê o próprio profile');
SELECT is(pg_temp.sees('nobody', 'SELECT 1 FROM public.profiles'), 1::bigint, 'profiles_select: usuário sem organização não vê mais ninguém');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.profiles WHERE id IN ({a_owner}, {a_att})'), 0::bigint, 'profiles_select: dono de B não vê membros de A');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.profiles WHERE id IN (SELECT user_id FROM public.organization_members WHERE organization_id IN ({org_a}, {org_b})) OR id IN ({nobody}, {platform}, {a_recruit}, {b_recruit})'), 10::bigint, 'profiles_select: admin da plataforma vê todos os profiles');

-- ---------------------------------------------------------------------------
-- profiles_update_own (+ correção: sem autopromoção a admin da plataforma)
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.does('a_att', $q$UPDATE public.profiles SET full_name = 'Novo Nome' WHERE id = {a_att}$q$), 1::bigint, 'profiles_update_own: usuário altera o próprio full_name');
SELECT is(pg_temp.does('a_att', $q$UPDATE public.profiles SET full_name = 'Invasor' WHERE id = {a_owner}$q$), 0::bigint, 'profiles_update_own: não altera o profile de um colega');
SELECT is(pg_temp.does('platform', $q$UPDATE public.profiles SET full_name = 'Invasor' WHERE id = {a_owner}$q$), 0::bigint, 'profiles_update_own: nem o admin da plataforma altera profile alheio');
SELECT is(pg_temp.does(NULL, $q$UPDATE public.profiles SET full_name = 'Invasor'$q$), 0::bigint, 'profiles_update_own: sem contexto não altera nada');
SELECT throws_ok(
  $$SELECT pg_temp.does('a_att', 'UPDATE public.profiles SET is_platform_admin = true WHERE id = {a_att}')$$,
  '42501', NULL, 'profiles: usuário NÃO se promove a admin da plataforma'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_att', $q$UPDATE public.profiles SET email = 'outro@teste.local' WHERE id = {a_att}$q$)$$,
  '42501', NULL, 'profiles: usuário NÃO altera o e-mail desnormalizado (vem de auth.users)'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_att', 'DELETE FROM public.profiles WHERE id = {a_att}')$$,
  '42501', NULL, 'profiles: DELETE não é concedido'
);
SELECT is((SELECT is_platform_admin FROM public.profiles WHERE id = pg_temp.id('a_att')), false, 'profiles: is_platform_admin do atendente continua false');

-- ---------------------------------------------------------------------------
-- organizations_select / insert / update / delete
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organizations WHERE id = {org_a}'), 1::bigint, 'organizations_select: membro ativo vê a própria organização');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organizations WHERE id = {org_b}'), 0::bigint, 'organizations_select: membro de A não vê B');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.organizations'), 1::bigint, 'organizations_select: dono de B vê só B');
SELECT is(pg_temp.sees('a_disabled', 'SELECT 1 FROM public.organizations'), 0::bigint, 'organizations_select: membro desativado não vê a organização');
SELECT is(pg_temp.sees('a_invited', 'SELECT 1 FROM public.organizations'), 0::bigint, 'organizations_select: membro apenas convidado não vê a organização');
SELECT is(pg_temp.sees('nobody', 'SELECT 1 FROM public.organizations'), 0::bigint, 'organizations_select: usuário sem organização não vê nenhuma');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.organizations WHERE id IN ({org_a}, {org_b})'), 2::bigint, 'organizations_select: admin da plataforma vê todas');

SELECT throws_ok(
  $$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.organizations (name, slug) VALUES ('Nova', 'nova-por-owner')$q$)$$,
  '42501', NULL, 'organizations_insert: owner de organização NÃO cria organização'
);
SELECT is(
  pg_temp.does('platform', $q$INSERT INTO public.organizations (name, slug) VALUES ('Org C', 'org-c-030')$q$),
  1::bigint, 'organizations_insert: admin da plataforma cria organização'
);
INSERT INTO ids SELECT 'org_c', id FROM public.organizations WHERE slug = 'org-c-030';

SELECT is(pg_temp.does('a_admin', $q$UPDATE public.organizations SET name = 'Org A (admin)' WHERE id = {org_a}$q$), 1::bigint, 'organizations_update: admin ativo altera a própria organização');
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.organizations SET name = 'Org A (owner)' WHERE id = {org_a}$q$), 1::bigint, 'organizations_update: owner ativo altera a própria organização');
SELECT is(pg_temp.does('a_att', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_a}$q$), 0::bigint, 'organizations_update: atendente NÃO altera configurações da organização');
SELECT is(pg_temp.does('a_disabled', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_a}$q$), 0::bigint, 'organizations_update: admin desativado NÃO altera');
SELECT is(pg_temp.does('a_admin', $q$UPDATE public.organizations SET name = 'Hack' WHERE id = {org_b}$q$), 0::bigint, 'organizations_update: admin de A NÃO altera B');
SELECT is(pg_temp.does('platform', $q$UPDATE public.organizations SET status = 'inactive' WHERE id = {org_c}$q$), 1::bigint, 'organizations_update: admin da plataforma altera qualquer organização');

SELECT is(pg_temp.does('a_owner', 'DELETE FROM public.organizations WHERE id = {org_a}'), 0::bigint, 'organizations_delete: owner NÃO apaga a organização');
SELECT is(pg_temp.does('b_owner', 'DELETE FROM public.organizations WHERE id = {org_a}'), 0::bigint, 'organizations_delete: dono de outra organização NÃO apaga');
SELECT is(pg_temp.does('platform', 'DELETE FROM public.organizations WHERE id = {org_c}'), 1::bigint, 'organizations_delete: admin da plataforma apaga');
SELECT throws_ok(
  $$SELECT pg_temp.does('platform', 'TRUNCATE public.organizations')$$,
  '42501', NULL, 'TRUNCATE é negado mesmo ao admin da plataforma'
);

-- ---------------------------------------------------------------------------
-- organization_members_select / insert / update / delete
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organization_members'), 5::bigint, 'organization_members_select: membro ativo vê todos os vínculos de A (qualquer status)');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.organization_members WHERE organization_id = {org_b}'), 0::bigint, 'organization_members_select: não vê vínculos de B');
SELECT is(pg_temp.sees('a_disabled', 'SELECT 1 FROM public.organization_members'), 0::bigint, 'organization_members_select: desativado não vê vínculos');
SELECT is(pg_temp.sees('nobody', 'SELECT 1 FROM public.organization_members'), 0::bigint, 'organization_members_select: sem organização não vê vínculos');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.organization_members WHERE organization_id IN ({org_a}, {org_b})'), 6::bigint, 'organization_members_select: admin da plataforma vê todos');

SELECT is(
  pg_temp.does('a_admin', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {a_recruit}, 'attendant')$q$),
  1::bigint, 'organization_members_insert: admin adiciona membro à própria organização'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_att', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {platform}, 'attendant')$q$)$$,
  '42501', NULL, 'organization_members_insert: atendente NÃO adiciona membros'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_admin', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_b}, {a_admin}, 'owner')$q$)$$,
  '42501', NULL, 'organization_members_insert: admin de A NÃO se insere em B'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_disabled', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_a}, {platform}, 'admin')$q$)$$,
  '42501', NULL, 'organization_members_insert: admin desativado NÃO adiciona membros'
);
SELECT is(
  pg_temp.does('platform', $q$INSERT INTO public.organization_members (organization_id, user_id, role) VALUES ({org_b}, {b_recruit}, 'attendant')$q$),
  1::bigint, 'organization_members_insert: admin da plataforma adiciona membro em qualquer organização'
);

SELECT is(pg_temp.does('a_admin', $q$UPDATE public.organization_members SET role = 'admin' WHERE id = {m_a_invited}$q$), 1::bigint, 'organization_members_update: admin altera papel de membro da própria organização');
SELECT is(pg_temp.does('a_att', $q$UPDATE public.organization_members SET role = 'owner' WHERE user_id = {a_owner}$q$), 0::bigint, 'organization_members_update: quem não é admin não altera vínculos');
SELECT is(pg_temp.does('b_owner', $q$UPDATE public.organization_members SET status = 'disabled' WHERE organization_id = {org_a}$q$), 0::bigint, 'organization_members_update: dono de B NÃO altera vínculos de A');
SELECT throws_ok(
  $$SELECT pg_temp.does('a_admin', 'UPDATE public.organization_members SET organization_id = {org_b} WHERE id = {m_a_att}')$$,
  '42501', NULL, 'organization_members_update: admin NÃO move membro para outra organização (WITH CHECK)'
);

SELECT is(pg_temp.does('a_att', 'DELETE FROM public.organization_members WHERE id = {m_a_invited}'), 0::bigint, 'organization_members_delete: não-admin NÃO remove membros');
SELECT is(pg_temp.does('b_owner', 'DELETE FROM public.organization_members WHERE id = {m_a_invited}'), 0::bigint, 'organization_members_delete: dono de B NÃO remove membro de A');
SELECT is(pg_temp.does('a_admin', 'DELETE FROM public.organization_members WHERE id = {m_a_invited}'), 1::bigint, 'organization_members_delete: admin remove membro da própria organização');

-- ---------------------------------------------------------------------------
-- whatsapp_accounts_select / insert / update / delete
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.whatsapp_accounts'), 1::bigint, 'whatsapp_accounts_select: membro vê só os canais da própria organização');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.whatsapp_accounts WHERE id = {wa_b}'), 0::bigint, 'whatsapp_accounts_select: não vê canal de B');
SELECT is(pg_temp.sees('a_disabled', 'SELECT 1 FROM public.whatsapp_accounts'), 0::bigint, 'whatsapp_accounts_select: desativado não vê canais');
SELECT is(pg_temp.sees('platform', 'SELECT 1 FROM public.whatsapp_accounts WHERE organization_id IN ({org_a}, {org_b})'), 2::bigint, 'whatsapp_accounts_select: admin da plataforma vê todos');

SELECT is(
  pg_temp.does('a_admin', $q$INSERT INTO public.whatsapp_accounts (organization_id, display_name) VALUES ({org_a}, 'Canal A2')$q$),
  1::bigint, 'whatsapp_accounts_insert: admin cria canal na própria organização'
);
INSERT INTO ids SELECT 'wa_a2', id FROM public.whatsapp_accounts WHERE display_name = 'Canal A2';
SELECT throws_ok(
  $$SELECT pg_temp.does('a_att', $q$INSERT INTO public.whatsapp_accounts (organization_id, display_name) VALUES ({org_a}, 'Canal Hack')$q$)$$,
  '42501', NULL, 'whatsapp_accounts_insert: atendente NÃO cria canal'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_admin', $q$INSERT INTO public.whatsapp_accounts (organization_id, display_name) VALUES ({org_b}, 'Canal forjado')$q$)$$,
  '42501', NULL, 'whatsapp_accounts_insert: admin de A NÃO forja canal com organization_id de B'
);

SELECT is(pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET display_name = 'Canal A (editado)' WHERE id = {wa_a}$q$), 1::bigint, 'whatsapp_accounts_update: owner altera canal da própria organização');
SELECT is(pg_temp.does('a_att', $q$UPDATE public.whatsapp_accounts SET status = 'disconnected' WHERE id = {wa_a}$q$), 0::bigint, 'whatsapp_accounts_update: atendente NÃO altera canal');
SELECT is(pg_temp.does('a_owner', $q$UPDATE public.whatsapp_accounts SET status = 'disconnected' WHERE id = {wa_b}$q$), 0::bigint, 'whatsapp_accounts_update: owner de A NÃO altera canal de B');
SELECT throws_ok(
  $$SELECT pg_temp.does('a_owner', 'UPDATE public.whatsapp_accounts SET organization_id = {org_b} WHERE id = {wa_a2}')$$,
  '42501', NULL, 'whatsapp_accounts_update: owner NÃO transfere canal para outra organização (WITH CHECK)'
);

SELECT is(pg_temp.does('a_att', 'DELETE FROM public.whatsapp_accounts WHERE id = {wa_a2}'), 0::bigint, 'whatsapp_accounts_delete: atendente NÃO remove canal');
SELECT is(pg_temp.does('b_owner', 'DELETE FROM public.whatsapp_accounts WHERE id = {wa_a2}'), 0::bigint, 'whatsapp_accounts_delete: dono de B NÃO remove canal de A');
SELECT is(pg_temp.does('a_admin', 'DELETE FROM public.whatsapp_accounts WHERE id = {wa_a2}'), 1::bigint, 'whatsapp_accounts_delete: admin remove canal da própria organização');

-- ---------------------------------------------------------------------------
-- contacts_select / conversations_select / messages_select (somente leitura)
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.contacts'), 1::bigint, 'contacts_select: atendente ativo vê os contatos de A');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.conversations'), 1::bigint, 'conversations_select: atendente ativo vê as conversas de A');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.messages'), 1::bigint, 'messages_select: atendente ativo vê as mensagens de A');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.messages WHERE organization_id = {org_b}'), 0::bigint, 'messages_select: owner de A NÃO vê mensagens de B mesmo filtrando por B');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.conversations WHERE id = {cv_b}'), 0::bigint, 'conversations_select: owner de A NÃO vê conversa de B pelo id');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.contacts WHERE id = {ct_a}'), 0::bigint, 'contacts_select: dono de B NÃO vê contato de A');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.messages'), 1::bigint, 'messages_select: dono de B vê só as mensagens de B');
SELECT is(
  pg_temp.sees('a_disabled', 'SELECT 1 FROM public.contacts UNION ALL SELECT 1 FROM public.conversations UNION ALL SELECT 1 FROM public.messages'),
  0::bigint, 'atendimento: membro desativado não vê contatos/conversas/mensagens'
);
SELECT is(
  pg_temp.sees('a_invited', 'SELECT 1 FROM public.contacts UNION ALL SELECT 1 FROM public.conversations UNION ALL SELECT 1 FROM public.messages'),
  0::bigint, 'atendimento: membro apenas convidado não vê contatos/conversas/mensagens'
);
SELECT is(
  pg_temp.sees('nobody', 'SELECT 1 FROM public.contacts UNION ALL SELECT 1 FROM public.conversations UNION ALL SELECT 1 FROM public.messages'),
  0::bigint, 'atendimento: usuário sem organização não vê nada'
);
SELECT is(
  pg_temp.sees('platform', 'SELECT 1 FROM public.contacts UNION ALL SELECT 1 FROM public.conversations UNION ALL SELECT 1 FROM public.messages'),
  0::bigint, 'atendimento: admin da plataforma NÃO lê conteúdo de atendimento (decisão de 0004)'
);

-- Nenhuma escrita direta nas tabelas de atendimento, nem por owner.
SELECT throws_ok(
  $$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.contacts (organization_id, phone_number) VALUES ({org_a}, '+5511900000399')$q$)$$,
  '42501', NULL, 'contacts: INSERT direto negado (mesmo para owner)'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_owner', $q$UPDATE public.conversations SET status = 'resolved', resolved_at = now() WHERE id = {cv_a}$q$)$$,
  '42501', NULL, 'conversations: UPDATE direto negado (mesmo para owner)'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_owner', 'DELETE FROM public.messages WHERE conversation_id = {cv_a}')$$,
  '42501', NULL, 'messages: DELETE direto negado (mesmo para owner)'
);
SELECT throws_ok(
  $$SELECT pg_temp.does('a_owner', $q$INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, sender_user_id, content) VALUES ({org_a}, {cv_a}, {wa_a}, 'outbound', 'user', {a_owner}, 'oi')$q$)$$,
  '42501', NULL, 'messages: INSERT direto negado (gravação só pela função de ingestão)'
);

-- ---------------------------------------------------------------------------
-- O papel da aplicação não ignora a RLS
-- ---------------------------------------------------------------------------
SELECT is(
  (SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname = 'antero_app'),
  false,
  'antero_app não tem BYPASSRLS nem superusuário'
);
SELECT is(
  (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname IN ('public', 'auth', 'app') AND pg_get_userbyid(c.relowner) <> 'antero_owner'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype = 'e')),
  0,
  'todas as tabelas pertencem a antero_owner (a aplicação nunca é dona, então não escapa da RLS)'
);
SELECT is(
  pg_temp.app_value(pg_temp.id('a_att'), $q$current_setting('row_security')$q$),
  'on',
  'row_security está ligado na sessão da aplicação'
);

SELECT * FROM finish();
ROLLBACK;

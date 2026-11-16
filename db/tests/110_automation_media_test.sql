-- Antero Atendimentos — Entrega E3B: imagens dos fluxos (0011).
--
-- Só owner/admin ativo com Automações, em organização ativa, grava; o tipo é
-- conferido pela assinatura do arquivo; tamanho e cota por organização; mesma
-- imagem devolve a existente; leitura isolada por organização e por módulo
-- (Automações ou Atendimento); a aplicação não escreve direto na tabela.
BEGIN;
\ir lib/helpers.psql
SELECT plan(24);

INSERT INTO public.organizations (name, slug) VALUES
  ('Org A', 'org-a-110'), ('Org B', 'org-b-110'), ('Org C', 'org-c-110'), ('Org D', 'org-d-110');
INSERT INTO ids SELECT 'org_a', id FROM public.organizations WHERE slug = 'org-a-110';
INSERT INTO ids SELECT 'org_b', id FROM public.organizations WHERE slug = 'org-b-110';
INSERT INTO ids SELECT 'org_c', id FROM public.organizations WHERE slug = 'org-c-110';
INSERT INTO ids SELECT 'org_d', id FROM public.organizations WHERE slug = 'org-d-110';
-- A e B: Automações. C: só Atendimento. D: nenhum módulo.
INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES
  (pg_temp.id('org_a'), 'automacoes', true), (pg_temp.id('org_a'), 'atendimento', true),
  (pg_temp.id('org_b'), 'automacoes', true),
  (pg_temp.id('org_c'), 'atendimento', true);

SELECT pg_temp.new_user('a_owner', 'a.owner.110@teste.local', 'A Owner');
SELECT pg_temp.new_user('a_admin', 'a.admin.110@teste.local', 'A Admin');
SELECT pg_temp.new_user('a_att', 'a.att.110@teste.local', 'A Atendente');
SELECT pg_temp.new_user('a_off', 'a.off.110@teste.local', 'A Admin Desativado');
SELECT pg_temp.new_user('b_owner', 'b.owner.110@teste.local', 'B Owner');
SELECT pg_temp.new_user('c_owner', 'c.owner.110@teste.local', 'C Owner');
SELECT pg_temp.new_user('d_owner', 'd.owner.110@teste.local', 'D Owner');
INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
  (pg_temp.id('org_a'), pg_temp.id('a_owner'), 'owner', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_admin'), 'admin', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_att'), 'attendant', 'active'),
  (pg_temp.id('org_a'), pg_temp.id('a_off'), 'admin', 'disabled'),
  (pg_temp.id('org_b'), pg_temp.id('b_owner'), 'owner', 'active'),
  (pg_temp.id('org_c'), pg_temp.id('c_owner'), 'owner', 'active'),
  (pg_temp.id('org_d'), pg_temp.id('d_owner'), 'owner', 'active');

-- Arquivos mínimos com a assinatura real de cada formato.
CREATE TEMP TABLE files (k text PRIMARY KEY, content_type text NOT NULL, data bytea NOT NULL);
INSERT INTO files VALUES
  ('jpeg', 'image/jpeg', '\xffd8ffe000104a464946'::bytea),
  ('jpeg2', 'image/jpeg', '\xffd8ffe000104a464947'::bytea),
  ('png', 'image/png', '\x89504e470d0a1a0a0000000d49484452'::bytea),
  ('gif', 'image/gif', '\x47494638396101000100'::bytea),
  ('fake_png', 'image/png', '\xffd8ffe000104a464946'::bytea);
GRANT SELECT ON files TO antero_app;

-- Grava como antero_app no contexto do usuário; devolve "(id,created)".
CREATE FUNCTION pg_temp.upload(p_user text, p_org text, p_file text, p_name text DEFAULT 'foto.jpg')
RETURNS text LANGUAGE sql AS $$
  SELECT pg_temp.app_value(pg_temp.id(p_user), format(
    '(SELECT row(m.media_id, m.created)::text FROM files f, public.save_automation_media(%L, f.content_type, %L, f.data) m WHERE f.k = %L)',
    pg_temp.id(p_org), p_name, p_file));
$$;

CREATE FUNCTION pg_temp.upload_sql(p_user text, p_org text, p_file text) RETURNS text
LANGUAGE sql AS $$ SELECT format('SELECT pg_temp.upload(%L, %L, %L)', p_user, p_org, p_file) $$;

-- ---------------------------------------------------------------------------
-- Estrutura e privilégios
-- ---------------------------------------------------------------------------
SELECT ok(
  NOT has_table_privilege('antero_app', 'public.automation_media', 'INSERT, UPDATE, DELETE'),
  'antero_app não escreve direto em automation_media'
);
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.automation_media'::regclass),
  'RLS ligada em automation_media'
);

-- ---------------------------------------------------------------------------
-- Gravação
-- ---------------------------------------------------------------------------
SELECT matches(pg_temp.upload('a_owner', 'org_a', 'jpeg'), ',t\)$', 'owner grava uma imagem JPEG');
INSERT INTO ids SELECT 'img_a', (SELECT id FROM public.automation_media WHERE organization_id = pg_temp.id('org_a'));
SELECT is(
  pg_temp.upload('a_admin', 'org_a', 'jpeg', 'outro-nome.jpg'),
  format('(%s,f)', pg_temp.id('img_a')),
  'a mesma imagem de novo devolve a existente, sem duplicar'
);
SELECT matches(pg_temp.upload('a_admin', 'org_a', 'png', 'logo.png'), ',t\)$', 'admin grava uma imagem PNG');
SELECT is(
  (SELECT row(byte_size, content_type, file_name, created_by = pg_temp.id('a_owner'))::text
   FROM public.automation_media WHERE id = pg_temp.id('img_a')),
  '(10,image/jpeg,foto.jpg,t)',
  'tamanho e tipo conferidos; autor vem da sessão, não do chamador'
);

SELECT throws_ok(pg_temp.upload_sql('a_att', 'org_a', 'jpeg2'), '42501', NULL, 'atendente não envia imagem');
SELECT throws_ok(pg_temp.upload_sql('a_off', 'org_a', 'jpeg2'), '42501', NULL, 'admin com vínculo desativado não envia');
SELECT throws_ok(pg_temp.upload_sql('b_owner', 'org_a', 'jpeg2'), '42501', NULL, 'owner de B não envia para A');
SELECT throws_ok(pg_temp.upload_sql('c_owner', 'org_c', 'jpeg2'), '42501', NULL, 'sem o módulo Automações não envia');
SELECT throws_ok(pg_temp.upload_sql('a_owner', 'org_a', 'gif'), 'AU012', NULL, 'GIF é recusado');
SELECT throws_ok(pg_temp.upload_sql('a_owner', 'org_a', 'fake_png'), 'AU012', NULL, 'tipo declarado não bate com o arquivo');
SELECT throws_ok(
  format('SELECT pg_temp.app_value(%L::uuid, %L)', pg_temp.id('a_owner'),
    format('(SELECT media_id FROM public.save_automation_media(%L, ''image/jpeg'', ''grande.jpg'', ''\xffd8ff''::bytea || pg_catalog.repeat(''x'', 5242880)::bytea))', pg_temp.id('org_a'))),
  'AU011', NULL, 'acima de 5 MB é recusado'
);
SELECT throws_ok(
  format('SELECT pg_temp.app_value(%L::uuid, %L)', pg_temp.id('a_owner'),
    format('(SELECT media_id FROM public.save_automation_media(%L, ''image/jpeg'', ''  '', ''\xffd8ff00''::bytea))', pg_temp.id('org_a'))),
  '22023', NULL, 'nome de arquivo em branco é recusado'
);

-- Cota: 100 imagens por organização.
INSERT INTO public.automation_media (organization_id, content_type, byte_size, sha256, data, file_name)
SELECT pg_temp.id('org_b'), 'image/jpeg', 4, sha256('\xffd8ff'::bytea || set_byte('\x00'::bytea, 0, n)),
       '\xffd8ff'::bytea || set_byte('\x00'::bytea, 0, n), 'cota.jpg'
FROM generate_series(1, 100) n;
SELECT is((SELECT count(*)::int FROM public.automation_media WHERE organization_id = pg_temp.id('org_b')), 100, 'B já tem 100 imagens');
SELECT throws_ok(pg_temp.upload_sql('b_owner', 'org_b', 'png'), 'AU013', NULL, 'acima da cota da organização é recusado');

-- ---------------------------------------------------------------------------
-- Leitura isolada por organização e módulo
-- ---------------------------------------------------------------------------
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.automation_media'), 2::bigint, 'owner de A vê as 2 imagens de A');
SELECT is(pg_temp.sees('a_att', 'SELECT 1 FROM public.automation_media'), 2::bigint, 'atendente de A vê (Inbox mostra o que a automação enviou)');
SELECT is(pg_temp.sees('a_off', 'SELECT 1 FROM public.automation_media'), 0::bigint, 'vínculo desativado não vê');
SELECT is(pg_temp.sees('b_owner', 'SELECT 1 FROM public.automation_media WHERE organization_id = {org_a}'), 0::bigint, 'B não vê as imagens de A');
SELECT is(pg_temp.sees('d_owner', 'SELECT 1 FROM public.automation_media'), 0::bigint, 'organização sem módulo não vê nada');

UPDATE public.organization_modules SET enabled = false WHERE organization_id = pg_temp.id('org_a');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.automation_media'), 0::bigint, 'A sem os dois módulos não vê as próprias imagens');
UPDATE public.organization_modules SET enabled = true WHERE organization_id = pg_temp.id('org_a');

-- Organização suspensa: nem lê nem grava.
UPDATE public.organizations SET status = 'inactive' WHERE id = pg_temp.id('org_a');
SELECT is(pg_temp.sees('a_owner', 'SELECT 1 FROM public.automation_media'), 0::bigint, 'organização suspensa não lê imagens');
SELECT throws_ok(pg_temp.upload_sql('a_owner', 'org_a', 'jpeg2'), '42501', NULL, 'organização suspensa não envia imagem');
UPDATE public.organizations SET status = 'active' WHERE id = pg_temp.id('org_a');

SELECT * FROM finish();
ROLLBACK;

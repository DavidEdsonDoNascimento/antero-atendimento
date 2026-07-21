-- Antero Atendimento — Seed
-- Cadastra a organização Antero como uma organização COMUM da plataforma
-- (sem exceções no código) e cria seu canal de WhatsApp de desenvolvimento.
-- Idempotente: pode ser executado mais de uma vez com segurança.
--
-- Este seed NÃO cria usuários nem credenciais. O vínculo do primeiro usuário
-- é feito manualmente após criar a conta no Supabase Auth (veja docs/SETUP.md).

insert into public.organizations (name, slug, status)
values ('Antero Sistemas', 'antero', 'active')
on conflict (slug) do nothing;

insert into public.whatsapp_accounts (organization_id, provider, display_name, status)
select o.id, 'development', 'Antero Sistemas', 'disconnected'
from public.organizations o
where o.slug = 'antero'
  and not exists (
    select 1 from public.whatsapp_accounts w where w.organization_id = o.id
  );

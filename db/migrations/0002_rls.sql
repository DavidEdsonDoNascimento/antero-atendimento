-- migrate:up
-- Antero Atendimento — Ciclo 1: Row Level Security
-- Isolamento multiempresa obrigatório. Nenhuma organização enxerga dados de
-- outra; atendentes não alteram configurações administrativas; usuários não
-- autenticados não acessam nada.
--
-- Porte para PostgreSQL próprio (Entrega 2) de supabase/migrations/0002_rls.sql.
-- As 14 políticas mantêm nome, comando e expressões; diferenças:
--   - auth.uid() -> (select app.current_user_id()) (o subselect avalia a
--     função uma vez por consulta, não por linha);
--   - papel `authenticated` -> antero_app (a credencial única da aplicação; o
--     usuário vem do contexto da transação). Não há papel `anon`: sem
--     contexto, current_user_id() é NULL e nenhuma política concede nada.
--   - as políticas declaram `to antero_app` (no original, sem TO = PUBLIC;
--     o efeito era o mesmo porque só `authenticated` tinha GRANT);
--   - CORREÇÃO DE SEGURANÇA em profiles: o original concedia UPDATE em todas
--     as colunas e profiles_update_own só conferia `id = auth.uid()`, então
--     qualquer usuário podia se promover (`is_platform_admin = true`) ou
--     trocar o próprio e-mail desnormalizado. Agora antero_app só tem
--     UPDATE (full_name); is_platform_admin é alterado apenas
--     administrativamente (fora da aplicação, como já era o processo — ver
--     src/app/(platform)/admin/page.tsx) e email é sincronizado por gatilho a
--     partir de auth.users. INSERT/DELETE em profiles também não são
--     concedidos (não havia política para eles; o efeito é o mesmo).

-- ---------------------------------------------------------------------------
-- Privilégios (avaliados ANTES da RLS). USAGE em public já foi concedido a
-- antero_app pela infraestrutura (docker/postgres/initdb/10-roles.sh).
-- ---------------------------------------------------------------------------
grant select on public.profiles to antero_app;
grant update (full_name) on public.profiles to antero_app;

grant select, insert, update, delete on
  public.organizations,
  public.organization_members,
  public.whatsapp_accounts
to antero_app;

-- As políticas executam estas funções com os privilégios de quem consulta.
grant execute on function public.is_platform_admin() to antero_app;
grant execute on function public.is_org_member(uuid) to antero_app;
grant execute on function public.is_org_admin(uuid) to antero_app;
grant execute on function public.shares_org_with(uuid) to antero_app;

-- Habilita RLS
alter table public.profiles enable row level security;
alter table public.organizations enable row level security;
alter table public.organization_members enable row level security;
alter table public.whatsapp_accounts enable row level security;

-- ---------------------------------------------------------------------------
-- profiles
-- Visível para: o próprio usuário, colegas de organização e admin da plataforma.
-- A criação é feita pelo gatilho handle_new_user (SECURITY DEFINER); por isso
-- não há política de INSERT para usuários comuns.
-- ---------------------------------------------------------------------------
create policy "profiles_select"
  on public.profiles for select
  to antero_app
  using (
    id = (select app.current_user_id())
    or public.is_platform_admin()
    or public.shares_org_with(id)
  );

create policy "profiles_update_own"
  on public.profiles for update
  to antero_app
  using (id = (select app.current_user_id()))
  with check (id = (select app.current_user_id()));

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create policy "organizations_select"
  on public.organizations for select
  to antero_app
  using (public.is_org_member(id) or public.is_platform_admin());

create policy "organizations_insert"
  on public.organizations for insert
  to antero_app
  with check (public.is_platform_admin());

create policy "organizations_update"
  on public.organizations for update
  to antero_app
  using (public.is_org_admin(id) or public.is_platform_admin())
  with check (public.is_org_admin(id) or public.is_platform_admin());

create policy "organizations_delete"
  on public.organizations for delete
  to antero_app
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
create policy "organization_members_select"
  on public.organization_members for select
  to antero_app
  using (public.is_org_member(organization_id) or public.is_platform_admin());

create policy "organization_members_insert"
  on public.organization_members for insert
  to antero_app
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "organization_members_update"
  on public.organization_members for update
  to antero_app
  using (public.is_org_admin(organization_id) or public.is_platform_admin())
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "organization_members_delete"
  on public.organization_members for delete
  to antero_app
  using (public.is_org_admin(organization_id) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- whatsapp_accounts
-- ---------------------------------------------------------------------------
create policy "whatsapp_accounts_select"
  on public.whatsapp_accounts for select
  to antero_app
  using (public.is_org_member(organization_id) or public.is_platform_admin());

create policy "whatsapp_accounts_insert"
  on public.whatsapp_accounts for insert
  to antero_app
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "whatsapp_accounts_update"
  on public.whatsapp_accounts for update
  to antero_app
  using (public.is_org_admin(organization_id) or public.is_platform_admin())
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "whatsapp_accounts_delete"
  on public.whatsapp_accounts for delete
  to antero_app
  using (public.is_org_admin(organization_id) or public.is_platform_admin());

-- migrate:down
-- Desfaz exatamente o que foi feito acima (não apaga dados). Depois do
-- rollback, antero_app volta a não ter acesso algum a estas tabelas.
drop policy "whatsapp_accounts_delete" on public.whatsapp_accounts;
drop policy "whatsapp_accounts_update" on public.whatsapp_accounts;
drop policy "whatsapp_accounts_insert" on public.whatsapp_accounts;
drop policy "whatsapp_accounts_select" on public.whatsapp_accounts;
drop policy "organization_members_delete" on public.organization_members;
drop policy "organization_members_update" on public.organization_members;
drop policy "organization_members_insert" on public.organization_members;
drop policy "organization_members_select" on public.organization_members;
drop policy "organizations_delete" on public.organizations;
drop policy "organizations_update" on public.organizations;
drop policy "organizations_insert" on public.organizations;
drop policy "organizations_select" on public.organizations;
drop policy "profiles_update_own" on public.profiles;
drop policy "profiles_select" on public.profiles;

alter table public.whatsapp_accounts disable row level security;
alter table public.organization_members disable row level security;
alter table public.organizations disable row level security;
alter table public.profiles disable row level security;

revoke execute on function public.shares_org_with(uuid) from antero_app;
revoke execute on function public.is_org_admin(uuid) from antero_app;
revoke execute on function public.is_org_member(uuid) from antero_app;
revoke execute on function public.is_platform_admin() from antero_app;

revoke all on
  public.profiles,
  public.organizations,
  public.organization_members,
  public.whatsapp_accounts
from antero_app;

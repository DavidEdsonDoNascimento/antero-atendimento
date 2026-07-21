-- Antero Atendimento — Ciclo 1: Row Level Security
-- Isolamento multiempresa obrigatório. Nenhuma organização enxerga dados de
-- outra; atendentes não alteram configurações administrativas; usuários não
-- autenticados não acessam nada.

-- Privilégios de tabela para o papel autenticado (o RLS filtra as linhas).
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
  public.profiles,
  public.organizations,
  public.organization_members,
  public.whatsapp_accounts
to authenticated;

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
  using (
    id = auth.uid()
    or public.is_platform_admin()
    or public.shares_org_with(id)
  );

create policy "profiles_update_own"
  on public.profiles for update
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------------------
-- organizations
-- ---------------------------------------------------------------------------
create policy "organizations_select"
  on public.organizations for select
  using (public.is_org_member(id) or public.is_platform_admin());

create policy "organizations_insert"
  on public.organizations for insert
  with check (public.is_platform_admin());

create policy "organizations_update"
  on public.organizations for update
  using (public.is_org_admin(id) or public.is_platform_admin())
  with check (public.is_org_admin(id) or public.is_platform_admin());

create policy "organizations_delete"
  on public.organizations for delete
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- organization_members
-- ---------------------------------------------------------------------------
create policy "organization_members_select"
  on public.organization_members for select
  using (public.is_org_member(organization_id) or public.is_platform_admin());

create policy "organization_members_insert"
  on public.organization_members for insert
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "organization_members_update"
  on public.organization_members for update
  using (public.is_org_admin(organization_id) or public.is_platform_admin())
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "organization_members_delete"
  on public.organization_members for delete
  using (public.is_org_admin(organization_id) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- whatsapp_accounts
-- ---------------------------------------------------------------------------
create policy "whatsapp_accounts_select"
  on public.whatsapp_accounts for select
  using (public.is_org_member(organization_id) or public.is_platform_admin());

create policy "whatsapp_accounts_insert"
  on public.whatsapp_accounts for insert
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "whatsapp_accounts_update"
  on public.whatsapp_accounts for update
  using (public.is_org_admin(organization_id) or public.is_platform_admin())
  with check (public.is_org_admin(organization_id) or public.is_platform_admin());

create policy "whatsapp_accounts_delete"
  on public.whatsapp_accounts for delete
  using (public.is_org_admin(organization_id) or public.is_platform_admin());

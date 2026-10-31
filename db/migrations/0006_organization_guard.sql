-- migrate:up
-- Antero Atendimentos — Entrega E1A: guarda da organização.
--
-- Falhas reproduzidas em db/tests/070_organization_guard_test.sql contra o
-- schema até 0005:
--   1) is_org_member/is_org_admin/shares_org_with ignoravam
--      organizations.status: organização 'inactive' operava normalmente,
--      inclusive por ingest_inbound_message;
--   2) o GRANT de UPDATE em toda a tabela organizations deixava owner/admin
--      (e, pelo privilégio, qualquer coluna) alterar status, slug e datas — um
--      owner suspenso se reativava sozinho;
--   3) owner/admin gravavam whatsapp_accounts diretamente, inclusive
--      external_account_id e provider: apontar o próprio canal para o
--      identificador de outra empresa desviaria os webhooks futuros.
--
-- Decisões:
--   - 'inactive' (enum já existente) significa suspensa; nada é apagado.
--   - A regra fica nas funções de autorização, em um só lugar: as políticas de
--     RLS, withOrganizationTransaction e ingest_inbound_message as usam, sem
--     alteração. is_platform_admin continua independente do status.
--   - antero_app passa a alterar em organizations só `name`. Status muda
--     apenas por set_organization_status, exclusiva do admin da plataforma.
--   - antero_app não escreve em whatsapp_accounts. As políticas de escrita são
--     removidas (não apenas ficam sem GRANT) para um GRANT futuro não as
--     reativar por engano. A aplicação não grava canais hoje; a conexão real
--     chegará por operação própria e autorizada.

-- ---------------------------------------------------------------------------
-- Autorização: vínculo ativo em organização ativa
-- ---------------------------------------------------------------------------
create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and o.status = 'active'
  );
$$;

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    join public.organizations o on o.id = m.organization_id
    where m.organization_id = org_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
      and o.status = 'active'
  );
$$;

create or replace function public.shares_org_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members me
    join public.organization_members them
      on them.organization_id = me.organization_id
    join public.organizations o
      on o.id = me.organization_id
    where me.user_id = app.current_user_id()
      and me.status = 'active'
      and them.user_id = target_user
      and them.status = 'active'
      and o.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- Organizações suspensas do PRÓPRIO usuário da transação. A RLS esconde essas
-- linhas do membro; sem esta função, "suspensa" e "sem vínculo" seriam
-- indistinguíveis para a interface. Devolve só id e nome, só de vínculos
-- ativos do chamador, e não recebe nenhum identificador de usuário.
-- ---------------------------------------------------------------------------
create function public.current_user_suspended_organizations()
returns table (organization_id uuid, organization_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.name
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = app.current_user_id()
    and m.status = 'active'
    and o.status = 'inactive'
  order by m.created_at asc, m.id asc;
$$;

-- ---------------------------------------------------------------------------
-- Suspensão e reativação: única porta de escrita de organizations.status.
-- SECURITY DEFINER porque antero_app não tem UPDATE nessa coluna; a autorização
-- é feita aqui dentro, contra a identidade da transação.
-- ---------------------------------------------------------------------------
create function public.set_organization_status(
  p_organization_id uuid,
  p_status public.organization_status
)
returns public.organization_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.organization_status;
begin
  if not public.is_platform_admin() then
    raise exception 'antero_org_status: not_authorized: operação exclusiva do administrador da plataforma'
      using errcode = '42501';
  end if;

  if p_organization_id is null or p_status is null then
    raise exception 'antero_org_status: invalid_input: organização e status são obrigatórios'
      using errcode = '22004';
  end if;

  update public.organizations
  set status = p_status
  where id = p_organization_id
  returning status into v_status;

  if not found then
    raise exception 'antero_org_status: organization_not_found: organização inexistente'
      using errcode = 'P0002';
  end if;

  return v_status;
end;
$$;

revoke all on function public.current_user_suspended_organizations() from public;
revoke all on function public.set_organization_status(uuid, public.organization_status) from public;
grant execute on function public.current_user_suspended_organizations() to antero_app;
grant execute on function public.set_organization_status(uuid, public.organization_status) to antero_app;

-- ---------------------------------------------------------------------------
-- organizations: UPDATE só em `name`. As políticas continuam decidindo QUEM
-- (admin ativo da organização ou admin da plataforma). updated_at segue pelo
-- gatilho, que não depende de privilégio de coluna.
-- ---------------------------------------------------------------------------
revoke update on public.organizations from antero_app;
grant update (name) on public.organizations to antero_app;

-- ---------------------------------------------------------------------------
-- whatsapp_accounts: só leitura para a aplicação
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.whatsapp_accounts from antero_app;

drop policy "whatsapp_accounts_insert" on public.whatsapp_accounts;
drop policy "whatsapp_accounts_update" on public.whatsapp_accounts;
drop policy "whatsapp_accounts_delete" on public.whatsapp_accounts;

-- migrate:down
-- Volta exatamente ao estado de 0005 (não apaga dados). As organizações
-- 'inactive' continuam assim, mas voltam a operar: reverter reabre as falhas
-- descritas acima.
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

grant insert, update, delete on public.whatsapp_accounts to antero_app;

revoke update (name) on public.organizations from antero_app;
grant update on public.organizations to antero_app;

drop function public.set_organization_status(uuid, public.organization_status);
drop function public.current_user_suspended_organizations();

create or replace function public.is_org_member(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
  );
$$;

create or replace function public.is_org_admin(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org_id
      and m.user_id = app.current_user_id()
      and m.status = 'active'
      and m.role in ('owner', 'admin')
  );
$$;

create or replace function public.shares_org_with(target_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members me
    join public.organization_members them
      on them.organization_id = me.organization_id
    where me.user_id = app.current_user_id()
      and me.status = 'active'
      and them.user_id = target_user
      and them.status = 'active'
  );
$$;

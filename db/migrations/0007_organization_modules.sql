-- migrate:up
-- Antero Atendimentos — Entrega E1B: módulos habilitáveis por organização.
--
-- Decisões:
--   - Cada organização tem a própria configuração, em linhas; nenhuma regra por
--     cliente em código. Sem linha significa desabilitado: uma organização nova
--     nasce sem nenhum módulo, até o admin da plataforma habilitar.
--   - Atendimento é habilitado aqui para as organizações existentes (inclusive
--     suspensas), porque a Inbox já funcionava para elas. updated_by nulo marca
--     a configuração inicial. Nada mais é habilitado automaticamente.
--   - antero_app só lê. A única porta de escrita é set_organization_module,
--     exclusiva do admin da plataforma (mesmo padrão de set_organization_status).
--   - has_module é SECURITY INVOKER: a leitura passa pela política de RLS e a
--     resposta só vale para o usuário da transação. Por isso informar o id de
--     outra organização devolve false. O admin da plataforma não é membro
--     implícito: configura módulos, mas has_module continua false para ele.
--   - contacts, conversations e messages são núcleo compartilhado e não recebem
--     has_module nas políticas (custo por linha, e a ingestão de uma organização
--     só com Automações continuará gravando neles). A guarda dessas telas é
--     withModuleTransaction, conferida uma vez por transação. Tabelas novas de
--     um módulo devem usar is_org_member(...) AND has_module(...).
--   - Dependência: Campanhas exige Contatos, nos dois sentidos. A trava na linha
--     da organização serializa as alterações; sem ela, habilitar Campanhas e
--     desabilitar Contatos em paralelo quebraria a regra.

create type public.organization_module as enum (
  'atendimento',
  'automacoes',
  'campanhas',
  'contatos'
);

create table public.organization_modules (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  module public.organization_module not null,
  enabled boolean not null default false,
  updated_by uuid references public.profiles (id) on delete set null,
  updated_at timestamptz not null default now(),
  unique (organization_id, module)
);

create trigger organization_modules_set_updated_at
before update on public.organization_modules
for each row execute function public.set_updated_at();

insert into public.organization_modules (organization_id, module, enabled)
select o.id, 'atendimento', true
from public.organizations o;

-- ---------------------------------------------------------------------------
-- RLS: membro ativo lê a própria organização; admin da plataforma lê todas.
-- Sem políticas de escrita: nem um GRANT futuro reabriria a escrita direta.
-- ---------------------------------------------------------------------------
alter table public.organization_modules enable row level security;

grant select on public.organization_modules to antero_app;

create policy "organization_modules_select"
  on public.organization_modules for select
  to antero_app
  using (public.is_org_member(organization_id) or public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- O usuário da transação pode usar este módulo nesta organização? Exige vínculo
-- ativo em organização ativa (is_org_member) e o módulo habilitado.
-- ---------------------------------------------------------------------------
create function public.has_module(
  org_id uuid,
  p_module public.organization_module
)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_org_member(org_id)
    and exists (
      select 1
      from public.organization_modules m
      where m.organization_id = org_id
        and m.module = p_module
        and m.enabled
    );
$$;

-- ---------------------------------------------------------------------------
-- Habilita ou desabilita um módulo. SECURITY DEFINER porque antero_app não
-- escreve na tabela; a autorização é feita aqui dentro, contra a identidade da
-- transação. Repetir a operação não cria linha nem troca o responsável.
-- ---------------------------------------------------------------------------
create function public.set_organization_module(
  p_organization_id uuid,
  p_module public.organization_module,
  p_enabled boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then
    raise exception 'antero_org_module: not_authorized: operação exclusiva do administrador da plataforma'
      using errcode = '42501';
  end if;

  if p_organization_id is null or p_module is null or p_enabled is null then
    raise exception 'antero_org_module: invalid_input: organização, módulo e situação são obrigatórios'
      using errcode = '22004';
  end if;

  perform 1
  from public.organizations o
  where o.id = p_organization_id
  for no key update;

  if not found then
    raise exception 'antero_org_module: organization_not_found: organização inexistente'
      using errcode = 'P0002';
  end if;

  if p_module = 'campanhas' and p_enabled and not exists (
    select 1
    from public.organization_modules m
    where m.organization_id = p_organization_id
      and m.module = 'contatos'
      and m.enabled
  ) then
    raise exception 'antero_org_module: dependency_required: Campanhas exige Contatos habilitado'
      using errcode = '23514';
  end if;

  if p_module = 'contatos' and not p_enabled and exists (
    select 1
    from public.organization_modules m
    where m.organization_id = p_organization_id
      and m.module = 'campanhas'
      and m.enabled
  ) then
    raise exception 'antero_org_module: dependency_in_use: desabilite Campanhas antes de Contatos'
      using errcode = '23514';
  end if;

  insert into public.organization_modules as m (organization_id, module, enabled, updated_by)
  values (p_organization_id, p_module, p_enabled, app.current_user_id())
  on conflict (organization_id, module) do update
    set enabled = excluded.enabled,
        updated_by = excluded.updated_by
    where m.enabled is distinct from excluded.enabled;

  return p_enabled;
end;
$$;

revoke all on function public.has_module(uuid, public.organization_module) from public;
revoke all on function public.set_organization_module(uuid, public.organization_module, boolean) from public;
grant execute on function public.has_module(uuid, public.organization_module) to antero_app;
grant execute on function public.set_organization_module(uuid, public.organization_module, boolean) to antero_app;

-- migrate:down
-- Recusa-se se o admin da plataforma já alterou alguma configuração, ou se há
-- módulo além da configuração inicial: reverter apagaria o que foi contratado.
do $$
begin
  if exists (
    select 1
    from public.organization_modules m
    where m.updated_by is not null
      or m.module <> 'atendimento'
      or not m.enabled
  ) then
    raise exception 'antero_org_module: rollback recusado: há configuração de módulos que seria perdida';
  end if;
end;
$$;

drop function public.set_organization_module(uuid, public.organization_module, boolean);
drop function public.has_module(uuid, public.organization_module);
drop table public.organization_modules;
drop type public.organization_module;

-- migrate:up
-- Antero Atendimentos — Entrega G2B: auditoria administrativa.
--
-- Investigação: claude-reports/2026-11-16-investigacao-g2b-auditoria.md.
--
-- Decisões:
--   - audit_events guarda só ALTERAÇÕES EFETIVADAS, na mesma transação da
--     alteração. Recusas não entram aqui (o ROLLBACK as levaria junto): vão para
--     o log estruturado da aplicação (src/lib/security-log.ts).
--   - Eventos nascem de gatilhos nas tabelas de estado (mesmo padrão de
--     record_conversation_event, 0008), não de chamadas espalhadas pelas
--     funções: qualquer caminho que mude o estado é registrado, inclusive
--     manutenção por SQL e funções futuras. A cláusula WHEN só deixa passar
--     mudança efetiva, então repetir o mesmo estado não gera evento.
--   - Autor: app.current_user_id() (definido só pelo servidor a partir da
--     sessão validada, com a marca da transação) e is_platform_admin() no
--     momento. Sem contexto de usuário e fora do papel da aplicação, é
--     manutenção, com o papel de login (session_user). Contexto presente mas
--     inválido (valor sem a marca, forjado) ou usuário que não é admin da
--     plataforma: a alteração é RECUSADA, nunca registrada como manutenção.
--   - Sem FKs: o evento sobrevive à exclusão da organização e do usuário.
--     Sem dados pessoais (nome/e-mail são resolvidos na leitura) e sem
--     conteúdo de cliente. action e actor_kind são text + CHECK, ampliáveis
--     pela G3 sem migration de enum.
--   - Imutável: antero_app só lê (e só o admin da plataforma, pela RLS);
--     gatilhos recusam UPDATE, DELETE e TRUNCATE para qualquer papel. Limite:
--     o dono das tabelas pode desligar gatilhos e o superusuário pode tudo.
--   - set_organization_status deixa de regravar quando o status pedido já é o
--     atual (sem updated_at falso e sem evento); devolve o mesmo valor.

-- ---------------------------------------------------------------------------
-- Tabela
-- ---------------------------------------------------------------------------
create table public.audit_events (
  id bigint generated always as identity primary key,
  -- Instante da GRAVAÇÃO (clock_timestamp), não o início da transação: as
  -- mudanças de uma organização acontecem sob a trava da linha dela, então,
  -- dentro da mesma organização, (occurred_at, id) segue a ordem real das
  -- mudanças mesmo quando uma transação começou antes e esperou a trava.
  -- Entre organizações diferentes, nem id nem occurred_at são a ordem de
  -- COMMIT; ordene por (occurred_at, id) para resultados determinísticos.
  occurred_at timestamptz not null default pg_catalog.clock_timestamp(),
  organization_id uuid not null,
  actor_user_id uuid,
  actor_kind text not null,
  action text not null,
  details jsonb not null default '{}'::jsonb,

  constraint audit_events_actor_kind check (actor_kind in ('platform_admin', 'maintenance')),
  constraint audit_events_action check (
    action in ('organization.suspended', 'organization.reactivated', 'module.enabled', 'module.disabled')
  ),
  constraint audit_events_actor_matches_kind check ((actor_kind = 'platform_admin') = (actor_user_id is not null)),
  constraint audit_events_details_object check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 2048)
);

comment on table public.audit_events is
  'Auditoria administrativa: alterações efetivadas, gravadas por gatilho na mesma transação. Imutável.';

create index audit_events_organization_idx on public.audit_events (organization_id, occurred_at desc, id desc);
create index audit_events_occurred_idx on public.audit_events (occurred_at desc, id desc);

-- ---------------------------------------------------------------------------
-- Leitura: só o admin da plataforma. Sem políticas de escrita.
-- ---------------------------------------------------------------------------
alter table public.audit_events enable row level security;

revoke all on public.audit_events from public;
revoke all on public.audit_events from antero_app;
grant select on public.audit_events to antero_app;

create policy "audit_events_select"
  on public.audit_events for select
  to antero_app
  using (public.is_platform_admin());

-- ---------------------------------------------------------------------------
-- Imutabilidade (vale também para o dono das tabelas)
-- ---------------------------------------------------------------------------
create function public.prevent_audit_event_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'antero_audit: immutable: eventos de auditoria não podem ser alterados nem apagados'
    using errcode = '42501';
end;
$$;

revoke all on function public.prevent_audit_event_change() from public;

create trigger audit_events_immutable
before update or delete on public.audit_events
for each row execute function public.prevent_audit_event_change();

create trigger audit_events_no_truncate
before truncate on public.audit_events
for each statement execute function public.prevent_audit_event_change();

-- ---------------------------------------------------------------------------
-- Gravação: quem é o autor e o registro do evento
--
-- SECURITY INVOKER e sem EXECUTE para nenhum papel da aplicação, como
-- record_conversation_event: roda com o papel de quem alterou o estado (o dono
-- das tabelas, dentro das funções SECURITY DEFINER, ou o operador do banco).
-- Se um dia antero_app ganhasse escrita direta nessas tabelas, o INSERT aqui
-- falharia por falta de privilégio e desfaria a alteração.
-- ---------------------------------------------------------------------------
create function public.record_audit_event(
  p_organization_id uuid,
  p_action text,
  p_details jsonb
)
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_raw text := pg_catalog.current_setting('app.user_id', true);
  v_uid uuid := app.current_user_id();
  v_kind text;
  v_details jsonb := coalesce(p_details, '{}'::jsonb);
begin
  if v_uid is null and coalesce(v_raw, '') <> '' then
    -- Valor de usuário sem a marca da transação: contexto forjado ou vazado.
    raise exception 'antero_audit: invalid_context: contexto de usuário inválido para alteração administrativa'
      using errcode = '42501';
  end if;

  if v_uid is not null then
    if not public.is_platform_admin() then
      raise exception 'antero_audit: not_authorized: só o admin da plataforma faz alterações administrativas'
        using errcode = '42501';
    end if;
    v_kind := 'platform_admin';
  else
    -- Sem contexto de usuário: só manutenção do banco. A aplicação sempre
    -- trabalha com contexto; antero_app sem contexto não é manutenção.
    if session_user = 'antero_app' or current_user = 'antero_app' then
      raise exception 'antero_audit: invalid_context: a aplicação não altera estado sem contexto de usuário'
        using errcode = '42501';
    end if;
    v_kind := 'maintenance';
    v_details := v_details || pg_catalog.jsonb_build_object('db_role', session_user::text);
  end if;

  insert into public.audit_events (organization_id, actor_user_id, actor_kind, action, details)
  values (p_organization_id, v_uid, v_kind, p_action, v_details);
end;
$$;

revoke all on function public.record_audit_event(uuid, text, jsonb) from public;

-- ---------------------------------------------------------------------------
-- Gatilhos de estado
-- ---------------------------------------------------------------------------
create function public.audit_organization_status()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.record_audit_event(
    new.id,
    case when new.status = 'inactive' then 'organization.suspended' else 'organization.reactivated' end,
    pg_catalog.jsonb_build_object('from', old.status::text, 'to', new.status::text)
  );
  return null;
end;
$$;

revoke all on function public.audit_organization_status() from public;

create trigger organizations_audit_status
after update of status on public.organizations
for each row
when (old.status is distinct from new.status)
execute function public.audit_organization_status();

-- Estado efetivo do módulo: sem linha = desabilitado. Inserir já desabilitado
-- e excluir uma linha desabilitada não mudam nada. A exclusão em cascata da
-- própria organização não é registrada como alteração de módulo.
create function public.audit_organization_module()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_row public.organization_modules := case when tg_op = 'DELETE' then old else new end;
  v_from boolean := case when tg_op = 'INSERT' then false else old.enabled end;
  v_to boolean := case when tg_op = 'DELETE' then false else new.enabled end;
begin
  if v_from is not distinct from v_to then
    return null;
  end if;
  if tg_op = 'DELETE' and not exists (select 1 from public.organizations o where o.id = old.organization_id) then
    return null;
  end if;
  perform public.record_audit_event(
    v_row.organization_id,
    case when v_to then 'module.enabled' else 'module.disabled' end,
    pg_catalog.jsonb_build_object('module', v_row.module::text, 'from', v_from, 'to', v_to)
  );
  return null;
end;
$$;

revoke all on function public.audit_organization_module() from public;

create trigger organization_modules_audit_insert
after insert on public.organization_modules
for each row
when (new.enabled)
execute function public.audit_organization_module();

create trigger organization_modules_audit_update
after update of enabled on public.organization_modules
for each row
when (old.enabled is distinct from new.enabled)
execute function public.audit_organization_module();

create trigger organization_modules_audit_delete
after delete on public.organization_modules
for each row
when (old.enabled)
execute function public.audit_organization_module();

-- ---------------------------------------------------------------------------
-- set_organization_status sem regravar o mesmo status
-- Mesma assinatura, autorização e erros de 0006. Trava a organização antes de
-- comparar, como antes o UPDATE fazia.
-- ---------------------------------------------------------------------------
create or replace function public.set_organization_status(
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

  select o.status into v_status
  from public.organizations o
  where o.id = p_organization_id
  for no key update;

  if not found then
    raise exception 'antero_org_status: organization_not_found: organização inexistente'
      using errcode = 'P0002';
  end if;

  if v_status = p_status then
    return v_status;
  end if;

  update public.organizations
  set status = p_status
  where id = p_organization_id;

  return p_status;
end;
$$;

-- migrate:down
-- Recusa se houver evento: reverter apagaria o histórico de auditoria. Para
-- recuperar, faça backup antes e decida conscientemente o que fazer com ele.
do $$
begin
  if exists (select 1 from public.audit_events) then
    raise exception 'antero_audit: rollback de 0013 recusado: há eventos de auditoria';
  end if;
end;
$$;

create or replace function public.set_organization_status(
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

drop trigger organization_modules_audit_delete on public.organization_modules;
drop trigger organization_modules_audit_update on public.organization_modules;
drop trigger organization_modules_audit_insert on public.organization_modules;
drop trigger organizations_audit_status on public.organizations;
drop function public.audit_organization_module();
drop function public.audit_organization_status();
drop function public.record_audit_event(uuid, text, jsonb);
drop table public.audit_events;
drop function public.prevent_audit_event_change();

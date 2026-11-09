-- migrate:up
-- Antero Atendimentos — Entrega E3A (2/2): motor de automações.
--
-- Decisões:
--   - Fluxo = definição JSON versionada (não as 5 tabelas previstas no Ciclo 3).
--     `automation_flows` guarda o rascunho e qual versão está publicada;
--     `automation_flow_versions` guarda cada publicação, IMUTÁVEL (gatilho). A
--     forma da definição é validada pela aplicação (Zod, modules/automations/
--     definition.ts); aqui só o mínimo estrutural (objeto, schemaVersion, tamanho).
--   - Sessão presa à versão em que começou: publicar de novo não muda uma
--     conversa em andamento. Uma sessão ativa por conversa (índice parcial).
--   - `automation_executions`: uma linha por mensagem RECEBIDA processada,
--     UNIQUE (message_id). É a idempotência: reentrega da mesma mensagem não
--     avança a sessão nem envia de novo. As respostas da automação são
--     mensagens comuns em `messages` (sender_type = 'bot'), ligadas à execução.
--   - O motor roda na aplicação (TypeScript puro, determinístico). O banco
--     decide QUANDO ele pode rodar (automation_prepare_internal) e grava o
--     resultado conferindo de novo tudo (automation_commit_internal), com a
--     conversa travada (FOR UPDATE): duas mensagens simultâneas se serializam.
--   - Identidade de execução: as funções *_internal não têm EXECUTE para nenhum
--     papel. Nesta entrega a única porta é a de DESENVOLVIMENTO (dev_automation_*):
--     só canal `development` e só owner/admin ativo da organização da mensagem,
--     as mesmas regras de ingest_inbound_message. Nada é gravado em nome desse
--     usuário (mensagens `bot`, eventos sem usuário). O worker da E2B ganha uma
--     porta própria, por papel próprio, sobre as mesmas funções internas.
--   - Módulos: a execução lê `organization_modules` direto (não has_module, que
--     responde pelo usuário da transação). Sem Automações: não começa nada, e a
--     sessão ativa é interrompida na mensagem seguinte. Sem Atendimento: o banco
--     recusa encaminhar para humano (o motor já não encaminha nesse caso).
--     Não há dependência entre os dois módulos.
--   - Organização suspensa: nada roda nem é alterado.
--   - Atendimento humano vence: qualquer saída de `bot` (assumir, resolver)
--     interrompe a sessão ativa por gatilho; a automação só age em conversa `bot`
--     e só começa em conversa `waiting`, sem responsável, na primeira mensagem do
--     ciclo (nova conversa ou reabertura) — nunca depois de um encaminhamento.

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.automation_flow_status as enum ('draft', 'active', 'paused');
create type public.automation_session_status as enum ('active', 'handed_off', 'completed', 'interrupted', 'failed');
create type public.automation_execution_outcome as enum (
  'started', 'advanced', 'handed_off', 'completed', 'failed', 'interrupted'
);

-- ---------------------------------------------------------------------------
-- Fluxos e versões
-- ---------------------------------------------------------------------------
create table public.automation_flows (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  slug text not null,
  name text not null,
  status public.automation_flow_status not null default 'draft',
  -- Fluxo de entrada: responde às conversas novas (e reabertas) da organização.
  is_entry boolean not null default false,
  draft_definition jsonb not null,
  -- Aumenta a cada gravação do rascunho: publicar confere que é o rascunho validado.
  draft_revision integer not null default 1,
  draft_updated_by uuid references public.profiles (id) on delete set null,
  draft_updated_at timestamptz not null default now(),
  published_version_id uuid,
  created_by uuid references public.profiles (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint automation_flows_organization_id_id_key unique (organization_id, id),
  constraint automation_flows_slug_key unique (organization_id, slug),
  constraint automation_flows_slug_format
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and char_length(slug) <= 60),
  constraint automation_flows_name_length check (char_length(pg_catalog.btrim(name)) between 1 and 120),
  constraint automation_flows_draft_is_object check (jsonb_typeof(draft_definition) = 'object'),
  constraint automation_flows_draft_size check (pg_column_size(draft_definition) <= 262144),
  constraint automation_flows_published_matches_status check ((status = 'draft') = (published_version_id is null))
);

create trigger automation_flows_set_updated_at
before update on public.automation_flows
for each row execute function public.set_updated_at();

create unique index automation_flows_one_entry_idx
  on public.automation_flows (organization_id)
  where is_entry;

create table public.automation_flow_versions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  flow_id uuid not null,
  version integer not null,
  definition jsonb not null,
  published_by uuid not null,
  published_at timestamptz not null default now(),

  constraint automation_flow_versions_flow_fkey
    foreign key (organization_id, flow_id)
    references public.automation_flows (organization_id, id)
    on delete cascade,
  -- Quem publicou é membro da organização; o vínculo não some enquanto houver
  -- versão. NO ACTION (conferido no fim do comando), não RESTRICT: excluir a
  -- organização inteira remove vínculos e versões no mesmo comando.
  constraint automation_flow_versions_published_by_fkey
    foreign key (organization_id, published_by)
    references public.organization_members (organization_id, user_id),
  constraint automation_flow_versions_version_key unique (flow_id, version),
  constraint automation_flow_versions_org_flow_id_key unique (organization_id, flow_id, id),
  constraint automation_flow_versions_version_positive check (version > 0),
  constraint automation_flow_versions_definition_shape
    check (jsonb_typeof(definition) = 'object' and definition ? 'schemaVersion'),
  constraint automation_flow_versions_definition_size check (pg_column_size(definition) <= 262144)
);

alter table public.automation_flows
  add constraint automation_flows_published_version_fkey
  foreign key (organization_id, id, published_version_id)
  references public.automation_flow_versions (organization_id, flow_id, id);

-- Versão publicada não muda: uma sessão em andamento sempre lê o que começou.
create function public.prevent_automation_version_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'antero_automation: version_immutable: versão publicada não pode ser alterada'
    using errcode = 'AU010';
end;
$$;

create trigger automation_flow_versions_immutable
before update on public.automation_flow_versions
for each row execute function public.prevent_automation_version_update();

-- ---------------------------------------------------------------------------
-- Sessões e execuções
-- ---------------------------------------------------------------------------
create table public.automation_sessions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  conversation_id uuid not null,
  flow_id uuid not null,
  flow_version_id uuid not null,
  status public.automation_session_status not null default 'active',
  -- Etapa que espera o cliente; também guardada em state (motor).
  current_step_id text,
  -- Estado do motor (etapa, pilha de menus, tentativas, respostas coletadas).
  state jsonb not null,
  revision integer not null default 1,
  -- Mensagem recebida mais recente já processada: ordem e mensagens atrasadas.
  last_message_id uuid not null,
  last_message_at timestamptz not null,
  end_reason text,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  ended_at timestamptz,

  constraint automation_sessions_organization_id_id_key unique (organization_id, id),
  constraint automation_sessions_conversation_fkey
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id)
    on delete cascade,
  constraint automation_sessions_version_fkey
    foreign key (organization_id, flow_id, flow_version_id)
    references public.automation_flow_versions (organization_id, flow_id, id),
  constraint automation_sessions_state_shape
    check (jsonb_typeof(state) = 'object' and pg_column_size(state) <= 65536),
  constraint automation_sessions_ended_matches_status check ((status = 'active') = (ended_at is null)),
  constraint automation_sessions_reason_matches_status check ((status = 'active') = (end_reason is null)),
  constraint automation_sessions_reason_format check (end_reason ~ '^[a-z_]{1,40}$'),
  constraint automation_sessions_step_format check (char_length(current_step_id) <= 64)
);

create trigger automation_sessions_set_updated_at
before update on public.automation_sessions
for each row execute function public.set_updated_at();

create unique index automation_sessions_one_active_idx
  on public.automation_sessions (conversation_id)
  where status = 'active';

create index automation_sessions_conversation_idx
  on public.automation_sessions (organization_id, conversation_id, started_at desc, id desc);

create table public.automation_executions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  session_id uuid not null,
  -- A mensagem recebida que provocou esta execução. Única: idempotência.
  message_id uuid not null references public.messages (id) on delete cascade,
  outcome public.automation_execution_outcome not null,
  step_before text,
  step_after text,
  reason text,
  created_at timestamptz not null default now(),

  constraint automation_executions_message_key unique (message_id),
  constraint automation_executions_organization_id_id_key unique (organization_id, id),
  constraint automation_executions_session_fkey
    foreign key (organization_id, session_id)
    references public.automation_sessions (organization_id, id)
    on delete cascade,
  constraint automation_executions_reason_format check (reason ~ '^[a-z_]{1,40}$')
);

create index automation_executions_session_idx
  on public.automation_executions (organization_id, session_id, created_at);

-- ---------------------------------------------------------------------------
-- messages: respostas da automação. payload = ação completa (texto, imagem,
-- lista), para reenviar ou traduzir para a Cloud API; content continua sendo o
-- texto legível do histórico.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column payload jsonb,
  add column automation_execution_id uuid;

alter table public.messages
  add constraint messages_automation_execution_fkey
    foreign key (organization_id, automation_execution_id)
    references public.automation_executions (organization_id, id),
  add constraint messages_automation_execution_is_bot
    check (automation_execution_id is null or (direction = 'outbound' and sender_type = 'bot')),
  add constraint messages_payload_is_bot
    check (
      payload is null
      or (sender_type = 'bot' and jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 16384)
    ),
  add constraint messages_rich_type_has_payload
    check (message_type = 'text' or payload is not null);

create index messages_automation_execution_idx
  on public.messages (automation_execution_id)
  where automation_execution_id is not null;

-- ---------------------------------------------------------------------------
-- RLS: só leitura para a aplicação. Fluxos e execuções são do módulo
-- Automações; a sessão (com os dados coletados) também é lida pela Inbox, para
-- o atendente ver o que a automação coletou antes de encaminhar.
-- ---------------------------------------------------------------------------
alter table public.automation_flows enable row level security;
alter table public.automation_flow_versions enable row level security;
alter table public.automation_sessions enable row level security;
alter table public.automation_executions enable row level security;

revoke all on public.automation_flows, public.automation_flow_versions,
  public.automation_sessions, public.automation_executions from antero_app;
grant select on public.automation_flows, public.automation_flow_versions,
  public.automation_sessions, public.automation_executions to antero_app;

create policy "automation_flows_select"
  on public.automation_flows for select
  to antero_app
  using (public.is_org_member(organization_id) and public.has_module(organization_id, 'automacoes'));

create policy "automation_flow_versions_select"
  on public.automation_flow_versions for select
  to antero_app
  using (public.is_org_member(organization_id) and public.has_module(organization_id, 'automacoes'));

create policy "automation_sessions_select"
  on public.automation_sessions for select
  to antero_app
  using (
    public.is_org_member(organization_id)
    and (public.has_module(organization_id, 'automacoes') or public.has_module(organization_id, 'atendimento'))
  );

create policy "automation_executions_select"
  on public.automation_executions for select
  to antero_app
  using (public.is_org_member(organization_id) and public.has_module(organization_id, 'automacoes'));

-- ---------------------------------------------------------------------------
-- Registro do atendimento (0008) com as passagens da automação. Eventos da
-- automação não têm usuário: quem agiu foi ela, não quem disparou a execução.
-- ---------------------------------------------------------------------------
alter table public.conversation_events drop constraint conversation_events_user_matches_type;
alter table public.conversation_events
  add constraint conversation_events_user_matches_type
  check (
    (event_type <> 'assigned' or user_id is not null)
    and (event_type not in ('reopened', 'automation_started', 'handed_off') or user_id is null)
  );

create or replace function public.record_conversation_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assigned_user_id is not null
     and new.assigned_user_id is distinct from old.assigned_user_id then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'assigned', new.assigned_user_id);
  end if;

  if new.status = 'resolved' and old.status <> 'resolved' then
    -- bot -> resolved só acontece pela automação (conclusão): sem usuário.
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'resolved',
            case when old.status = 'bot' then null else app.current_user_id() end);
  elsif old.status = 'resolved' and new.status <> 'resolved' then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'reopened', null);
  elsif old.status = 'waiting' and new.status = 'bot' then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'automation_started', null);
  elsif old.status = 'bot' and new.status = 'waiting' then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'handed_off', null);
  end if;

  return null;
end;
$$;

-- Qualquer saída de `bot` que não foi feita pela própria automação (assumir,
-- e no futuro transferir ou responder pelo celular) interrompe a sessão ativa:
-- o robô nunca responde por cima do atendente. A automação encerra a própria
-- sessão antes de mudar o estado, então aqui não encontra nada.
create function public.stop_automation_on_conversation_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  update public.automation_sessions s
  set status = 'interrupted',
      ended_at = now(),
      end_reason = case when new.status = 'human' then 'human_takeover' else 'conversation_' || new.status::text end,
      revision = s.revision + 1
  where s.organization_id = new.organization_id
    and s.conversation_id = new.id
    and s.status = 'active';
  return null;
end;
$$;

create trigger conversations_stop_automation
after update of status on public.conversations
for each row
when (old.status = 'bot' and new.status <> 'bot')
execute function public.stop_automation_on_conversation_change();

-- ---------------------------------------------------------------------------
-- Configuração (owner/admin com o módulo Automações). Chamada pela aplicação
-- depois de validar a definição com o mesmo schema que o motor usa.
-- ---------------------------------------------------------------------------
create function public.assert_automation_admin(p_organization_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.current_user_id();
begin
  if v_uid is null then
    raise exception 'antero_automation: not_authenticated: operação requer usuário autenticado'
      using errcode = '28000';
  end if;
  if p_organization_id is null
     or not public.is_org_admin(p_organization_id)
     or not public.has_module(p_organization_id, 'automacoes') then
    raise exception 'antero_automation: not_authorized: só owner/admin com o módulo Automações configura fluxos'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

create function public.assert_flow_definition_shape(p_definition jsonb)
returns void
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_definition is null
     or jsonb_typeof(p_definition) <> 'object'
     or p_definition -> 'schemaVersion' is distinct from '1'::jsonb
     or jsonb_typeof(p_definition -> 'steps') is distinct from 'array'
     or pg_column_size(p_definition) > 262144 then
    raise exception 'antero_automation: invalid_definition: definição de fluxo malformada'
      using errcode = 'AU003';
  end if;
end;
$$;

-- Cria ou atualiza o rascunho pelo identificador (slug). Não publica.
create function public.save_automation_flow(
  p_organization_id uuid,
  p_slug text,
  p_name text,
  p_definition jsonb,
  p_is_entry boolean default false
)
returns table (flow_id uuid, draft_revision integer, created boolean)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public.assert_automation_admin(p_organization_id);
  v_flow_id uuid;
  v_revision integer;
  v_created boolean;
begin
  perform public.assert_flow_definition_shape(p_definition);
  if p_slug is null or p_name is null or p_is_entry is null then
    raise exception 'antero_automation: invalid_input: identificador, nome e entrada são obrigatórios'
      using errcode = '22004';
  end if;

  if p_is_entry and exists (
    select 1 from public.automation_flows f
    where f.organization_id = p_organization_id and f.is_entry and f.slug <> p_slug
  ) then
    raise exception 'antero_automation: entry_conflict: a organização já tem um fluxo de entrada'
      using errcode = 'AU001';
  end if;

  insert into public.automation_flows as f (
    organization_id, slug, name, is_entry, draft_definition, draft_updated_by, created_by
  )
  values (p_organization_id, p_slug, pg_catalog.btrim(p_name), p_is_entry, p_definition, v_uid, v_uid)
  on conflict (organization_id, slug) do update
    set name = excluded.name,
        is_entry = excluded.is_entry,
        draft_definition = excluded.draft_definition,
        draft_revision = f.draft_revision + 1,
        draft_updated_by = excluded.draft_updated_by,
        draft_updated_at = now()
  returning f.id, f.draft_revision, (f.xmax = 0) into v_flow_id, v_revision, v_created;

  return query select v_flow_id, v_revision, v_created;
end;
$$;

-- Publica o rascunho como nova versão imutável. `p_expected_draft_revision` é a
-- revisão que a aplicação validou: outra gravação no meio recusa (AU002).
create function public.publish_automation_flow(
  p_organization_id uuid,
  p_flow_id uuid,
  p_expected_draft_revision integer
)
returns table (version_id uuid, version integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public.assert_automation_admin(p_organization_id);
  v_flow record;
  v_version integer;
  v_version_id uuid;
begin
  select f.draft_definition, f.draft_revision
    into v_flow
  from public.automation_flows f
  where f.organization_id = p_organization_id
    and f.id = p_flow_id
  for update;

  if not found then
    raise exception 'antero_automation: flow_not_found: fluxo inexistente nesta organização'
      using errcode = 'P0002';
  end if;
  if p_expected_draft_revision is distinct from v_flow.draft_revision then
    raise exception 'antero_automation: draft_changed: o rascunho mudou depois de validado'
      using errcode = 'AU002';
  end if;
  perform public.assert_flow_definition_shape(v_flow.draft_definition);

  select coalesce(max(v.version), 0) + 1 into v_version
  from public.automation_flow_versions v
  where v.flow_id = p_flow_id;

  insert into public.automation_flow_versions (organization_id, flow_id, version, definition, published_by)
  values (p_organization_id, p_flow_id, v_version, v_flow.draft_definition, v_uid)
  returning id into v_version_id;

  update public.automation_flows f
  set published_version_id = v_version_id,
      status = case when f.status = 'draft' then 'active'::public.automation_flow_status else f.status end
  where f.organization_id = p_organization_id
    and f.id = p_flow_id;

  return query select v_version_id, v_version;
end;
$$;

-- Ativa ou pausa um fluxo publicado. Pausar interrompe as sessões na próxima mensagem.
create function public.set_automation_flow_status(
  p_organization_id uuid,
  p_flow_id uuid,
  p_status public.automation_flow_status
)
returns public.automation_flow_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := public.assert_automation_admin(p_organization_id);
  v_status public.automation_flow_status;
begin
  if p_status is null or p_status = 'draft' then
    raise exception 'antero_automation: invalid_status: use active ou paused'
      using errcode = '22023';
  end if;

  select f.status into v_status
  from public.automation_flows f
  where f.organization_id = p_organization_id
    and f.id = p_flow_id
  for update;

  if not found then
    raise exception 'antero_automation: flow_not_found: fluxo inexistente nesta organização'
      using errcode = 'P0002';
  end if;
  if v_status = 'draft' then
    raise exception 'antero_automation: not_published: publique o fluxo antes de ativá-lo'
      using errcode = 'AU004';
  end if;

  update public.automation_flows f
  set status = p_status
  where f.organization_id = p_organization_id
    and f.id = p_flow_id
    and f.status is distinct from p_status;

  return p_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Execução (internas: sem EXECUTE para nenhum papel).
-- ---------------------------------------------------------------------------

-- Interrompe uma sessão ativa sem enviar nada e devolve a conversa à equipe.
create function public.automation_interrupt_internal(p_message_id uuid, p_session_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session record;
begin
  update public.automation_sessions s
  set status = 'interrupted',
      ended_at = now(),
      end_reason = p_reason,
      revision = s.revision + 1
  where s.id = p_session_id
    and s.status = 'active'
  returning s.organization_id, s.conversation_id, s.current_step_id into v_session;

  if not found then
    return;
  end if;

  insert into public.automation_executions (organization_id, session_id, message_id, outcome, step_before, reason)
  values (v_session.organization_id, p_session_id, p_message_id, 'interrupted', v_session.current_step_id, p_reason)
  on conflict (message_id) do nothing;

  update public.conversations c
  set status = 'waiting'
  where c.organization_id = v_session.organization_id
    and c.id = v_session.conversation_id
    and c.status = 'bot';
end;
$$;

-- O que fazer com esta mensagem recebida: nada (`none`, com o motivo), iniciar
-- uma sessão (`start`) ou avançar a sessão ativa (`advance`). Trava a conversa;
-- chamada na mesma transação do commit, a decisão vale até o COMMIT.
create function public.automation_prepare_internal(p_message_id uuid)
returns table (
  action text,
  reason text,
  organization_id uuid,
  conversation_id uuid,
  session_id uuid,
  session_revision integer,
  flow_id uuid,
  flow_version_id uuid,
  definition jsonb,
  state jsonb,
  message_content text,
  attendance_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_message record;
  v_conversation record;
  v_session record;
  v_flow record;
  v_automation boolean;
  v_attendance boolean;
  v_channel_connected boolean;
  v_cycle_start timestamptz;
begin
  select m.organization_id, m.conversation_id, m.whatsapp_account_id, m.created_at, m.content, m.direction
    into v_message
  from public.messages m
  where m.id = p_message_id;

  if not found or v_message.direction <> 'inbound' then
    raise exception 'antero_automation: message_not_found: mensagem recebida inexistente'
      using errcode = 'P0002';
  end if;

  select c.status, c.assigned_user_id, c.started_at
    into v_conversation
  from public.conversations c
  where c.organization_id = v_message.organization_id
    and c.id = v_message.conversation_id
  for update;

  if not exists (
    select 1 from public.organizations o
    where o.id = v_message.organization_id and o.status = 'active'
  ) then
    return query select 'none', 'organization_inactive', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;

  if exists (select 1 from public.automation_executions e where e.message_id = p_message_id) then
    return query select 'none', 'already_processed', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;

  select exists (
           select 1 from public.organization_modules om
           where om.organization_id = v_message.organization_id and om.module = 'automacoes' and om.enabled
         ),
         exists (
           select 1 from public.organization_modules om
           where om.organization_id = v_message.organization_id and om.module = 'atendimento' and om.enabled
         ),
         exists (
           select 1 from public.whatsapp_accounts w
           where w.organization_id = v_message.organization_id
             and w.id = v_message.whatsapp_account_id
             and w.status = 'connected'
         )
    into v_automation, v_attendance, v_channel_connected;

  select s.id, s.revision, s.flow_id, s.flow_version_id, s.state, s.last_message_id, s.last_message_at,
         f.status as flow_status, v.definition
    into v_session
  from public.automation_sessions s
  join public.automation_flows f on f.organization_id = s.organization_id and f.id = s.flow_id
  join public.automation_flow_versions v on v.organization_id = s.organization_id and v.id = s.flow_version_id
  where s.organization_id = v_message.organization_id
    and s.conversation_id = v_message.conversation_id
    and s.status = 'active'
  for update of s;

  if found then
    if not v_automation then
      perform public.automation_interrupt_internal(p_message_id, v_session.id, 'module_disabled');
      return query select 'none', 'module_disabled', v_message.organization_id, v_message.conversation_id,
        v_session.id, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
      return;
    end if;
    if v_session.flow_status <> 'active' then
      perform public.automation_interrupt_internal(p_message_id, v_session.id, 'flow_paused');
      return query select 'none', 'flow_paused', v_message.organization_id, v_message.conversation_id,
        v_session.id, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
      return;
    end if;
    if not v_channel_connected or v_conversation.status <> 'bot' then
      return query select 'none', case when v_channel_connected then 'not_eligible' else 'channel_unavailable' end,
        v_message.organization_id, v_message.conversation_id,
        v_session.id, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
      return;
    end if;
    -- Mensagem anterior (ou igual) à última processada: chegou atrasada.
    if (v_message.created_at, p_message_id) <= (v_session.last_message_at, v_session.last_message_id) then
      return query select 'none', 'stale', v_message.organization_id, v_message.conversation_id,
        v_session.id, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
      return;
    end if;
    return query select 'advance', null::text, v_message.organization_id, v_message.conversation_id,
      v_session.id, v_session.revision, v_session.flow_id, v_session.flow_version_id, v_session.definition,
      v_session.state, v_message.content, v_attendance;
    return;
  end if;

  -- Sem sessão ativa: só começa numa conversa aguardando, sem responsável, na
  -- primeira mensagem do ciclo (conversa nova ou reaberta) e se o ciclo ainda
  -- não teve sessão — depois de um encaminhamento a conversa espera a equipe.
  if not v_automation then
    return query select 'none', 'module_disabled', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;
  if v_conversation.status <> 'waiting' or v_conversation.assigned_user_id is not null then
    return query select 'none', 'not_eligible', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;

  select greatest(v_conversation.started_at, max(e.created_at))
    into v_cycle_start
  from public.conversation_events e
  where e.organization_id = v_message.organization_id
    and e.conversation_id = v_message.conversation_id
    and e.event_type = 'reopened';
  v_cycle_start := coalesce(v_cycle_start, v_conversation.started_at);

  if exists (
    select 1 from public.automation_sessions s
    where s.organization_id = v_message.organization_id
      and s.conversation_id = v_message.conversation_id
      and s.started_at >= v_cycle_start
  ) or exists (
    select 1 from public.messages m
    where m.organization_id = v_message.organization_id
      and m.conversation_id = v_message.conversation_id
      and m.direction = 'inbound'
      and m.created_at >= v_cycle_start
      and (m.created_at, m.id) < (v_message.created_at, p_message_id)
  ) then
    return query select 'none', 'not_eligible', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;

  if not v_channel_connected then
    return query select 'none', 'channel_unavailable', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;

  select f.id, f.published_version_id, v.definition
    into v_flow
  from public.automation_flows f
  join public.automation_flow_versions v on v.organization_id = f.organization_id and v.id = f.published_version_id
  where f.organization_id = v_message.organization_id
    and f.is_entry
    and f.status = 'active';

  if not found then
    return query select 'none', 'no_flow', v_message.organization_id, v_message.conversation_id,
      null::uuid, null::integer, null::uuid, null::uuid, null::jsonb, null::jsonb, null::text, null::boolean;
    return;
  end if;

  return query select 'start', null::text, v_message.organization_id, v_message.conversation_id,
    null::uuid, null::integer, v_flow.id, v_flow.published_version_id, v_flow.definition,
    null::jsonb, v_message.content, v_attendance;
end;
$$;

-- Grava o resultado do motor para esta mensagem: sessão, execução, respostas
-- (`pending`, na ordem) e o estado da conversa. Confere de novo, com a conversa
-- travada, que a decisão ainda vale e que é a mesma sessão/revisão que o motor
-- leu. Devolve as respostas para o envio (fora da transação).
create function public.automation_commit_internal(
  p_message_id uuid,
  p_session_id uuid,
  p_expected_revision integer,
  p_flow_version_id uuid,
  p_status public.automation_session_status,
  p_step_id text,
  p_state jsonb,
  p_reason text,
  p_outputs jsonb
)
returns table (
  message_id uuid,
  message_type public.message_type,
  content text,
  payload jsonb,
  whatsapp_account_id uuid,
  provider public.whatsapp_provider,
  external_account_id text,
  recipient_phone_number text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_plan record;
  v_session_id uuid;
  v_execution_id uuid;
  v_message record;
  v_output jsonb;
  v_type public.message_type;
  v_at timestamptz;
  v_previous_at timestamptz;
  v_new_status public.conversation_status;
  v_outcome public.automation_execution_outcome;
begin
  select * into v_plan from public.automation_prepare_internal(p_message_id);

  if v_plan.action = 'none' then
    raise exception 'antero_automation: not_eligible: %', v_plan.reason
      using errcode = 'AU006';
  end if;
  if (v_plan.action = 'start' and (p_session_id is not null or p_flow_version_id is distinct from v_plan.flow_version_id))
     or (v_plan.action = 'advance' and (p_session_id is distinct from v_plan.session_id
         or p_expected_revision is distinct from v_plan.session_revision
         or p_flow_version_id is distinct from v_plan.flow_version_id)) then
    raise exception 'antero_automation: revision_conflict: a sessão mudou desde a leitura'
      using errcode = 'AU005';
  end if;

  if not coalesce(
       p_status <> 'interrupted'
       and jsonb_typeof(p_state) = 'object'
       and (p_status = 'active') = (p_step_id is not null)
       and (p_status = 'active') = (p_reason is null)
       and jsonb_typeof(p_outputs) = 'array',
       false) then
    raise exception 'antero_automation: invalid_result: resultado do motor malformado'
      using errcode = 'AU007';
  end if;
  if jsonb_array_length(p_outputs) > 6 then
    raise exception 'antero_automation: invalid_result: respostas demais numa execução'
      using errcode = 'AU007';
  end if;
  if p_status = 'handed_off' and not v_plan.attendance_enabled then
    raise exception 'antero_automation: handoff_unavailable: a organização não tem o módulo Atendimento'
      using errcode = 'AU008';
  end if;

  select m.whatsapp_account_id, m.created_at, w.provider, w.external_account_id, ct.phone_number
    into v_message
  from public.messages m
  join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
  join public.whatsapp_accounts w on w.organization_id = c.organization_id and w.id = c.whatsapp_account_id
  join public.contacts ct on ct.organization_id = c.organization_id and ct.id = c.contact_id
  where m.id = p_message_id;

  if v_plan.action = 'start' then
    insert into public.automation_sessions (
      organization_id, conversation_id, flow_id, flow_version_id, status, current_step_id, state,
      last_message_id, last_message_at
    )
    values (
      v_plan.organization_id, v_plan.conversation_id, v_plan.flow_id, v_plan.flow_version_id, 'active',
      p_step_id, p_state, p_message_id, v_message.created_at
    )
    returning id into v_session_id;

    update public.conversations c
    set status = 'bot'
    where c.organization_id = v_plan.organization_id
      and c.id = v_plan.conversation_id;
  else
    v_session_id := v_plan.session_id;
  end if;

  v_outcome := case
    when p_status = 'active' and v_plan.action = 'start' then 'started'
    when p_status = 'active' then 'advanced'
    else p_status::text::public.automation_execution_outcome
  end;

  insert into public.automation_executions (organization_id, session_id, message_id, outcome, step_before, step_after, reason)
  values (v_plan.organization_id, v_session_id, p_message_id, v_outcome,
          v_plan.state ->> 'stepId', p_step_id, p_reason)
  returning id into v_execution_id;

  -- Respostas em ordem: created_at crescente pelo relógio real (now() é o mesmo
  -- para a transação inteira e empataria).
  v_previous_at := v_message.created_at;
  for v_output in select value from jsonb_array_elements(p_outputs)
  loop
    if not coalesce(
         jsonb_typeof(v_output) = 'object'
         and v_output ->> 'message_type' in ('text', 'image', 'interactive')
         and jsonb_typeof(v_output -> 'content') = 'string'
         and jsonb_typeof(v_output -> 'payload') = 'object',
         false) then
      raise exception 'antero_automation: invalid_result: resposta do motor malformada'
        using errcode = 'AU007';
    end if;
    v_type := (v_output ->> 'message_type')::public.message_type;
    v_at := greatest(pg_catalog.clock_timestamp(), v_previous_at + interval '1 microsecond');
    v_previous_at := v_at;

    insert into public.messages (
      organization_id, conversation_id, whatsapp_account_id, direction, sender_type, sender_user_id,
      message_type, content, delivery_status, payload, automation_execution_id, created_at
    )
    values (
      v_plan.organization_id, v_plan.conversation_id, v_message.whatsapp_account_id, 'outbound', 'bot', null,
      v_type, pg_catalog.btrim(v_output ->> 'content'), 'pending', v_output -> 'payload', v_execution_id, v_at
    );
  end loop;

  update public.automation_sessions s
  set status = p_status,
      current_step_id = p_step_id,
      state = p_state,
      revision = s.revision + case when v_plan.action = 'start' then 0 else 1 end,
      last_message_id = p_message_id,
      last_message_at = v_message.created_at,
      end_reason = p_reason,
      ended_at = case when p_status = 'active' then null else now() end
  where s.id = v_session_id;

  -- Estado da conversa: encaminhada aguarda a equipe; concluída fica resolvida
  -- (a próxima mensagem do cliente reabre e recomeça); falha volta para a equipe
  -- quando há atendimento humano e, sem ele, também fica resolvida.
  v_new_status := case
    when p_status = 'active' then 'bot'
    when p_status = 'handed_off' then 'waiting'
    when p_status = 'failed' and v_plan.attendance_enabled then 'waiting'
    else 'resolved'
  end::public.conversation_status;

  update public.conversations c
  set status = v_new_status,
      resolved_at = case when v_new_status = 'resolved' then now() else null end,
      last_message_at = case when jsonb_array_length(p_outputs) > 0 then now() else c.last_message_at end
  where c.organization_id = v_plan.organization_id
    and c.id = v_plan.conversation_id;

  return query
  select m.id, m.message_type, m.content, m.payload, m.whatsapp_account_id, v_message.provider,
         v_message.external_account_id, v_message.phone_number
  from public.messages m
  where m.organization_id = v_plan.organization_id
    and m.automation_execution_id = v_execution_id
  order by m.created_at, m.id;
end;
$$;

-- Resultado do envio de uma resposta da automação (fase 2). Só `pending` muda;
-- repetir não altera o que já foi gravado.
create function public.automation_record_delivery_internal(
  p_message_id uuid,
  p_delivery_status public.message_delivery_status,
  p_external_message_id text default null
)
returns public.message_delivery_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_external text := nullif(pg_catalog.btrim(coalesce(p_external_message_id, '')), '');
  v_status public.message_delivery_status;
begin
  if p_delivery_status is null or p_delivery_status not in ('sent', 'failed') then
    raise exception 'antero_automation: invalid_delivery_status: resultado deve ser sent ou failed'
      using errcode = '22023';
  end if;
  if (p_delivery_status = 'sent') <> (v_external is not null) then
    raise exception 'antero_automation: invalid_external_message_id: id externo só (e sempre) em sent'
      using errcode = '22023';
  end if;

  select m.delivery_status into v_status
  from public.messages m
  where m.id = p_message_id
    and m.sender_type = 'bot'
    and m.automation_execution_id is not null
  for update;

  if not found then
    raise exception 'antero_automation: message_not_found: resposta da automação inexistente'
      using errcode = 'P0002';
  end if;
  if v_status <> 'pending' then
    return v_status;
  end if;

  update public.messages m
  set delivery_status = p_delivery_status,
      external_message_id = v_external
  where m.id = p_message_id;

  return p_delivery_status;
end;
$$;

-- ---------------------------------------------------------------------------
-- Porta de DESENVOLVIMENTO (simulador). Mesmas regras da ingestão simulada:
-- usuário autenticado, owner/admin ativo da organização da mensagem
-- (is_org_admin exige organização ativa) e canal `development`. Canal real
-- (cloud_api) é recusado: em produção esta porta não alcança nenhum cliente.
-- ---------------------------------------------------------------------------
create function public.assert_dev_automation_access(p_message_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := app.current_user_id();
  v_organization_id uuid;
  v_provider public.whatsapp_provider;
begin
  if v_uid is null then
    raise exception 'antero_automation: not_authenticated: operação requer usuário autenticado'
      using errcode = '28000';
  end if;

  select m.organization_id, w.provider
    into v_organization_id, v_provider
  from public.messages m
  join public.whatsapp_accounts w on w.organization_id = m.organization_id and w.id = m.whatsapp_account_id
  where m.id = p_message_id;

  if not found then
    raise exception 'antero_automation: message_not_found: mensagem inexistente'
      using errcode = 'P0002';
  end if;
  if not public.is_org_admin(v_organization_id) then
    raise exception 'antero_automation: not_authorized: só owner/admin ativo da organização do canal'
      using errcode = '42501';
  end if;
  if v_provider <> 'development' then
    raise exception 'antero_automation: provider_not_allowed: a porta de desenvolvimento só atende canais development'
      using errcode = 'AU009';
  end if;
  return v_organization_id;
end;
$$;

create function public.dev_automation_prepare(p_message_id uuid)
returns table (
  action text,
  reason text,
  organization_id uuid,
  conversation_id uuid,
  session_id uuid,
  session_revision integer,
  flow_id uuid,
  flow_version_id uuid,
  definition jsonb,
  state jsonb,
  message_content text,
  attendance_enabled boolean
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_dev_automation_access(p_message_id);
  return query select * from public.automation_prepare_internal(p_message_id);
end;
$$;

create function public.dev_automation_commit(
  p_message_id uuid,
  p_session_id uuid,
  p_expected_revision integer,
  p_flow_version_id uuid,
  p_status public.automation_session_status,
  p_step_id text,
  p_state jsonb,
  p_reason text,
  p_outputs jsonb
)
returns table (
  message_id uuid,
  message_type public.message_type,
  content text,
  payload jsonb,
  whatsapp_account_id uuid,
  provider public.whatsapp_provider,
  external_account_id text,
  recipient_phone_number text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_dev_automation_access(p_message_id);
  return query select * from public.automation_commit_internal(
    p_message_id, p_session_id, p_expected_revision, p_flow_version_id,
    p_status, p_step_id, p_state, p_reason, p_outputs);
end;
$$;

create function public.dev_automation_record_delivery(
  p_message_id uuid,
  p_delivery_status public.message_delivery_status,
  p_external_message_id text default null
)
returns public.message_delivery_status
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.assert_dev_automation_access(p_message_id);
  return public.automation_record_delivery_internal(p_message_id, p_delivery_status, p_external_message_id);
end;
$$;

revoke all on function public.prevent_automation_version_update() from public;
revoke all on function public.stop_automation_on_conversation_change() from public;
revoke all on function public.assert_automation_admin(uuid) from public;
revoke all on function public.assert_flow_definition_shape(jsonb) from public;
revoke all on function public.save_automation_flow(uuid, text, text, jsonb, boolean) from public;
revoke all on function public.publish_automation_flow(uuid, uuid, integer) from public;
revoke all on function public.set_automation_flow_status(uuid, uuid, public.automation_flow_status) from public;
revoke all on function public.automation_interrupt_internal(uuid, uuid, text) from public;
revoke all on function public.automation_prepare_internal(uuid) from public;
revoke all on function public.automation_commit_internal(uuid, uuid, integer, uuid, public.automation_session_status, text, jsonb, text, jsonb) from public;
revoke all on function public.automation_record_delivery_internal(uuid, public.message_delivery_status, text) from public;
revoke all on function public.assert_dev_automation_access(uuid) from public;
revoke all on function public.dev_automation_prepare(uuid) from public;
revoke all on function public.dev_automation_commit(uuid, uuid, integer, uuid, public.automation_session_status, text, jsonb, text, jsonb) from public;
revoke all on function public.dev_automation_record_delivery(uuid, public.message_delivery_status, text) from public;

grant execute on function public.save_automation_flow(uuid, text, text, jsonb, boolean) to antero_app;
grant execute on function public.publish_automation_flow(uuid, uuid, integer) to antero_app;
grant execute on function public.set_automation_flow_status(uuid, uuid, public.automation_flow_status) to antero_app;
grant execute on function public.dev_automation_prepare(uuid) to antero_app;
grant execute on function public.dev_automation_commit(uuid, uuid, integer, uuid, public.automation_session_status, text, jsonb, text, jsonb) to antero_app;
grant execute on function public.dev_automation_record_delivery(uuid, public.message_delivery_status, text) to antero_app;

-- migrate:down
-- Recusa-se se houver fluxo, sessão ou resposta da automação: reverter apagaria
-- configuração de cliente e histórico de atendimento.
do $$
begin
  if exists (select 1 from public.automation_flows)
     or exists (select 1 from public.messages where automation_execution_id is not null or payload is not null)
     or exists (select 1 from public.conversation_events where event_type::text in ('automation_started', 'handed_off')) then
    raise exception 'antero_automation: rollback de 0010 recusado: há fluxos ou histórico da automação';
  end if;
end;
$$;

drop function public.dev_automation_record_delivery(uuid, public.message_delivery_status, text);
drop function public.dev_automation_commit(uuid, uuid, integer, uuid, public.automation_session_status, text, jsonb, text, jsonb);
drop function public.dev_automation_prepare(uuid);
drop function public.assert_dev_automation_access(uuid);
drop function public.automation_record_delivery_internal(uuid, public.message_delivery_status, text);
drop function public.automation_commit_internal(uuid, uuid, integer, uuid, public.automation_session_status, text, jsonb, text, jsonb);
drop function public.automation_prepare_internal(uuid);
drop function public.automation_interrupt_internal(uuid, uuid, text);
drop function public.set_automation_flow_status(uuid, uuid, public.automation_flow_status);
drop function public.publish_automation_flow(uuid, uuid, integer);
drop function public.save_automation_flow(uuid, text, text, jsonb, boolean);
drop function public.assert_flow_definition_shape(jsonb);
drop function public.assert_automation_admin(uuid);

drop trigger conversations_stop_automation on public.conversations;
drop function public.stop_automation_on_conversation_change();

create or replace function public.record_conversation_event()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.assigned_user_id is not null
     and new.assigned_user_id is distinct from old.assigned_user_id then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'assigned', new.assigned_user_id);
  end if;

  if new.status = 'resolved' and old.status <> 'resolved' then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'resolved', app.current_user_id());
  elsif old.status = 'resolved' and new.status <> 'resolved' then
    insert into public.conversation_events (organization_id, conversation_id, event_type, user_id)
    values (new.organization_id, new.id, 'reopened', null);
  end if;

  return null;
end;
$$;

alter table public.conversation_events drop constraint conversation_events_user_matches_type;
alter table public.conversation_events
  add constraint conversation_events_user_matches_type
  check (
    (event_type <> 'assigned' or user_id is not null)
    and (event_type <> 'reopened' or user_id is null)
  );

drop index public.messages_automation_execution_idx;
alter table public.messages
  drop constraint messages_rich_type_has_payload,
  drop constraint messages_payload_is_bot,
  drop constraint messages_automation_execution_is_bot,
  drop constraint messages_automation_execution_fkey;
alter table public.messages
  drop column automation_execution_id,
  drop column payload;

drop table public.automation_executions;
drop table public.automation_sessions;
alter table public.automation_flows drop constraint automation_flows_published_version_fkey;
drop table public.automation_flow_versions;
drop function public.prevent_automation_version_update();
drop table public.automation_flows;
drop type public.automation_execution_outcome;
drop type public.automation_session_status;
drop type public.automation_flow_status;

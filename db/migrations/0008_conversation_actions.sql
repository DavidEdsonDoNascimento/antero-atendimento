-- migrate:up
-- Antero Atendimentos — Entrega E2A: atendimento humano (assumir, responder,
-- resolver) e registro das mudanças de atendimento.
--
-- Decisões:
--   - antero_app continua SEM INSERT/UPDATE/DELETE em conversations, messages e
--     na tabela nova. Cada operação é uma função SECURITY DEFINER com a
--     transição explícita; a autorização é refeita dentro dela contra a
--     identidade da transação (mesmo padrão de ingest_inbound_message).
--   - As funções recebem a organização ativa (decidida pelo servidor) E a
--     conversa, e exigem que as duas batam: um usuário com vínculo em duas
--     empresas só age na do contexto. Autorização: has_module(org,
--     'atendimento'), que já exige vínculo ativo em organização ativa.
--   - A linha da conversa é travada (FOR UPDATE) antes de decidir. Duas pessoas
--     assumindo ao mesmo tempo: a segunda espera o COMMIT da primeira, lê o
--     estado novo e recebe conflito. Repetir a própria operação não muda nada.
--
-- Transições (o enum e as constraints de 0003 não mudam):
--   assumir   waiting|bot -> human, responsável = quem assumiu. Já assumida pelo
--             próprio usuário: sem efeito. Por outro: conflito. Resolvida: não
--             elegível (reabre só com nova mensagem do cliente).
--   resolver  human -> resolved, pelo responsável ou por owner/admin. O
--             responsável é mantido (quem atendeu). Já resolvida: sem efeito.
--   reabrir   resolved -> waiting, limpando o responsável: continua sendo feito
--             só por ingest_inbound_message (0005), sem alteração.
--   responder só em human, só pelo responsável, só dentro da janela de 24 h
--             contada da última mensagem RECEBIDA do cliente.
--
-- Envio em duas fases, como será com a Cloud API (a chamada externa nunca fica
-- dentro de uma transação do banco):
--   1) send_conversation_reply grava a mensagem `pending`, com a chave de
--      idempotência do pedido (client_message_id);
--   2) o servidor chama o provedor e grava o resultado com
--      record_outbound_result (`sent` com o id externo, ou `failed`).
-- Nesta entrega, record_outbound_result só aceita canais `development`: o
-- usuário não consegue marcar como enviada uma mensagem de canal real. O
-- resultado da Cloud API virá do worker/webhook (E2B), por papel próprio.
--
-- conversation_events: conversations guarda só o estado ATUAL (responsável,
-- resolved_at), e a reabertura apaga os dois. A tabela guarda quem assumiu,
-- quando resolveu e quando reabriu. Quem respondeu já está em
-- messages.sender_user_id. É preenchida por gatilho em conversations, então
-- nenhum caminho de escrita (inclusive a ingestão, inalterada) deixa de
-- registrar. Não é a auditoria administrativa (E1C).

-- ---------------------------------------------------------------------------
-- Alvo (organization_id, id) para FK composta a partir de conversation_events.
-- ---------------------------------------------------------------------------
alter table public.conversations
  add constraint conversations_organization_id_id_key
  unique (organization_id, id);

-- ---------------------------------------------------------------------------
-- messages: chave de idempotência do envio pelo atendente. Única por conversa;
-- só existe em mensagem enviada por usuário. delivery_status e
-- external_message_id passam a mudar, só por record_outbound_result; conteúdo,
-- autor e horário continuam imutáveis.
-- ---------------------------------------------------------------------------
alter table public.messages
  add column client_message_id uuid;

alter table public.messages
  add constraint messages_client_message_id_user_outbound
  check (client_message_id is null or (direction = 'outbound' and sender_type = 'user'));

create unique index messages_conversation_client_message_id_key
  on public.messages (conversation_id, client_message_id)
  where client_message_id is not null;

-- ---------------------------------------------------------------------------
-- conversation_events
-- ---------------------------------------------------------------------------
create type public.conversation_event_type as enum ('assigned', 'resolved', 'reopened');

create table public.conversation_events (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  conversation_id uuid not null,
  event_type public.conversation_event_type not null,
  -- assigned: quem passou a responder; resolved: quem resolveu (nulo se não
  -- houver usuário na transação); reopened: sempre nulo (foi o cliente).
  user_id uuid,
  created_at timestamptz not null default now(),

  constraint conversation_events_conversation_fkey
    foreign key (organization_id, conversation_id)
    references public.conversations (organization_id, id)
    on delete cascade,
  -- Mesmo critério de messages.sender_user_id: só membro da organização, e o
  -- vínculo não some enquanto houver registro dele.
  constraint conversation_events_user_fkey
    foreign key (organization_id, user_id)
    references public.organization_members (organization_id, user_id)
    on delete restrict,
  constraint conversation_events_user_matches_type
    check (
      (event_type <> 'assigned' or user_id is not null)
      and (event_type <> 'reopened' or user_id is null)
    )
);

create index conversation_events_conversation_idx
  on public.conversation_events (organization_id, conversation_id, created_at desc, id desc);

alter table public.conversation_events enable row level security;

revoke all on public.conversation_events from antero_app;
grant select on public.conversation_events to antero_app;

-- Tabela do módulo Atendimento: vínculo ativo e módulo habilitado (docs/MODULES.md).
create policy "conversation_events_select"
  on public.conversation_events for select
  to antero_app
  using (
    public.is_org_member(organization_id)
    and public.has_module(organization_id, 'atendimento')
  );

-- Registra as mudanças de atendimento a partir da própria linha da conversa.
-- SECURITY INVOKER: as escritas em conversations só acontecem dentro das funções
-- SECURITY DEFINER (antero_owner); se um dia alguém ganhasse UPDATE direto, o
-- INSERT aqui falharia por falta de privilégio, em vez de gravar em silêncio.
create function public.record_conversation_event()
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

create trigger conversations_record_event
after update of status, assigned_user_id on public.conversations
for each row execute function public.record_conversation_event();

-- ---------------------------------------------------------------------------
-- Autorização comum às operações de atendimento. Exige usuário na transação e
-- has_module(org, 'atendimento') — vínculo ativo, organização ativa, módulo
-- habilitado. Interna: sem EXECUTE para antero_app.
-- ---------------------------------------------------------------------------
create function public.assert_attendance_access(p_organization_id uuid)
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
    raise exception 'antero_conversation: not_authenticated: operação requer usuário autenticado'
      using errcode = '28000';
  end if;
  if p_organization_id is null or not public.has_module(p_organization_id, 'atendimento') then
    raise exception 'antero_conversation: not_authorized: sem acesso ao Atendimento desta organização'
      using errcode = '42501';
  end if;
  return v_uid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Assumir atendimento.
-- ---------------------------------------------------------------------------
create function public.claim_conversation(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns table (
  status public.conversation_status,
  assigned_user_id uuid,
  assigned_at timestamptz,
  changed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public.assert_attendance_access(p_organization_id);
  v_status public.conversation_status;
  v_assignee uuid;
  v_assigned_at timestamptz;
begin
  select c.status, c.assigned_user_id, c.assigned_at
    into v_status, v_assignee, v_assigned_at
  from public.conversations c
  where c.organization_id = p_organization_id
    and c.id = p_conversation_id
  for update;

  if not found then
    raise exception 'antero_conversation: conversation_not_found: conversa inexistente nesta organização'
      using errcode = 'P0002';
  end if;

  if v_status = 'human' and v_assignee = v_uid then
    return query select v_status, v_assignee, v_assigned_at, false;
    return;
  end if;

  if v_status = 'resolved' then
    raise exception 'antero_conversation: not_eligible: conversa resolvida; reabre com nova mensagem do cliente'
      using errcode = 'AT002';
  end if;

  if v_assignee is not null and v_assignee <> v_uid then
    raise exception 'antero_conversation: assigned_to_other: conversa já está com outro atendente'
      using errcode = 'AT001';
  end if;

  update public.conversations c
  set status = 'human',
      assigned_user_id = v_uid,
      assigned_at = now()
  where c.organization_id = p_organization_id
    and c.id = p_conversation_id
  returning c.status, c.assigned_user_id, c.assigned_at
    into v_status, v_assignee, v_assigned_at;

  return query select v_status, v_assignee, v_assigned_at, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resolver atendimento.
-- ---------------------------------------------------------------------------
create function public.resolve_conversation(
  p_organization_id uuid,
  p_conversation_id uuid
)
returns table (
  status public.conversation_status,
  resolved_at timestamptz,
  changed boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public.assert_attendance_access(p_organization_id);
  v_status public.conversation_status;
  v_assignee uuid;
  v_resolved_at timestamptz;
begin
  select c.status, c.assigned_user_id, c.resolved_at
    into v_status, v_assignee, v_resolved_at
  from public.conversations c
  where c.organization_id = p_organization_id
    and c.id = p_conversation_id
  for update;

  if not found then
    raise exception 'antero_conversation: conversation_not_found: conversa inexistente nesta organização'
      using errcode = 'P0002';
  end if;

  if v_status = 'resolved' then
    return query select v_status, v_resolved_at, false;
    return;
  end if;

  if v_status <> 'human' then
    raise exception 'antero_conversation: not_eligible: só uma conversa em atendimento humano pode ser resolvida'
      using errcode = 'AT002';
  end if;

  if v_assignee <> v_uid and not public.is_org_admin(p_organization_id) then
    raise exception 'antero_conversation: not_assignee: só o responsável ou owner/admin resolve'
      using errcode = 'AT003';
  end if;

  update public.conversations c
  set status = 'resolved',
      resolved_at = now()
  where c.organization_id = p_organization_id
    and c.id = p_conversation_id
  returning c.status, c.resolved_at into v_status, v_resolved_at;

  return query select v_status, v_resolved_at, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Responder (fase 1 do envio): grava a mensagem `pending`. Devolve o necessário
-- para o servidor chamar o provedor do canal. O mesmo client_message_id
-- devolve a mensagem já gravada (created = false), sem gravar outra; ele é
-- conferido antes do estado, para um pedido repetido depois de resolver ainda
-- receber a mensagem original em vez de erro.
-- ---------------------------------------------------------------------------
create function public.send_conversation_reply(
  p_organization_id uuid,
  p_conversation_id uuid,
  p_content text,
  p_client_message_id uuid
)
returns table (
  message_id uuid,
  whatsapp_account_id uuid,
  provider public.whatsapp_provider,
  external_account_id text,
  recipient_phone_number text,
  content text,
  delivery_status public.message_delivery_status,
  created_at timestamptz,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := public.assert_attendance_access(p_organization_id);
  v_content text := pg_catalog.btrim(coalesce(p_content, ''));
  v_status public.conversation_status;
  v_assignee uuid;
  v_account_id uuid;
  v_contact_id uuid;
  v_provider public.whatsapp_provider;
  v_account_status public.whatsapp_status;
  v_external_account_id text;
  v_phone text;
  v_last_inbound_at timestamptz;
  v_message record;
begin
  if p_client_message_id is null then
    raise exception 'antero_conversation: missing_client_message_id: chave de idempotência obrigatória'
      using errcode = '22004';
  end if;

  if char_length(v_content) = 0 or char_length(v_content) > 4096 then
    raise exception 'antero_conversation: invalid_content: mensagem vazia ou com mais de 4096 caracteres'
      using errcode = 'AT005';
  end if;

  select c.status, c.assigned_user_id, c.whatsapp_account_id, c.contact_id
    into v_status, v_assignee, v_account_id, v_contact_id
  from public.conversations c
  where c.organization_id = p_organization_id
    and c.id = p_conversation_id
  for update;

  if not found then
    raise exception 'antero_conversation: conversation_not_found: conversa inexistente nesta organização'
      using errcode = 'P0002';
  end if;

  select w.provider, w.status, w.external_account_id
    into v_provider, v_account_status, v_external_account_id
  from public.whatsapp_accounts w
  where w.organization_id = p_organization_id
    and w.id = v_account_id;

  select ct.phone_number into v_phone
  from public.contacts ct
  where ct.organization_id = p_organization_id
    and ct.id = v_contact_id;

  -- Pedido repetido: a conversa está travada, então um pedido igual e
  -- simultâneo já terminou e está visível aqui.
  select m.id, m.sender_user_id, m.content, m.delivery_status, m.created_at
    into v_message
  from public.messages m
  where m.organization_id = p_organization_id
    and m.conversation_id = p_conversation_id
    and m.client_message_id = p_client_message_id;

  if found then
    if v_message.sender_user_id is distinct from v_uid then
      raise exception 'antero_conversation: idempotency_conflict: chave de envio já usada por outra mensagem'
        using errcode = 'AT006';
    end if;
    return query select v_message.id, v_account_id, v_provider, v_external_account_id, v_phone,
      v_message.content, v_message.delivery_status, v_message.created_at, false;
    return;
  end if;

  if v_status <> 'human' then
    raise exception 'antero_conversation: not_eligible: só uma conversa em atendimento humano recebe resposta'
      using errcode = 'AT002';
  end if;

  if v_assignee <> v_uid then
    raise exception 'antero_conversation: not_assignee: só o responsável responde'
      using errcode = 'AT003';
  end if;

  select m.created_at into v_last_inbound_at
  from public.messages m
  where m.organization_id = p_organization_id
    and m.conversation_id = p_conversation_id
    and m.direction = 'inbound'
  order by m.created_at desc, m.id desc
  limit 1;

  if v_last_inbound_at is null or v_last_inbound_at < now() - interval '24 hours' then
    raise exception 'antero_conversation: reply_window_closed: janela de 24 horas encerrada'
      using errcode = 'AT004';
  end if;

  if v_account_status <> 'connected' then
    raise exception 'antero_conversation: channel_unavailable: canal desconectado'
      using errcode = 'AT007';
  end if;

  insert into public.messages as m (
    organization_id, conversation_id, whatsapp_account_id, direction, sender_type,
    sender_user_id, message_type, content, delivery_status, client_message_id
  )
  values (
    p_organization_id, p_conversation_id, v_account_id, 'outbound', 'user',
    v_uid, 'text', v_content, 'pending', p_client_message_id
  )
  returning m.id, m.sender_user_id, m.content, m.delivery_status, m.created_at into v_message;

  update public.conversations c
  set last_message_at = now()
  where c.organization_id = p_organization_id
    and c.id = p_conversation_id;

  return query select v_message.id, v_account_id, v_provider, v_external_account_id, v_phone,
    v_message.content, v_message.delivery_status, v_message.created_at, true;
end;
$$;

-- ---------------------------------------------------------------------------
-- Resultado do envio (fase 2). Só o autor, só da própria mensagem `pending`,
-- só em canal de desenvolvimento nesta entrega. Repetir com o mesmo resultado
-- não muda nada; um resultado diferente depois do primeiro é ignorado (devolve
-- o estado gravado).
-- ---------------------------------------------------------------------------
create function public.record_outbound_result(
  p_organization_id uuid,
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
  v_uid uuid := public.assert_attendance_access(p_organization_id);
  v_external text := nullif(pg_catalog.btrim(coalesce(p_external_message_id, '')), '');
  v_status public.message_delivery_status;
  v_provider public.whatsapp_provider;
begin
  if p_delivery_status is null or p_delivery_status not in ('sent', 'failed') then
    raise exception 'antero_conversation: invalid_delivery_status: resultado deve ser sent ou failed'
      using errcode = '22023';
  end if;

  if (p_delivery_status = 'sent') <> (v_external is not null) then
    raise exception 'antero_conversation: invalid_external_message_id: id externo só (e sempre) em sent'
      using errcode = '22023';
  end if;

  select m.delivery_status, w.provider
    into v_status, v_provider
  from public.messages m
  join public.whatsapp_accounts w
    on w.organization_id = m.organization_id and w.id = m.whatsapp_account_id
  where m.organization_id = p_organization_id
    and m.id = p_message_id
    and m.direction = 'outbound'
    and m.sender_type = 'user'
    and m.sender_user_id = v_uid
  for update of m;

  if not found then
    raise exception 'antero_conversation: message_not_found: mensagem inexistente ou de outro autor'
      using errcode = 'P0002';
  end if;

  if v_provider <> 'development' then
    raise exception 'antero_conversation: provider_not_allowed: resultado de canal real vem do provedor'
      using errcode = 'AT008';
  end if;

  if v_status <> 'pending' then
    return v_status;
  end if;

  update public.messages m
  set delivery_status = p_delivery_status,
      external_message_id = v_external
  where m.organization_id = p_organization_id
    and m.id = p_message_id;

  return p_delivery_status;
end;
$$;

revoke all on function public.record_conversation_event() from public;
revoke all on function public.assert_attendance_access(uuid) from public;
revoke all on function public.claim_conversation(uuid, uuid) from public;
revoke all on function public.resolve_conversation(uuid, uuid) from public;
revoke all on function public.send_conversation_reply(uuid, uuid, text, uuid) from public;
revoke all on function public.record_outbound_result(uuid, uuid, public.message_delivery_status, text) from public;

grant execute on function public.claim_conversation(uuid, uuid) to antero_app;
grant execute on function public.resolve_conversation(uuid, uuid) to antero_app;
grant execute on function public.send_conversation_reply(uuid, uuid, text, uuid) to antero_app;
grant execute on function public.record_outbound_result(uuid, uuid, public.message_delivery_status, text) to antero_app;

-- migrate:down
-- Recusa-se se já houver registro de atendimento ou mensagem enviada por esta
-- entrega: reverter apagaria o histórico de quem assumiu, resolveu e respondeu.
do $$
begin
  if exists (select 1 from public.conversation_events)
     or exists (select 1 from public.messages where client_message_id is not null) then
    raise exception 'antero_conversation: rollback recusado: há histórico de atendimento que seria perdido';
  end if;
end;
$$;

drop function public.record_outbound_result(uuid, uuid, public.message_delivery_status, text);
drop function public.send_conversation_reply(uuid, uuid, text, uuid);
drop function public.resolve_conversation(uuid, uuid);
drop function public.claim_conversation(uuid, uuid);
drop function public.assert_attendance_access(uuid);

drop trigger conversations_record_event on public.conversations;
drop function public.record_conversation_event();
drop table public.conversation_events;
drop type public.conversation_event_type;

drop index public.messages_conversation_client_message_id_key;
alter table public.messages drop constraint messages_client_message_id_user_outbound;
alter table public.messages drop column client_message_id;

alter table public.conversations drop constraint conversations_organization_id_id_key;

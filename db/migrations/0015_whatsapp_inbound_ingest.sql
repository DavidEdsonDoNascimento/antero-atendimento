-- migrate:up
-- Antero Atendimentos — Entrega E2B-2a: porta segura de ingestão das mensagens
-- recebidas pela WhatsApp Cloud API (webhook da Meta → evento bruto da 0014 →
-- contato, conversa e mensagem).
--
-- Decisões:
--   - Porta única do worker: `webhook_ingest_message(evento, token, wamid)`.
--     O chamador informa só QUAL mensagem de QUAL evento reivindicado quer
--     ingerir. Organização, canal, telefone, texto, tipo e horário saem da
--     linha persistida em `webhook_events` (gravada antes do 200 e já ligada
--     ao canal pela 0014), nunca de parâmetros. O token e o prazo da
--     reivindicação são conferidos; um wamid que não está no evento é recusado.
--   - Situação atual conferida a cada ingestão: canal cloud_api conectado e
--     com os mesmos ids do evento, organização ativa, módulo Atendimento ou
--     Automações ligado. Sem isso, `rejected` sem gravar nada.
--   - Uma só implementação da ingestão: o corpo de `ingest_inbound_message`
--     (0005) foi para `ingest_inbound_internal`, sem EXECUTE para ninguém. A
--     porta do simulador continua com as mesmas checagens, na mesma ordem, e
--     com o mesmo resultado (pgTAP 050/060 inalterados).
--   - Mensagem recebida guarda o tipo original da Meta
--     (`provider_message_type`), o horário da Meta quando válido
--     (`provider_sent_at`), a chegada do webhook (`webhook_received_at`) e, nas
--     respostas de lista/botão, o id escolhido (`interaction_reply_id`).
--     Mídias e tipos não suportados viram texto marcador (sem download); o
--     tipo original diz ao motor (E2B-2b) que aquilo não é resposta do cliente.
--   - Horário da Meta: válido se cair entre 30 dias antes e 5 minutos depois
--     da CHEGADA do webhook (não do processamento da fila). Ausente, inválido
--     ou fora disso: a mensagem entra, `provider_sent_at` fica nulo e o
--     resultado diz o porquê. Janela de 24 h de canal cloud_api: só horários
--     válidos, limitados à chegada (`least(provider_sent_at,
--     webhook_received_at)`), pelo maior deles. Sem horário válido, não há
--     janela. Canal development: regra anterior (`created_at`).
--   - Mensagem válida que não pode virar conversa com segurança (sem
--     telefone, telefone inválido, conteúdo inválido ou acima de 4096
--     caracteres, identidade em conflito) fica em `webhook_message_holds`, com
--     motivo e a cópia só do elemento da mensagem e do contato. Sobrevive à
--     exclusão do evento (FK anulável, ON DELETE SET NULL). Nenhum contato
--     fictício é criado.
--   - Cópia da retenção: o elemento inteiro até 512 KiB (mensagem) e 16 KiB
--     (contato). Acima disso, uma representação LIMITADA, marcada
--     (`*_storage = 'size_limited'`), com tamanho e sha256 do original; nunca
--     erro de constraint nem descarte. A representação limitada não tem a
--     forma de uma mensagem da Meta (o texto vira `text_body_prefix`), então
--     não é interpretada como mensagem completa.
--   - BSUID (`user_id`, Meta): formato documentado "país + ponto + até 128
--     alfanuméricos" (variante parent com ENT.), escopo por PORTFÓLIO
--     empresarial, regenerado na troca de número. Como a organização não é o
--     portfólio, não há índice único: só formato conservador (alfanumérico e
--     ponto, até 160). Política CONSERVADORA (MVP): qualquer divergência entre
--     o BSUID recebido e o do contato (o telefone já tem outro BSUID, o BSUID
--     já é de outro contato, ou a notificação traz dois) retém a mensagem
--     (`identity_conflict`). Pode reter mensagem legítima de BSUIDs de
--     portfólios diferentes; reavaliar antes de operar com vários portfólios.
--     Nunca sobrescreve um BSUID já gravado nem une contatos.
--   - Duplicidade: lock consultivo por (canal, wamid), o mesmo da 0005, decide
--     entre mensagem existente, retenção existente e ingestão nova. Nunca um
--     lock global; organizações independentes não se esperam.
--   - Identidade sob trava, sempre nesta ordem: (canal, wamid) → (organização,
--     telefone) → (organização, BSUID) → linhas (contato, conversa). Uma
--     chamada por transação (o worker usa autocommit): várias ingestões numa
--     mesma transação acumulariam travas fora da ordem.
-- Requer a 0014 (fila e papel antero_worker).
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'antero_worker') then
    raise exception 'antero_webhook: 0015 requer o papel antero_worker: rode `pnpm db:roles` (local) ou docker/postgres/initdb/10-roles.sh (servidor) antes de migrar';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- messages: dados de origem da mensagem recebida (só inbound)
-- ---------------------------------------------------------------------------
alter table public.messages
  add column provider_message_type text,
  add column provider_sent_at timestamptz,
  add column webhook_received_at timestamptz,
  add column interaction_reply_id text;

alter table public.messages
  add constraint messages_provider_fields_inbound
    check (
      direction = 'inbound'
      or (provider_message_type is null and provider_sent_at is null
          and webhook_received_at is null and interaction_reply_id is null)
    ),
  -- Tipo e chegada andam juntos: toda mensagem que veio do webhook tem os dois.
  add constraint messages_provider_origin_complete
    check ((provider_message_type is null) = (webhook_received_at is null)),
  add constraint messages_provider_message_type_format
    check (provider_message_type ~ '^[a-z_]{1,32}$'),
  add constraint messages_provider_sent_at_has_arrival
    check (provider_sent_at is null or webhook_received_at is not null),
  add constraint messages_interaction_reply_id_format
    check (
      interaction_reply_id is null
      or (provider_message_type = 'interactive' and char_length(interaction_reply_id) between 1 and 256)
    ),
  -- Alvo de FK composta (retenção resolvida → mensagem do mesmo canal e organização).
  add constraint messages_organization_account_id_key
    unique (organization_id, whatsapp_account_id, id);

-- ---------------------------------------------------------------------------
-- contacts: BSUID opcional (sem unicidade: ver cabeçalho)
-- ---------------------------------------------------------------------------
alter table public.contacts
  add column whatsapp_user_id text;

alter table public.contacts
  add constraint contacts_whatsapp_user_id_format
    check (whatsapp_user_id ~ '^[A-Za-z0-9.]{1,160}$');

create index contacts_organization_whatsapp_user_id_idx
  on public.contacts (organization_id, whatsapp_user_id)
  where whatsapp_user_id is not null;

-- ---------------------------------------------------------------------------
-- webhook_events: alvo de FK composta (retenção → evento do mesmo canal)
-- ---------------------------------------------------------------------------
alter table public.webhook_events
  add constraint webhook_events_organization_account_id_key
    unique (organization_id, whatsapp_account_id, id);

-- ---------------------------------------------------------------------------
-- webhook_message_holds: mensagens válidas que não puderam ser ingeridas
-- com segurança. Prazo previsto: 90 dias (`created_at`), purga em entrega
-- própria. Estados: held (aguardando), resolved (virou mensagem), discarded.
-- Sem acesso para nenhum papel da aplicação.
-- ---------------------------------------------------------------------------
create table public.webhook_message_holds (
  id bigint generated always as identity primary key,
  organization_id uuid not null,
  whatsapp_account_id uuid not null,
  -- Evento de origem; nulo depois que a retenção de 30 dias o remover.
  event_id bigint,
  wamid text not null,
  reason text not null,
  status text not null default 'held',
  provider_message_type text,
  provider_user_id text,
  provider_sent_at timestamptz,
  webhook_received_at timestamptz not null,
  -- Só o elemento `messages[i]` e o `contacts[j]` correspondente, não a
  -- notificação. `complete`: o elemento como veio; `size_limited`: acima do
  -- limite, só os campos de identificação (ver webhook_hold_copy).
  message jsonb not null,
  message_storage text not null default 'complete',
  -- Tamanho (bytes UTF-8) e sha256 do texto canônico (jsonb::text) do
  -- elemento ORIGINAL: rastreabilidade quando a cópia é limitada.
  message_original_bytes integer not null,
  message_sha256 bytea not null,
  contact jsonb,
  contact_storage text,
  contact_original_bytes integer,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  resolved_at timestamptz,
  resolved_message_id uuid,

  constraint webhook_message_holds_account_wamid_key unique (whatsapp_account_id, wamid),
  constraint webhook_message_holds_organization_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  -- NO ACTION: o canal com retenções não é removido sozinho; a organização
  -- inteira é (mesmo padrão de webhook_events, 0014).
  constraint webhook_message_holds_account_fkey
    foreign key (organization_id, whatsapp_account_id)
    references public.whatsapp_accounts (organization_id, id),
  -- Mesmo canal e organização do evento; a exclusão do evento só anula event_id.
  constraint webhook_message_holds_event_fkey
    foreign key (organization_id, whatsapp_account_id, event_id)
    references public.webhook_events (organization_id, whatsapp_account_id, id)
    on delete set null (event_id),
  constraint webhook_message_holds_resolved_message_fkey
    foreign key (organization_id, whatsapp_account_id, resolved_message_id)
    references public.messages (organization_id, whatsapp_account_id, id)
    on delete set null (resolved_message_id),
  constraint webhook_message_holds_wamid_length check (char_length(wamid) between 1 and 256),
  constraint webhook_message_holds_reason_known
    check (reason in ('missing_phone', 'invalid_phone', 'invalid_content', 'content_too_long', 'identity_conflict')),
  constraint webhook_message_holds_status_known check (status in ('held', 'resolved', 'discarded')),
  constraint webhook_message_holds_resolution
    check ((status = 'held') = (resolved_at is null)),
  constraint webhook_message_holds_resolved_message_only_resolved
    check (resolved_message_id is null or status = 'resolved'),
  constraint webhook_message_holds_type_format check (provider_message_type ~ '^[a-z_]{1,32}$'),
  constraint webhook_message_holds_user_id_format check (provider_user_id ~ '^[A-Za-z0-9.]{1,160}$'),
  -- Limites: os mesmos que webhook_hold_copy confere ANTES de gravar (a
  -- constraint é a última defesa, nunca o caminho normal).
  constraint webhook_message_holds_message_object
    check (jsonb_typeof(message) = 'object' and pg_column_size(message) <= 524288),
  constraint webhook_message_holds_message_storage_known
    check (message_storage in ('complete', 'size_limited')),
  constraint webhook_message_holds_message_original
    check (message_original_bytes > 0 and octet_length(message_sha256) = 32),
  constraint webhook_message_holds_contact_object
    check (contact is null or (jsonb_typeof(contact) = 'object' and pg_column_size(contact) <= 16384)),
  constraint webhook_message_holds_contact_storage
    check (
      case when contact is null then contact_storage is null and contact_original_bytes is null
           else coalesce(contact_storage in ('complete', 'size_limited') and contact_original_bytes > 0, false)
      end
    )
);

create index webhook_message_holds_created_idx
  on public.webhook_message_holds (created_at);

create index webhook_message_holds_organization_idx
  on public.webhook_message_holds (organization_id, status, created_at);

create index webhook_message_holds_event_idx
  on public.webhook_message_holds (event_id)
  where event_id is not null;

alter table public.webhook_message_holds enable row level security;
revoke all on public.webhook_message_holds from antero_app, antero_auth, antero_worker;

-- ---------------------------------------------------------------------------
-- ingest_inbound_internal: o corpo da ingestão (0005), sem nenhuma checagem
-- de quem chama. Só funções SECURITY DEFINER desta base a chamam; nenhum papel
-- tem EXECUTE. Mesmas validações, mesma trava, mesma ordem e mesmos efeitos da
-- 0005; os parâmetros novos são nulos na porta do simulador.
-- ---------------------------------------------------------------------------
create function public.ingest_inbound_internal(
  p_organization_id uuid,
  p_whatsapp_account_id uuid,
  p_phone_number text,
  p_content text,
  p_external_message_id text,
  p_contact_name text,
  p_provider_message_type text,
  p_provider_sent_at timestamptz,
  p_webhook_received_at timestamptz,
  p_interaction_reply_id text
)
returns table (
  organization_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  created boolean,
  duplicate boolean,
  reopened boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_organization_id uuid := p_organization_id;
  v_phone_number text := p_phone_number;
  v_content text := trim(p_content);
  v_external_message_id text := trim(p_external_message_id);
  v_contact_name text := nullif(trim(coalesce(p_contact_name, '')), '');
  v_contact_id uuid;
  v_conversation_id uuid;
  v_conversation_status public.conversation_status;
  v_message_id uuid;
  v_created boolean := false;
  v_duplicate boolean := false;
  v_reopened boolean := false;
  v_lock_key bigint;
  v_existing_message_id uuid;
  v_existing_conversation_id uuid;
  v_existing_organization_id uuid;
begin
  -- O canal pertence à organização informada (defesa: quem chama é interno).
  if p_organization_id is null or not exists (
    select 1 from public.whatsapp_accounts w
    where w.organization_id = p_organization_id and w.id = p_whatsapp_account_id
  ) then
    raise exception 'antero_ingest: account_not_found: whatsapp_account % não existe', p_whatsapp_account_id;
  end if;

  -- 5) telefone em E.164 (a constraint de contacts continua sendo a autoridade).
  if v_phone_number !~ '^\+[1-9][0-9]{1,14}$' then
    raise exception 'antero_ingest: invalid_phone_number: telefone % não está em E.164', v_phone_number;
  end if;

  -- 6)/7) conteúdo após trim, não vazio e dentro do limite.
  if char_length(v_content) = 0 then
    raise exception 'antero_ingest: empty_content: conteúdo da mensagem está vazio após trim';
  end if;

  if char_length(v_content) > 4096 then
    raise exception 'antero_ingest: content_too_long: conteúdo da mensagem excede 4096 caracteres';
  end if;

  -- 8) external_message_id obrigatório e não vazio.
  if p_external_message_id is null or char_length(v_external_message_id) = 0 then
    raise exception 'antero_ingest: missing_external_message_id: external_message_id é obrigatório e não pode ser vazio';
  end if;

  -- Duplicidade decidida ANTES de qualquer escrita (ver 0005).
  v_lock_key := hashtextextended(p_whatsapp_account_id::text || ':' || v_external_message_id, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select m.id, m.conversation_id, m.organization_id
    into v_existing_message_id, v_existing_conversation_id, v_existing_organization_id
  from public.messages m
  where m.whatsapp_account_id = p_whatsapp_account_id
    and m.external_message_id = v_external_message_id;

  if found then
    select c.contact_id into v_contact_id
    from public.conversations c
    where c.organization_id = v_existing_organization_id
      and c.id = v_existing_conversation_id;

    return query
    select
      v_existing_organization_id,
      v_contact_id,
      v_existing_conversation_id,
      v_existing_message_id,
      false,
      true,
      false;
    return;
  end if;

  insert into public.contacts (organization_id, phone_number, name)
  values (v_organization_id, v_phone_number, v_contact_name)
  on conflict (organization_id, phone_number) do nothing
  returning id into v_contact_id;

  if v_contact_id is null then
    select c.id into v_contact_id
    from public.contacts c
    where c.organization_id = v_organization_id
      and c.phone_number = v_phone_number;
  end if;

  insert into public.conversations (organization_id, whatsapp_account_id, contact_id)
  values (v_organization_id, p_whatsapp_account_id, v_contact_id)
  on conflict (organization_id, whatsapp_account_id, contact_id) do nothing
  returning id, status into v_conversation_id, v_conversation_status;

  if v_conversation_id is null then
    select c.id, c.status
      into v_conversation_id, v_conversation_status
    from public.conversations c
    where c.organization_id = v_organization_id
      and c.whatsapp_account_id = p_whatsapp_account_id
      and c.contact_id = v_contact_id
    for update;
  end if;

  insert into public.messages (
    organization_id,
    conversation_id,
    whatsapp_account_id,
    external_message_id,
    direction,
    sender_type,
    sender_user_id,
    message_type,
    content,
    delivery_status,
    provider_message_type,
    provider_sent_at,
    webhook_received_at,
    interaction_reply_id
  )
  values (
    v_organization_id,
    v_conversation_id,
    p_whatsapp_account_id,
    v_external_message_id,
    'inbound',
    'contact',
    null,
    'text',
    v_content,
    'delivered',
    p_provider_message_type,
    p_provider_sent_at,
    p_webhook_received_at,
    p_interaction_reply_id
  )
  on conflict (whatsapp_account_id, external_message_id) where external_message_id is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    v_duplicate := true;
    v_created := false;
    v_reopened := false;

    select m.id, m.conversation_id, m.organization_id
      into v_message_id, v_conversation_id, v_organization_id
    from public.messages m
    where m.whatsapp_account_id = p_whatsapp_account_id
      and m.external_message_id = v_external_message_id;

    select c.contact_id
      into v_contact_id
    from public.conversations c
    where c.organization_id = v_organization_id
      and c.id = v_conversation_id;
  else
    v_created := true;
    v_duplicate := false;
    v_reopened := (v_conversation_status = 'resolved');

    -- `last_message_at` é a CHEGADA (now()), nunca o horário da Meta: uma
    -- mensagem atrasada não faz a conversa regredir na Inbox.
    if v_reopened then
      update public.conversations
      set status = 'waiting',
          resolved_at = null,
          assigned_user_id = null,
          assigned_at = null,
          last_message_at = now()
      where organization_id = v_organization_id
        and id = v_conversation_id;
    else
      update public.conversations
      set last_message_at = now()
      where organization_id = v_organization_id
        and id = v_conversation_id;
    end if;
  end if;

  return query
  select
    v_organization_id,
    v_contact_id,
    v_conversation_id,
    v_message_id,
    v_created,
    v_duplicate,
    v_reopened;
end;
$$;

-- ---------------------------------------------------------------------------
-- ingest_inbound_message (porta do simulador, 0005): mesmas checagens 1–4, na
-- mesma ordem; o resto é a função interna, com os campos novos nulos.
-- ---------------------------------------------------------------------------
create or replace function public.ingest_inbound_message(
  p_whatsapp_account_id uuid,
  p_phone_number text,
  p_content text,
  p_external_message_id text,
  p_contact_name text default null
)
returns table (
  organization_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  created boolean,
  duplicate boolean,
  reopened boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_organization_id uuid;
  v_account_status public.whatsapp_status;
  v_account_provider public.whatsapp_provider;
begin
  -- 1) usuário autenticado
  v_uid := app.current_user_id();
  if v_uid is null then
    raise exception 'antero_ingest: not_authenticated: chamada requer usuário autenticado'
      using errcode = '28000';
  end if;

  -- 2) conta existente e ativa + 3) provider dev
  select w.organization_id, w.status, w.provider
    into v_organization_id, v_account_status, v_account_provider
  from public.whatsapp_accounts w
  where w.id = p_whatsapp_account_id;

  if not found then
    raise exception 'antero_ingest: account_not_found: whatsapp_account % não existe', p_whatsapp_account_id;
  end if;

  if v_account_status <> 'connected' then
    raise exception 'antero_ingest: account_inactive: whatsapp_account % não está ativa (status=%)',
      p_whatsapp_account_id, v_account_status;
  end if;

  if v_account_provider <> 'development' then
    raise exception 'antero_ingest: account_wrong_provider: whatsapp_account % não é provider development (provider=%)',
      p_whatsapp_account_id, v_account_provider;
  end if;

  -- 4) autorização por organização: chamador deve ser owner/admin ativo
  if not public.is_org_admin(v_organization_id) then
    raise exception 'antero_ingest: not_authorized: usuário % não é owner/admin ativo da organização %',
      v_uid, v_organization_id
      using errcode = '42501';
  end if;

  return query
  select *
  from public.ingest_inbound_internal(
    v_organization_id, p_whatsapp_account_id, p_phone_number, p_content,
    p_external_message_id, p_contact_name, null, null, null, null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- webhook_message_content: o que uma mensagem da Meta vira no Antero. Pura
-- (sem tabela). `ok` com o conteúdo; `ignored` (reação, mensagem de sistema:
-- não são falas do cliente); `invalid` (estrutura que não dá para gravar).
--   - text: o corpo (1 a 4096 caracteres após trim);
--   - interactive list_reply/button_reply: o título como conteúdo e o id
--     escolhido em interaction_reply_id;
--   - audio, image, video, document, sticker, location: marcador próprio;
--     a legenda (image/video/document) vem depois do marcador, cortada para
--     caber em 4096;
--   - qualquer outro tipo (contacts, button de template, order, unsupported,
--     interactive de outro tipo…): marcador genérico.
-- ---------------------------------------------------------------------------
create function public.webhook_message_content(p_message jsonb)
returns table (outcome text, reason text, provider_message_type text, content text, interaction_reply_id text)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_type text;
  v_text text;
  v_kind text;
  v_id text;
  v_marker text;
begin
  if jsonb_typeof(p_message) is distinct from 'object'
     or jsonb_typeof(p_message -> 'type') is distinct from 'string'
     or (p_message ->> 'type') !~ '^[a-z_]{1,32}$' then
    return query select 'invalid'::text, 'invalid_content'::text, null::text, null::text, null::text;
    return;
  end if;
  v_type := p_message ->> 'type';

  if v_type in ('reaction', 'system') then
    return query select 'ignored'::text, v_type, v_type, null::text, null::text;
    return;
  end if;

  if v_type = 'text' then
    v_text := btrim(coalesce(p_message #>> '{text,body}', ''));
    if char_length(v_text) between 1 and 4096 then
      return query select 'ok'::text, null::text, v_type, v_text, null::text;
    elsif char_length(v_text) > 4096 then
      -- Texto legítimo, só maior que `messages.content`: retido, nunca cortado.
      return query select 'invalid'::text, 'content_too_long'::text, v_type, null::text, null::text;
    else
      return query select 'invalid'::text, 'invalid_content'::text, v_type, null::text, null::text;
    end if;
    return;
  end if;

  if v_type = 'interactive' then
    v_kind := p_message #>> '{interactive,type}';
    if v_kind in ('list_reply', 'button_reply') then
      v_text := btrim(coalesce(p_message -> 'interactive' -> v_kind ->> 'title', ''));
      v_id := p_message -> 'interactive' -> v_kind ->> 'id';
      if char_length(v_text) between 1 and 4096 and char_length(coalesce(v_id, '')) between 1 and 256 then
        return query select 'ok'::text, null::text, v_type, v_text, v_id;
      else
        return query select 'invalid'::text, 'invalid_content'::text, v_type, null::text, null::text;
      end if;
      return;
    end if;
  end if;

  v_marker := case v_type
    when 'audio' then '[Áudio recebido — conteúdo indisponível no Antero]'
    when 'image' then '[Imagem recebida — conteúdo indisponível no Antero]'
    when 'video' then '[Vídeo recebido — conteúdo indisponível no Antero]'
    when 'document' then '[Documento recebido — conteúdo indisponível no Antero]'
    when 'sticker' then '[Figurinha recebida — conteúdo indisponível no Antero]'
    when 'location' then '[Localização recebida — conteúdo indisponível no Antero]'
    else '[Mensagem recebida — formato não suportado]'
  end;

  if v_type in ('image', 'video', 'document') and jsonb_typeof(p_message -> v_type) = 'object' then
    v_text := btrim(coalesce(p_message -> v_type ->> 'caption', ''));
    if char_length(v_text) > 0 then
      v_marker := v_marker || E'\n' || left(v_text, 4096 - char_length(v_marker) - 1);
    end if;
  end if;

  return query select 'ok'::text, null::text, v_type, v_marker, null::text;
end;
$$;

-- ---------------------------------------------------------------------------
-- webhook_hold_copy: o que a retenção guarda de um elemento (`message` ou
-- `contact`). Pura (sem tabela). Até o limite (512 KiB mensagem, 16 KiB
-- contato, medidos como a constraint mede: pg_column_size), o elemento como
-- veio (`complete`). Acima, `size_limited`: só os campos de identificação,
-- cada um cortado, e o começo do texto em `text_body_prefix` (fora do formato
-- da Meta: nunca é lido como mensagem completa). Sempre devolve o tamanho
-- (bytes UTF-8) e o sha256 do texto canônico do ORIGINAL.
-- ---------------------------------------------------------------------------
create function public.webhook_hold_copy(p_kind text, p_element jsonb)
returns table (element jsonb, storage text, original_bytes integer, element_sha256 bytea)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_limit integer;
  v_canonical bytea;
begin
  if p_element is null or jsonb_typeof(p_element) is distinct from 'object'
     or p_kind is null or p_kind not in ('message', 'contact') then
    raise exception 'antero_webhook: invalid_input: elemento de retenção deve ser um objeto (message/contact)'
      using errcode = '22023';
  end if;

  v_limit := case p_kind when 'message' then 524288 else 16384 end;
  v_canonical := pg_catalog.convert_to(p_element::text, 'UTF8');

  if pg_catalog.pg_column_size(p_element) <= v_limit then
    return query select p_element, 'complete'::text, octet_length(v_canonical), pg_catalog.sha256(v_canonical);
    return;
  end if;

  if p_kind = 'message' then
    return query select
      jsonb_strip_nulls(jsonb_build_object(
        'id', case when jsonb_typeof(p_element -> 'id') = 'string' then left(p_element ->> 'id', 256) end,
        'from', case when jsonb_typeof(p_element -> 'from') = 'string' then left(p_element ->> 'from', 256) end,
        'from_user_id', case when jsonb_typeof(p_element -> 'from_user_id') = 'string' then left(p_element ->> 'from_user_id', 256) end,
        'timestamp', case when jsonb_typeof(p_element -> 'timestamp') in ('string', 'number') then left(p_element ->> 'timestamp', 32) end,
        'type', case when jsonb_typeof(p_element -> 'type') = 'string' then left(p_element ->> 'type', 64) end,
        'text_body_prefix', case when jsonb_typeof(p_element #> '{text,body}') = 'string' then left(p_element #>> '{text,body}', 4096) end
      )),
      'size_limited'::text, octet_length(v_canonical), pg_catalog.sha256(v_canonical);
  else
    return query select
      jsonb_strip_nulls(jsonb_build_object(
        'wa_id', case when jsonb_typeof(p_element -> 'wa_id') = 'string' then left(p_element ->> 'wa_id', 256) end,
        'user_id', case when jsonb_typeof(p_element -> 'user_id') = 'string' then left(p_element ->> 'user_id', 256) end,
        'profile_name_prefix', case when jsonb_typeof(p_element #> '{profile,name}') = 'string' then left(p_element #>> '{profile,name}', 256) end
      )),
      'size_limited'::text, octet_length(v_canonical), pg_catalog.sha256(v_canonical);
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- webhook_ingest_message: a porta do worker. Ver o cabeçalho e docs/WHATSAPP.md.
--
-- Erros (nada gravado):
--   22023 invalid_input         parâmetros ausentes ou wamid fora de 1–256 / com espaços nas pontas
--   P0002 event_not_found       evento inexistente
--   WH001 claim_lost            evento não pendente, token diferente ou prazo vencido
--   WH002 message_not_in_event  o wamid não está em `value.messages` do evento
--   WH003 unsupported_field     evento de outro campo que não `messages`
--   WH004 provider_not_allowed  canal do evento não é cloud_api
--   WH005 identity_race         o BSUID do contato mudou sob a trava (não deveria
--                               acontecer; a transação inteira é desfeita)
-- Resultados:
--   created    mensagem nova (contato e conversa criados ou reaproveitados)
--   duplicate  o wamid já é uma mensagem deste canal
--   held       retida (reason); duplicate = true se a retenção já existia
--   ignored    reação ou mensagem de sistema (reason), nada gravado
--   rejected   channel_disconnected | channel_mismatch | organization_inactive | modules_disabled
-- provider_time_status: valid | missing | invalid | out_of_range.
-- identity_note:
--   bsuid_invalid        BSUID fora do formato: descartado, a mensagem segue pelo telefone
--   bsuid_contradiction  (held) a notificação traz dois BSUIDs para a mensagem
--   bsuid_in_use         (held) o BSUID já é de outro contato da organização
--   bsuid_mismatch       (held) o telefone já tem outro BSUID
-- Nada disso vai para log: só o código; os identificadores ficam na retenção.
-- ---------------------------------------------------------------------------
create function public.webhook_ingest_message(p_event_id bigint, p_claim_token uuid, p_wamid text)
returns table (
  outcome text,
  reason text,
  organization_id uuid,
  whatsapp_account_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  hold_id bigint,
  duplicate boolean,
  reopened boolean,
  provider_time_status text,
  identity_note text
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_event record;
  v_channel record;
  v_message jsonb;
  v_contact jsonb;
  v_content record;
  v_existing record;
  v_result record;
  v_org uuid;
  v_account uuid;
  v_reason text;
  v_from text;
  v_phone text;
  v_bsuid_message text;
  v_bsuid_contact text;
  v_bsuid text;
  v_known_bsuid text;
  v_name text;
  v_raw_time text;
  v_sent_at timestamptz;
  v_time_status text;
  v_identity text;
  v_hold_reason text;
  v_hold_id bigint;
  v_copy record;
  v_contact_element jsonb;
  v_contact_storage text;
  v_contact_bytes integer;
begin
  if p_event_id is null or p_claim_token is null or p_wamid is null
     or char_length(p_wamid) not between 1 and 256 or p_wamid <> btrim(p_wamid) then
    raise exception 'antero_webhook: invalid_input: evento, token e wamid (1 a 256 caracteres, sem espaços nas pontas) são obrigatórios'
      using errcode = '22023';
  end if;

  -- FOR SHARE: várias mensagens do mesmo evento podem ser ingeridas ao mesmo
  -- tempo, mas nem uma nova reivindicação nem o encerramento passam no meio.
  select e.status, e.claim_token, e.claimed_until, e.field, e.organization_id, e.whatsapp_account_id,
         e.phone_number_id, e.waba_id, e.received_at, e.payload
    into v_event
  from public.webhook_events e
  where e.id = p_event_id
  for share;

  if not found then
    raise exception 'antero_webhook: event_not_found: evento inexistente'
      using errcode = 'P0002';
  end if;
  if v_event.status <> 'received'
     or v_event.claim_token is distinct from p_claim_token
     or v_event.claimed_until is null
     or v_event.claimed_until <= pg_catalog.clock_timestamp() then
    raise exception 'antero_webhook: claim_lost: o evento não está reivindicado por este token'
      using errcode = 'WH001';
  end if;
  if v_event.field is distinct from 'messages' then
    raise exception 'antero_webhook: unsupported_field: só eventos do campo messages contêm mensagens'
      using errcode = 'WH003';
  end if;

  select el into v_message
  from jsonb_array_elements(
         case when jsonb_typeof(v_event.payload #> '{value,messages}') = 'array'
              then v_event.payload #> '{value,messages}' else '[]'::jsonb end) as t(el)
  where jsonb_typeof(el) = 'object' and el ->> 'id' = p_wamid
  limit 1;

  if v_message is null then
    raise exception 'antero_webhook: message_not_in_event: a mensagem não pertence a este evento'
      using errcode = 'WH002';
  end if;

  v_org := v_event.organization_id;
  v_account := v_event.whatsapp_account_id;

  -- Situação ATUAL do canal e da organização (podem ter mudado desde a gravação).
  select w.provider, w.status, w.external_account_id, w.external_business_account_id,
         o.status as organization_status
    into v_channel
  from public.whatsapp_accounts w
  join public.organizations o on o.id = w.organization_id
  where w.organization_id = v_org and w.id = v_account;

  if not found or v_channel.provider <> 'cloud_api' then
    raise exception 'antero_webhook: provider_not_allowed: esta porta só atende canais cloud_api'
      using errcode = 'WH004';
  end if;

  if v_channel.external_account_id is distinct from v_event.phone_number_id
     or v_channel.external_business_account_id is distinct from v_event.waba_id then
    v_reason := 'channel_mismatch';
  elsif v_channel.status <> 'connected' then
    v_reason := 'channel_disconnected';
  elsif v_channel.organization_status <> 'active' then
    v_reason := 'organization_inactive';
  elsif not exists (
    select 1 from public.organization_modules om
    where om.organization_id = v_org and om.module in ('atendimento', 'automacoes') and om.enabled
  ) then
    v_reason := 'modules_disabled';
  end if;

  if v_reason is not null then
    return query select 'rejected'::text, v_reason, v_org, v_account, null::uuid, null::uuid, null::uuid,
      null::bigint, false, false, null::text, null::text;
    return;
  end if;

  select * into v_content from public.webhook_message_content(v_message);

  if v_content.outcome = 'ignored' then
    return query select 'ignored'::text, v_content.reason, v_org, v_account, null::uuid, null::uuid, null::uuid,
      null::bigint, false, false, null::text, null::text;
    return;
  end if;

  -- Mesma trava da ingestão interna (reentrante na transação): mensagem
  -- existente, retenção existente e ingestão nova se excluem por (canal, wamid).
  perform pg_advisory_xact_lock(hashtextextended(v_account::text || ':' || p_wamid, 0));

  select m.id, m.conversation_id, c.contact_id
    into v_existing
  from public.messages m
  join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
  where m.whatsapp_account_id = v_account and m.external_message_id = p_wamid;

  if found then
    return query select 'duplicate'::text, null::text, v_org, v_account, v_existing.contact_id,
      v_existing.conversation_id, v_existing.id, null::bigint, true, false, null::text, null::text;
    return;
  end if;

  select h.id, h.reason into v_existing
  from public.webhook_message_holds h
  where h.whatsapp_account_id = v_account and h.wamid = p_wamid;

  if found then
    return query select 'held'::text, v_existing.reason, v_org, v_account, null::uuid, null::uuid, null::uuid,
      v_existing.id, true, false, null::text, null::text;
    return;
  end if;

  -- Horário da Meta (segundos Unix em texto), conferido contra a CHEGADA do webhook.
  v_raw_time := case when jsonb_typeof(v_message -> 'timestamp') in ('string', 'number')
                     then v_message ->> 'timestamp' end;
  if v_message -> 'timestamp' is null then
    v_time_status := 'missing';
  elsif v_raw_time is null or v_raw_time !~ '^[0-9]{1,12}$' then
    v_time_status := 'invalid';
  else
    v_sent_at := pg_catalog.to_timestamp(v_raw_time::double precision);
    if v_sent_at < v_event.received_at - interval '30 days'
       or v_sent_at > v_event.received_at + interval '5 minutes' then
      v_time_status := 'out_of_range';
      v_sent_at := null;
    else
      v_time_status := 'valid';
    end if;
  end if;

  -- Identidade: telefone (`from`/`wa_id`) e BSUID (`from_user_id`/`user_id`).
  v_from := case when jsonb_typeof(v_message -> 'from') = 'string' then v_message ->> 'from' end;
  v_bsuid_message := case when jsonb_typeof(v_message -> 'from_user_id') = 'string' then v_message ->> 'from_user_id' end;

  select el into v_contact
  from jsonb_array_elements(
         case when jsonb_typeof(v_event.payload #> '{value,contacts}') = 'array'
              then v_event.payload #> '{value,contacts}' else '[]'::jsonb end) as t(el)
  where jsonb_typeof(el) = 'object'
    and ((v_from is not null and el ->> 'wa_id' = v_from)
         or (v_from is null and v_bsuid_message is not null and el ->> 'user_id' = v_bsuid_message))
  limit 1;

  v_bsuid_contact := case when jsonb_typeof(v_contact -> 'user_id') = 'string' then v_contact ->> 'user_id' end;
  v_name := nullif(left(btrim(coalesce(v_contact #>> '{profile,name}', '')), 256), '');

  if v_bsuid_message is not null and v_bsuid_contact is not null and v_bsuid_message <> v_bsuid_contact then
    -- A própria notificação se contradiz sobre quem enviou.
    v_hold_reason := 'identity_conflict';
    v_identity := 'bsuid_contradiction';
  end if;
  v_bsuid := coalesce(v_bsuid_message, v_bsuid_contact);
  if v_bsuid is not null and v_bsuid !~ '^[A-Za-z0-9.]{1,160}$' then
    v_identity := coalesce(v_identity, 'bsuid_invalid');
    v_bsuid := null;
  end if;

  if v_hold_reason is null then
    if v_from is null then
      v_hold_reason := 'missing_phone';
    elsif v_from !~ '^[1-9][0-9]{1,14}$' then
      v_hold_reason := 'invalid_phone';
    else
      v_phone := '+' || v_from;
    end if;
  end if;

  if v_hold_reason is null and v_content.outcome <> 'ok' then
    v_hold_reason := coalesce(v_content.reason, 'invalid_content');
  end if;

  if v_hold_reason is null and v_bsuid is not null then
    -- Decisão de identidade sob trava, na ordem fixa (canal, wamid) →
    -- (organização, telefone) → (organização, BSUID): o mesmo telefone com
    -- BSUIDs diferentes, ou o mesmo BSUID com telefones diferentes, nunca é
    -- decidido por duas transações ao mesmo tempo. Cada trava é da organização;
    -- nenhuma é global. Em READ COMMITTED, as consultas abaixo enxergam o que a
    -- transação anterior (que segurava a trava) confirmou.
    perform pg_advisory_xact_lock(hashtextextended('contact_phone:' || v_org::text || ':' || v_phone, 0));
    perform pg_advisory_xact_lock(hashtextextended('bsuid:' || v_org::text || ':' || v_bsuid, 0));
    if exists (
      select 1 from public.contacts c
      where c.organization_id = v_org and c.whatsapp_user_id = v_bsuid and c.phone_number <> v_phone
    ) then
      -- O BSUID já identifica OUTRO contato: não se escolhe um lado.
      v_hold_reason := 'identity_conflict';
      v_identity := 'bsuid_in_use';
    else
      select c.whatsapp_user_id into v_known_bsuid
      from public.contacts c
      where c.organization_id = v_org and c.phone_number = v_phone;
      if v_known_bsuid is not null and v_known_bsuid <> v_bsuid then
        -- O telefone já tem OUTRO BSUID (número reciclado, outro portfólio…):
        -- política conservadora, não entra no histórico desse contato.
        v_hold_reason := 'identity_conflict';
        v_identity := 'bsuid_mismatch';
      end if;
    end if;
  end if;

  if v_hold_reason is not null then
    select * into v_copy from public.webhook_hold_copy('message', v_message);
    if v_contact is not null then
      select x.element, x.storage, x.original_bytes into v_contact_element, v_contact_storage, v_contact_bytes
      from public.webhook_hold_copy('contact', v_contact) x;
    end if;

    insert into public.webhook_message_holds as h (
      organization_id, whatsapp_account_id, event_id, wamid, reason, provider_message_type,
      provider_user_id, provider_sent_at, webhook_received_at,
      message, message_storage, message_original_bytes, message_sha256,
      contact, contact_storage, contact_original_bytes
    )
    values (
      v_org, v_account, p_event_id, p_wamid, v_hold_reason, v_content.provider_message_type,
      v_bsuid, v_sent_at, v_event.received_at,
      v_copy.element, v_copy.storage, v_copy.original_bytes, v_copy.element_sha256,
      v_contact_element, v_contact_storage, v_contact_bytes
    )
    on conflict (whatsapp_account_id, wamid) do nothing
    returning h.id into v_hold_id;

    return query select 'held'::text, v_hold_reason, v_org, v_account, null::uuid, null::uuid, null::uuid,
      v_hold_id, false, false, v_time_status, v_identity;
    return;
  end if;

  select * into v_result
  from public.ingest_inbound_internal(
    v_org, v_account, v_phone, v_content.content, p_wamid, v_name,
    v_content.provider_message_type, v_sent_at, v_event.received_at, v_content.interaction_reply_id
  );

  if v_bsuid is not null and v_result.created then
    -- Ainda sob as travas: o campo está vazio (preenche) ou já é este BSUID.
    update public.contacts c
    set whatsapp_user_id = v_bsuid
    where c.organization_id = v_org and c.id = v_result.contact_id and c.whatsapp_user_id is null;
    if not found and not exists (
      select 1 from public.contacts c
      where c.organization_id = v_org and c.id = v_result.contact_id and c.whatsapp_user_id = v_bsuid
    ) then
      -- Ninguém grava o BSUID fora desta função e destas travas; se mudou, a
      -- mensagem não fica num histórico contraditório: desfaz tudo.
      raise exception 'antero_webhook: identity_race: a identidade do contato mudou durante a ingestão'
        using errcode = 'WH005';
    end if;
  end if;

  return query select case when v_result.duplicate then 'duplicate' else 'created' end, null::text,
    v_org, v_account, v_result.contact_id, v_result.conversation_id, v_result.message_id, null::bigint,
    v_result.duplicate, v_result.reopened, v_time_status, v_identity;
end;
$$;

-- ---------------------------------------------------------------------------
-- send_conversation_reply (0008): só a janela de 24 h muda. Canal cloud_api:
-- maior `least(provider_sent_at, webhook_received_at)` das recebidas com
-- horário válido da Meta; sem nenhum, não há janela. Outros canais: igual.
-- ---------------------------------------------------------------------------
create or replace function public.send_conversation_reply(
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

  if v_provider = 'cloud_api' then
    -- Só a evidência da Meta abre a janela, e nunca além da chegada do webhook:
    -- mensagem atrasada não a prolonga, mensagem fora de ordem não a encurta.
    select max(least(m.provider_sent_at, m.webhook_received_at)) into v_last_inbound_at
    from public.messages m
    where m.organization_id = p_organization_id
      and m.conversation_id = p_conversation_id
      and m.direction = 'inbound'
      and m.provider_sent_at is not null;
  else
    select m.created_at into v_last_inbound_at
    from public.messages m
    where m.organization_id = p_organization_id
      and m.conversation_id = p_conversation_id
      and m.direction = 'inbound'
    order by m.created_at desc, m.id desc
    limit 1;
  end if;

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
-- Privilégios: só antero_worker executa a porta; o resto não é de ninguém.
-- (CREATE OR REPLACE preserva os GRANTs de ingest_inbound_message e de
-- send_conversation_reply a antero_app.)
-- ---------------------------------------------------------------------------
revoke all on function public.ingest_inbound_internal(uuid, uuid, text, text, text, text, text, timestamptz, timestamptz, text) from public;
revoke all on function public.webhook_message_content(jsonb) from public;
revoke all on function public.webhook_hold_copy(text, jsonb) from public;
revoke all on function public.webhook_ingest_message(bigint, uuid, text) from public;
grant execute on function public.webhook_ingest_message(bigint, uuid, text) to antero_worker;

-- migrate:down
-- Recusa se já houver dado que só esta migration sabe guardar (perderia
-- informação): retenções, BSUID em contato ou origem da Meta em mensagem.
do $$
begin
  if exists (select 1 from public.webhook_message_holds)
     or exists (select 1 from public.contacts where whatsapp_user_id is not null)
     or exists (select 1 from public.messages where provider_message_type is not null
                  or provider_sent_at is not null or webhook_received_at is not null
                  or interaction_reply_id is not null) then
    raise exception 'antero_webhook: rollback de 0015 recusado: há mensagens retidas, BSUID em contatos ou mensagens recebidas pela Cloud API';
  end if;
end;
$$;

-- send_conversation_reply e ingest_inbound_message voltam ao corpo da 0008/0005.
create or replace function public.send_conversation_reply(
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

create or replace function public.ingest_inbound_message(
  p_whatsapp_account_id uuid,
  p_phone_number text,
  p_content text,
  p_external_message_id text,
  p_contact_name text default null
)
returns table (
  organization_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  created boolean,
  duplicate boolean,
  reopened boolean
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid;
  v_organization_id uuid;
  v_account_status public.whatsapp_status;
  v_account_provider public.whatsapp_provider;
  v_phone_number text := p_phone_number;
  v_content text := trim(p_content);
  v_external_message_id text := trim(p_external_message_id);
  v_contact_name text := nullif(trim(coalesce(p_contact_name, '')), '');
  v_contact_id uuid;
  v_conversation_id uuid;
  v_conversation_status public.conversation_status;
  v_message_id uuid;
  v_created boolean := false;
  v_duplicate boolean := false;
  v_reopened boolean := false;
  v_lock_key bigint;
  v_existing_message_id uuid;
  v_existing_conversation_id uuid;
  v_existing_organization_id uuid;
begin
  v_uid := app.current_user_id();
  if v_uid is null then
    raise exception 'antero_ingest: not_authenticated: chamada requer usuário autenticado'
      using errcode = '28000';
  end if;

  select w.organization_id, w.status, w.provider
    into v_organization_id, v_account_status, v_account_provider
  from public.whatsapp_accounts w
  where w.id = p_whatsapp_account_id;

  if not found then
    raise exception 'antero_ingest: account_not_found: whatsapp_account % não existe', p_whatsapp_account_id;
  end if;

  if v_account_status <> 'connected' then
    raise exception 'antero_ingest: account_inactive: whatsapp_account % não está ativa (status=%)',
      p_whatsapp_account_id, v_account_status;
  end if;

  if v_account_provider <> 'development' then
    raise exception 'antero_ingest: account_wrong_provider: whatsapp_account % não é provider development (provider=%)',
      p_whatsapp_account_id, v_account_provider;
  end if;

  if not public.is_org_admin(v_organization_id) then
    raise exception 'antero_ingest: not_authorized: usuário % não é owner/admin ativo da organização %',
      v_uid, v_organization_id
      using errcode = '42501';
  end if;

  if v_phone_number !~ '^\+[1-9][0-9]{1,14}$' then
    raise exception 'antero_ingest: invalid_phone_number: telefone % não está em E.164', v_phone_number;
  end if;

  if char_length(v_content) = 0 then
    raise exception 'antero_ingest: empty_content: conteúdo da mensagem está vazio após trim';
  end if;

  if char_length(v_content) > 4096 then
    raise exception 'antero_ingest: content_too_long: conteúdo da mensagem excede 4096 caracteres';
  end if;

  if p_external_message_id is null or char_length(v_external_message_id) = 0 then
    raise exception 'antero_ingest: missing_external_message_id: external_message_id é obrigatório e não pode ser vazio';
  end if;

  v_lock_key := hashtextextended(p_whatsapp_account_id::text || ':' || v_external_message_id, 0);
  perform pg_advisory_xact_lock(v_lock_key);

  select m.id, m.conversation_id, m.organization_id
    into v_existing_message_id, v_existing_conversation_id, v_existing_organization_id
  from public.messages m
  where m.whatsapp_account_id = p_whatsapp_account_id
    and m.external_message_id = v_external_message_id;

  if found then
    select c.contact_id into v_contact_id
    from public.conversations c
    where c.organization_id = v_existing_organization_id
      and c.id = v_existing_conversation_id;

    return query
    select
      v_existing_organization_id,
      v_contact_id,
      v_existing_conversation_id,
      v_existing_message_id,
      false,
      true,
      false;
    return;
  end if;

  insert into public.contacts (organization_id, phone_number, name)
  values (v_organization_id, v_phone_number, v_contact_name)
  on conflict (organization_id, phone_number) do nothing
  returning id into v_contact_id;

  if v_contact_id is null then
    select c.id into v_contact_id
    from public.contacts c
    where c.organization_id = v_organization_id
      and c.phone_number = v_phone_number;
  end if;

  insert into public.conversations (organization_id, whatsapp_account_id, contact_id)
  values (v_organization_id, p_whatsapp_account_id, v_contact_id)
  on conflict (organization_id, whatsapp_account_id, contact_id) do nothing
  returning id, status into v_conversation_id, v_conversation_status;

  if v_conversation_id is null then
    select c.id, c.status
      into v_conversation_id, v_conversation_status
    from public.conversations c
    where c.organization_id = v_organization_id
      and c.whatsapp_account_id = p_whatsapp_account_id
      and c.contact_id = v_contact_id
    for update;
  end if;

  insert into public.messages (
    organization_id,
    conversation_id,
    whatsapp_account_id,
    external_message_id,
    direction,
    sender_type,
    sender_user_id,
    message_type,
    content,
    delivery_status
  )
  values (
    v_organization_id,
    v_conversation_id,
    p_whatsapp_account_id,
    v_external_message_id,
    'inbound',
    'contact',
    null,
    'text',
    v_content,
    'delivered'
  )
  on conflict (whatsapp_account_id, external_message_id) where external_message_id is not null
  do nothing
  returning id into v_message_id;

  if v_message_id is null then
    v_duplicate := true;
    v_created := false;
    v_reopened := false;

    select m.id, m.conversation_id, m.organization_id
      into v_message_id, v_conversation_id, v_organization_id
    from public.messages m
    where m.whatsapp_account_id = p_whatsapp_account_id
      and m.external_message_id = v_external_message_id;

    select c.contact_id
      into v_contact_id
    from public.conversations c
    where c.organization_id = v_organization_id
      and c.id = v_conversation_id;
  else
    v_created := true;
    v_duplicate := false;
    v_reopened := (v_conversation_status = 'resolved');

    if v_reopened then
      update public.conversations
      set status = 'waiting',
          resolved_at = null,
          assigned_user_id = null,
          assigned_at = null,
          last_message_at = now()
      where organization_id = v_organization_id
        and id = v_conversation_id;
    else
      update public.conversations
      set last_message_at = now()
      where organization_id = v_organization_id
        and id = v_conversation_id;
    end if;
  end if;

  return query
  select
    v_organization_id,
    v_contact_id,
    v_conversation_id,
    v_message_id,
    v_created,
    v_duplicate,
    v_reopened;
end;
$$;

drop function public.webhook_ingest_message(bigint, uuid, text);
drop function public.webhook_hold_copy(text, jsonb);
drop function public.webhook_message_content(jsonb);
drop function public.ingest_inbound_internal(uuid, uuid, text, text, text, text, text, timestamptz, timestamptz, text);
drop table public.webhook_message_holds;
alter table public.webhook_events drop constraint webhook_events_organization_account_id_key;
drop index public.contacts_organization_whatsapp_user_id_idx;
alter table public.contacts drop constraint contacts_whatsapp_user_id_format;
alter table public.contacts drop column whatsapp_user_id;
alter table public.messages
  drop constraint messages_organization_account_id_key,
  drop constraint messages_interaction_reply_id_format,
  drop constraint messages_provider_sent_at_has_arrival,
  drop constraint messages_provider_message_type_format,
  drop constraint messages_provider_origin_complete,
  drop constraint messages_provider_fields_inbound;
alter table public.messages
  drop column interaction_reply_id,
  drop column webhook_received_at,
  drop column provider_sent_at,
  drop column provider_message_type;

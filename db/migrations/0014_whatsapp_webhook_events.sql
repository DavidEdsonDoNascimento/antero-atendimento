-- migrate:up
-- Antero Atendimentos — Entrega E2B-1: canal Cloud API e eventos brutos do
-- webhook da Meta, gravados antes de qualquer processamento.
--
-- Decisões:
--   - Canal cloud_api: `external_account_id` é o Phone Number ID da Meta, ÚNICO
--     entre todos os canais cloud_api (de qualquer organização), e
--     `external_business_account_id` é a WABA. Uma WABA pertence a uma única
--     organização (gatilho). Depois de criado, o canal cloud_api não muda de
--     organização, de provedor nem de identificadores: trocar o número exige
--     um canal novo, nunca um redirecionamento silencioso das mensagens.
--   - `webhook_events`: uma linha por ALTERAÇÃO (`entry[].changes[]`) de uma
--     notificação cuja assinatura a aplicação já conferiu. A organização sai
--     SÓ do canal registrado: Phone Number ID (`value.metadata`) → canal
--     cloud_api → WABA conferida contra `entry[].id`. Nada no corpo informa a
--     organização diretamente. Uma notificação com números de organizações
--     diferentes vira linhas separadas, cada uma da sua organização.
--   - Duplicidade: a Meta reentrega por até 7 dias. A chave é o sha256 da
--     alteração em forma canônica (jsonb), com a WABA; reentrega idêntica não
--     grava de novo. A idempotência por mensagem (wamid) continua sendo a de
--     `messages` (0003), na E2B-2.
--   - Estados: `received` (pendente), `processed`, `rejected` (não será
--     processado: canal desconhecido, WABA divergente, canal desconectado,
--     organização suspensa, campo não suportado, estrutura inválida) e
--     `failed` (desistência depois das tentativas). Rejeitado guarda o motivo e
--     a organização só quando o canal foi de fato reconhecido.
--   - Fila para a E2B-2: `webhook_claim_events` reivindica por prazo (lease,
--     FOR UPDATE SKIP LOCKED) e `webhook_finish_event` encerra com o token da
--     reivindicação. Quem perdeu o prazo não encerra o trabalho de outro. Sem
--     processamento em memória como única garantia: o que não terminar volta
--     para a fila quando o prazo vence.
--   - Retenção: 30 dias para eventos finalizados (`finished_at`), pendentes
--     preservados. Nenhuma rotina de exclusão nesta entrega; o índice parcial
--     de `finished_at` já atende a futura limpeza.
--   - Acesso: antero_worker só EXECUTA as três funções `webhook_*` (sem
--     privilégio de tabela). antero_app e antero_auth não leem nem executam
--     nada daqui: o corpo bruto (telefones, nomes, mensagens) não é dado da
--     aplicação. RLS habilitada sem política, por defesa em profundidade.

-- O papel é criado pelo 10-roles.sh (idempotente), ANTES desta migration.
do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'antero_worker') then
    raise exception 'antero_webhook: 0014 requer o papel antero_worker: rode `pnpm db:roles` (local) ou docker/postgres/initdb/10-roles.sh (servidor) antes de migrar';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- whatsapp_accounts: identificadores do canal cloud_api
-- ---------------------------------------------------------------------------
alter table public.whatsapp_accounts
  add column external_business_account_id text;

-- Ids da Meta são numéricos. Só valem para cloud_api; canais development não
-- têm WABA (não muda nada nas linhas existentes, que nascem com a coluna nula).
alter table public.whatsapp_accounts
  add constraint whatsapp_accounts_cloud_api_ids
    check (
      provider <> 'cloud_api'
      or (coalesce(external_account_id ~ '^[0-9]{5,32}$', false)
          and coalesce(external_business_account_id ~ '^[0-9]{5,32}$', false))
    ),
  add constraint whatsapp_accounts_waba_only_cloud_api
    check (provider = 'cloud_api' or external_business_account_id is null);

-- Um Phone Number ID aponta para um único canal, de uma única organização.
create unique index whatsapp_accounts_cloud_api_phone_number_id_key
  on public.whatsapp_accounts (external_account_id)
  where provider = 'cloud_api';

-- Regras que um índice não expressa: a WABA de um canal cloud_api pertence a
-- uma única organização, e a identidade do canal não muda depois de criado.
-- SECURITY INVOKER: quem grava whatsapp_accounts é o dono (manutenção); a
-- aplicação não tem INSERT/UPDATE nesta tabela (0006). Mesmo padrão do
-- ensure_active_owner (0012): trava consultiva por WABA e só READ COMMITTED,
-- em que cada comando da função enxerga o que já foi confirmado.
create function public.enforce_whatsapp_channel_rules()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (old.provider = 'cloud_api' or new.provider = 'cloud_api')
     and (new.organization_id is distinct from old.organization_id
          or new.provider is distinct from old.provider
          or new.external_account_id is distinct from old.external_account_id
          or new.external_business_account_id is distinct from old.external_business_account_id) then
    raise exception 'antero_webhook: channel_identity_immutable: organização, provedor, Phone Number ID e WABA de um canal cloud_api não mudam; cadastre outro canal'
      using errcode = 'WH011';
  end if;

  if new.provider = 'cloud_api' then
    if pg_catalog.current_setting('transaction_isolation') <> 'read committed' then
      raise exception 'antero_webhook: isolation_not_supported: canais cloud_api só são gravados em READ COMMITTED'
        using errcode = 'WH012';
    end if;
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('whatsapp_waba:' || new.external_business_account_id, 0));
    if exists (
      select 1 from public.whatsapp_accounts w
      where w.provider = 'cloud_api'
        and w.external_business_account_id = new.external_business_account_id
        and w.organization_id <> new.organization_id
    ) then
      raise exception 'antero_webhook: waba_in_use: esta WABA já está vinculada a outra organização'
        using errcode = 'WH010';
    end if;
  end if;

  return new;
end;
$$;

create trigger whatsapp_accounts_channel_rules
before insert or update on public.whatsapp_accounts
for each row execute function public.enforce_whatsapp_channel_rules();

-- ---------------------------------------------------------------------------
-- webhook_events
-- ---------------------------------------------------------------------------
create type public.webhook_event_status as enum ('received', 'processed', 'rejected', 'failed');

create table public.webhook_events (
  id bigint generated always as identity primary key,
  -- sha256 da alteração canônica (ou da notificação inteira, se inválida).
  dedupe_key bytea not null,
  received_at timestamptz not null default pg_catalog.clock_timestamp(),
  -- `changes[].field` (ex.: messages), `entry[].id` (WABA) e o Phone Number ID,
  -- como vieram, para investigação. Nulos quando ausentes ou malformados.
  field text,
  waba_id text,
  phone_number_id text,
  -- Só quando o canal foi reconhecido (Phone Number ID + WABA conferidos).
  organization_id uuid,
  whatsapp_account_id uuid,
  -- A alteração (`changes[i]`) ou, para estrutura inválida, o corpo inteiro.
  payload jsonb not null,
  status public.webhook_event_status not null default 'received',
  -- Motivo de `rejected`/`failed` (código, nunca texto livre).
  reason text,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default pg_catalog.clock_timestamp(),
  -- Última reivindicação: token e prazo. O token fica depois de encerrar
  -- (repetir o encerramento com ele é inofensivo); o prazo, não.
  claim_token uuid,
  claimed_until timestamptz,
  -- Último erro de uma tentativa (código).
  last_error text,
  finished_at timestamptz,

  constraint webhook_events_dedupe_key_key unique (dedupe_key),
  constraint webhook_events_dedupe_key_length check (octet_length(dedupe_key) = 32),
  constraint webhook_events_organization_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  -- O canal não é removido enquanto houver evento dele (até a limpeza de 30 dias).
  constraint webhook_events_whatsapp_account_fkey
    foreign key (organization_id, whatsapp_account_id)
    references public.whatsapp_accounts (organization_id, id)
    on delete restrict,
  constraint webhook_events_account_has_organization
    check (whatsapp_account_id is null or organization_id is not null),
  constraint webhook_events_pending_has_channel
    check (status <> 'received' or (organization_id is not null and whatsapp_account_id is not null)),
  constraint webhook_events_finished_matches_status
    check ((status = 'received') = (finished_at is null)),
  constraint webhook_events_reason_matches_status
    check ((status in ('rejected', 'failed')) = (reason is not null)),
  constraint webhook_events_reason_format check (reason ~ '^[a-z0-9_]{1,60}$'),
  constraint webhook_events_last_error_format check (last_error ~ '^[a-z0-9_]{1,60}$'),
  constraint webhook_events_claim_has_token check (claimed_until is null or claim_token is not null),
  constraint webhook_events_claim_only_pending check (status = 'received' or claimed_until is null),
  constraint webhook_events_attempts_positive check (attempts >= 0),
  constraint webhook_events_field_length check (char_length(field) between 1 and 64),
  constraint webhook_events_waba_format check (waba_id ~ '^[0-9]{1,32}$'),
  constraint webhook_events_phone_number_id_format check (phone_number_id ~ '^[0-9]{1,32}$'),
  -- A Meta envia até 3 MB por notificação.
  constraint webhook_events_payload_size check (pg_column_size(payload) <= 4194304)
);

-- Fila (E2B-2): pendentes por vez de tentativa.
create index webhook_events_pending_idx
  on public.webhook_events (next_attempt_at, id)
  where status = 'received';

-- Retenção: finalizados por data de encerramento.
create index webhook_events_finished_idx
  on public.webhook_events (finished_at)
  where status <> 'received';

create index webhook_events_organization_idx
  on public.webhook_events (organization_id, received_at desc, id desc)
  where organization_id is not null;

alter table public.webhook_events enable row level security;
revoke all on public.webhook_events from antero_app, antero_auth, antero_worker;

-- ---------------------------------------------------------------------------
-- Registro da notificação (o webhook chama depois de conferir a assinatura).
-- Tudo numa transação: ou a notificação inteira fica gravada (e o webhook
-- responde 200), ou nada fica (e a Meta reenvia). Devolve quantas alterações
-- ficaram pendentes, rejeitadas e quantas já existiam.
-- ---------------------------------------------------------------------------
create function public.webhook_record_delivery(p_payload jsonb)
returns table (received integer, rejected integer, duplicates integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_entry jsonb;
  v_change jsonb;
  v_valid boolean;
  v_changes integer := 0;
  v_received integer := 0;
  v_rejected integer := 0;
  v_duplicates integer := 0;
  v_waba text;
  v_phone text;
  v_field text;
  v_account record;
  v_status public.webhook_event_status;
  v_reason text;
  v_organization_id uuid;
  v_account_id uuid;
  v_id bigint;
begin
  if p_payload is null then
    raise exception 'antero_webhook: invalid_input: notificação obrigatória'
      using errcode = '22004';
  end if;

  -- Estrutura mínima: { object: "whatsapp_business_account", entry: [ { id,
  -- changes: [ { field, value: {…} } ] } ] }. Qualquer parte faltando (nulo)
  -- torna a notificação inválida (coalesce(…, false)).
  v_valid := coalesce(
    jsonb_typeof(p_payload) = 'object'
    and p_payload ->> 'object' = 'whatsapp_business_account'
    and jsonb_typeof(p_payload -> 'entry') = 'array'
    and jsonb_array_length(p_payload -> 'entry') > 0,
    false);

  if v_valid then
    <<entries>>
    for v_entry in select value from jsonb_array_elements(p_payload -> 'entry')
    loop
      v_valid := coalesce(
        jsonb_typeof(v_entry) = 'object'
        and jsonb_typeof(v_entry -> 'id') = 'string'
        and (v_entry ->> 'id') ~ '^[0-9]{1,32}$'
        and jsonb_typeof(v_entry -> 'changes') = 'array'
        and jsonb_array_length(v_entry -> 'changes') > 0,
        false);
      exit entries when not v_valid;
      for v_change in select value from jsonb_array_elements(v_entry -> 'changes')
      loop
        v_valid := coalesce(
          jsonb_typeof(v_change) = 'object'
          and jsonb_typeof(v_change -> 'field') = 'string'
          and char_length(v_change ->> 'field') between 1 and 64
          and jsonb_typeof(v_change -> 'value') = 'object',
          false);
        exit entries when not v_valid;
        v_changes := v_changes + 1;
      end loop;
    end loop;
  end if;

  -- Estrutura inválida ou lote maior que o da Meta (até 1000 alterações): uma
  -- linha rejeitada com o corpo inteiro, sem organização.
  if not v_valid or v_changes > 1000 then
    insert into public.webhook_events as e (dedupe_key, payload, status, reason, finished_at)
    values (
      pg_catalog.sha256(pg_catalog.convert_to('delivery:' || p_payload::text, 'UTF8')),
      p_payload,
      'rejected',
      case when v_valid then 'too_many_changes' else 'invalid_payload' end,
      pg_catalog.clock_timestamp()
    )
    on conflict (dedupe_key) do nothing
    returning e.id into v_id;

    if v_id is null then
      return query select 0, 0, 1;
    else
      return query select 0, 1, 0;
    end if;
    return;
  end if;

  for v_entry in select value from jsonb_array_elements(p_payload -> 'entry')
  loop
    v_waba := v_entry ->> 'id';
    for v_change in select value from jsonb_array_elements(v_entry -> 'changes')
    loop
      v_field := v_change ->> 'field';
      v_phone := v_change #>> '{value,metadata,phone_number_id}';
      v_organization_id := null;
      v_account_id := null;
      v_status := 'rejected';
      v_reason := null;

      if v_field <> 'messages' then
        -- Só mensagens e status (campo `messages`) são processados no MVP.
        v_reason := 'unsupported_field';
        if not coalesce(v_phone ~ '^[0-9]{1,32}$', false) then
          v_phone := null;
        end if;
      elsif not coalesce(v_phone ~ '^[0-9]{1,32}$', false) then
        v_reason := 'missing_phone_number_id';
        v_phone := null;
      else
        select w.id, w.organization_id, w.external_business_account_id, w.status, o.status as organization_status
          into v_account
        from public.whatsapp_accounts w
        join public.organizations o on o.id = w.organization_id
        where w.provider = 'cloud_api'
          and w.external_account_id = v_phone;

        if not found then
          v_reason := 'unknown_channel';
        elsif v_account.external_business_account_id is distinct from v_waba then
          -- Número de um canal, WABA de outra conta: não se confia em nenhum
          -- dos dois, e a linha fica sem organização.
          v_reason := 'waba_mismatch';
        else
          v_organization_id := v_account.organization_id;
          v_account_id := v_account.id;
          if v_account.status <> 'connected' then
            v_reason := 'channel_disconnected';
          elsif v_account.organization_status <> 'active' then
            v_reason := 'organization_inactive';
          else
            v_status := 'received';
          end if;
        end if;
      end if;

      insert into public.webhook_events as e (
        dedupe_key, field, waba_id, phone_number_id, organization_id, whatsapp_account_id,
        payload, status, reason, finished_at
      )
      values (
        pg_catalog.sha256(pg_catalog.convert_to('change:' || v_waba || ':' || v_change::text, 'UTF8')),
        v_field,
        v_waba,
        v_phone,
        v_organization_id,
        v_account_id,
        v_change,
        v_status,
        v_reason,
        case when v_status = 'received' then null else pg_catalog.clock_timestamp() end
      )
      on conflict (dedupe_key) do nothing
      returning e.id into v_id;

      if v_id is null then
        v_duplicates := v_duplicates + 1;
      elsif v_status = 'received' then
        v_received := v_received + 1;
      else
        v_rejected := v_rejected + 1;
      end if;
    end loop;
  end loop;

  return query select v_received, v_rejected, v_duplicates;
end;
$$;

-- ---------------------------------------------------------------------------
-- Fila (para a E2B-2). Reivindica até p_limit pendentes por p_lease_seconds.
-- Cada reivindicação conta uma tentativa. Depois de 10 tentativas, um prazo
-- vencido (processo que caiu no meio) encerra o evento como `failed`.
-- ---------------------------------------------------------------------------
create function public.webhook_claim_events(p_limit integer, p_lease_seconds integer)
returns table (
  event_id bigint,
  claim_token uuid,
  organization_id uuid,
  whatsapp_account_id uuid,
  field text,
  payload jsonb,
  attempts integer
)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if p_limit is null or p_limit not between 1 and 100
     or p_lease_seconds is null or p_lease_seconds not between 10 and 900 then
    raise exception 'antero_webhook: invalid_input: limite de 1 a 100 e prazo de 10 a 900 segundos'
      using errcode = '22023';
  end if;

  update public.webhook_events e
  set status = 'failed',
      reason = 'max_attempts',
      finished_at = pg_catalog.clock_timestamp(),
      claimed_until = null
  where e.id in (
    select x.id
    from public.webhook_events x
    where x.status = 'received'
      and x.attempts >= 10
      and (x.claimed_until is null or x.claimed_until < pg_catalog.clock_timestamp())
    for update skip locked
  );

  return query
  with picked as (
    select x.id
    from public.webhook_events x
    where x.status = 'received'
      and x.attempts < 10
      and x.next_attempt_at <= pg_catalog.clock_timestamp()
      and (x.claimed_until is null or x.claimed_until < pg_catalog.clock_timestamp())
    order by x.next_attempt_at, x.id
    limit p_limit
    for update skip locked
  )
  update public.webhook_events e
  set claim_token = pg_catalog.gen_random_uuid(),
      claimed_until = pg_catalog.clock_timestamp() + pg_catalog.make_interval(secs => p_lease_seconds),
      attempts = e.attempts + 1
  from picked
  where e.id = picked.id
  returning e.id, e.claim_token, e.organization_id, e.whatsapp_account_id, e.field, e.payload, e.attempts;
end;
$$;

-- Encerra uma reivindicação: `processed`, `rejected` ou `failed` (com motivo),
-- ou `retry` (volta à fila com espera crescente: 30 s, 1 min, 2 min… até 1 h;
-- na 10ª tentativa vira `failed`). Exige o token da reivindicação vigente:
-- quem perdeu o prazo e foi substituído recebe `claim_lost`. Repetir o
-- encerramento com o mesmo token devolve o estado gravado, sem mudar nada.
create function public.webhook_finish_event(
  p_event_id bigint,
  p_claim_token uuid,
  p_outcome text,
  p_reason text default null
)
returns public.webhook_event_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event record;
begin
  if p_event_id is null or p_claim_token is null
     or p_outcome is null or p_outcome not in ('processed', 'rejected', 'failed', 'retry')
     or (p_outcome = 'processed') <> (p_reason is null)
     or not coalesce(p_reason ~ '^[a-z0-9_]{1,60}$', p_outcome = 'processed') then
    raise exception 'antero_webhook: invalid_input: resultado processed (sem motivo) ou rejected/failed/retry com motivo em código'
      using errcode = '22023';
  end if;

  select e.status, e.claim_token, e.claimed_until, e.attempts
    into v_event
  from public.webhook_events e
  where e.id = p_event_id
  for update;

  if not found then
    raise exception 'antero_webhook: event_not_found: evento inexistente'
      using errcode = 'P0002';
  end if;
  if v_event.claim_token is distinct from p_claim_token then
    raise exception 'antero_webhook: claim_lost: o evento foi reivindicado por outra execução'
      using errcode = 'WH001';
  end if;
  if v_event.status <> 'received' then
    return v_event.status;
  end if;
  if v_event.claimed_until is null then
    -- Já devolvido à fila por este mesmo token (retry): a reivindicação acabou.
    raise exception 'antero_webhook: claim_lost: a reivindicação já foi encerrada'
      using errcode = 'WH001';
  end if;

  if p_outcome = 'retry' then
    if v_event.attempts >= 10 then
      update public.webhook_events e
      set status = 'failed', reason = 'max_attempts', last_error = p_reason,
          finished_at = pg_catalog.clock_timestamp(), claimed_until = null
      where e.id = p_event_id;
      return 'failed';
    end if;
    update public.webhook_events e
    set claimed_until = null,
        last_error = p_reason,
        next_attempt_at = pg_catalog.clock_timestamp()
          + least(interval '30 seconds' * pg_catalog.power(2, greatest(v_event.attempts - 1, 0)), interval '1 hour')
    where e.id = p_event_id;
    return 'received';
  end if;

  update public.webhook_events e
  set status = p_outcome::public.webhook_event_status,
      reason = case when p_outcome = 'processed' then null else p_reason end,
      finished_at = pg_catalog.clock_timestamp(),
      claimed_until = null
  where e.id = p_event_id;
  return p_outcome::public.webhook_event_status;
end;
$$;

revoke all on function public.enforce_whatsapp_channel_rules() from public;
revoke all on function public.webhook_record_delivery(jsonb) from public;
revoke all on function public.webhook_claim_events(integer, integer) from public;
revoke all on function public.webhook_finish_event(bigint, uuid, text, text) from public;

grant execute on function public.webhook_record_delivery(jsonb) to antero_worker;
grant execute on function public.webhook_claim_events(integer, integer) to antero_worker;
grant execute on function public.webhook_finish_event(bigint, uuid, text, text) to antero_worker;

-- migrate:down
-- Recusa-se se houver evento recebido ou canal cloud_api: reverter apagaria
-- notificações da Meta ainda não tratadas e os identificadores dos canais reais.
do $$
begin
  if exists (select 1 from public.webhook_events)
     or exists (select 1 from public.whatsapp_accounts where provider = 'cloud_api') then
    raise exception 'antero_webhook: rollback de 0014 recusado: há eventos do webhook ou canais cloud_api';
  end if;
end;
$$;

drop function public.webhook_finish_event(bigint, uuid, text, text);
drop function public.webhook_claim_events(integer, integer);
drop function public.webhook_record_delivery(jsonb);
drop table public.webhook_events;
drop type public.webhook_event_status;

drop trigger whatsapp_accounts_channel_rules on public.whatsapp_accounts;
drop function public.enforce_whatsapp_channel_rules();
drop index public.whatsapp_accounts_cloud_api_phone_number_id_key;
alter table public.whatsapp_accounts
  drop constraint whatsapp_accounts_waba_only_cloud_api,
  drop constraint whatsapp_accounts_cloud_api_ids,
  drop column external_business_account_id;

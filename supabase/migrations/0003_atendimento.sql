-- Antero Atendimento — Ciclo 2, Etapa 1: schema fundamental do atendimento
-- Cria os enums e as tabelas contacts, conversations e messages. Sem
-- políticas de RLS (Etapa 2), sem função de ingestão (Etapa 3), sem UI.
--
-- Decisões aprovadas que este schema materializa:
--   - Estados de conversa: bot, waiting, human, resolved. "Aberta" é o
--     agregado status <> 'resolved', não um quinto estado.
--   - Contato é identidade organizacional: único por (organization_id,
--     phone_number), independente do canal. Conversa é a thread desse
--     contato em UM canal específico: única por (organization_id,
--     whatsapp_account_id, contact_id) — o mesmo contato pode falar com
--     dois números da mesma empresa sem misturar canal ou histórico. Uma
--     mensagem recebida para uma conversa "resolved" reabrirá a MESMA
--     linha (Etapa 3, função de ingestão) quando vier do mesmo contato
--     pela mesma conta; outra conta gera outra conversa. A unicidade é
--     permanente, não parcial por status.
--   - messages referencia conversations por FK TRIPLA (organization_id,
--     conversation_id, whatsapp_account_id), não apenas por
--     conversation_id, para provar que a conta gravada na mensagem é
--     exatamente a conta já registrada na conversa. Isso torna a FK
--     separada messages→whatsapp_accounts redundante (removida).
--   - external_message_id entra já no Ciclo 2 (não no Ciclo 4) e é único
--     por CANAL (whatsapp_account_id), não por organização.
--   - conversation_assignments foi avaliada e postergada: assigned_user_id
--     + assigned_at em conversations bastam para o Ciclo 2.
--   - unread_count foi postergado (sem consumidor no Ciclo 2).
--   - Toda tabela de negócio carrega organization_id e referencia sua
--     entidade pai por FK COMPOSTA (organization_id, id) — não apenas por
--     RLS. Isso impede estruturalmente que uma linha filha combine o
--     organization_id de uma organização com uma entidade pai de outra
--     (ver exemplo no relatório de implementação desta etapa).

-- ---------------------------------------------------------------------------
-- Enums
-- 'bot' já entra em conversation_status mesmo sem motor de automação
-- (Ciclo 3): "alter type ... add value" não pode ser usada e consumida na
-- mesma transação, então adicionar o valor depois exigiria uma migration
-- extra só para isso. Incluir agora custa zero.
-- ---------------------------------------------------------------------------
create type public.conversation_status as enum ('bot', 'waiting', 'human', 'resolved');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_sender as enum ('contact', 'bot', 'user', 'system');
create type public.message_type as enum ('text');
create type public.message_delivery_status as enum ('pending', 'sent', 'delivered', 'read', 'failed');

-- ---------------------------------------------------------------------------
-- Pré-requisito: chave composta em whatsapp_accounts (Ciclo 1)
-- Necessária como alvo das foreign keys compostas (organization_id, id) a
-- partir de conversations e messages. Aditivo: não altera dados nem
-- comportamento existente, apenas soma uma constraint.
-- ---------------------------------------------------------------------------
alter table public.whatsapp_accounts
  add constraint whatsapp_accounts_organization_id_id_key
  unique (organization_id, id);

-- ---------------------------------------------------------------------------
-- contacts (Ciclo 2)
-- Identifica um cliente pelo telefone dentro de uma organização. A
-- aplicação normaliza o telefone em E.164 antes de gravar; o banco apenas
-- valida o formato final.
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  name text,
  phone_number text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint contacts_organization_id_id_key
    unique (organization_id, id),
  constraint contacts_organization_id_phone_number_key
    unique (organization_id, phone_number),

  -- E.164: '+' seguido do código do país (primeiro dígito 1-9, nunca zero)
  -- e até 14 dígitos adicionais — 2 a 15 dígitos ao todo. Forma explícita
  -- com [0-9] (evita a classe abreviada \d), válida para qualquer país, não
  -- restrita ao Brasil. Não aceita espaço, parêntese ou hífen: a
  -- normalização em E.164 é responsabilidade da camada de entrada, antes da
  -- persistência.
  constraint contacts_phone_number_format
    check (phone_number ~ '^\+[1-9][0-9]{1,14}$')
);

create trigger contacts_set_updated_at
before update on public.contacts
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- conversations (Ciclo 2)
-- Uma única thread por CONTATO e CANAL (whatsapp_account_id) na
-- organização — o mesmo contato pode conversar com dois números diferentes
-- da mesma empresa sem misturar canal, histórico ou rota de resposta.
-- Estados (conversation_status): bot, waiting, human, resolved. Default
-- 'waiting': o Ciclo 2 ainda não tem motor de automação (Ciclo 3), então
-- toda conversa nova já nasce aguardando atendimento humano — 'bot' só
-- passa a ser usado como default quando o motor de fluxos existir.
-- ---------------------------------------------------------------------------
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  whatsapp_account_id uuid not null,
  contact_id uuid not null,
  status public.conversation_status not null default 'waiting',
  assigned_user_id uuid,
  assigned_at timestamptz,
  started_at timestamptz not null default now(),
  last_message_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Alvo da FK tripla de messages (organization_id, conversation_id,
  -- whatsapp_account_id): garante que uma mensagem só possa referenciar uma
  -- conversa cujo whatsapp_account_id seja exatamente o mesmo já gravado
  -- nela — ver messages_conversation_whatsapp_account_fkey mais abaixo.
  constraint conversations_organization_id_id_whatsapp_account_id_key
    unique (organization_id, id, whatsapp_account_id),
  -- Uma única thread por contato E canal: o mesmo contato pode ter uma
  -- conversa por número da organização, sem misturar histórico entre
  -- canais. Reabertura reutiliza esta mesma linha (Etapa 3) quando a nova
  -- mensagem chega do mesmo contato pela mesma conta; outra conta gera
  -- outra conversa.
  constraint conversations_one_thread_per_contact_account
    unique (organization_id, whatsapp_account_id, contact_id),

  -- Canal removido não apaga o histórico da conversa silenciosamente: a
  -- remoção do whatsapp_account fica bloqueada enquanto houver conversa
  -- vinculada (decisão explícita de quem for remover o canal).
  constraint conversations_whatsapp_account_id_fkey
    foreign key (organization_id, whatsapp_account_id)
    references public.whatsapp_accounts (organization_id, id)
    on delete restrict,

  -- Mesmo raciocínio: um contato com histórico de conversa não pode ser
  -- apagado silenciosamente.
  constraint conversations_contact_id_fkey
    foreign key (organization_id, contact_id)
    references public.contacts (organization_id, id)
    on delete restrict,

  -- Garante que o atendente atribuído seja, de fato, membro desta
  -- organização (qualquer status de vínculo). MATCH SIMPLE (padrão do
  -- Postgres): se assigned_user_id for NULL, a checagem é ignorada —
  -- conversa sem atendente não exige nada. Um vínculo não pode ser removido
  -- enquanto ainda for referenciado por uma atribuição (preserva quem
  -- atendeu o quê).
  constraint conversations_assigned_user_id_fkey
    foreign key (organization_id, assigned_user_id)
    references public.organization_members (organization_id, user_id)
    on delete restrict,

  constraint conversations_resolved_at_matches_status
    check ((status = 'resolved') = (resolved_at is not null)),
  constraint conversations_assigned_at_matches_assignee
    check ((assigned_user_id is null) = (assigned_at is null)),
  constraint conversations_human_requires_assignee
    check (status <> 'human' or assigned_user_id is not null)
);

create trigger conversations_set_updated_at
before update on public.conversations
for each row execute function public.set_updated_at();

-- Consulta da inbox: conversas da organização, filtradas por status,
-- ordenadas por atividade recente.
create index conversations_org_status_last_message_idx
  on public.conversations (organization_id, status, last_message_at desc);

-- "Minhas conversas": conversas atribuídas a um atendente específico.
create index conversations_org_assigned_user_idx
  on public.conversations (organization_id, assigned_user_id)
  where assigned_user_id is not null;

-- ---------------------------------------------------------------------------
-- messages (Ciclo 2)
-- Histórico imutável: sem UPDATE/DELETE (nem política, nem trigger de
-- updated_at) — corrigir ou apagar uma mensagem não é uma operação do
-- domínio. Ordenação estável via (created_at, id), porque created_at
-- sozinho pode empatar entre linhas.
--
-- Idempotência: external_message_id é opcional (nulo para mensagens sem
-- identificador externo, como as enviadas manualmente pelo atendente) e
-- único por CANAL — (whatsapp_account_id, external_message_id) — não por
-- organização. Duas contas de WhatsApp são fluxos de entrega
-- independentes: o id externo de uma conta não deveria bloquear o mesmo id
-- em outra conta da mesma organização.
-- ---------------------------------------------------------------------------
create table public.messages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,
  conversation_id uuid not null,
  whatsapp_account_id uuid not null,
  external_message_id text,
  direction public.message_direction not null,
  sender_type public.message_sender not null,
  sender_user_id uuid,
  message_type public.message_type not null default 'text',
  content text not null,
  delivery_status public.message_delivery_status not null default 'sent',
  created_at timestamptz not null default now(),

  -- Mensagem não tem sentido fora da sua conversa: apagar a conversa (ação
  -- deliberada, sem política de exclusão no Ciclo 2) aceita apagar as
  -- mensagens junto. A FK é TRIPLA — inclui whatsapp_account_id — porque
  -- (organization_id, conversation_id) sozinho não impede gravar uma
  -- mensagem com a conta certa da organização, mas ERRADA para aquela
  -- conversa especificamente; exigir que o trio bata exatamente com
  -- conversations_organization_id_id_whatsapp_account_id_key prova que
  -- messages.whatsapp_account_id é o mesmo canal já registrado na
  -- conversa. Isso torna redundante uma FK separada messages→
  -- whatsapp_accounts: a própria conversations já garante, com RESTRICT,
  -- que seu whatsapp_account_id aponta para uma conta real da mesma
  -- organização — por isso essa FK separada foi removida daqui.
  constraint messages_conversation_whatsapp_account_fkey
    foreign key (organization_id, conversation_id, whatsapp_account_id)
    references public.conversations (organization_id, id, whatsapp_account_id)
    on delete cascade,

  constraint messages_sender_user_id_fkey
    foreign key (organization_id, sender_user_id)
    references public.organization_members (organization_id, user_id)
    on delete restrict,

  constraint messages_content_length
    check (char_length(content) between 1 and 4096),
  constraint messages_sender_user_id_matches_sender_type
    check ((sender_type = 'user') = (sender_user_id is not null)),
  constraint messages_inbound_from_contact
    check ((direction = 'inbound') = (sender_type = 'contact'))
);

create index messages_conversation_created_idx
  on public.messages (conversation_id, created_at, id);

create unique index messages_whatsapp_account_external_id_key
  on public.messages (whatsapp_account_id, external_message_id)
  where external_message_id is not null;

-- ---------------------------------------------------------------------------
-- RLS — habilitado sem políticas nesta etapa. A Etapa 2 cria os grants e as
-- políticas. Consequência esperada e segura: nenhum papel (incluindo
-- authenticated) consegue ler ou escrever nestas 3 tabelas via API até lá.
-- As 14 políticas do Ciclo 1 não são tocadas por esta migration.
-- ---------------------------------------------------------------------------
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

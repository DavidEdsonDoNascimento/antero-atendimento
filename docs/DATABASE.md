# Banco de dados — Antero Atendimento

PostgreSQL (Supabase). UUIDs como chave. RLS obrigatório. Migrations em
`supabase/migrations`.

## Estratégia por ciclos

O modelo completo do produto foi projetado desde o início, mas as tabelas são
criadas **por ciclo**, conforme a necessidade real, mantendo cada migration
focada e o RLS coerente.

| Ciclo | Tabelas |
|------|---------|
| 1 | `profiles`, `organizations`, `organization_members`, `whatsapp_accounts` |
| **2 (atual)** | `contacts`, `conversations`, `messages` |
| 3 | `flows`, `flow_steps`, `flow_options`, `flow_sessions`, `captured_answers` |
| 4 | `webhook_events` |

`conversation_assignments` foi avaliada e postergada: `conversations.assigned_user_id`
+ `assigned_at` cobrem a atribuição de atendente do Ciclo 2 sem precisar de uma
tabela de histórico ainda sem consumidor.

## Tabelas do Ciclo 1

### profiles
Espelha `auth.users`. Guarda `email`, `full_name` e `is_platform_admin`.
Criado automaticamente por gatilho ao surgir um usuário no Auth
(`handle_new_user`). O `email` é desnormalizado aqui para exibir a equipe sem
acessar o schema `auth`.

### organizations
`name`, `slug` (único), `status` (`active`/`inactive`).

### organization_members
Vínculo usuário↔organização com `role` (`owner`/`admin`/`attendant`) e `status`
(`active`/`invited`/`disabled`). Índices em `user_id` e `organization_id`.
Único por `(organization_id, user_id)`. O modelo permite um usuário em várias
organizações no futuro; no MVP a interface usa a primeira associação ativa.

### whatsapp_accounts
Canal por organização: `provider` (`development`/`cloud_api`),
`external_account_id`, `phone_number`, `display_name`, `status`.

## Tabelas do Ciclo 2 (Etapa 1 — schema fundamental)

### contacts
**Identidade organizacional.** Identifica um cliente pelo telefone dentro da
organização, independente de canal — chave de identidade:
`(organization_id, phone_number)`. O telefone é normalizado em E.164 pela
aplicação antes de persistir; o banco valida apenas o formato final.

### conversations
Representa a thread de um contato **em uma conta/canal específico** — não
apenas por contato. Unicidade permanente em `(organization_id,
whatsapp_account_id, contact_id)`: o mesmo contato pode ter uma conversa por
número da organização (ex.: fala com o número comercial e, separadamente,
com o número de suporte) sem misturar canal, histórico ou rota de resposta.
Uma mensagem recebida para uma conversa `resolved` reabre a mesma linha
(Etapa 3) quando vem do mesmo contato **pela mesma conta**; se a mensagem
chegar por outra conta da organização, gera uma conversa diferente (nova
linha, não reaproveitamento). Estados (`conversation_status`): `bot`,
`waiting`, `human`, `resolved`. "Conversa aberta" não é um estado — é o
agregado `status <> 'resolved'`. O default do status é `waiting`: o Ciclo 2
ainda não tem motor de automação (Ciclo 3), então toda conversa nova já
nasce aguardando atendimento humano. Atribuição de atendente é opcional
(`assigned_user_id` + `assigned_at`); `conversation_assignments` (histórico
de atribuições) foi avaliada e postergada — ver tabela de ciclos acima.
`unread_count` também foi postergado, por não ter consumidor no Ciclo 2.

### messages
Histórico imutável (sem UPDATE/DELETE) de uma conversa. `direction`
(`inbound`/`outbound`), `sender_type` (`contact`/`bot`/`user`/`system`) e
`message_type` (`text` por enquanto) descrevem a mensagem;
`external_message_id` é opcional e identifica a mensagem no provedor.
Ordenação estável via `(created_at, id)`. A foreign key para `conversations`
é **tripla** — `(organization_id, conversation_id, whatsapp_account_id)` —
para provar que a conta gravada na mensagem é exatamente a conta já
registrada na conversa, não apenas uma conta válida da mesma organização.
Isso torna desnecessária uma foreign key separada para `whatsapp_accounts`:
a própria `conversations` já garante (com `ON DELETE RESTRICT`) que seu
`whatsapp_account_id` aponta para uma conta real da mesma organização.

Todas as três tabelas carregam `organization_id` e referenciam sua entidade
pai por **foreign key composta** — não apenas por RLS. Isso impede
estruturalmente que uma linha filha combine o `organization_id` de uma
organização com uma entidade pai (contato, conta ou conversa) de outra.

RLS está **habilitado** nas três tabelas desde a Etapa 1. Desde a Etapa 2
(ver "Políticas de RLS" abaixo), um membro ativo da organização pode **ler**
os dados operacionais da própria organização via
`is_org_member(organization_id)`. Não há política de INSERT/UPDATE/DELETE —
toda escrita chega por função restrita, começando pela ingestão atômica da
Etapa 3. `owner`, `admin` e `attendant` não são diferenciados na leitura.

## Tabelas do Ciclo 2 (Etapa 3 — ingestão atômica)

Nenhuma tabela nova. `contacts`, `conversations` e `messages` continuam sem
política de INSERT/UPDATE/DELETE (0004_atendimento_rls.sql). A única porta de
escrita destas três tabelas é a função `security definer`
`ingest_inbound_message`, criada em `0005_ingest_inbound_message.sql`:

```sql
ingest_inbound_message(
  p_whatsapp_account_id uuid,
  p_phone_number text,
  p_content text,
  p_external_message_id text,
  p_contact_name text default null
) returns table (
  organization_id uuid,
  contact_id uuid,
  conversation_id uuid,
  message_id uuid,
  created boolean,
  duplicate boolean,
  reopened boolean
)
```

Recebe apenas o mínimo do chamador — nunca `organization_id`,
`conversation_id`, status, `direction`, `sender_type`, timestamps ou
`sender_user_id`. `organization_id` é sempre derivado de
`whatsapp_accounts.id`; os demais campos da mensagem são fixos
(`direction = 'inbound'`, `sender_type = 'contact'`, `sender_user_id = null`,
`message_type = 'text'`, `delivery_status = 'delivered'` — a mensagem já
chegou por completo, não há "envio" a confirmar do nosso lado).

Validado dentro da função, nesta ordem: usuário autenticado; conta existente
e ativa (`whatsapp_accounts.status = 'connected'` — não existe valor
`'active'` neste enum); provider `development` (não existe valor `'dev'` — só
contas de desenvolvimento podem receber ingestão nesta etapa, antes da
integração real com a Meta); chamador é `owner`/`admin` ativo da organização
derivada (`is_org_admin`); telefone em E.164; conteúdo, após `trim`, não
vazio e até 4096 caracteres; `external_message_id` obrigatório e não vazio.

Contato e conversa são localizados ou criados com
`insert ... on conflict (...) do nothing returning ... into`, nunca com
"verificar e depois inserir": a UNIQUE de cada tabela decide sozinha quem
vence uma criação concorrente, e um `select` subsequente busca a linha
vencedora quando a própria inserção não retorna nada. Entregas duplicadas
nunca alteram um contato existente (não há UPDATE de `name` no caminho de
"contato já existe").

Idempotência de mensagem: a autoridade final é a UNIQUE PARTIAL INDEX
`messages_whatsapp_account_external_id_key` (Etapa 1). O INSERT da mensagem
usa `on conflict (whatsapp_account_id, external_message_id) ... do nothing`;
quando o conflito ocorre, a função busca a mensagem já persistida e retorna
`duplicate = true` sem tocar em conversa, contato ou status —
`created`/`duplicate` nunca são `true` ao mesmo tempo.

Reabertura: uma mensagem nova (não duplicata) para uma conversa `resolved`
reabre a MESMA linha (`status = 'waiting'`, `resolved_at = null`, atribuição
anterior limpa) e retorna `reopened = true`; para conversas `waiting`,
`human`, `bot` ou recém-criadas, apenas `last_message_at` avança. Antes de
decidir reabrir uma conversa pré-existente, a função trava a linha com
`select ... for update`, serializando duas mensagens novas concorrentes para
a mesma conversa `resolved` — só a primeira reabre; a segunda já enxerga
`waiting`.

## Decisão sobre `organization_id`

Tabelas de negócio carregam `organization_id` **direto** quando isso simplifica
segurança e consultas. No Ciclo 1, `organization_members` e `whatsapp_accounts`
têm `organization_id` direto. Nos próximos ciclos, `messages` também terá
`organization_id` direto (embora derivável de `conversation`), justamente para
tornar o RLS simples e rápido.

## Enums

`organization_status`, `member_role`, `member_status`, `whatsapp_provider`,
`whatsapp_status` (Ciclo 1); `conversation_status`, `message_direction`,
`message_sender`, `message_type`, `message_delivery_status` (Ciclo 2). Enums
foram escolhidos por trazerem clareza; adicionar novos valores (ex.: outro
provedor) é feito com `alter type ... add value`.

## Funções auxiliares (autorização)

Definidas como `security definer` para que sejam avaliadas dentro das políticas
de RLS **sem recursão** (rodam como owner e ignoram o RLS ao ler
`organization_members`). Todas usam `set search_path = ''` e referências
totalmente qualificadas.

- `is_platform_admin()` — o usuário é admin global da plataforma?
- `is_org_member(org_id)` — é membro ativo da organização?
- `is_org_admin(org_id)` — é `owner`/`admin` ativo da organização?
- `shares_org_with(user_id)` — compartilha organização com outro usuário?
  (usado para exibir colegas de equipe)

## Políticas de RLS (resumo)

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|--------|
| profiles | próprio, colega de org, admin plataforma | (gatilho) | próprio | — |
| organizations | membro, admin plataforma | admin plataforma | admin da org, admin plataforma | admin plataforma |
| organization_members | membro, admin plataforma | admin da org, admin plataforma | idem | idem |
| whatsapp_accounts | membro, admin plataforma | admin da org, admin plataforma | idem | idem |
| contacts | membro ativo da org | — | — | — |
| conversations | membro ativo da org | — | — | — |
| messages | membro ativo da org | — | — | — |

`—` nas três tabelas do Ciclo 2 significa "sem política": nenhum papel
escreve direto por INSERT/UPDATE/DELETE via API. A escrita chega por função
restrita (Etapa 3 em diante).

Garantias exigidas e atendidas:

- Um usuário não vê dados de outra organização.
- Um atendente não altera configurações administrativas (INSERT/UPDATE exigem
  `owner`/`admin`).
- Usuário não autenticado não acessa nada (sem sessão, `auth.uid()` é nulo).
- O cliente não consegue “forjar” outro `organization_id`: as políticas checam a
  associação real no banco, não um valor enviado pelo frontend.
- `contacts`, `conversations` e `messages` **não** concedem leitura a
  `is_platform_admin()`: administração da plataforma é distinta de pertencer
  à organização, e o conteúdo de conversas e mensagens de clientes é
  sensível.

## Administrador da plataforma vs. proprietário

`is_platform_admin` (em `profiles`) é o administrador **global da Antero**,
distinto do papel `owner` de uma organização. A verificação é feita no servidor
(DAL + RLS). A Antero é uma organização comum; o poder de plataforma vem apenas
desta flag.

## Idempotência

`messages.external_message_id` existe desde o Ciclo 2, é opcional e único
por canal — índice único parcial em `(whatsapp_account_id,
external_message_id)` onde `external_message_id is not null`. O escopo é o
canal, não a organização: duas contas de WhatsApp são fluxos de entrega
independentes, e um id externo de uma conta não deveria bloquear o mesmo id
em outra conta da mesma organização. O Ciclo 4 adicionará `webhook_events`
com o mesmo propósito do lado do webhook real da Meta.

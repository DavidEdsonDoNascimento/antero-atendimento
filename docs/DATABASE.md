# Banco de dados — Antero Atendimento

PostgreSQL. UUIDs como chave. RLS obrigatório.

- **Banco:** PostgreSQL 17 próprio; migrations em `db/migrations` (dbmate),
  a única fonte oficial. Identidade do Better Auth (schema `auth`). Ver a
  seção "PostgreSQL próprio" ao final.
- **Histórico:** o modelo nasceu no Supabase (migrations originais, removidas
  do projeto na Entrega 6). Recuperáveis no Git:
  `git show 796c6e7:supabase/migrations/0001_init.sql`.

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
`name`, `slug` (único), `status` (`active`/`inactive`). `inactive` significa
**suspensa** (ver "Suspensão de organizações"). Pela aplicação, só `name` é
editável; `status` muda apenas por `set_organization_status`.

### organization_members
Vínculo usuário↔organização com `role` (`owner`/`admin`/`attendant`) e `status`
(`active`/`invited`/`disabled`). Índices em `user_id` e `organization_id`.
Único por `(organization_id, user_id)`. O modelo permite um usuário em várias
organizações no futuro; no MVP a interface usa a primeira associação ativa.

### whatsapp_accounts
Canal por organização: `provider` (`development`/`cloud_api`),
`external_account_id`, `phone_number`, `display_name`, `status`. Somente leitura
para a aplicação desde a E1A: esses campos decidirão para qual empresa vão os
webhooks. A conexão real chegará por operação própria e autorizada.

### organization_modules
Módulos de cada organização: `organization_id`, `module`, `enabled`, `updated_by`,
`updated_at`, com UNIQUE `(organization_id, module)`. Sem linha significa
desabilitado. Só leitura para a aplicação; ver "Módulos por organização (E1B)".

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

`organization_status`, `organization_module`, `member_role`, `member_status`,
`whatsapp_provider`, `whatsapp_status` (Ciclo 1); `conversation_status`, `message_direction`,
`message_sender`, `message_type`, `message_delivery_status` (Ciclo 2). Enums
foram escolhidos por trazerem clareza; adicionar novos valores (ex.: outro
provedor) é feito com `alter type ... add value`.

## Funções auxiliares (autorização)

Definidas como `security definer` para que sejam avaliadas dentro das políticas
de RLS **sem recursão** (rodam como owner e ignoram o RLS ao ler
`organization_members`). Todas usam `set search_path = ''` e referências
totalmente qualificadas.

- `is_platform_admin()` — o usuário é admin global da plataforma?
- `is_org_member(org_id)` — é membro ativo da organização, e ela está ativa?
- `is_org_admin(org_id)` — é `owner`/`admin` ativo da organização, e ela está ativa?
- `shares_org_with(user_id)` — compartilha organização ativa com outro usuário?
  (usado para exibir colegas de equipe)
- `current_user_suspended_organizations()` — organizações suspensas em que o
  próprio usuário tem vínculo ativo (id e nome).
- `set_organization_status(org_id, status)` — suspende ou reativa; exclusiva do
  admin da plataforma, conferida dentro da função.
- `has_module(org_id, módulo)` — o usuário da transação pode usar o módulo nessa
  organização? `SECURITY INVOKER`; exige `is_org_member` e o módulo habilitado.
- `set_organization_module(org_id, módulo, habilitado)` — altera um módulo; exclusiva
  do admin da plataforma, com a dependência entre módulos conferida na função.

## Políticas de RLS (resumo)

| Tabela | SELECT | INSERT | UPDATE | DELETE |
|--------|--------|--------|--------|--------|
| profiles | próprio, colega de org, admin plataforma | (gatilho) | próprio | — |
| organizations | membro, admin plataforma | admin plataforma | admin da org, admin plataforma (só `name`) | admin plataforma |
| organization_members | membro, admin plataforma | admin da org, admin plataforma | idem | idem |
| whatsapp_accounts | membro, admin plataforma | — | — | — |
| organization_modules | membro, admin plataforma | — | — | — |
| contacts | membro ativo da org | — | — | — |
| conversations | membro ativo da org | — | — | — |
| messages | membro ativo da org | — | — | — |

`—` significa "sem política": nenhum papel escreve direto por
INSERT/UPDATE/DELETE via API. Em `contacts`, `conversations` e `messages`, a
escrita chega por função restrita (Etapa 3 em diante). Em `whatsapp_accounts`,
ainda não há operação de escrita pela aplicação.

"Membro" e "admin da org" valem só para organização **ativa** (E1A).

Garantias exigidas e atendidas:

- Um usuário não vê dados de outra organização.
- Um atendente não altera configurações administrativas (INSERT/UPDATE exigem
  `owner`/`admin`).
- Usuário não autenticado não acessa nada (sem sessão, `auth.uid()` — no
  banco próprio, `app.current_user_id()` — é nulo).
- O cliente não consegue “forjar” outro `organization_id`: as políticas checam a
  associação real no banco, não um valor enviado pelo frontend.
- `contacts`, `conversations` e `messages` **não** concedem leitura a
  `is_platform_admin()`: administração da plataforma é distinta de pertencer
  à organização, e o conteúdo de conversas e mensagens de clientes é
  sensível.

## Suspensão de organizações (E1A)

Migration `0006_organization_guard`. Uma organização `inactive` não opera:

- **Banco:** a regra está em `is_org_member`, `is_org_admin` e `shares_org_with`,
  então vale para todas as políticas, para `withOrganizationTransaction` e para
  `ingest_inbound_message`. Atinge a sessão já aberta na requisição seguinte.
- **Aplicação:** `getActiveContext` ignora organização suspensa. Sem outra ativa,
  `requireActiveContext` leva a `/organizacao-suspensa`, distinta de
  `/sem-organizacao`. O login continua válido.
- **Vários vínculos:** a suspensão vale por organização. O contexto passa para a
  associação ativa mais antiga em organização ativa.
- **Dados:** nada é apagado; reativar restaura as permissões dos membros ativos.
- **Admin da plataforma:** continua vendo organização, vínculos, canal e status,
  e não lê contatos, conversas nem mensagens. Se também for membro da suspensa,
  o vínculo não opera. `/admin` não depende de organização ativa.

A única porta de escrita de `status` é `set_organization_status`, chamada pela
Server Action de `/admin`, que confere o papel no DAL e de novo no banco. Nem o
admin da plataforma altera a coluna por UPDATE direto.

**Custo:** `is_org_member` ganhou um JOIN com `organizations` e roda por linha.
Medido com `EXPLAIN ANALYZE`, como `antero_app`, com 2 organizações × 20 mil
conversas e 400 mil mensagens: lista da Inbox de ~113 ms para ~165 ms, filtro
`open` de ~117 ms para ~177 ms, histórico abaixo de 1 ms nos dois casos. O índice
`(organization_id, last_message_at DESC, id DESC)` leva a lista a ~0,3 ms, mas não
ajuda o filtro `open`; não foi criado, porque a escala atual não exige.

## Módulos por organização (E1B)

Migration `0007_organization_modules`. Funcionamento, dependências e como adicionar
módulos: `docs/MODULES.md`. Pontos de banco:

- Atendimento foi habilitado na migration para as organizações existentes, com
  `updated_by` nulo; organização criada depois nasce sem módulos.
- `set_organization_module` é a única porta de escrita: `SECURITY DEFINER`, dono
  `antero_owner`, `search_path` vazio, sem EXECUTE para PUBLIC. Nem o admin da
  plataforma escreve por UPDATE direto. Erros: 42501 (não autorizado), 23514
  (dependência), P0002 (organização inexistente), 22004 (entrada nula).
- A função trava a linha da organização (`FOR NO KEY UPDATE`): sem isso, habilitar
  Campanhas e desabilitar Contatos em paralelo deixa Campanhas sem Contatos, como o
  teste de concorrência demonstra.
- `contacts`, `conversations` e `messages` não têm `has_module` nas políticas; a
  guarda da Inbox é `withModuleTransaction`, uma vez por transação. Por isso uma
  consulta SQL sob o contexto do membro ainda lê essas tabelas: o bloqueio de
  Atendimento é da aplicação, não da RLS. Tabelas novas de um módulo usam
  `has_module` na política.
- O rollback da 0007 recusa-se se alguma configuração foi alterada.

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

## PostgreSQL próprio (Entrega 2)

### Ordem das migrations e dependências

| Migration | Cria | Depende de |
| --- | --- | --- |
| `0000_identity` | schema `auth` (tabelas do Better Auth) e schema `app` (contexto do usuário) | papéis `antero_owner`, `antero_app`, `antero_auth` (infra) |
| `0001_init` | enums, `profiles`, `organizations`, `organization_members`, `whatsapp_accounts`, funções de autorização, gatilhos de perfil | `auth.users`, `app.current_user_id()` |
| `0002_rls` | privilégios de `antero_app` e as 14 políticas do Ciclo 1 | 0001 |
| `0003_atendimento` | `contacts`, `conversations`, `messages` (idêntica à original) | 0001 |
| `0004_atendimento_rls` | as 3 políticas de leitura do Ciclo 2 | 0003 |
| `0005_ingest_inbound_message` | função de ingestão | 0001, 0003 |
| `0006_organization_guard` | suspensão efetiva, `set_organization_status`, restrição de escrita em `organizations` e `whatsapp_accounts` | 0001–0005 |
| `0007_organization_modules` | enum e tabela de módulos, `has_module`, `set_organization_module`, Atendimento nas organizações existentes | 0006 |

O banco é construído integralmente do zero por `pnpm db:test:migrate`.

### O que mudou em relação ao Supabase

| Supabase | Banco próprio |
| --- | --- |
| `auth.users` (Supabase Auth) | `auth.users` do Better Auth 1.7.12 (`users`, `sessions`, `accounts`, `verifications`; ids `uuid`) |
| `auth.uid()` (claim JWT) | `app.current_user_id()` (contexto da transação) |
| papel `authenticated` | `antero_app` + contexto de usuário |
| papel `anon` | `antero_app` **sem** contexto → nada visível |
| `service_role` | não existe; `antero_auth` só enxerga `auth` |
| `raw_user_meta_data ->> 'full_name'` | `auth.users.name` |

Tabelas, colunas, tipos, enums, constraints, índices, FKs compostas,
gatilhos, nomes e expressões das 17 políticas e o corpo de
`ingest_inbound_message` foram preservados. `gen_random_uuid()` é nativa
(sem `pgcrypto`).

### Identidade (Better Auth)

- Configuração do schema em `src/lib/auth/better-auth-options.ts`:
  `generateId: "uuid"`, tabelas no plural, colunas em snake_case,
  `schemaName: "auth"`. Mudou a configuração → nova migration. A instância
  de runtime (`src/lib/identity`, Entrega 5A) parte dessas opções e não cria
  tabelas (rate limit em memória, sem plugins) — ver `docs/AUTH.md`.
- `pnpm db:test:auth-schema` compara o banco com o planejador oficial do
  Better Auth e com uma checagem estrita de tipos (`uuid` em ids e FKs).
- `profiles.id` → `auth.users.id` (`on delete cascade`). `profiles` nasce pelo
  gatilho `handle_new_user` (nome vazio → parte local do e-mail) e
  `profiles.email` acompanha `auth.users.email` (`handle_user_email_updated`).
  Os dois são `SECURITY DEFINER`: `antero_auth` não precisa de nada em
  `public`.
- `antero_app` não tem `USAGE` em `auth`: não lê hashes de senha
  (`accounts.password`), tokens de sessão, tokens OAuth nem verificações.

### Contexto do usuário

```sql
begin;
select app.set_user_context('<id da sessão validada no servidor>');
-- consultas da aplicação (RLS usa app.current_user_id())
commit;
```

- `set_user_context` grava `app.user_id` com escopo de **transação** e uma
  marca da transação (pid + início). `current_user_id()` só devolve o id se a
  marca for da transação atual: um `SET` de sessão, um `SET` direto de
  `app.user_id` ou um contexto que sobrou de outra transação resultam em
  `NULL` → acesso negado. Compatível com pool.
- O valor **não autentica ninguém**: só a camada de servidor (DAL) pode
  defini-lo, a partir de uma sessão do Better Auth já validada — nunca de um id
  vindo do cliente.

### Correção de segurança em `profiles`

No original, `authenticated` tinha `UPDATE` em todas as colunas de
`profiles` e `profiles_update_own` só conferia `id = auth.uid()`: qualquer
usuário podia se tornar `is_platform_admin` ou trocar o próprio e-mail
desnormalizado. Agora `antero_app` só tem `UPDATE (full_name)`;
`is_platform_admin` muda apenas administrativamente e `email` vem de
`auth.users`. A aplicação atual não escreve em `profiles`, então nada muda
para ela.

**Pendência de segurança no Supabase antigo (produção atual):** a falha
continua lá — qualquer usuário autenticado pode executar, pela API do
Supabase, `update profiles set is_platform_admin = true` no próprio registro.
Não foi alterada (Supabase remoto fora do escopo). Recomenda-se aplicar lá a
mesma restrição de coluna (`revoke update … ; grant update (full_name) …`) ou
concluir a migração antes de expor o produto a usuários não confiáveis.

### Entrada de sistema (webhook/worker) — desenho futuro

`ingest_inbound_message` continua exigindo um humano `owner`/`admin` ativo
(é o que o simulador de desenvolvimento usa). A ingestão real da Meta **não**
deve afrouxá-la (aceitar contexto nulo, "usuário de sistema" global ou
`organization_id` vindo do chamador). Desenho previsto:

1. papel dedicado (ex.: `antero_ingest`, `LOGIN`, sem `BYPASSRLS`, sem
   privilégio de leitura nas tabelas) usado só pelo processo do webhook;
2. função separada `SECURITY DEFINER` executável apenas por esse papel, que
   recebe o identificador externo da conta (assinatura da Meta já validada
   pelo webhook) e deriva `organization_id` **somente** de um
   `whatsapp_account` `cloud_api` conectado;
3. a gravação (contato, conversa, mensagem, idempotência, reabertura) é
   extraída para uma função interna comum, sem `EXECUTE` para nenhum papel de
   login, chamada pelas duas portas de entrada;
4. `webhook_events` (Ciclo 4) registra a entrega bruta antes da ingestão.

### Pendência obrigatória: regras herdadas de gerenciamento de membros

Preservadas da migração sem alteração, mas **precisam de decisão de negócio
antes de implementar o gerenciamento de membros/usuários** (telas ou ações
de equipe):

- `organization_members_update`: um `admin` ativo pode alterar o `role` de
  qualquer vínculo da organização — inclusive promover alguém (ou a si
  mesmo) a `owner` e rebaixar um `owner`;
- `organization_members_delete`: um `admin` pode remover qualquer vínculo,
  inclusive o de um `owner`, e uma organização pode ficar sem `owner`;
- `organization_members_insert`: um `admin` pode criar vínculos com qualquer
  papel, inclusive `owner`.

Decidir (ex.: só `owner` gerencia `owner`/`admin`; pelo menos um `owner`
ativo sempre) e implementar com nova migration + testes pgTAP. A E1A não alterou
estas regras; elas só deixam de valer enquanto a organização estiver suspensa.

## Camada de acesso da aplicação (Entrega 3)

`src/lib/db` (server-only; importe só de `@/lib/db`):

```ts
import { withUserTransaction } from "@/lib/db";

const rows = await withUserTransaction(sessionUserId, async (tx) => {
  const { rows } = await tx.query("SELECT … WHERE organization_id = $1", [organizationId]);
  return rows;
});
```

- Conexão do pool `antero_app` (`APP_DATABASE_URL`) → `BEGIN` →
  `app.set_user_context($1::uuid)` → callback na mesma conexão → `COMMIT` ou
  `ROLLBACK` (erro propagado) → devolução da conexão (ou descarte, se quebrou).
- `sessionUserId` deve vir **só** de uma sessão validada no servidor
  (`lib/auth/dal.ts`); nunca de parâmetro, cookie ou corpo da requisição.
- Não há helper sem usuário nem acesso privilegiado: sem contexto a RLS não
  mostra nada, e a futura ingestão da Meta terá entrada própria (seção
  "Entrada de sistema").
- `tx.query` recusa controle de transação/sessão, troca de contexto e
  parâmetros `Date`; sempre um comando por chamada.
- Timestamps chegam como string ISO com microssegundos, no mesmo formato do
  PostgREST (`2026-10-26T13:45:12.123456+00:00`); passe-os de volta como
  string nos parâmetros (`$1::timestamptz`).

## Consultas SQL da aplicação (Entrega 4)

Camada de leitura implementada na Entrega 4 e **ativada na Entrega 5B**: o
DAL e as páginas usam `modules/*/sql-queries.ts`;
os `queries.ts` (PostgREST) do Supabase foram removidos na Entrega 6.

### Contexto de organização

```ts
import { withOrganizationTransaction } from "@/lib/db";

await withOrganizationTransaction({ userId, organizationId }, async (tx) => { … });
```

`withUserTransaction` + `SELECT public.is_org_member($1)` na mesma
transação: sem vínculo **ativo** (desativado, sem organização, outra
empresa, id inexistente ou inválido) → `AccessDeniedError` genérico antes do
callback. `userId` precisa vir de uma sessão validada e `organizationId` da
associação ativa desse usuário (`getActiveContext` abaixo) — nunca do
navegador. As consultas mantêm a RLS e ainda filtram `organization_id`
explicitamente: um usuário com vínculo em duas empresas vê só a do contexto
(testado).

`withModuleTransaction(context, módulo, callback)` acrescenta, na mesma transação,
`public.has_module`: com vínculo e módulo desligado → `ModuleDisabledError` (subclasse
de `AccessDeniedError`). As consultas da Inbox rodam nela, com o módulo Atendimento.

### Funções disponíveis

| Módulo (`sql-queries.ts`) | Função | Uso |
| --- | --- | --- |
| `conversations` | `listConversations(ctx, params)` | lista da Inbox |
| `conversations` | `getConversationDetail(ctx, id)` | detalhe da conversa |
| `conversations` | `listConversationMessages(ctx, id, params)` | histórico paginado |
| `organizations` | `getActiveContext({ userId })` | contexto ativo do DAL (`lib/auth/dal.ts`) |
| `organizations` | `listAllOrganizations({ userId })` | `/admin` (confere o papel no banco) |
| `organizations` | `setOrganizationStatus({ userId, organizationId, status })` | suspender/reativar em `/admin` |
| `organizations` | `getSuspendedOrganizations({ userId })` | `/organizacao-suspensa` |
| `organizations` | `listEnabledModules({ userId })` | módulos na listagem de `/admin` |
| `organizations` | `getOrganizationModuleConfiguration({ userId, organizationId })` | `/admin/organizacoes/[id]` |
| `organizations` | `setOrganizationModule({ userId, organizationId, module, enabled })` | habilitar/desabilitar em `/admin` |
| `users` | `listOrganizationMembers(ctx)` | Equipe |
| `users` | `getOwnProfile({ userId })` | perfil do próprio usuário (DAL) |
| `whatsapp` | `getPrimaryWhatsappAccount(ctx)` | Configurações |

`ctx` = `{ userId, organizationId }` (`OrganizationContext`), entregue pelo
DAL (`organizationContextOf`). O SQL da Inbox fica em
`modules/conversations/sql.ts` (puro, testado sem banco); `cursor.ts`,
`pagination.ts`, `mappers.ts`, `rows.ts` e `types.ts` são os contratos de
retorno.

### Equivalência com o contrato original (PostgREST)

- Embeds → JOINs pelas mesmas FKs compostas: contato e canal (JOIN),
  atendente e perfil (LEFT JOIN), última mensagem por `LEFT JOIN LATERAL`
  pela FK tripla de `messages`. As linhas são remontadas no formato de
  `rows.ts` (`last_message` como array de 0/1 item).
- Os testes geram as linhas exatamente como o PostgREST as montava
  (subconsultas JSON executadas sob a RLS do usuário), passam pelos mesmos
  mapeadores e comparam item a item com o resultado SQL.
- Erros: `InvalidCursorError` e `ConversationQueryError` como antes (o
  `DatabaseError` original fica em `cause`); contexto inválido →
  `AccessDeniedError`/`InvalidUserContextError`. As consultas auxiliares
  lançam `Error` com o mesmo prefixo de mensagem das atuais.

Diferenças deliberadas (todas cobertas por teste):

1. **Atendente desativado**: a RLS de `profiles` (`shares_org_with`) oculta
   o perfil de quem não tem vínculo ativo. O PostgREST devolvia
   `assigned_member.profile = null` e `mapAssignee` quebrava com `TypeError`
   (**defeito latente no fluxo atual**: uma conversa atribuída a alguém
   depois desativado derruba a Inbox e o detalhe). No SQL o atendente sai
   com `fullName: null` e o mapeador fica igual.
2. **Última mensagem com empate exato** em `created_at`: o PostgREST
   ordenava só por `created_at` (resultado indefinido); o SQL desempata por
   `id DESC`, igual à última linha do histórico.
3. **Desempate por `id`** também em membros (`created_at, id`), conta
   principal e lista de organizações.
4. **Cursor bem formado, mas recusado pelo PostgreSQL** como timestamp (ex.:
   ano `0000`, aceito pelo formato ISO): `InvalidCursorError` (o loader
   volta à primeira página) em vez de erro de consulta.
5. **`listAllOrganizations`**: o papel de administrador da plataforma é
   conferido no banco; quem não é recebe `AccessDeniedError` (a RLS sozinha
   devolveria as próprias organizações). A página `/admin` já exige o papel.
6. Colunas sempre explícitas (nunca `*`): uma coluna nova (ex.: credencial
   da Meta em `whatsapp_accounts`) não passa a sair sem revisão.

### Paginação

- `last_message_at` e `messages.created_at` são `NOT NULL DEFAULT now()`
  (0003): não existe timestamp nulo, e conversa sem mensagens aparece pela
  própria `last_message_at` (= `started_at` ao nascer), com
  `lastMessage: null`. Por isso o keyset composto
  `(last_message_at, id) < ($ts::timestamptz, $id::uuid)` é exatamente o
  `last_message_at.lt.X or (eq.X and id.lt.Y)` do PostgREST.
- Ordem `last_message_at DESC, id DESC` (lista) e `created_at DESC, id DESC`
  (histórico, invertido em memória para a ordem cronológica). Busca
  `limit + 1`; `nextCursor` aponta para o último item **devolvido** (a linha
  extra só indica que há mais).
- Cursores e timestamps são strings ISO com microssegundos, como no
  PostgREST: um cursor gerado pela versão Supabase continua válido.
- O cursor é só uma posição: usado com outro filtro, devolve os itens desse
  filtro mais antigos que a posição; de outra empresa, não revela nada (filtro
  explícito + RLS). Cursor inválido → `InvalidCursorError` antes de usar
  conexão (lista) ou após confirmar a conversa (histórico, como antes).

### Desempenho (medido com `EXPLAIN ANALYZE`, dados fictícios)

Banco de testes, como `antero_app` com contexto (RLS ativa): 2 organizações
× 20 mil conversas, 405 mil mensagens, uma conversa com 5 mil mensagens.

| Consulta | Tempo |
| --- | --- |
| lista, 1ª página — JOINs/LATERAL no nível do `LIMIT` (1ª versão) | 1 774 ms |
| lista, 1ª página — página escolhida antes dos JOINs (atual) | 118 ms |
| lista, página profunda / filtro `open` com cursor (atual) | 61 ms |
| lista (atual) + índice `(organization_id, last_message_at DESC, id DESC)` | 3–4 ms |
| detalhe | 0,3 ms |
| histórico, 1ª página (índice `messages_conversation_created_idx` de trás para frente) | 0,7 ms |
| histórico, 2 500 mensagens adiante (keyset como condição do índice) | 14,5 ms |

- Uma única consulta de dados por página da Inbox (sem N+1): o LATERAL roda
  só para as `limit + 1` conversas da página.
- O custo restante da lista é a política de RLS: `is_org_member()` é
  chamada para cada conversa da organização antes do top-N. O índice acima
  eliminaria isso (3–4 ms), mas **não foi criado**: exige migration e a
  escala atual não precisa. Reavaliar antes de organizações com milhares de
  conversas (junto com uma política que avalie o vínculo uma vez por
  consulta).

### Ativação (Entrega 5B — concluída)

1. Better Auth valida a sessão → `userId`; `getActiveContext({ userId })` →
   organização ativa e papel (DAL, com `cache` e `redirect`).
2. Loaders e páginas usam `modules/*/sql-queries` com `{ userId,
   organizationId }` do DAL; a regra de lint de `sql-queries` foi substituída
   por uma que bloqueia o legado Supabase.
3. Validado: suíte de integração, E2E contra o servidor real e roteiro no
   navegador (lista, filtros, paginação, conversa, histórico, isolamento).

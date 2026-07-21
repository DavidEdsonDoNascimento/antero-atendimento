# Banco de dados — Antero Atendimento

PostgreSQL (Supabase). UUIDs como chave. RLS obrigatório. Migrations em
`supabase/migrations`.

## Estratégia por ciclos

O modelo completo do produto foi projetado desde o início, mas as tabelas são
criadas **por ciclo**, conforme a necessidade real, mantendo cada migration
focada e o RLS coerente.

| Ciclo | Tabelas |
|------|---------|
| **1 (atual)** | `profiles`, `organizations`, `organization_members`, `whatsapp_accounts` |
| 2 | `contacts`, `conversations`, `messages`, `conversation_assignments` |
| 3 | `flows`, `flow_steps`, `flow_options`, `flow_sessions`, `captured_answers` |
| 4 | `webhook_events` |

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

## Decisão sobre `organization_id`

Tabelas de negócio carregam `organization_id` **direto** quando isso simplifica
segurança e consultas. No Ciclo 1, `organization_members` e `whatsapp_accounts`
têm `organization_id` direto. Nos próximos ciclos, `messages` também terá
`organization_id` direto (embora derivável de `conversation`), justamente para
tornar o RLS simples e rápido.

## Enums

`organization_status`, `member_role`, `member_status`, `whatsapp_provider`,
`whatsapp_status`. Enums foram escolhidos por trazerem clareza; adicionar novos
valores (ex.: outro provedor) é feito com `alter type ... add value`.

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

Garantias exigidas e atendidas:

- Um usuário não vê dados de outra organização.
- Um atendente não altera configurações administrativas (INSERT/UPDATE exigem
  `owner`/`admin`).
- Usuário não autenticado não acessa nada (sem sessão, `auth.uid()` é nulo).
- O cliente não consegue “forjar” outro `organization_id`: as políticas checam a
  associação real no banco, não um valor enviado pelo frontend.

## Administrador da plataforma vs. proprietário

`is_platform_admin` (em `profiles`) é o administrador **global da Antero**,
distinto do papel `owner` de uma organização. A verificação é feita no servidor
(DAL + RLS). A Antero é uma organização comum; o poder de plataforma vem apenas
desta flag.

## Idempotência (preparação para webhook)

O Ciclo 4 adicionará `messages.external_message_id` e `webhook_events` com
identificadores externos únicos, para descartar entregas duplicadas do webhook.

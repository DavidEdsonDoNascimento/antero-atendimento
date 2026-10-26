# Infraestrutura local — Antero Atendimento

Ambiente local **independente do Supabase**: PostgreSQL 17 de desenvolvimento,
PostgreSQL 17 de testes (descartável, com pgTAP), Mailpit e um executor de
migrations SQL. Faz parte da migração para infraestrutura própria (Entregas 1
e 2).

> **Estado atual:** a aplicação ainda usa o Supabase (veja `docs/SETUP.md`) e
> `pnpm dev` continua inalterado — nada da aplicação conecta neste banco ainda.
> O schema completo (identidade do Better Auth + migrations `0000`–`0005`)
> já é construído do zero aqui e validado por pgTAP (Entrega 2; detalhes em
> `docs/DATABASE.md`, seção "PostgreSQL próprio"). Nada aqui acessa o
> Supabase remoto, a VPS ou o Coolify.

## Pré-requisitos

- Docker com Compose v2
- Node.js 20+ e **pnpm 11** (versão fixada em `packageManager`; `corepack enable`)

## Primeiros passos

```bash
pnpm install
pnpm infra:env        # cria .env.infra com senhas aleatórias (nunca sobrescreve;
                      # num arquivo existente só acrescenta senhas que faltam)
pnpm infra:up         # PostgreSQL de desenvolvimento + Mailpit
pnpm db:roles         # só para bancos criados antes da Entrega 2: cria antero_auth
pnpm db:migrate       # aplica db/migrations/ no banco de desenvolvimento
pnpm db:verify        # confere papéis e privilégios do banco de desenvolvimento
pnpm db:auth-schema   # confere o schema `auth` contra a configuração do Better Auth
```

Banco de testes (descartável):

```bash
pnpm db:test:reset        # recria o banco de testes do zero (tmpfs)
pnpm db:test:migrate      # aplica todas as migrations
pnpm db:test:verify       # confere papéis e privilégios
pnpm db:test:auth-schema  # confere o schema `auth` contra o Better Auth
pnpm db:test:pgtap        # roda db/tests/*.sql com pg_prove
pnpm db:test:migrate:status / db:test:migrate:rollback
pnpm db:test:stop         # remove o container de testes (os dados somem)
```

`.env.infra` é ignorado pelo Git e tem permissão `600`. Para ver o estado:
`pnpm infra:status`, `pnpm infra:logs [serviço]`; para parar sem apagar nada:
`pnpm infra:stop`.

## Serviços

Projeto Compose `antero-atendimentos`, rede `antero-atendimentos-net`. Todas as
portas são publicadas **somente em `127.0.0.1`** e foram escolhidas fora das
usadas por antero-pedidos (5433–5435) e antero-cartas (54321–54324).

| Serviço | Container | Porta local | Armazenamento |
| --- | --- | --- | --- |
| `postgres-dev` | `antero-atendimentos-db` | 55433 | volume `antero-atendimentos-pgdata-dev` |
| `postgres-test` | `antero-atendimentos-db-test` | 55434 | **tmpfs** (descartável) |
| `mailpit` | `antero-atendimentos-mailpit` | SMTP 55425, UI http://127.0.0.1:55426 | — |
| `migrate-dev` / `migrate-test` | efêmeros (`run --rm`) | — | — |

O banco de testes usa `fsync=off`, só aceitável porque os dados são
descartáveis. A imagem (`docker/postgres/Dockerfile`) é a mesma nos dois
bancos (PostgreSQL 17 + pgTAP + `pg_prove`); as extensões `pgtap` e `dblink`
(esta no schema `test_tools`, sem acesso para os papéis da aplicação) só são
criadas no banco de testes.

## Papéis do PostgreSQL

Criados na primeira inicialização de cada banco por
`docker/postgres/initdb/10-roles.sh`. O script é idempotente: `pnpm db:roles`
/ `pnpm db:test:roles` o executam num banco já existente para criar papéis
novos e ressincronizar atributos e senhas com `.env.infra` (sem tocar em
dados; o container precisa estar com as variáveis atuais — `pnpm infra:up`
recria o container quando o compose muda, preservando o volume).

| Papel | Login | Função | Privilégios |
| --- | --- | --- | --- |
| `antero_admin` | sim | bootstrap do cluster e operações administrativas locais | superusuário; **nunca usado pela aplicação** |
| `antero_owner` | não | dono do banco, do schema `public` e de todos os objetos | ninguém loga com ele |
| `antero_migrator` | sim | executa as migrations (dbmate) | ao conectar assume `antero_owner` (`role = antero_owner`), então os objetos nascem com o dono certo; sem superusuário, sem `CREATEROLE`/`CREATEDB` |
| `antero_app` | sim | conexão da aplicação | sem superusuário, **sem `BYPASSRLS`**, `NOINHERIT`, sem `CREATE`/`TEMP`, não é dono de nada; `CONNECT`, `USAGE` em `public` e `app` e só os privilégios de tabela/função concedidos pelas migrations (sujeitos à RLS). **Sem acesso ao schema `auth`** |
| `antero_auth` | sim | conexão do Better Auth (a partir da Entrega 5) | mesmas restrições do `antero_app`; `USAGE` só no schema `auth` e `SELECT/INSERT/UPDATE/DELETE` nas 4 tabelas do Better Auth; **nada em `public`**, nenhuma função do projeto, sem `CREATE` em `auth` (migrations do Better Auth nunca rodam em runtime) |

Garantias de base:

- `PUBLIC` não tem `CONNECT` no banco nem `USAGE` no schema `public`.
- Funções criadas por `antero_owner` **não** ficam executáveis por `PUBLIC`
  (`ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE … FROM PUBLIC`): cada função
  precisa de `GRANT EXECUTE` explícito na migration que a cria.
- Tabelas novas **não** concedem nada a `antero_app` por padrão: cada migration
  concede o mínimo necessário (privilégio de tabela + política de RLS).
- Como `antero_app` não é dono das tabelas e não tem `BYPASSRLS`, a RLS vale
  para ele. **Conectar a aplicação como dono das tabelas ou como superusuário
  desligaria a RLS silenciosamente** — `pnpm db:verify` e o teste pgTAP existem
  para flagrar isso.

### Como são usados (Entrega 2)

- Migrations rodam como `antero_migrator` (objetos pertencem a `antero_owner`).
- A aplicação conectará como `antero_app` e, em cada transação que age por um
  usuário, chamará `app.set_user_context(<id>)` (escopo da transação, seguro
  com pool). O identificador vem de uma sessão **validada no servidor**
  (Better Auth), nunca diretamente da requisição; as políticas e as funções
  `SECURITY DEFINER` conferem pertencimento e papel na organização.
- O Better Auth conecta como `antero_auth` (pool próprio, `src/lib/identity`,
  Entrega 5A — ainda não usado pelas rotas; ver `docs/AUTH.md`), enxergando só
  o schema `auth`.
  Perfis em `public.profiles` nascem/sincronizam por gatilho `SECURITY
  DEFINER`, sem conceder nada em `public` ao `antero_auth`.
- Webhook/worker futuros: entrada de sistema própria, por papel dedicado e
  restrita pela conta de WhatsApp — desenho em `docs/DATABASE.md`.

## Migrations (dbmate)

Escolhido o **dbmate 2.36** (imagem oficial, fixada) em vez de um executor Node:
SQL puro versionado no Git (`db/migrations/`, blocos `-- migrate:up` /
`-- migrate:down`), tabela de controle `schema_migrations`, ordem determinística
pela versão (prefixo numérico do arquivo), trava consultiva contra execuções
concorrentes, transação por migration, **zero dependências npm** e uma imagem
que o Coolify pode executar como passo de pré-deploy.

```bash
pnpm db:new nome_da_migration   # cria db/migrations/<timestamp>_nome.sql
pnpm db:migrate                 # aplica pendentes no banco de desenvolvimento
pnpm db:migrate:status          # lista aplicadas/pendentes
pnpm db:migrate:rollback        # desfaz a última
pnpm db:test:migrate            # aplica pendentes no banco de testes
```

- Cadeia atual (versão = prefixo numérico): `0000_identity`, `0001_init`,
  `0002_rls`, `0003_atendimento`, `0004_atendimento_rls`,
  `0005_ingest_inbound_message`. Novas migrations criadas com `pnpm db:new`
  recebem prefixo de data/hora e ordenam depois delas.
- `up` é idempotente: uma segunda execução não reaplica nada.
- Todo `migrate:down` desfaz de fato os efeitos do `up` e **recusa-se** a
  apagar dados (as migrations que criam tabelas abortam se houver linhas). O
  dbmate imprime `Rolled back:` mesmo quando o `down` falha — confira o código
  de saída e `status`: nesses casos a migration continua aplicada e nada muda.
  Nunca use rollback no banco de desenvolvimento para "limpar" dados.
- As migrations originais do Supabase continuam intactas em
  `supabase/migrations/` e **não** são lidas por este executor.

## Testes do banco (pgTAP)

`db/tests/*.sql`, executados por `pnpm db:test:pgtap` como superusuário do
banco **descartável** (só para montar fixtures). Toda verificação de acesso
executa o SQL sob teste como `antero_app`/`antero_auth`, com o contexto de
usuário definido como a aplicação fará (helpers em `db/tests/lib/helpers.psql`).

| Arquivo | Cobre |
| --- | --- |
| `000_infra_roles_test` | papéis e privilégios de base |
| `010_identity_test` | schema do Better Auth (uuid, FKs), gatilhos de perfil, separação `antero_app`/`antero_auth` |
| `020_user_context_test` | contexto de usuário preso à transação, sem vazamento |
| `030_rls_policies_test` | as 17 políticas por comportamento |
| `040_security_definer_test` | funções privilegiadas: dono, `search_path`, grants, autorização |
| `050_ingest_inbound_message_test` | as 69 asserções originais da ingestão + isolamento entre orgs |
| `060_ingest_concurrency_test` | concorrência real com duas conexões (dblink) |

## Testes de integração (`src/lib/db` e `modules/*/sql-queries.ts`)

```bash
pnpm db:test:integration   # tests/db/*.test.ts, só contra o banco de testes
```

O comando monta, a partir de `.env.infra`, as URLs do banco de **testes** para
`antero_app` (a camada), `antero_migrator` e `antero_auth` (fixtures) e não
repassa nenhuma credencial de desenvolvimento. Antes de escrever, o harness
(`tests/db/harness.ts`) confere host loopback, porta e nome (`*_test`) e, no
servidor, `fsync = off` e a extensão pgTAP — marcas que o banco de
desenvolvimento não tem. Fixtures são fictícios e removidos ao final de cada
arquivo. Os testes rodam com `node --conditions=react-server` (o mesmo modo
que o Next.js usa para o `server-only`) e com `tests/db/register-aliases.mjs`,
que resolve o alias `@/` dos módulos da aplicação (hook de `node:module`).

Alguns testes da Entrega 3 contam linhas sem filtro de organização e usam
`statement_timeout` de 500 ms: não deixe volume extra no banco de testes
(ex.: dados de `EXPLAIN`); `pnpm db:test:reset` + `pnpm db:test:migrate` o
recriam do zero.

| Arquivo | Cobre |
| --- | --- |
| `connection.test.ts` | papel `antero_app`, ausência de privilégios, sessão (UTC/ISO, timeouts), ciclo de vida do pool |
| `transactions.test.ts` | pool de 1 conexão: commit, rollback, erros, timeout, queda de conexão, sem vazamento de contexto |
| `security.test.ts` | isolamento entre organizações, desativados, sem organização, sem contexto, tabelas de autenticação |
| `concurrency.test.ts` | 60 transações simultâneas, transações sobrepostas, falha isolada |
| `timestamps.test.ts` | microssegundos, paridade com `to_json`, keyset com os cursores atuais |
| `inbox-list.test.ts` | lista da Inbox: equivalência com o PostgREST, ordem, filtros, paginação, limites, embeds |
| `inbox-history.test.ts` | detalhe e histórico: equivalência, keyset invertido, empates, µs, not-found |
| `inbox-isolation.test.ts` | empresas A/B, usuário em duas empresas, desativado, sem organização, sem contexto |
| `inbox-robustness.test.ts` | pool de 1 conexão: cursores/ids inválidos, erro do PostgreSQL, timeout, sem vazamento |
| `auxiliary-queries.test.ts` | contexto ativo, membros, conta principal de WhatsApp, admin da plataforma |
| `identity-foundation.test.ts` | Better Auth: schema x opções reais, UUID, pools/papéis separados, perfil automático, cadastro bloqueado, provisionamento |
| `identity-sessions.test.ts` | login, cookies (ausente, adulterado, outro segredo, expirado), logout, sessões simultâneas, revogação, CSRF, banco indisponível |
| `identity-password-reset.test.ts` | recuperação com o Mailpit: resposta neutra, link, token expirado/reutilizado, redirecionamentos externos, logs |
| `identity-rate-limit.test.ts` | limites de login e recuperação por IP, X-Forwarded-For forjado, `auth.api` fora do limite |
| `identity-access.test.ts` | login real → sessão → organização ativa → consultas SQL por organização |

`tests/db/inbox-fixtures.ts` monta os dados da Inbox com timestamps explícitos
(empates, passos de 1 µs) e a referência no formato do PostgREST.
`tests/db/identity-harness.ts` cria instâncias reais do Better Auth
(`antero_auth` do banco de testes, segredo aleatório por execução) e as
exercita pelo handler HTTP com cookies; e-mails vão só para o Mailpit local
(cada teste lê e apaga só as mensagens dos próprios destinatários).

Um subconjunto: `pnpm db:test:integration 'identity-*'` (filtro com letras
minúsculas, dígitos, `-` e `*`).

### Variáveis da aplicação (servidor)

| Variável | Padrão | Uso |
| --- | --- | --- |
| `APP_DATABASE_URL` | — (obrigatória) | `postgres://antero_app:<senha>@host:porta/banco[?sslmode=…]`; outro papel ou outros parâmetros são recusados |
| `APP_DATABASE_POOL_MAX` | 10 (1–50) | conexões por processo |
| `APP_DATABASE_CONNECT_TIMEOUT_MS` | 5000 | espera por conexão |
| `APP_DATABASE_IDLE_TIMEOUT_MS` | 30000 | fecha conexões ociosas |
| `APP_DATABASE_STATEMENT_TIMEOUT_MS` | 15000 | limite por comando (servidor) |

`idle_in_transaction_session_timeout` é fixo em 60 s. Ainda não há nada no
`.env.local` e `pnpm dev` não usa a camada: as rotas continuam no Supabase até
a Entrega 5B. As variáveis da identidade (`AUTH_DATABASE_URL`,
`BETTER_AUTH_*`, `AUTH_TRUSTED_PROXIES`, `SMTP_*`, `MAIL_FROM`) estão em
`docs/AUTH.md`.

## Identidades fictícias locais

`pnpm auth:provision <test|dev> --email … --name … [--rotate-password]` cria
(ou reaproveita) uma identidade pelo fluxo oficial do Better Auth, sem
cadastro público, e mostra a senha gerada uma única vez. Só aceita banco e
origem locais. Em `dev` altera dados persistentes — use só quando decidido.
Detalhes em `docs/AUTH.md`.

## Schema do Better Auth

`pnpm db:test:auth-schema` / `pnpm db:auth-schema` (script
`scripts/auth-schema.mjs`) conectam como `antero_auth` e rodam o planejador
de migrations do próprio Better Auth (`getMigrations`, o mesmo de
`auth generate`) com a configuração de `src/lib/auth/better-auth-options.ts`:
falham se ele quiser criar/alterar algo ou emitir aviso, e conferem tipos
(`uuid`), nulabilidade, FKs e unicidade. Nunca executam migrations.
`node scripts/infra.mjs auth-schema test print` imprime o SQL que o gerador
oficial produziria (num banco sem a `0000`, é o schema de referência).

## Proteções dos scripts

Todos os comandos passam por `scripts/infra.mjs`, que:

- usa sempre `-p antero-atendimentos` e `compose.yaml` deste repositório;
- lê a configuração só de `.env.infra` e descarta variáveis do shell que
  poderiam redirecionar o Compose/dbmate (`COMPOSE_*`, `DBMATE_*`, `PG*`,
  `DATABASE_URL`);
- recusa `DOCKER_HOST` não local, variáveis ausentes, senhas curtas ou repetidas
  e `TEST_DB_NAME` que não termine em `_test`;
- conecta o dbmate sempre pela rede interna ao serviço do alvo escolhido
  (`dev` ou `test`) com a credencial do `antero_migrator`;
- **não oferece nenhum comando que apague o volume do banco de
  desenvolvimento**. O reset do banco de testes remove apenas o container
  `postgres-test` deste projeto (dados em tmpfs);
- `auth-schema` só aceita URL local (`127.0.0.1`/`localhost`).

## Apagar o banco de desenvolvimento (manual e consciente)

Não há script. Se for realmente necessário, após `pnpm infra:stop`, remova
**somente** o volume `antero-atendimentos-pgdata-dev` e os containers deste
projeto, conferindo os nomes antes. Nunca use comandos de limpeza global do
Docker: outros projetos compartilham este daemon.

## Docker/Coolify (preparação)

O futuro Dockerfile da aplicação deve usar a mesma versão do pnpm
(`packageManager` no `package.json`; `corepack enable`) e instalar com
`pnpm install --frozen-lockfile`. O Dockerfile definitivo, o `/api/health` e a
configuração do Coolify pertencem a entregas posteriores.

- No container, `APP_DATABASE_URL` deve apontar para o PostgreSQL pela rede
  interna do Coolify, com o papel `antero_app`; o processo deve chamar
  `closeAppPool()` no encerramento (SIGTERM) para devolver as conexões.
- `next build` hoje precisa de rede só por causa de `next/font/google`
  (`src/app/layout.tsx`): um build totalmente offline (container com
  `--network none`, sem `.env*`) falha ao baixar Geist/Geist Mono e, com as
  fontes substituídas, conclui. Para builds sem rede no Coolify, migrar para
  `next/font/local` com os arquivos versionados.

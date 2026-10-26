# Infraestrutura local — Antero Atendimento

Ambiente local **independente do Supabase**: PostgreSQL 17 de desenvolvimento,
PostgreSQL 17 de testes (descartável, com pgTAP), Mailpit e um executor de
migrations SQL. Faz parte da migração para infraestrutura própria (Entrega 1).

> **Estado atual:** a aplicação ainda usa o Supabase (veja `docs/SETUP.md`).
> Esta infraestrutura só prepara o terreno: as migrations `0001`–`0005` ainda
> não foram portadas (Entrega 2) e `pnpm dev` continua inalterado. Nada aqui
> acessa o Supabase remoto, a VPS ou o Coolify.

## Pré-requisitos

- Docker com Compose v2
- Node.js 20+ e **pnpm 11** (versão fixada em `packageManager`; `corepack enable`)

## Primeiros passos

```bash
pnpm install
pnpm infra:env        # cria .env.infra com senhas aleatórias (nunca sobrescreve)
pnpm infra:up         # PostgreSQL de desenvolvimento + Mailpit
pnpm db:verify        # confere papéis e privilégios do banco de desenvolvimento
```

Banco de testes (descartável):

```bash
pnpm db:test:up       # sobe o PostgreSQL de testes (tmpfs)
pnpm db:test:verify   # confere papéis e privilégios
pnpm db:test:pgtap    # roda db/tests/*.sql com pg_prove
pnpm db:test:reset    # recria o banco de testes do zero
pnpm db:test:stop     # remove o container de testes (os dados somem)
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
bancos (PostgreSQL 17 + pgTAP + `pg_prove`); a extensão `pgtap` só é criada no
banco de testes.

## Papéis do PostgreSQL

Criados na primeira inicialização de cada banco por
`docker/postgres/initdb/10-roles.sh`.

| Papel | Login | Função | Privilégios |
| --- | --- | --- | --- |
| `antero_admin` | sim | bootstrap do cluster e operações administrativas locais | superusuário; **nunca usado pela aplicação** |
| `antero_owner` | não | dono do banco, do schema `public` e de todos os objetos | ninguém loga com ele |
| `antero_migrator` | sim | executa as migrations (dbmate) | ao conectar assume `antero_owner` (`role = antero_owner`), então os objetos nascem com o dono certo; sem superusuário, sem `CREATEROLE`/`CREATEDB` |
| `antero_app` | sim | conexão da aplicação | sem superusuário, **sem `BYPASSRLS`**, sem `CREATE`, não é dono de nada; só `CONNECT` e `USAGE` no schema `public` |

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

### Como serão usados na Entrega 2 (proposta)

- Migrations rodam como `antero_migrator` (objetos pertencem a `antero_owner`).
- A aplicação conecta como `antero_app` e, em cada transação, define o contexto
  do usuário com `set_config('app.user_id', …, true)` (escopo da transação, seguro
  com pool). O identificador vem de uma sessão **validada no servidor**
  (Better Auth), nunca diretamente da requisição; as políticas e as funções
  `SECURITY DEFINER` continuam conferindo pertencimento e papel na organização.
- Webhook/worker futuros usarão um contexto de sistema próprio, restrito por
  organização — decisão a detalhar na Entrega 2.
- As tabelas do Better Auth (ids em `uuid`) entram na Entrega 2.

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

- Nomes como `0001_init.sql` também funcionam (a versão é o prefixo numérico);
  a Entrega 2 poderá manter a numeração `0001`–`0005`.
- `up` **falha explicitamente** quando `db/migrations/` não tem nenhum arquivo
  (`no migration files found`); `status` funciona. Isso muda quando houver
  migrations.
- As migrations originais do Supabase continuam intactas em
  `supabase/migrations/` e **não** são lidas por este executor.

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
  `postgres-test` deste projeto (dados em tmpfs).

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

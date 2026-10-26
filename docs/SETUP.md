# Setup — Antero Atendimento

Guia para rodar o projeto localmente: **Next.js 16 + Better Auth + PostgreSQL 17 + pnpm**.
Tempo estimado: ~10 minutos. Tudo roda em containers locais (PostgreSQL e
Mailpit) e em `127.0.0.1`; nenhum serviço remoto é necessário.

Detalhes de cada parte: [`INFRA-LOCAL.md`](INFRA-LOCAL.md) (containers,
papéis, migrations, testes), [`AUTH.md`](AUTH.md) (autenticação),
[`DATABASE.md`](DATABASE.md) (modelo e RLS).

## Pré-requisitos

- Docker com Compose v2
- Node.js 20+ (testado com 24) e **pnpm 11** (versão fixada em
  `packageManager`; habilite com `corepack enable`)

## 1. Instalar dependências

```bash
pnpm install
```

## 2. Preparar as variáveis de desenvolvimento

```bash
pnpm infra:env     # cria .env.infra (senhas aleatórias dos containers; nunca sobrescreve)
pnpm env:local     # cria .env.local a partir de .env.infra
```

`.env.infra` e `.env.local` são ignorados pelo Git (permissão `600`). O
`.env.local` gerado tem só variáveis locais: `APP_DATABASE_URL` (papel
`antero_app`), `AUTH_DATABASE_URL` (papel `antero_auth`), `BETTER_AUTH_URL`
(`http://127.0.0.1:3000`), `BETTER_AUTH_SECRET` (aleatório) e o SMTP do
Mailpit. Se o arquivo já existir, o comando recusa; `pnpm env:local --force`
guarda uma cópia do antigo em `~/backups/antero-atendimentos/` antes de
substituí-lo. Os nomes e o significado de cada variável estão em
`.env.example`.

## 3. Subir os containers e aplicar as migrations

```bash
pnpm infra:up      # PostgreSQL de desenvolvimento (55433) + Mailpit (SMTP 55425, UI 55426)
pnpm db:migrate    # aplica db/migrations/ (única fonte oficial de migrations)
pnpm db:verify     # confere papéis e privilégios
```

## 4. Dados fictícios e usuários

```bash
pnpm db:dev-fixtures   # 2 organizações, 8 usuários, 51 conversas, 370 mensagens (idempotente)
```

O comando imprime as senhas **uma única vez** (anote-as; não são gravadas).
`pnpm db:dev-fixtures --rotate-passwords` gera senhas novas e encerra as
sessões. Contas, vínculos e o que cada uma testa: `docs/INFRA-LOCAL.md`.
Recomendado para começar: `admin.plataforma@ficticio.local` (administrador
da plataforma e da organização "Clínica Aurora").

Não há cadastro público. Para criar uma identidade nova (sem organização):

```bash
pnpm auth:provision dev --email voce@exemplo.local --name "Seu Nome"
```

Para vinculá-la a uma organização e (opcional) torná-la administradora da
plataforma — operação administrativa feita direto no banco, como dono das
tabelas (a RLS impede que a aplicação o faça):

```bash
docker exec -i antero-atendimentos-db psql -U antero_admin -d antero_atendimentos <<'SQL'
-- Substitua o e-mail e o slug da organização.
insert into public.organization_members (organization_id, user_id, role, status)
select o.id, p.id, 'owner', 'active'
from public.organizations o, public.profiles p
where o.slug = 'ficticia-clinica-aurora' and p.email = 'voce@exemplo.local'
on conflict (organization_id, user_id) do update set role = 'owner', status = 'active';

update public.profiles set is_platform_admin = true where email = 'voce@exemplo.local';
SQL
```

> Isto altera o banco **persistente** de desenvolvimento: faça só quando
> decidido. A criação de organizações reais e o bootstrap em produção
> pertencem à entrega de deploy (Coolify).

## 5. Rodar a aplicação

```bash
pnpm dev
```

Acesse **http://127.0.0.1:3000** (use `127.0.0.1`, não `localhost`: o login
confere a origem e `localhost` seria outra origem → 403). O servidor escuta
só em `127.0.0.1`. O Next.js carrega apenas `.env.local`
(a saída mostra `Environments: .env.local`).

Páginas para começar: `/login` → `/visao-geral` → `/conversas` (filtros,
"Carregar mais", histórico) → `/equipe` → `/configuracoes` → `/admin`
(só administrador da plataforma). A Inbox é somente leitura.

E-mails (recuperação de senha) chegam ao Mailpit: http://127.0.0.1:55426.

> `pnpm dev` pode alterar `AGENTS.md` (o Next.js 16 regrava o bloco
> `nextjs-agent-rules`); o conteúdo gerado já está commitado.

## 6. Testes, lint e build

```bash
pnpm test:unit                       # unitários
pnpm db:test:reset && pnpm db:test:migrate   # banco descartável de testes
pnpm db:test:integration             # integração (banco de testes + Mailpit)
pnpm db:test:pgtap                   # políticas RLS e funções (pgTAP)
pnpm app:e2e                         # ponta a ponta contra o servidor Next real
pnpm lint && pnpm typecheck
pnpm check:supabase                  # garante que nada do Supabase voltou
pnpm db:verify && pnpm db:test:verify && pnpm db:auth-schema && pnpm db:test:auth-schema
pnpm app:build                       # build de produção sem rede e sem .env (container)
pnpm build                           # build direto no repositório
```

## 7. Encerrar

```bash
# Ctrl+C no terminal do `pnpm dev`, ou, se foi iniciado em segundo plano:
ss -ltnp 'sport = :3000'             # confira o PID do next-server do Antero
kill <PID>                           # só esse processo

pnpm infra:stop                      # para PostgreSQL e Mailpit SEM apagar dados
```

Nunca use `docker compose down -v`: apagaria o volume do banco de
desenvolvimento.

## Solução de problemas

- **Login responde "Não foi possível validar a requisição"** (403): você abriu
  a aplicação por outro endereço (ex.: `localhost`). Use
  `http://127.0.0.1:3000`, igual a `BETTER_AUTH_URL`.
- **"Muitas tentativas"** (429): o limite é de 5 erros de login por minuto por
  IP; aguarde a janela. Reiniciar o servidor também zera os contadores.
- **"Serviço temporariamente indisponível"**: o PostgreSQL não responde —
  `pnpm infra:status` e `pnpm infra:up`.
- **Variáveis inválidas ao iniciar** (`Configuração da identidade inválida`):
  recrie o arquivo com `pnpm env:local --force` e reinicie.
- **Porta 3000 ocupada**: identifique o dono com `ss -ltnp 'sport = :3000'`
  antes de encerrar qualquer coisa; ou `pnpm dev --port 3100` e ajuste
  `BETTER_AUTH_URL` no `.env.local` para a mesma origem.

## Histórico

O projeto usou o Supabase (Auth e PostgREST) até a Entrega 5B; a migração para
PostgreSQL próprio e Better Auth está descrita em `claude-reports/`. O último
commit que contém o diretório `supabase/` (migrations originais, seed e teste
pgTAP) é `796c6e7`: `git show 796c6e7:supabase/migrations/0001_init.sql`.

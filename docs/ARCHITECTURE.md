# Arquitetura — Antero Atendimento

Monólito modular em Next.js (App Router). Sem microsserviços, sem monorepo.

## Stack

- **Next.js 16** (App Router, React Server Components por padrão)
- **React 19** + React Compiler
- **TypeScript** estrito
- **Tailwind CSS v4** (configuração via `@theme` no CSS)
- **PostgreSQL 17 próprio** — RLS, acesso por `pg` em `src/lib/db` (papel `antero_app`)
- **Better Auth 1.7.12** — identidade e sessões no schema `auth` (`src/lib/identity`, papel `antero_auth`)
- **Zod v4** — validação de entrada no servidor

## Convenções do Next.js 16 (importante)

Esta versão tem mudanças em relação a versões anteriores. Pontos que este
projeto segue:

- **Proxy** substitui o Middleware — arquivo `src/proxy.ts`.
- `params` e `searchParams` são **Promises** (usar `await`).
- Autorização via **DAL** (Data Access Layer) com `cache()` do React.
- Mutações via **Server Actions** (`"use server"`) + `useActionState`.

## Estrutura de pastas

```
src/
  app/
    (auth)/              # login, recuperar-senha, redefinir-senha (formulários → /api/auth)
    api/auth/[...all]/   # handler HTTP do Better Auth
    (platform)/          # área autenticada (sidebar + header)
      visao-geral/  conversas/  contatos/  fluxos/  equipe/
      configuracoes/
    (platform-admin)/admin/  # admin da plataforma (is_platform_admin), sem exigir organização ativa
    sem-organizacao/     # usuário autenticado sem vínculo com organização
    organizacao-suspensa/  # vínculo ativo, mas a organização está suspensa
  components/
    ui/                  # design system (Button, Card, Field, Badge, ...)
    layout/              # Sidebar, Header, UserMenu, navegação
  modules/               # lógica por domínio de negócio
    auth/                # schemas + server actions
    conversations/       # DAL da Inbox (cursor, paginação, mapeadores)
    organizations/  users/  whatsapp/   # consultas SQL por domínio (sql-queries.ts)
  lib/
    db/                  # PostgreSQL próprio: pool antero_app, withUserTransaction e
                         # withOrganizationTransaction
    auth/                # dal.ts (sessão Better Auth + organização ativa via SQL),
                         # route-access.ts (regras do proxy)
    identity/            # Better Auth sobre o PostgreSQL próprio (ver docs/AUTH.md)
    types/               # tipos do banco
    utils/  labels.ts    # helpers e rótulos em pt-BR
  proxy.ts               # proteção otimista de rotas (só o cookie, sem banco)
db/
  migrations/            # SQL versionado (dbmate): única fonte oficial de migrations
  tests/                 # pgTAP (RLS, funções, ingestão)
scripts/                 # infraestrutura local, fixtures, verificações
tests/                   # integração (banco de testes) e ponta a ponta
```

### Por que módulos por domínio (e não repository/service/controller)?

Para cada entidade criamos apenas o que é usado hoje: um arquivo de consultas
(`sql-queries.ts`, leitura) e, quando há escrita, `actions` (Server Actions). Não há camadas
genéricas (repository/service/manager) sem uso real. A estrutura acompanha a
sugestão do escopo, adaptando nomes de rotas para português (`visao-geral`,
`conversas`, ...) por serem visíveis ao usuário.

## Segurança (camadas)

1. **Proxy** (`proxy.ts`): redirecionamento otimista para `/login` sem o
   cookie de sessão (não consulta o banco; não é a defesa principal).
2. **DAL** (`lib/auth/dal.ts`): verifica sessão e resolve a organização ativa
   perto do dado (organização suspensa não conta). Toda página/ação autenticada
   passa por aqui.
3. **RLS no Postgres**: a defesa definitiva. Mesmo que a UI falhe, o banco
   impede acesso cruzado entre organizações. Ver `docs/DATABASE.md`.

Regras: segredos só no servidor (nenhuma variável `NEXT_PUBLIC_` é
necessária); login, logout e senha só pelo handler `/api/auth` (rate limit,
origem/CSRF); `userId` só da sessão validada; não confiar em filtros de
frontend.

## Renderização

- Server Components por padrão (busca de dados próxima à fonte).
- Client Components apenas onde há interação (formulários, menus, navegação
  ativa) — marcados com `"use client"`.
- Mutações preferem **Server Actions**, exceto autenticação: os formulários
  de login/senha usam ações de cliente que chamam o handler do Better Auth
  (uma Server Action com `auth.api` escaparia do rate limit). Route Handlers:
  `/api/auth` e, futuramente, o webhook do WhatsApp.

## Integração com WhatsApp

No Ciclo 1 existe apenas a modelagem (`whatsapp_accounts`) e o provedor de
**desenvolvimento** (simulado). O contrato de provedor e o webhook real
(WhatsApp Cloud API) chegam nos Ciclos 2–4, sem reescrever contatos, conversas
e mensagens.

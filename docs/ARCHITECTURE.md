# Arquitetura — Antero Atendimento

Monólito modular em Next.js (App Router). Sem microsserviços, sem monorepo.

## Stack

- **Next.js 16** (App Router, React Server Components por padrão)
- **React 19** + React Compiler
- **TypeScript** estrito
- **Tailwind CSS v4** (configuração via `@theme` no CSS)
- **Supabase** — PostgreSQL, Auth e RLS (cliente oficial `@supabase/ssr`)
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
    (auth)/              # login, recuperar-senha, redefinir-senha
    (platform)/          # área autenticada (sidebar + header)
      visao-geral/  conversas/  contatos/  fluxos/  equipe/
      configuracoes/  admin/    # admin da plataforma (is_platform_admin)
    auth/confirm/        # route handler: confirma tokens de e-mail
    sem-organizacao/     # usuário autenticado sem organização ativa
  components/
    ui/                  # design system (Button, Card, Field, Badge, ...)
    layout/              # Sidebar, Header, UserMenu, navegação
  modules/               # lógica por domínio de negócio
    auth/                # schemas + server actions
    organizations/  users/  whatsapp/   # queries por domínio
  lib/
    supabase/            # clients browser e server
    auth/                # dal.ts (verificação de sessão + contexto)
    env/                 # validação de variáveis (client/server)
    types/               # tipos do banco
    utils/  labels.ts    # helpers e rótulos em pt-BR
  proxy.ts               # renovação de sessão + proteção otimista de rotas
supabase/
  migrations/            # SQL versionado
  seed.sql               # organização Antero + canal de desenvolvimento
```

### Por que módulos por domínio (e não repository/service/controller)?

Para cada entidade criamos apenas o que é usado hoje: um arquivo de `queries`
(leitura) e, quando há escrita, `actions` (Server Actions). Não há camadas
genéricas (repository/service/manager) sem uso real. A estrutura acompanha a
sugestão do escopo, adaptando nomes de rotas para português (`visao-geral`,
`conversas`, ...) por serem visíveis ao usuário.

## Segurança (camadas)

1. **Proxy** (`proxy.ts`): renova a sessão e faz redirecionamento otimista
   (não é a defesa principal — apenas a primeira barreira).
2. **DAL** (`lib/auth/dal.ts`): verifica sessão e resolve a organização ativa
   perto do dado. Toda página/ação autenticada passa por aqui.
3. **RLS no Postgres**: a defesa definitiva. Mesmo que a UI falhe, o banco
   impede acesso cruzado entre organizações. Ver `docs/DATABASE.md`.

Regras: segredos só no servidor; o navegador usa apenas a chave anônima; nunca
usar `service_role` no cliente; não confiar em filtros de frontend.

## Renderização

- Server Components por padrão (busca de dados próxima à fonte).
- Client Components apenas onde há interação (formulários, menus, navegação
  ativa) — marcados com `"use client"`.
- Mutações preferem **Server Actions**; Route Handlers ficam para casos como o
  callback de confirmação de e-mail e, futuramente, o webhook do WhatsApp.

## Integração com WhatsApp

No Ciclo 1 existe apenas a modelagem (`whatsapp_accounts`) e o provedor de
**desenvolvimento** (simulado). O contrato de provedor e o webhook real
(WhatsApp Cloud API) chegam nos Ciclos 2–4, sem reescrever contatos, conversas
e mensagens.

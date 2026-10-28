# Autenticação própria — Better Auth 1.7.12 (Entregas 5A e 5B)

> **Estado (Entrega 5B):** é a autenticação da aplicação. Login, logout,
> recuperação/redefinição de senha, `proxy.ts` e o DAL
> (`src/lib/auth/dal.ts`) usam o Better Auth sobre o PostgreSQL próprio; as
> páginas leem dados pelas consultas SQL (`modules/*/sql-queries.ts`). O
> Supabase foi removido do projeto na Entrega 6 (código, dependências,
> variáveis e o diretório `supabase/`); `pnpm check:supabase` impede o
> retorno.

**Divisão de responsabilidades:** o Better Auth responde **quem** é o
usuário (sessão validada → UUID). **O que** ele acessa continua decidido por
`organization_members` + RLS (`withOrganizationTransaction`). Estar
autenticado não concede organização nenhuma (testado).

## Arquivos (`src/lib/identity/`)

| Arquivo | Papel |
| --- | --- |
| `config.ts` | `parseIdentityConfig(env)`: valida as variáveis abaixo, sem ecoar segredos |
| `pool.ts` | pool `antero_auth` (papel conferido a cada conexão nova), separado do pool `antero_app` |
| `options.ts` | `buildIdentityAuthOptions`: opções do Better Auth sobre `betterAuthSchemaOptions` (fonte única com a migration `0000`) |
| `auth.ts` | `getIdentityAuth()` (instância única em `globalThis`), `createIdentityAuth`, `closeIdentity()` |
| `constants.ts` | caminho `/api/auth`, nomes do cookie, página de redefinição, limites de senha (sem dependências: proxy e navegador usam) |
| `handler.ts` | `handleIdentityRequest(Request)`, montado em `app/api/auth/[...all]/route.ts` (exceção ou 5xx → 503 neutro) |
| `session.ts` | `getValidatedSession(headers)` (usado pelo DAL) e `signOutSession(headers)` |
| `client.ts` | cliente HTTP oficial do Better Auth para o navegador (`better-auth/client`) |
| `mailer.ts` | SMTP (`nodemailer`) e o e-mail de redefinição em pt-BR |
| `provision.ts` | provisionamento LOCAL de identidades fictícias (só scripts/testes) |

Dependências novas (versões fixas): `kysely` 0.29.7 (a mesma que o Better
Auth já resolvia; o adapter precisa dela para usar `schemaName`),
`nodemailer` 10.1.0 e `@types/nodemailer` 8.0.2.

## Configuração (só servidor)

| Variável | Padrão | Regra |
| --- | --- | --- |
| `AUTH_DATABASE_URL` | — | `postgres://antero_auth:<senha>@host:porta/banco[?sslmode=…]`; outro papel ou parâmetros → recusado |
| `AUTH_DATABASE_POOL_MAX` | 5 (1–20) | conexões por processo |
| `AUTH_DATABASE_CONNECT_TIMEOUT_MS` / `_IDLE_TIMEOUT_MS` / `_STATEMENT_TIMEOUT_MS` | 5000 / 30000 / 10000 | `idle_in_transaction_session_timeout` fixo em 60 s |
| `BETTER_AUTH_SECRET` | — | ≥ 32 caracteres, não trivial (`openssl rand -base64 32`); assina os cookies |
| `BETTER_AUTH_URL` | — | só a origem; `https` (http só em localhost fora de produção) |
| `AUTH_TRUSTED_PROXIES` | — | IP/CIDR do proxy reverso; **obrigatória em produção** (ver rate limit) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | porta 587 | usuário e senha juntos; em produção sem `SMTP_SECURE` exige STARTTLS |

## Decisões de configuração

- **Banco:** adapter Kysely com `schemaName: "auth"` e `transaction: true`
  (o padrão é `false` no formato `dialect`; sem ele a redefinição de senha —
  consumir token, revogar sessões e gravar o hash — não seria atômica).
  Tipos padrão do `pg` (`Date`): os parsers de string ISO são só do pool da
  aplicação. O schema confere com a versão instalada: `pnpm db:auth-schema`
  e um teste de integração rodam o planejador oficial com as opções **reais**
  de runtime e exigem "nada a gerar".
- **IDs:** `uuid` (`generateId: "uuid"`), iguais a `profiles.id`,
  `organization_members.user_id` etc.
- **Cadastro público desligado:** `disableSignUp` + rota `/sign-up/email`
  em `disabledPaths` (404). Também desligadas: login social, `update-user`,
  `change-email`, `delete-user`, vínculo de contas, verificação de e-mail,
  `update-session`. Perfil (nome) é dado de negócio em `public.profiles`.
- **Sessão:** persistida em `auth.sessions`, 7 dias, renovada a cada 24 h de
  uso, **sem cookie cache** — logout e revogação valem na próxima requisição.
- **Cookie:** `antero.session_token` (`__Secure-antero.session_token` em
  https), `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` em https; valor
  assinado com HMAC (`token.assinatura`).
- **Origem/CSRF:** `disableOriginCheck: false` e `disableCSRFCheck: false`
  **explícitos** — com `NODE_ENV=test` o Better Auth 1.7.12 desliga a
  checagem de origem por padrão (e, junto, a de CSRF e a validação de
  `callbackURL`/`redirectTo`). `trustedOrigins` = só a origem de
  `BETTER_AUTH_URL`.
- **Senha:** mínimo 8 (como o fluxo atual), máximo 128; hash `scrypt` da
  biblioteca.
- **Logs:** nível `warn`, mensagens redigidas (tokens, `callbackURL`,
  e-mails) e, de erros, só nome/código. Telemetria desligada.

## Como a aplicação usa (Entrega 5B)

| Camada | Arquivo | O que faz |
| --- | --- | --- |
| Rota | `src/app/api/auth/[...all]/route.ts` | `GET`/`POST` → `handleIdentityRequest` |
| Formulários | `src/modules/auth/browser-actions.ts` + páginas `(auth)` | ações de **cliente** (`useActionState`) que validam com os schemas de antes e chamam o handler pelo cliente oficial; mensagens em `modules/auth/messages.ts` |
| Logout | `UserMenu` e `SignOutForm` | `POST /api/auth/sign-out` e recarga completa em `/login` |
| Proxy | `src/proxy.ts` + `lib/auth/route-access.ts` | otimista: sem cookie `antero.session_token` com formato de token → `/login`; **sem banco** |
| DAL | `src/lib/auth/dal.ts` | `getValidatedSession(await headers())` → `getActiveContext({ userId })` (SQL) → `{ userId, organizationId }` para as consultas |

**Por que não há Server Action de login:** `auth.api.signInEmail` no servidor
não passa pelo rate limit nem pela checagem de origem do handler (testado na
5A). Os formulários usam o cliente HTTP oficial (`better-auth/client`), com a
mesma interface, campos, validações e estados de carregamento. Garantias:

- lint (`eslint.config.mjs`): fora de `src/lib/identity`, só `handler`,
  `session`, `client`, `constants` e `errors` podem ser importados — nada que
  exponha `auth.api`;
- teste de integração varre `src/` e falha se aparecer `auth.api`,
  `getIdentityAuth`, `signInEmail` ou `"use server"` fora de `lib/identity`;
- o rate limit foi exercitado pela rota montada (integração), pelo servidor
  Next real (E2E) e pelo formulário no navegador.

**Redirecionamentos:** destinos fixos no código (`/visao-geral` depois do
login, `/login?aviso=senha-redefinida` depois da troca, `/login` depois do
logout); nenhum parâmetro de URL escolhe destino. O aviso do login aceita só
valores conhecidos. O antigo `/auth/confirm` (Supabase, com redirecionamento
aberto para `//host`) foi removido. `redirectTo` da recuperação é relativo e
fixo (`/redefinir-senha`); o handler recusa (403) destinos externos.

**Usuário logado em `/login`/`/recuperar-senha`:** a página valida a sessão
no banco e redireciona. O proxy não faz isso só pelo cookie: um cookie
revogado criaria um ciclo `/login ↔ /visao-geral`.

**Organização ativa:** regra preservada — vínculo `active` mais antigo
(`created_at`, desempate por `id`). Desativado, convite ou sem vínculo →
`/sem-organizacao`. Não há seletor; URL, cookie e corpo não escolhem a
empresa. Toda consulta usa `withOrganizationTransaction` (vínculo ativo
conferido na mesma transação + RLS + filtro explícito). `/admin` exige
`profiles.is_platform_admin` no DAL e de novo no banco
(`listAllOrganizations`). O status da organização (`inactive`) não bloqueia
o acesso, como antes.

**Erros:** identidade/banco indisponível → `app/error.tsx` ("Serviço
temporariamente indisponível", botão que refaz a requisição) ou mensagem do
formulário; o handler devolve 503 neutro. Sessão expirada/revogada →
`/login`. Conversa inexistente ou de outra empresa → "Conversa não
encontrada". Nenhum fallback para o Supabase.

## Fluxos (validados com o handler real e cookies)

- **Login** `POST /api/auth/sign-in/email` → 200 + cookie; senha errada e
  e-mail inexistente → mesmo 401 `INVALID_EMAIL_OR_PASSWORD` (a biblioteca
  calcula um hash fictício para igualar o tempo); e-mail normalizado.
- **Sessão** `getValidatedSession(headers)`: sem cookie, adulterado, de outro
  segredo, expirado ou revogado → `null`; banco fora → `IdentityUnavailableError`.
- **Logout** `POST /api/auth/sign-out` (ou `signOutSession`): apaga a linha e
  limpa o cookie; o cookie antigo deixa de valer. Sessões simultâneas são
  independentes; `/revoke-session`, `/revoke-sessions` e
  `/revoke-other-sessions` só alcançam as do próprio usuário.
- **Recuperação** `POST /api/auth/request-password-reset { email, redirectTo:
  "/redefinir-senha" }` → resposta neutra igual para qualquer e-mail; o envio
  SMTP não bloqueia a resposta. O e-mail traz
  `<origem>/api/auth/reset-password/<token>?callbackURL=/redefinir-senha`
  (token de 24 caracteres, 1 hora, uso único). O link redireciona para
  `/redefinir-senha?token=…` (ou `?error=INVALID_TOKEN`); a página posta
  `POST /api/auth/reset-password { token, newPassword }`. Depois da troca, a
  senha antiga falha e **todas as sessões da conta são revogadas**.
- **Redirecionamentos:** `redirectTo`/`callbackURL` só relativos seguros ou da
  própria origem; `//host`, `https://outro`, `javascript:`, `data:`, `/\host`
  e separadores codificados → 403, sem e-mail.

## Rate limit

Better Auth 1.7.12, **memória do processo**, por IP + rota (testado):

| Rota | Limite |
| --- | --- |
| `/sign-in/email` | 5 por 60 s |
| `/request-password-reset` | 3 por 300 s |
| `/reset-password`, `/change-password` | 5 por 300 s |
| demais | 100 por 60 s |

- Aceitável enquanto houver **uma única instância**: os contadores somem em
  reinício/deploy e não são compartilhados. **Antes de múltiplas instâncias**
  é preciso armazenamento compartilhado (`rateLimit.storage = "database"`
  exige migration de `rate_limit` + `betterAuthSchemaOptions`; ou
  `secondaryStorage`) e limites coerentes entre réplicas.
- O IP vem de `X-Forwarded-For`. Sem `AUTH_TRUSTED_PROXIES`, uma cadeia com
  vários saltos não é aceita como IP do cliente e todos caem num balde
  único — 5 erros por minuto bloqueariam o login de todos. Por isso a
  variável é obrigatória em produção (Coolify/Traefik: a rede do proxy).
- **O Next.js 16 só preenche `X-Forwarded-For` quando ele NÃO vem na
  requisição** (`base-server`: `??=` com o IP do socket). Com a aplicação
  exposta diretamente, um cliente pode mandar um `X-Forwarded-For` diferente
  a cada tentativa e escapar do limite por IP (verificado com `curl` no
  ambiente local). Em produção, a aplicação deve ser acessível **só** pelo
  proxy reverso, e ele deve **sobrescrever** o cabeçalho com o IP real
  (Traefik faz isso para clientes fora de `forwardedHeaders.trustedIPs`).
  Pendência de configuração do Coolify; ver "Pendências". **Entrega 7A:**
  confirmado com o Traefik 3.6 real em homologação local (pelo proxy: 5 erros
  e 429 mesmo variando o cabeçalho; direto na aplicação: sem limite) — ver
  `docs/DEPLOY.md` ("Proxy e X-Forwarded-For"), que também analisa defesas
  adicionais. A rede real do Coolify segue por testar (Entrega 7B).
- O limite vale para requisições HTTP (`handler`). **Chamadas
  `auth.api.*` no servidor não passam por ele** (testado): por isso a
  aplicação faz login, logout e redefinição só pelo handler
  (`/api/auth/*`), a partir do navegador.
- É por IP, não por conta: não há bloqueio de conta após N falhas (decisão
  pendente; ver "Pendências").

## Provisionamento local (sem cadastro público)

```bash
pnpm auth:provision test --email maria@exemplo.local --name "Maria Teste"
pnpm auth:provision test --email maria@exemplo.local --rotate-password
```

- Uma instância **privada** do Better Auth (nunca montada em HTTP) executa o
  fluxo oficial de cadastro (`auth.api.signUpEmail`: mesma transação, e-mail
  normalizado, hash da biblioteca, `autoSignIn: false`); o perfil nasce pelo
  gatilho `handle_new_user`; o e-mail fica como verificado.
- Recusa produção, banco fora de loopback e `BETTER_AUTH_URL` não local. O
  `infra.mjs` monta o ambiente (antero_auth do alvo, `localhost:3000`,
  segredo aleatório, Mailpit) e descarta `BETTER_AUTH_*`/`SMTP_*` herdados.
- Repetível por e-mail (não duplica). `--rotate-password` define nova senha e
  encerra as sessões. A senha gerada aparece **uma vez** na saída e não é
  gravada; nada vai para o Git.
- Não vincula organizações nem mexe em `is_platform_admin` (`antero_auth` não
  tem acesso a `public`). Vínculos: as fixtures de teste usam o dono das
  tabelas no banco descartável; no desenvolvimento, quando houver
  organizações, por SQL consciente ou pela futura gestão de membros.
- `dev` é aceito pelo script, mas **criar identidades no banco de
  desenvolvimento altera dados persistentes**: faça só quando decidido.
- Para validar a aplicação no navegador há um conjunto pronto, idempotente e
  fictício: `pnpm db:dev-fixtures` (ver `docs/INFRA-LOCAL.md`).

## Testes

- `pnpm db:test:integration 'identity-*'` (52) e `'app-*'` (5: rota real,
  5xx → 503, perfil, loaders, varredura de `auth.api`);
- `pnpm test:unit`: `config.test.ts`, `route-access.test.ts` (proxy),
  `messages.test.ts` (mensagens e aviso do login);
- `pnpm app:e2e` (9): servidor Next real isolado sobre o banco de testes —
  proxy, login/cookies, Inbox por organização, papéis, rate limit, cookie
  adulterado, sessão revogada, logout, recuperação pelo Mailpit.

Ver `docs/INFRA-LOCAL.md` (aplicação isolada e fixtures de desenvolvimento).

## Supabase removido (Entrega 6)

Removidos: os dois pacotes do SDK do Supabase (cliente e SSR), o cliente
em `src/lib/` e `src/lib/env` (só validava as variáveis públicas do Supabase),
os `modules/*/queries.ts` (PostgREST) e o diretório `supabase/`. Barreiras:
a regra de lint (`eslint.config.mjs`) e `pnpm check:supabase`
(`scripts/check-no-supabase.mjs`, também no `pnpm test:unit`), que falham
se voltarem pacotes, imports, variáveis, URLs, comandos da CLI, o diretório
ou variáveis `SUPABASE_*` em algum `.env*` local. Menções históricas
(relatórios, comentários das migrations portadas) não falham. Os arquivos
originais estão no Git: `git show 796c6e7:supabase/migrations/…`.

## Pendências

1. **Supabase remoto (produção atual):** o projeto remoto não foi tocado e
   continua com a falha de autopromoção a `is_platform_admin` (ver
   `docs/DATABASE.md`); decidir seu destino (migração de dados, desligamento).
2. **Regras de membros herdadas:** `admin` pode criar/alterar/remover `owner`
   (ver `docs/DATABASE.md`); decidir a política antes de gerir membros.
3. **Bloqueio por conta:** o limite é por IP; avaliar bloqueio progressivo
   por conta (ou atraso) antes da exposição pública. Análise e recomendação em
   `docs/DEPLOY.md` ("Rate limiting"): decidir antes de abrir a usuários reais.
4. **Várias instâncias:** rate limit em memória; precisa de armazenamento
   compartilhado antes de escalar horizontalmente.
5. **`AUTH_TRUSTED_PROXIES` e topologia do Coolify:** configurar com a rede
   real do Traefik e garantir que a aplicação só receba tráfego pelo proxy,
   que sobrescreve `X-Forwarded-For` (senão o limite por IP é contornável).
   Condições e testes: `docs/DEPLOY.md` (7A); verificação no Coolify real: 7B.
6. **Contas do Supabase:** senhas não migram; migrar identidades
   (`auth.users`/perfis/vínculos) e exigir redefinição de senha.
7. **Campanhas e WhatsApp:** módulo posterior.
8. **Pedido de redefinição sem cookie aceita outra origem** (o Better Auth só
   confere origem com cookie ou no login): resposta neutra e limitada por IP,
   o mesmo que chamar o endpoint diretamente; registrado, sem ação.
9. **Sessão de 7 dias** (renovada a cada 24 h de uso): confirmar com o produto.

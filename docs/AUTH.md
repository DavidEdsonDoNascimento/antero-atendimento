# Autenticação própria — Better Auth 1.7.12 (Entrega 5A)

> **Estado:** implementada e testada, **ainda não ligada à aplicação**. Login,
> logout, recuperação de senha, `proxy.ts` e o DAL (`src/lib/auth/dal.ts`)
> continuam no Supabase até a Entrega 5B. Uma regra de lint impede importar
> `src/lib/identity` em qualquer outro ponto de `src/`.

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
| `handler.ts` | `handleIdentityRequest(Request)`: o handler que a 5B monta em `app/api/auth/[...all]` (erro inesperado → 503 neutro) |
| `session.ts` | `getValidatedSession(headers)` e `signOutSession(headers)` para o DAL da 5B |
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
- O limite vale para requisições HTTP (`handler`). **Chamadas
  `auth.api.*` no servidor não passam por ele** (testado): na 5B o login deve
  ir pelo handler (`/api/auth/sign-in/email`) ou aplicar o limite antes de
  `auth.api.signInEmail` numa Server Action.
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

## Testes

`pnpm db:test:integration 'identity-*'` (banco descartável + Mailpit; 52
testes) e `pnpm test:unit` (`config.test.ts`: 8). Ver `docs/INFRA-LOCAL.md`.

## Ativação na Entrega 5B (roteiro)

1. Variáveis de identidade no ambiente local de desenvolvimento (não no
   `.env.local` atual sem decisão) e `pnpm auth:provision dev` para as contas.
2. `app/api/auth/[...all]/route.ts`: `GET`/`POST` →
   `handleIdentityRequest(request)`.
3. Novo DAL (`lib/auth/dal.ts`): `getValidatedSession(await headers())` →
   `/login` se `null`; `getActiveContext({ userId })`
   (`modules/organizations/sql-queries`) → `/sem-organizacao` se `null`;
   `requirePlatformAdmin` via `profile.is_platform_admin`; `cache()` como hoje.
4. Login/logout/recuperação (`modules/auth/actions.ts` e páginas): postar para
   o handler (rate limit) ou aplicar o limite antes de `auth.api.*`; página
   `/redefinir-senha` lê `?token=`/`?error=` e posta `reset-password`.
5. `proxy.ts`: checagem otimista pelo cookie `antero.session_token` (sem
   banco); a validação real continua no DAL.
6. Trocar `modules/*/queries` por `sql-queries` com `{ userId, organizationId }`
   do DAL; remover as regras de lint de `sql-queries` e `lib/identity`
   (mantendo `provision.ts` fora do app).
7. Migrar contas do Supabase (sem senhas: redefinição obrigatória no primeiro
   acesso) e só então remover `@supabase/*`, `lib/supabase` e `queries.ts`.
8. Validar: suíte completa, roteiro manual (login, erro, logout, recuperação
   pelo Mailpit, Inbox por organização), build isolado (após `next/font/local`).

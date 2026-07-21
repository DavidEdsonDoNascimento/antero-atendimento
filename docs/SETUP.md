# Setup — Antero Atendimento

Guia para colocar o projeto rodando localmente. Tempo estimado: ~15 minutos.

## Pré-requisitos

- Node.js 20+
- npm
- Uma conta no [Supabase](https://supabase.com) (plano gratuito serve)

## 1. Instalar dependências

```bash
npm install
```

## 2. Criar o projeto Supabase

1. Acesse o dashboard do Supabase e crie um novo projeto.
2. Guarde a senha do banco (necessária apenas se usar o CLI).
3. Em **Project Settings > API**, copie:
   - **Project URL**
   - **anon public** key

## 3. Configurar variáveis de ambiente

```bash
cp .env.example .env.local
```

Preencha `.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=https://xxxxxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_...
```

A chave anônima pode vir em dois formatos, ambos aceitos: a JWT legada
(`eyJ...`) ou a nova chave publicável (`sb_publishable_...`). Use a que o seu
projeto exibir em **Project Settings > API**.

A aplicação valida as variáveis no início (via Zod). Se algo estiver faltando,
você verá um erro claro.

> **Windows:** salve o `.env.local` com quebras de linha **LF**, não CRLF. O
> Next remove o `\r` ao carregar, então não afeta a aplicação — mas scripts que
> leem o arquivo cru podem herdar um `\r` no fim dos valores.

## 4. Aplicar o schema (migrations + seed)

Escolha **uma** das opções.

### Opção A — SQL Editor (sem CLI, recomendada para começar)

No dashboard, abra **SQL Editor** e execute, nesta ordem, o conteúdo de:

1. `supabase/migrations/0001_init.sql`
2. `supabase/migrations/0002_rls.sql`
3. `supabase/seed.sql`

### Opção B — Supabase CLI

```bash
npx supabase login
npx supabase link --project-ref <ref-do-projeto>
npx supabase db push          # aplica as migrations
# rode o seed:
npx supabase db execute --file supabase/seed.sql
```

Ao final, você terá as tabelas `profiles`, `organizations`,
`organization_members`, `whatsapp_accounts`, com RLS habilitado, e a
organização **Antero Sistemas** (slug `antero`) cadastrada.

## 5. Criar o primeiro usuário e vinculá-lo à Antero

Não há cadastro público (signup): usuários são adicionados de forma
administrativa.

**5.1.** No dashboard, vá em **Authentication > Users > Add user** e crie um
usuário com e-mail e senha. Marque a opção para confirmar o e-mail
automaticamente (ou confirme depois).

**5.2.** No **SQL Editor**, rode o bootstrap abaixo (substitua o e-mail). Ele
garante o perfil, vincula o usuário à Antero como **proprietário** e o marca
como **administrador da plataforma**:

```sql
-- Substitua pelo e-mail do usuário criado no passo 5.1
-- 1) Garante o profile (normalmente já criado pelo gatilho)
insert into public.profiles (id, email, full_name)
select id, email,
       coalesce(raw_user_meta_data ->> 'full_name', split_part(email, '@', 1))
from auth.users
where email = 'voce@antero.com.br'
on conflict (id) do nothing;

-- 2) Vincula como proprietário da Antero
insert into public.organization_members (organization_id, user_id, role, status)
select o.id, u.id, 'owner', 'active'
from public.organizations o, auth.users u
where o.slug = 'antero' and u.email = 'voce@antero.com.br'
on conflict (organization_id, user_id)
do update set role = 'owner', status = 'active';

-- 3) (Opcional) Torna-o administrador da plataforma Antero
update public.profiles
set is_platform_admin = true
where id = (select id from auth.users where email = 'voce@antero.com.br');
```

> O SQL Editor roda como superusuário e ignora o RLS — por isso o vínculo
> inicial é feito por aqui, e não pela aplicação.

## 6. Rodar a aplicação

```bash
npm run dev
```

Acesse http://localhost:3000, faça login com o usuário criado e você cairá na
**Visão geral**.

## 7. (Opcional) Recuperação de senha

O app usa o fluxo **server-side (`token_hash`)** do Supabase: o link do e-mail
aponta para `/auth/confirm`, que valida o token via cookie e redireciona. Por
padrão o Supabase envia o fluxo implícito (token no fragmento `#`, caindo em
`/login`), que o app **não** processa. São dois ajustes no dashboard:

**7.1. Authentication > URL Configuration**

- **Site URL:** `http://localhost:3000`
- **Redirect URLs:** adicione `http://localhost:3000/**`

**7.2. Authentication > Emails** — edite os templates trocando o link
`{{ .ConfirmationURL }}` (padrão) por uma URL que aponte para `/auth/confirm`:

| Template | `type` | `next` |
| --- | --- | --- |
| Reset Password | `recovery` | `/redefinir-senha` |
| Confirm signup | `signup` | `/visao-geral` |
| Magic Link | `magiclink` | `/visao-geral` |

Exemplo para **Reset Password**:

```html
<a href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/redefinir-senha">
  Redefinir senha
</a>
```

O link do e-mail passa a ser
`…/auth/confirm?token_hash=…&type=recovery&next=/redefinir-senha` →
`src/app/auth/confirm/route.ts` chama `verifyOtp`, estabelece a sessão e
redireciona para `/redefinir-senha`, onde a nova senha é salva.

> O botão **Reset password** da lista de usuários e o formulário
> `/recuperar-senha` do app usam esse mesmo template. Enquanto ele estiver no
> padrão, ambos falham.

## Solução de problemas

### "E-mail ou senha inválidos" com um usuário que existe e está confirmado

O login (`src/modules/auth/actions.ts`) registra o erro real do Supabase no
terminal (`[auth.login] …`) — comece por aí. Se o `code` for
`invalid_credentials`, o e-mail está certo mas a **senha não confere**. Causas
comuns:

- O usuário foi criado por **convite** (Add user > *Send invitation*), que **não
  define senha** — só magic link.
- A senha digitada difere da cadastrada.

Para definir a senha direto no banco, sem depender de e-mail, rode no **SQL
Editor** (substitua o e-mail e a senha):

```sql
update auth.users
set encrypted_password = crypt('SuaNovaSenha123', gen_salt('bf', 10)),
    updated_at = now()
where email = 'voce@antero.com.br';
```

> Se `crypt`/`gen_salt` não forem encontrados, prefixe com o schema:
> `extensions.crypt(...)` e `extensions.gen_salt('bf', 10)`.

### O link de recuperação abre em `/login#access_token=...`

O template de e-mail ainda está no padrão (fluxo implícito). Aplique a
configuração da **seção 7.2**.

## Scripts úteis

```bash
npm run dev        # ambiente de desenvolvimento
npm run build      # build de produção (inclui type-check)
npm run lint       # ESLint
npm run typecheck  # TypeScript sem emitir
```

This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

Ambiente local (PostgreSQL próprio + Better Auth + Mailpit; detalhes em
`docs/INFRA-LOCAL.md` e `docs/AUTH.md`):

```bash
pnpm install
pnpm infra:env && pnpm env:local     # .env.infra e .env.local (locais, fora do Git)
pnpm infra:up && pnpm db:migrate     # PostgreSQL + Mailpit e schema
pnpm db:dev-fixtures                 # dados fictícios (opcional)
pnpm dev                             # http://127.0.0.1:3000
```

Guia completo: `docs/SETUP.md`. Imagem Docker de produção, migrations,
health checks e preparação para o Coolify: `docs/DEPLOY.md`.

Este projeto usa **pnpm** (versão fixada em `packageManager` no `package.json`) como único gerenciador de pacotes. Habilite-o com `corepack enable`, se necessário.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

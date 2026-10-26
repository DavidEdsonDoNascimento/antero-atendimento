import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Acesso ao PostgreSQL só pela camada `@/lib/db` (withUserTransaction +
// contexto de RLS). Importar `pg` ou os arquivos internos da camada
// permitiria consultas fora de uma transação com usuário.
const restrictedPg = { name: "pg", message: "Use `@/lib/db` (withUserTransaction), não o `pg` direto." };

const dbInternals = {
  group: ["@/lib/db/*", "**/lib/db/*"],
  message: "Importe apenas de `@/lib/db`; os arquivos internos não são API pública.",
};

// Identidade (Better Auth): a aplicação só usa o handler HTTP (rota
// /api/auth), a sessão validada (DAL), o cliente do navegador e as
// constantes/erros. A instância (`auth.ts`), as opções, o pool e o
// provisionamento ficam fora do alcance: `auth.api.signInEmail` numa Server
// Action escaparia do rate limit e da checagem de origem do handler.
const identityInternals = {
  group: [
    "@/lib/identity/*",
    "!@/lib/identity/handler",
    "!@/lib/identity/session",
    "!@/lib/identity/client",
    "!@/lib/identity/constants",
    "!@/lib/identity/errors",
    "**/lib/identity/auth*",
    "**/lib/identity/options*",
    "**/lib/identity/pool*",
    "**/lib/identity/config*",
    "**/lib/identity/mailer*",
    "**/lib/identity/provision*",
  ],
  message:
    "Use só handler/session/client/constants/errors de `@/lib/identity`: login e senha passam pelo handler HTTP (rate limit e CSRF).",
};

// Supabase foi removido (Entrega 6): nenhum pacote, cliente ou PostgREST pode
// voltar. `pnpm check:supabase` varre o repositório inteiro.
const noSupabase = {
  group: ["@supabase/*", "**/lib/supabase", "**/lib/supabase/*", "@/modules/*/queries", "**/modules/*/queries"],
  message: "Supabase foi removido: use `modules/*/sql-queries` e `@/lib/identity`.",
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}"],
    ignores: ["src/lib/db/**", "src/lib/identity/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [restrictedPg], patterns: [dbInternals, identityInternals, noSupabase] },
      ],
    },
  },
  // A identidade tem pool próprio (`antero_auth`, sem acesso a dados de
  // negócio) e por isso usa `pg`; não usa o legado nem a camada de dados.
  {
    files: ["src/lib/identity/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [dbInternals, noSupabase] }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

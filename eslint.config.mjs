import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Acesso ao PostgreSQL só pela camada `@/lib/db` (withUserTransaction +
// contexto de RLS). Importar `pg` ou os arquivos internos da camada
// permitiria consultas fora de uma transação com usuário.
const restrictedPg = { name: "pg", message: "Use `@/lib/db` (withUserTransaction), não o `pg` direto." };

const restrictedPatterns = [
  {
    group: ["@/lib/db/*", "**/lib/db/*"],
    message: "Importe apenas de `@/lib/db`; os arquivos internos não são API pública.",
  },
  // Entrega 4: as consultas SQL paralelas ainda não podem ser ligadas a
  // rotas, actions ou ao DAL. A Entrega 5B remove esta restrição ao trocar
  // `queries.ts` por `sql-queries.ts`.
  {
    group: ["**/sql-queries", "**/sql-queries.ts"],
    message: "Camada SQL paralela (Entrega 4): só será ativada na Entrega 5, junto com o Better Auth.",
  },
  // Entrega 5A: o Better Auth (src/lib/identity) existe e é testado, mas
  // ainda não pode ser ligado a rotas, actions, proxy ou DAL. A Entrega 5B
  // libera os módulos públicos (auth/handler/session); o provisionamento local
  // (provision.ts) continua só para scripts e testes.
  {
    group: ["@/lib/identity", "@/lib/identity/*", "**/lib/identity", "**/lib/identity/*"],
    message: "Better Auth (Entrega 5A) ainda não é usado pela aplicação: a ativação é a Entrega 5B.",
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}"],
    ignores: ["src/lib/db/**", "src/lib/identity/**"],
    rules: {
      "no-restricted-imports": ["error", { paths: [restrictedPg], patterns: restrictedPatterns }],
    },
  },
  // A identidade tem pool próprio (`antero_auth`, sem acesso a dados de
  // negócio) e por isso usa `pg`; as demais restrições continuam valendo.
  {
    files: ["src/lib/identity/**/*.{ts,tsx,js,jsx,mjs}"],
    rules: {
      "no-restricted-imports": ["error", { patterns: restrictedPatterns }],
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

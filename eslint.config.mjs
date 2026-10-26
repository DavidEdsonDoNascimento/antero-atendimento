import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Acesso ao PostgreSQL só pela camada `@/lib/db` (withUserTransaction +
  // contexto de RLS). Importar `pg` ou os arquivos internos da camada
  // permitiria consultas fora de uma transação com usuário.
  {
    files: ["src/**/*.{ts,tsx,js,jsx,mjs}"],
    ignores: ["src/lib/db/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "pg", message: "Use `@/lib/db` (withUserTransaction), não o `pg` direto." }],
          patterns: [
            {
              group: ["@/lib/db/*", "**/lib/db/*"],
              message: "Importe apenas de `@/lib/db`; os arquivos internos não são API pública.",
            },
            // Entrega 4: as consultas SQL paralelas ainda não podem ser
            // ligadas a rotas, actions ou ao DAL. A Entrega 5 remove esta
            // restrição ao trocar `queries.ts` por `sql-queries.ts`.
            {
              group: ["**/sql-queries", "**/sql-queries.ts"],
              message: "Camada SQL paralela (Entrega 4): só será ativada na Entrega 5, junto com o Better Auth.",
            },
          ],
        },
      ],
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

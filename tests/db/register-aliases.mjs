/**
 * Resolve o alias `@/` (tsconfig.json → `src/`) para os testes de integração
 * rodarem os módulos reais da aplicação com `node --test`, sem bundler e sem
 * dependência nova: hook síncrono de resolução de módulos (`node:module`,
 * API pública). Carregado por `pnpm db:test:integration` via `--import`.
 */
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

const SRC = new URL("../../src/", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      const base = new URL(specifier.slice(2), SRC);
      for (const candidate of [`${base.href}.ts`, `${base.href}/index.ts`, base.href]) {
        if (existsSync(fileURLToPath(candidate))) return nextResolve(candidate, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

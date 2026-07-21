import "server-only";

import { z } from "zod";

import { clientEnv } from "./client";

/**
 * Variáveis de ambiente disponíveis apenas no servidor.
 *
 * O `import "server-only"` garante, em tempo de build, que este módulo nunca
 * seja incluído em um bundle do cliente. Segredos vivem exclusivamente aqui.
 */
const serverEnvSchema = z.object({
  // Opcional: usada apenas por scripts administrativos executados no servidor
  // (ex.: cadastro em massa de organizações). Nunca é lida no caminho de
  // requisição da aplicação e nunca é exposta ao navegador.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
});

const parsed = serverEnvSchema.safeParse({
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `- ${i.message}`).join("\n");
  throw new Error(`Variáveis de ambiente do servidor inválidas:\n${issues}`);
}

export const serverEnv = { ...clientEnv, ...parsed.data };

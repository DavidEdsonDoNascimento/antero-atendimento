import { z } from "zod";

/**
 * Variáveis de ambiente expostas ao navegador.
 *
 * Apenas variáveis com prefixo `NEXT_PUBLIC_` podem existir aqui — o Next.js
 * substitui as demais por string vazia no bundle do cliente. Nada sensível
 * (service role, segredos) deve ser adicionado a este arquivo.
 *
 * As chaves são referenciadas estaticamente porque o Next só faz a substituição
 * de `process.env.NEXT_PUBLIC_*` quando o acesso é literal.
 */
const clientEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url({
    error: "NEXT_PUBLIC_SUPABASE_URL deve ser uma URL válida do projeto Supabase.",
  }),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, {
    error: "NEXT_PUBLIC_SUPABASE_ANON_KEY é obrigatória.",
  }),
});

const parsed = clientEnvSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
});

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `- ${i.message}`).join("\n");
  throw new Error(
    `Variáveis de ambiente inválidas. Verifique seu .env.local (veja .env.example):\n${issues}`,
  );
}

export const clientEnv = parsed.data;

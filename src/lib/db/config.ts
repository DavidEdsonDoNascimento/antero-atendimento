import { z } from "zod";

// Extensão .ts explícita: importação de VALOR, para o ESM nativo do Node
// resolver nos testes (ver nota em modules/conversations/cursor.ts).
import { DatabaseConfigError } from "./errors.ts";

// Lógica pura (parsing/validação, sem I/O) — sem `import "server-only"` para
// ser testável com `node --test`. Quem lê `process.env` e abre conexões é
// `pool.ts`, que é server-only.

/** Único papel com que a aplicação pode conectar (sujeito à RLS). */
export const APP_DATABASE_ROLE = "antero_app";

/**
 * Configuração do pool da aplicação, lida SÓ de variáveis de ambiente do
 * servidor (nunca `NEXT_PUBLIC_*`):
 *
 *   APP_DATABASE_URL                    postgres://antero_app:<senha>@host:porta/banco[?sslmode=…]
 *   APP_DATABASE_POOL_MAX               conexões simultâneas (1–50, padrão 10)
 *   APP_DATABASE_CONNECT_TIMEOUT_MS     espera por conexão (padrão 5000)
 *   APP_DATABASE_IDLE_TIMEOUT_MS        fecha conexão ociosa após (padrão 30000)
 *   APP_DATABASE_STATEMENT_TIMEOUT_MS   limite por comando no servidor (padrão 15000)
 */
export type AppDatabaseConfig = {
  connectionString: string;
  host: string;
  port: number;
  database: string;
  poolMax: number;
  connectTimeoutMs: number;
  idleTimeoutMs: number;
  statementTimeoutMs: number;
  /** Encerra no servidor transações abandonadas abertas (não configurável). */
  idleInTransactionTimeoutMs: number;
};

const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

// Parâmetros de URL aceitos. Os demais (user, host, options, …) poderiam
// trocar silenciosamente o papel/servidor ou desligar proteções da sessão.
const ALLOWED_URL_PARAMS = new Set(["sslmode"]);

function intSetting(name: string, min: number, max: number, fallback: number) {
  return z
    .string()
    .trim()
    .regex(/^\d+$/, { error: `${name} deve ser um inteiro.` })
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(min, { error: `${name} deve ser no mínimo ${min}.` })
        .max(max, { error: `${name} deve ser no máximo ${max}.` }),
    )
    .optional()
    .transform((value) => value ?? fallback);
}

const envSchema = z.object({
  APP_DATABASE_URL: z
    .string({ error: "APP_DATABASE_URL é obrigatória." })
    .min(1, { error: "APP_DATABASE_URL é obrigatória." }),
  APP_DATABASE_POOL_MAX: intSetting("APP_DATABASE_POOL_MAX", 1, 50, 10),
  APP_DATABASE_CONNECT_TIMEOUT_MS: intSetting("APP_DATABASE_CONNECT_TIMEOUT_MS", 500, 60_000, 5_000),
  APP_DATABASE_IDLE_TIMEOUT_MS: intSetting("APP_DATABASE_IDLE_TIMEOUT_MS", 1_000, 600_000, 30_000),
  APP_DATABASE_STATEMENT_TIMEOUT_MS: intSetting("APP_DATABASE_STATEMENT_TIMEOUT_MS", 100, 300_000, 15_000),
});

/**
 * Valida a URL sem nunca incluir a senha (nem a URL) em mensagens de erro.
 * Exige o papel `antero_app`: conectar como dono das tabelas ou superusuário
 * desligaria a RLS silenciosamente.
 */
function parseConnectionUrl(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseConfigError("APP_DATABASE_URL não é uma URL válida.");
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigError("APP_DATABASE_URL deve usar o esquema postgres://.");
  }
  if (decodeURIComponent(url.username) !== APP_DATABASE_ROLE) {
    throw new DatabaseConfigError(`APP_DATABASE_URL deve conectar com o papel ${APP_DATABASE_ROLE}.`);
  }
  if (!url.password) {
    throw new DatabaseConfigError("APP_DATABASE_URL deve conter a senha do papel.");
  }
  if (!url.hostname) {
    throw new DatabaseConfigError("APP_DATABASE_URL deve conter o host.");
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    throw new DatabaseConfigError("APP_DATABASE_URL deve conter o nome do banco.");
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key)) {
      throw new DatabaseConfigError(
        `APP_DATABASE_URL: parâmetro "${key}" não é permitido (aceitos: ${[...ALLOWED_URL_PARAMS].join(", ")}).`,
      );
    }
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    database,
  };
}

/** Lê e valida a configuração. Lança `DatabaseConfigError` (sem segredos). */
export function parseAppDatabaseConfig(env: Record<string, string | undefined>): AppDatabaseConfig {
  const parsed = envSchema.safeParse({
    APP_DATABASE_URL: env.APP_DATABASE_URL,
    APP_DATABASE_POOL_MAX: env.APP_DATABASE_POOL_MAX || undefined,
    APP_DATABASE_CONNECT_TIMEOUT_MS: env.APP_DATABASE_CONNECT_TIMEOUT_MS || undefined,
    APP_DATABASE_IDLE_TIMEOUT_MS: env.APP_DATABASE_IDLE_TIMEOUT_MS || undefined,
    APP_DATABASE_STATEMENT_TIMEOUT_MS: env.APP_DATABASE_STATEMENT_TIMEOUT_MS || undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n");
    throw new DatabaseConfigError(`Configuração do banco inválida:\n${issues}`);
  }
  const settings = parsed.data;
  const target = parseConnectionUrl(settings.APP_DATABASE_URL);
  return {
    connectionString: settings.APP_DATABASE_URL,
    ...target,
    poolMax: settings.APP_DATABASE_POOL_MAX,
    connectTimeoutMs: settings.APP_DATABASE_CONNECT_TIMEOUT_MS,
    idleTimeoutMs: settings.APP_DATABASE_IDLE_TIMEOUT_MS,
    statementTimeoutMs: settings.APP_DATABASE_STATEMENT_TIMEOUT_MS,
    idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}

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

type DatabaseSpec = {
  /** Prefixo das variáveis (`APP_DATABASE` → `APP_DATABASE_URL`, `APP_DATABASE_POOL_MAX`…). */
  name: "APP_DATABASE" | "WORKER_DATABASE";
  role: string;
  label: string;
  defaults: { poolMax: number; connectTimeoutMs: number; idleTimeoutMs: number; statementTimeoutMs: number };
};

const APP_SPEC: DatabaseSpec = {
  name: "APP_DATABASE",
  role: APP_DATABASE_ROLE,
  label: "Configuração do banco inválida",
  defaults: { poolMax: 10, connectTimeoutMs: 5_000, idleTimeoutMs: 30_000, statementTimeoutMs: 15_000 },
};

/**
 * Pool da ENTRADA DE SISTEMA (webhook da Meta; depois, a varredura da E2B-2).
 * Mesmas regras da aplicação, outro papel e limites menores:
 *
 *   WORKER_DATABASE_URL                    postgres://antero_worker:<senha>@host:porta/banco[?sslmode=…]
 *   WORKER_DATABASE_POOL_MAX               conexões simultâneas (1–50, padrão 3)
 *   WORKER_DATABASE_CONNECT_TIMEOUT_MS     espera por conexão (padrão 3000)
 *   WORKER_DATABASE_IDLE_TIMEOUT_MS        fecha conexão ociosa após (padrão 30000)
 *   WORKER_DATABASE_STATEMENT_TIMEOUT_MS   limite por comando no servidor (padrão 10000)
 *
 * `antero_worker` não tem privilégio de tabela: só executa as funções que as
 * migrations lhe concedem (0014).
 */
export const WORKER_DATABASE_ROLE = "antero_worker";

const WORKER_SPEC: DatabaseSpec = {
  name: "WORKER_DATABASE",
  role: WORKER_DATABASE_ROLE,
  label: "Configuração do banco do worker inválida",
  defaults: { poolMax: 3, connectTimeoutMs: 3_000, idleTimeoutMs: 30_000, statementTimeoutMs: 10_000 },
};

function envSchema({ name, defaults }: DatabaseSpec) {
  return z.object({
    url: z
      .string({ error: `${name}_URL é obrigatória.` })
      .min(1, { error: `${name}_URL é obrigatória.` }),
    poolMax: intSetting(`${name}_POOL_MAX`, 1, 50, defaults.poolMax),
    connectTimeoutMs: intSetting(`${name}_CONNECT_TIMEOUT_MS`, 500, 60_000, defaults.connectTimeoutMs),
    idleTimeoutMs: intSetting(`${name}_IDLE_TIMEOUT_MS`, 1_000, 600_000, defaults.idleTimeoutMs),
    statementTimeoutMs: intSetting(`${name}_STATEMENT_TIMEOUT_MS`, 100, 300_000, defaults.statementTimeoutMs),
  });
}

/**
 * Valida a URL sem nunca incluir a senha (nem a URL) em mensagens de erro.
 * Exige o papel do pool: conectar como dono das tabelas ou superusuário
 * desligaria a RLS silenciosamente.
 */
function parseConnectionUrl(raw: string, { name, role }: DatabaseSpec) {
  const variable = `${name}_URL`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DatabaseConfigError(`${variable} não é uma URL válida.`);
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new DatabaseConfigError(`${variable} deve usar o esquema postgres://.`);
  }
  if (decodeURIComponent(url.username) !== role) {
    throw new DatabaseConfigError(`${variable} deve conectar com o papel ${role}.`);
  }
  if (!url.password) {
    throw new DatabaseConfigError(`${variable} deve conter a senha do papel.`);
  }
  if (!url.hostname) {
    throw new DatabaseConfigError(`${variable} deve conter o host.`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    throw new DatabaseConfigError(`${variable} deve conter o nome do banco.`);
  }
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_URL_PARAMS.has(key)) {
      throw new DatabaseConfigError(
        `${variable}: parâmetro "${key}" não é permitido (aceitos: ${[...ALLOWED_URL_PARAMS].join(", ")}).`,
      );
    }
  }
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    database,
  };
}

function parseDatabaseConfig(env: Record<string, string | undefined>, spec: DatabaseSpec): AppDatabaseConfig {
  const { name } = spec;
  const parsed = envSchema(spec).safeParse({
    url: env[`${name}_URL`],
    poolMax: env[`${name}_POOL_MAX`] || undefined,
    connectTimeoutMs: env[`${name}_CONNECT_TIMEOUT_MS`] || undefined,
    idleTimeoutMs: env[`${name}_IDLE_TIMEOUT_MS`] || undefined,
    statementTimeoutMs: env[`${name}_STATEMENT_TIMEOUT_MS`] || undefined,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n");
    throw new DatabaseConfigError(`${spec.label}:\n${issues}`);
  }
  const settings = parsed.data;
  const target = parseConnectionUrl(settings.url, spec);
  return {
    connectionString: settings.url,
    ...target,
    poolMax: settings.poolMax,
    connectTimeoutMs: settings.connectTimeoutMs,
    idleTimeoutMs: settings.idleTimeoutMs,
    statementTimeoutMs: settings.statementTimeoutMs,
    idleInTransactionTimeoutMs: IDLE_IN_TRANSACTION_TIMEOUT_MS,
  };
}

/** Lê e valida a configuração. Lança `DatabaseConfigError` (sem segredos). */
export function parseAppDatabaseConfig(env: Record<string, string | undefined>): AppDatabaseConfig {
  return parseDatabaseConfig(env, APP_SPEC);
}

/** Configuração do pool do worker (`antero_worker`). Lança `DatabaseConfigError` (sem segredos). */
export function parseWorkerDatabaseConfig(env: Record<string, string | undefined>): AppDatabaseConfig {
  return parseDatabaseConfig(env, WORKER_SPEC);
}

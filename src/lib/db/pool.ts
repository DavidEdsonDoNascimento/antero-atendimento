import "server-only";

import pg from "pg";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { APP_DATABASE_ROLE, parseAppDatabaseConfig, type AppDatabaseConfig } from "./config.ts";
import { DatabaseConfigError } from "./errors.ts";
import { pgTimestampToIso, pgTimestamptzToIso } from "./timestamps.ts";

/**
 * Pool de conexões da APLICAÇÃO — sempre `antero_app` (sujeito à RLS).
 *
 * Uso interno de `src/lib/db`: o resto do código passa por
 * `withUserTransaction` (transaction.ts), nunca pelo pool direto (regra
 * `no-restricted-imports` em eslint.config.mjs). O pool do Better Auth
 * (`antero_auth`) é outro e só entra na Entrega 5.
 *
 * Ciclo de vida:
 * - criado na primeira utilização (não no import), a partir de variáveis de
 *   ambiente do servidor validadas por `parseAppDatabaseConfig`;
 * - guardado em `globalThis`, para o hot reload do `next dev` reaproveitar o
 *   mesmo pool em vez de abrir um novo a cada recompilação;
 * - cada conexão NOVA é conferida no servidor (opção `verify` do pool)
 *   antes do primeiro uso: papel `antero_app`, sem superusuário/BYPASSRLS/
 *   papéis herdados. Se não for, a conexão é descartada e o uso falha
 *   (fail closed) — custo zero nas conexões reaproveitadas;
 * - `closeAppPool()` encerra as conexões (shutdown controlado / testes).
 */

type PoolState = {
  pool: pg.Pool;
  config: AppDatabaseConfig;
};

const GLOBAL_KEY = "__anteroAppDatabasePool";
const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: PoolState };

// OIDs fixos do PostgreSQL (pg_type).
const TYPE_OID = {
  date: 1082,
  dateArray: 1182,
  timestamp: 1114,
  timestampArray: 1115,
  timestamptz: 1184,
  timestamptzArray: 1185,
} as const;

// A tipagem de @types/pg declara `arrayParser` como função; em runtime
// (pg-types 2.2) é `{ create(source, transform) { parse() } }`.
const arrayParser = pg.types.arrayParser as unknown as {
  create(source: string, transform: (entry: string) => unknown): { parse(): unknown[] };
};
const parseArray = (transform: (entry: string) => unknown) => (source: string) =>
  arrayParser.create(source, transform).parse();
const identity = (value: string) => value;

/**
 * Parsers SÓ deste pool (não altera `pg.types` global, que o Better Auth
 * também usará): datas e timestamps chegam como string ISO, sem perda de
 * microssegundos (ver timestamps.ts). Demais tipos: padrão do `pg`
 * (`bigint`/`numeric` como string, `json` como objeto, `uuid` como string).
 */
const appTypeParsers: pg.CustomTypesConfig = {
  getTypeParser: ((oid: number, format?: "text" | "binary") => {
    if (format === undefined || format === "text") {
      switch (oid) {
        case TYPE_OID.timestamptz:
          return pgTimestamptzToIso;
        case TYPE_OID.timestamptzArray:
          return parseArray(pgTimestamptzToIso);
        case TYPE_OID.timestamp:
          return pgTimestampToIso;
        case TYPE_OID.timestampArray:
          return parseArray(pgTimestampToIso);
        case TYPE_OID.date:
          return identity;
        case TYPE_OID.dateArray:
          return parseArray(identity);
      }
    }
    return pg.types.getTypeParser(oid, format);
  }) as pg.CustomTypesConfig["getTypeParser"],
};

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter((part) => typeof part === "string" && part).join(": ") || "erro desconhecido";
  }
  return "erro desconhecido";
}

const ROLE_CHECK_SQL = `
  SELECT current_user = $1 AND session_user = $1 AS is_app_role,
         r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
         EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS has_memberships
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user`;

async function verifyAppRole(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query(ROLE_CHECK_SQL, [APP_DATABASE_ROLE]);
  const role = rows[0];
  const safe =
    role?.is_app_role === true &&
    !role.rolsuper &&
    !role.rolbypassrls &&
    !role.rolcreaterole &&
    !role.rolcreatedb &&
    !role.rolreplication &&
    !role.has_memberships;
  if (!safe) {
    throw new DatabaseConfigError(
      `A conexão do banco precisa usar o papel ${APP_DATABASE_ROLE} sem superusuário, BYPASSRLS, ` +
        "CREATEROLE/CREATEDB/REPLICATION nem papéis herdados. Uso do banco bloqueado.",
    );
  }
}

function createState(): PoolState {
  const config = parseAppDatabaseConfig(process.env);
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.poolMax,
    connectionTimeoutMillis: config.connectTimeoutMs,
    idleTimeoutMillis: config.idleTimeoutMs,
    statement_timeout: config.statementTimeoutMs,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMs,
    application_name: "antero-atendimentos",
    // Sessão determinística: a saída textual de timestamps (que os parsers
    // acima convertem) depende de DateStyle e TimeZone.
    options: "-c TimeZone=UTC -c DateStyle=ISO,MDY",
    types: appTypeParsers,
    verify: (client, done) => {
      verifyAppRole(client).then(() => done(), (error: Error) => done(error));
    },
  });
  // Sem este handler, um erro numa conexão OCIOSA (ex.: servidor reiniciado)
  // derruba o processo. O pool já descarta a conexão; só registramos —
  // código e mensagem do PostgreSQL, nunca a configuração/credencial.
  pool.on("error", (error) => {
    console.error(`[db] conexão ociosa descartada: ${describeError(error)}`);
  });
  return { pool, config };
}

function getState(): PoolState {
  holder[GLOBAL_KEY] ??= createState();
  return holder[GLOBAL_KEY];
}

/** Pool da aplicação (criado e validado sob demanda). Interno de src/lib/db. */
export function getAppPool(): pg.Pool {
  return getState().pool;
}

/** Destino da conexão (sem credenciais), para diagnóstico e testes. */
export function getAppDatabaseTarget(): Pick<AppDatabaseConfig, "host" | "port" | "database" | "poolMax"> {
  const { host, port, database, poolMax } = getState().config;
  return { host, port, database, poolMax };
}

/**
 * Obtém uma conexão do pool (papel já verificado). O chamador DEVE liberá-la
 * (`release`) e tratar o evento `error` enquanto a usa. Interno de src/lib/db.
 */
export function acquireAppClient(): Promise<pg.PoolClient> {
  return getState().pool.connect();
}

/**
 * Encerra o pool da aplicação (espera as conexões em uso serem liberadas).
 * Uma utilização posterior cria um pool novo.
 */
export async function closeAppPool(): Promise<void> {
  const state = holder[GLOBAL_KEY];
  if (!state) return;
  delete holder[GLOBAL_KEY];
  await state.pool.end();
}

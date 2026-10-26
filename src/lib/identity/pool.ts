import "server-only";

import pg from "pg";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { AUTH_DATABASE_ROLE, type IdentityConfig } from "./config.ts";
import { IdentityConfigError } from "./errors.ts";

/**
 * Pool da IDENTIDADE — sempre `antero_auth`, separado do pool `antero_app`
 * (`lib/db/pool.ts`): papéis, credenciais, limites e conexões diferentes.
 * `antero_auth` só tem USAGE no schema `auth` (users/sessions/accounts/
 * verifications) e nenhum privilégio em `public`/`app`; `antero_app` não
 * enxerga `auth`.
 *
 * - Cada conexão NOVA é conferida no servidor (`verify`) antes do uso: papel
 *   `antero_auth`, sem superusuário/BYPASSRLS/CREATEROLE/CREATEDB/
 *   REPLICATION e sem papéis herdados. Senão a conexão é descartada e o uso
 *   falha (fail closed).
 * - Tipos padrão do `pg` (timestamps como `Date`): é o que o Better Auth
 *   espera. Os parsers de string ISO são só do pool da aplicação.
 * - Erros em conexões ociosas são registrados só com código e mensagem.
 */

const ROLE_CHECK_SQL = `
  SELECT current_user = $1 AND session_user = $1 AS is_auth_role,
         r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication,
         EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m WHERE m.member = r.oid) AS has_memberships
  FROM pg_catalog.pg_roles r
  WHERE r.rolname = current_user`;

async function verifyAuthRole(client: pg.ClientBase): Promise<void> {
  const { rows } = await client.query(ROLE_CHECK_SQL, [AUTH_DATABASE_ROLE]);
  const role = rows[0];
  const safe =
    role?.is_auth_role === true &&
    !role.rolsuper &&
    !role.rolbypassrls &&
    !role.rolcreaterole &&
    !role.rolcreatedb &&
    !role.rolreplication &&
    !role.has_memberships;
  if (!safe) {
    throw new IdentityConfigError(
      `A conexão da identidade precisa usar o papel ${AUTH_DATABASE_ROLE} sem superusuário, BYPASSRLS, ` +
        "CREATEROLE/CREATEDB/REPLICATION nem papéis herdados. Uso bloqueado.",
    );
  }
}

function describeError(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return [code, message].filter((part) => typeof part === "string" && part).join(": ") || "erro desconhecido";
  }
  return "erro desconhecido";
}

/** Cria um pool `antero_auth` a partir de uma configuração já validada. */
export function createIdentityPool(database: IdentityConfig["database"]): pg.Pool {
  const pool = new pg.Pool({
    connectionString: database.connectionString,
    max: database.poolMax,
    connectionTimeoutMillis: database.connectTimeoutMs,
    idleTimeoutMillis: database.idleTimeoutMs,
    statement_timeout: database.statementTimeoutMs,
    idle_in_transaction_session_timeout: database.idleInTransactionTimeoutMs,
    application_name: "antero-atendimentos-auth",
    options: "-c TimeZone=UTC",
    verify: (client, done) => {
      verifyAuthRole(client).then(() => done(), (error: Error) => done(error));
    },
  });
  pool.on("error", (error) => {
    console.error(`[auth] conexão ociosa descartada: ${describeError(error)}`);
  });
  return pool;
}

import "server-only";

/**
 * Camada PostgreSQL da aplicação (Entrega 3). Ponto de entrada ÚNICO para o
 * resto do código: importe de `@/lib/db`, nunca dos arquivos internos nem do
 * `pg` diretamente (regra `no-restricted-imports` em eslint.config.mjs).
 *
 * Ainda não é usada pelas rotas: as consultas SQL paralelas
 * (`modules/<domínio>/sql-queries.ts`, Entrega 4) só serão ligadas às páginas junto
 * com a autenticação própria (Entrega 5).
 */
export { withUserTransaction } from "./transaction.ts";
export { withOrganizationTransaction, type OrganizationContext } from "./organization.ts";
export { closeAppPool } from "./pool.ts";
export {
  AccessDeniedError,
  DatabaseConfigError,
  DisallowedQueryError,
  InvalidUserContextError,
  TransactionClosedError,
  sqlStateOf,
} from "./errors.ts";
export type { DbTransaction, QueryResult, QueryResultRow } from "./types";

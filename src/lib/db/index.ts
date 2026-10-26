import "server-only";

/**
 * Camada PostgreSQL da aplicação (Entrega 3). Ponto de entrada ÚNICO para o
 * resto do código: importe de `@/lib/db`, nunca dos arquivos internos nem do
 * `pg` diretamente (regra `no-restricted-imports` em eslint.config.mjs).
 *
 * Ainda não é usada pela aplicação: as páginas continuam no Supabase até a
 * migração da DAL (Entrega 4) e da autenticação (Entrega 5).
 */
export { withUserTransaction } from "./transaction.ts";
export { closeAppPool } from "./pool.ts";
export {
  DatabaseConfigError,
  DisallowedQueryError,
  InvalidUserContextError,
  TransactionClosedError,
} from "./errors.ts";
export type { DbTransaction, QueryResult, QueryResultRow } from "./types";

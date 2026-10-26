import type { QueryResult, QueryResultRow } from "pg";

export type { QueryResult, QueryResultRow };

/**
 * Transação em andamento, entregue ao callback de `withUserTransaction`.
 *
 * Só executa comandos parametrizados (`$1`, `$2`, …) na conexão DESTA
 * transação — nunca no pool. Sempre um comando por chamada (protocolo
 * estendido). Recusa:
 * - controle de transação/sessão (BEGIN, COMMIT, ROLLBACK, SAVEPOINT, SET,
 *   RESET, DISCARD…) e troca de contexto (`set_user_context`, `set_config`);
 * - parâmetros `Date` — passe timestamps como string ISO (com
 *   microssegundos), como os que esta camada devolve;
 * - uso depois que o callback terminou.
 */
export interface DbTransaction {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<R>>;
}

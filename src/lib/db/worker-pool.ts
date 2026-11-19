import "server-only";

import type pg from "pg";
import type { QueryConfig } from "pg";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { WORKER_DATABASE_ROLE, parseWorkerDatabaseConfig } from "./config.ts";
import { DisallowedQueryError } from "./errors.ts";
import { createVerifiedPool } from "./pool.ts";
import type { QueryResult, QueryResultRow } from "./types";

/**
 * Pool da ENTRADA DE SISTEMA — sempre `antero_worker` (E2B-1).
 *
 * Usado só pelo código do servidor que não tem usuário humano: o webhook da
 * Meta e, na E2B-2, a varredura. O papel não tem privilégio de tabela e só
 * executa funções `SECURITY DEFINER` que a migration lhe concede; é nelas que
 * a organização é derivada do canal registrado e conferida. Por isso esta
 * camada expõe uma única operação: chamar UMA função por comando.
 *
 * Mesmo ciclo de vida do pool da aplicação: criado no primeiro uso (não no
 * import) a partir de `WORKER_DATABASE_*`, papel conferido em cada conexão
 * nova, guardado em `globalThis` para o hot reload, fechado no encerramento.
 * Sem configuração, o uso falha com `DatabaseConfigError` (sem segredos) e
 * quem chama decide a resposta; o resto da aplicação não depende dele.
 */

type WorkerPoolState = { pool: pg.Pool };

const GLOBAL_KEY = "__anteroWorkerDatabasePool";
const holder = globalThis as typeof globalThis & { [GLOBAL_KEY]?: WorkerPoolState };

const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const CONTEXT_SWITCH = /\b(?:set_user_context|set_config)\s*\(/i;

function getState(): WorkerPoolState {
  holder[GLOBAL_KEY] ??= {
    pool: createVerifiedPool(parseWorkerDatabaseConfig(process.env), {
      role: WORKER_DATABASE_ROLE,
      applicationName: "antero-atendimentos-worker",
      label: "worker-db",
    }),
  };
  return holder[GLOBAL_KEY];
}

/**
 * Executa um único `SELECT … FROM public.<função>(…)` parametrizado como
 * `antero_worker`, fora de transação explícita (a função é atômica). Proteção
 * contra erro de programação, não a fronteira de segurança (essa são os
 * GRANTs): recusa outro comando, mais de um comando e troca de contexto.
 */
export async function workerQuery<R extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult<R>> {
  const statement = text.replace(LEADING_COMMENTS, "");
  if (!/^select\b/i.test(statement) || text.includes(";") || CONTEXT_SWITCH.test(text)) {
    throw new DisallowedQueryError("O pool do worker só chama uma função por comando (SELECT … FROM public.<função>(…)).");
  }
  const config: QueryConfig & { queryMode: "extended" } = { text, values: [...values], queryMode: "extended" };
  return getState().pool.query<R>(config);
}

/** Encerra o pool do worker (shutdown controlado / testes). Um uso posterior cria outro. */
export async function closeWorkerPool(): Promise<void> {
  const state = holder[GLOBAL_KEY];
  if (!state) return;
  delete holder[GLOBAL_KEY];
  await state.pool.end();
}

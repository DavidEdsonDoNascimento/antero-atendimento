import "server-only";

import type { QueryConfig } from "pg";
import { z } from "zod";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import {
  DisallowedQueryError,
  InvalidUserContextError,
  TransactionClosedError,
} from "./errors.ts";
import { acquireAppClient } from "./pool.ts";
import type { DbTransaction } from "./types";

const userIdSchema = z.uuid();

// Comentários iniciais são ignorados na checagem do primeiro comando.
const LEADING_COMMENTS = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
const TRANSACTION_OR_SESSION_CONTROL =
  /^(?:begin|start|commit|end|rollback|abort|savepoint|release|prepare|set|reset|discard)\b/i;
const CONTEXT_SWITCH = /\b(?:set_user_context|set_config)\s*\(/i;

/**
 * Proteção contra ERROS de programação dentro do callback (não é a fronteira
 * de segurança — essa é a RLS + nunca montar SQL com entrada do usuário).
 */
function assertAllowed(text: string, values: readonly unknown[]): void {
  const statement = text.replace(LEADING_COMMENTS, "");
  if (TRANSACTION_OR_SESSION_CONTROL.test(statement)) {
    throw new DisallowedQueryError(
      "Controle de transação/sessão não é permitido dentro de withUserTransaction.",
    );
  }
  if (CONTEXT_SWITCH.test(text)) {
    throw new DisallowedQueryError(
      "O contexto de usuário é definido só por withUserTransaction; não o altere dentro do callback.",
    );
  }
  const hasDate = values.some(
    (value) => value instanceof Date || (Array.isArray(value) && value.some((item) => item instanceof Date)),
  );
  if (hasDate) {
    throw new DisallowedQueryError(
      "Parâmetro Date recusado: perderia os microssegundos. Passe o timestamp como string ISO.",
    );
  }
}

/**
 * Executa `callback` numa transação da aplicação com o contexto de RLS do
 * usuário `userId`:
 *
 *   conexão do pool → BEGIN → app.set_user_context($1::uuid) → callback(tx)
 *   → COMMIT (sucesso) | ROLLBACK (qualquer erro, que é propagado) → release
 *
 * - Todas as consultas do callback usam a MESMA conexão (`tx.query`).
 * - O contexto vale só para esta transação (`set_config(..., true)` + marca
 *   da transação, migration 0000): não sobrevive ao COMMIT/ROLLBACK nem passa
 *   para o próximo uso da conexão no pool.
 * - Se nem o ROLLBACK funcionar, ou se a conexão cair durante a transação,
 *   ela é DESCARTADA, não devolvida ao pool.
 *
 * SEGURANÇA: `userId` NÃO é prova de autenticação. Ele deve vir
 * exclusivamente de uma sessão validada no servidor (Better Auth, via DAL)
 * — nunca de parâmetro de rota, formulário, cookie não verificado ou corpo de
 * requisição. Sem `userId` válido não há transação (InvalidUserContextError),
 * e não existe fallback para administrador.
 *
 * Não aninhe chamadas (cada uma usa sua própria conexão e transação).
 */
export async function withUserTransaction<T>(
  userId: string,
  callback: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  if (typeof userId !== "string" || !userIdSchema.safeParse(userId).success) {
    throw new InvalidUserContextError();
  }

  const client = await acquireAppClient();
  // Enquanto a conexão está emprestada, o pool não escuta o evento `error`
  // dela: sem este listener, a queda do backend no meio da transação
  // (restart do PostgreSQL, conexão encerrada) derrubaria o processo. As
  // consultas pendentes já são rejeitadas pelo `pg`; aqui só marcamos a
  // conexão para descarte.
  let connectionBroken = false;
  const onConnectionError = () => {
    connectionBroken = true;
  };
  client.on("error", onConnectionError);
  let open = true;
  const tx: DbTransaction = {
    query(text, values = []) {
      if (!open) return Promise.reject(new TransactionClosedError());
      try {
        assertAllowed(text, values);
      } catch (error) {
        return Promise.reject(error);
      }
      // `queryMode: "extended"` (suportado pelo pg, ausente da tipagem):
      // um único comando por chamada, mesmo sem parâmetros.
      const config: QueryConfig & { queryMode: "extended" } = {
        text,
        values: [...values],
        queryMode: "extended",
      };
      return client.query(config);
    },
  };

  let discardConnection = false;
  try {
    await client.query("BEGIN");
    await client.query("SELECT app.set_user_context($1::uuid)", [userId]);
    const result = await callback(tx);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      discardConnection = true;
    }
    throw error;
  } finally {
    open = false;
    client.removeListener("error", onConnectionError);
    client.release(discardConnection || connectionBroken);
  }
}

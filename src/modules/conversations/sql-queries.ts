import "server-only";

import { z } from "zod";

import {
  sqlStateOf,
  withOrganizationTransaction,
  type DbTransaction,
  type OrganizationContext,
} from "@/lib/db";

// Extensão .ts explícita nas importações de VALOR (ver nota em cursor.ts).
import {
  decodeConversationCursor,
  decodeMessageHistoryCursor,
  encodeConversationCursor,
  encodeMessageHistoryCursor,
} from "./cursor.ts";
import { ConversationQueryError, InvalidCursorError } from "./errors.ts";
import { mapConversationDetailRow, mapConversationListRow, mapMessageRow } from "./mappers.ts";
import { CONVERSATIONS_PAGE_LIMIT, MESSAGES_PAGE_LIMIT, clampLimit } from "./pagination.ts";
import type { MessageHistoryRow } from "./rows";
import {
  buildConversationDetailQuery,
  buildConversationListQuery,
  buildConversationOwnershipQuery,
  buildMessageHistoryQuery,
  toConversationDetailRow,
  toConversationListRow,
  type ConversationDetailSqlRow,
  type ConversationListSqlRow,
} from "./sql.ts";
import type {
  ConversationDetail,
  ConversationListPage,
  ListConversationMessagesParams,
  ListConversationsParams,
  MessageHistoryPage,
} from "./types";

/**
 * DAL de leitura de conversas sobre o PostgreSQL próprio (Entrega 4) —
 * PARALELA a `queries.ts` (Supabase/PostgREST), que continua sendo a usada
 * pelas rotas até a Entrega 5. Mesmos nomes, mesmos parâmetros depois do
 * primeiro e mesmos tipos de retorno; muda só o primeiro argumento:
 *
 *   queries.ts      listConversations(organizationId, params)
 *   sql-queries.ts  listConversations({ userId, organizationId }, params)
 *
 * O `OrganizationContext` precisa vir do servidor (sessão validada +
 * organização ativa do usuário) — nunca do navegador. Cada chamada roda em
 * `withOrganizationTransaction`: contexto de RLS do usuário, vínculo ativo
 * com a organização confirmado (senão `AccessDeniedError`) e filtro
 * explícito por `organization_id` em todas as consultas.
 *
 * Erros: os mesmos de `queries.ts` — `InvalidCursorError` para cursor
 * inválido e `ConversationQueryError` para falha do banco (com o
 * `DatabaseError` original em `cause`); além deles, `AccessDeniedError` e
 * `InvalidUserContextError` de `@/lib/db` para contexto inválido.
 *
 * Não importe este módulo em rotas/actions antes da Entrega 5 (regra de
 * lint em eslint.config.mjs).
 */

const uuidSchema = z.uuid();

function isUuid(value: string): boolean {
  return uuidSchema.safeParse(value).success;
}

// Um cursor bem formado pode ainda ser recusado pelo PostgreSQL como
// timestamp (ex.: ano 0000, aceito pelo formato ISO): tratado como cursor
// inválido, igual a um adulterado, para o chamador voltar à primeira página.
const INVALID_DATETIME_SQLSTATES = new Set(["22007", "22008"]);

async function runRead<T>(
  context: OrganizationContext,
  failure: string,
  hasCursor: () => boolean,
  work: (tx: DbTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await withOrganizationTransaction(context, work);
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (sqlState === undefined) throw error;
    if (hasCursor() && INVALID_DATETIME_SQLSTATES.has(sqlState)) throw new InvalidCursorError();
    throw new ConversationQueryError(`${failure}: ${(error as Error).message}`, { cause: error });
  }
}

/**
 * Lista paginada de conversas da organização, mais recentes primeiro —
 * equivalente a `queries.ts#listConversations`, numa única consulta de
 * dados (contato, canal, atendente e última mensagem por JOIN/LATERAL).
 */
export async function listConversations(
  context: OrganizationContext,
  params: ListConversationsParams = {},
): Promise<ConversationListPage> {
  const limit = clampLimit(params.limit, CONVERSATIONS_PAGE_LIMIT);
  const cursor = params.cursor ? decodeConversationCursor(params.cursor) : null;

  const rows = await runRead(context, "Falha ao carregar conversas", () => cursor !== null, async (tx) => {
    const query = buildConversationListQuery(context.organizationId, { status: params.status, cursor, limit });
    return (await tx.query<ConversationListSqlRow>(query.text, query.values)).rows;
  });

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);

  return {
    items: pageRows.map((row) => mapConversationListRow(toConversationListRow(row))),
    nextCursor:
      hasMore && last
        ? encodeConversationCursor({ lastMessageAt: last.last_message_at, id: last.id })
        : null,
  };
}

/**
 * Detalhe de uma conversa — equivalente a `queries.ts#getConversationDetail`:
 * ID malformado, inexistente ou de outra organização → `null`, sem distinção.
 */
export async function getConversationDetail(
  context: OrganizationContext,
  conversationId: string,
): Promise<ConversationDetail | null> {
  if (!isUuid(conversationId)) return null;

  const row = await runRead(context, "Falha ao carregar conversa", () => false, async (tx) => {
    const query = buildConversationDetailQuery(context.organizationId, conversationId);
    return (await tx.query<ConversationDetailSqlRow>(query.text, query.values)).rows[0];
  });

  return row ? mapConversationDetailRow(toConversationDetailRow(row)) : null;
}

/**
 * Histórico paginado de mensagens — equivalente a
 * `queries.ts#listConversationMessages`: `null` para conversa inválida,
 * inexistente ou de outra organização (verificado ANTES de ler mensagens);
 * `{ items: [], nextCursor: null }` para conversa sem mensagens; itens em
 * ordem cronológica, páginas seguintes cada vez mais antigas.
 */
export async function listConversationMessages(
  context: OrganizationContext,
  conversationId: string,
  params: ListConversationMessagesParams = {},
): Promise<MessageHistoryPage | null> {
  if (!isUuid(conversationId)) return null;
  const limit = clampLimit(params.limit, MESSAGES_PAGE_LIMIT);
  let cursorUsed = false;

  const rows = await runRead(context, "Falha ao carregar mensagens", () => cursorUsed, async (tx) => {
    const ownership = buildConversationOwnershipQuery(context.organizationId, conversationId);
    const { rowCount } = await tx.query(ownership.text, ownership.values);
    if (!rowCount) return null;

    // Mesma ordem de `queries.ts`: o cursor só é validado para uma conversa
    // que existe nesta organização.
    const cursor = params.cursor ? decodeMessageHistoryCursor(params.cursor) : null;
    cursorUsed = cursor !== null;
    const query = buildMessageHistoryQuery(context.organizationId, conversationId, { cursor, limit });
    return (await tx.query<MessageHistoryRow>(query.text, query.values)).rows;
  });
  if (rows === null) return null;

  const hasMore = rows.length > limit;
  const pageRowsDesc = hasMore ? rows.slice(0, limit) : rows;
  const oldestLoaded = pageRowsDesc.at(-1);

  return {
    items: pageRowsDesc.map(mapMessageRow).reverse(),
    nextCursor:
      hasMore && oldestLoaded
        ? encodeMessageHistoryCursor({ createdAt: oldestLoaded.created_at, id: oldestLoaded.id })
        : null,
  };
}

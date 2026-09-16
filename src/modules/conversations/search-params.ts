import type { ConversationStatusFilter } from "./types";

/**
 * Interpretação segura de `searchParams` da caixa de conversas para os
 * parâmetros aceitos por `listConversations`/`listConversationMessages`.
 *
 * Pura, sem I/O — mesma convenção de `cursor.ts`/`pagination.ts`: testável
 * com `node --test`, sem `import "server-only"`. O cursor continua opaco
 * aqui — só extraímos a string bruta da URL, quem valida o conteúdo é a DAL
 * (`decodeConversationCursor`/`decodeMessageHistoryCursor` em `cursor.ts`).
 */

const VALID_STATUS_FILTERS: ReadonlySet<string> = new Set([
  "bot",
  "waiting",
  "human",
  "resolved",
  "open",
]);

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Valida `status` vindo da URL contra o conjunto de filtros realmente
 * suportados pela DAL. Um valor ausente, vazio ou fora do conjunto é
 * tratado como "sem filtro" (lista todos os status) — nunca lança erro por
 * um valor de URL inesperado.
 */
export function parseConversationStatusFilter(
  raw: string | string[] | undefined,
): ConversationStatusFilter | undefined {
  const value = firstValue(raw);
  return value && VALID_STATUS_FILTERS.has(value)
    ? (value as ConversationStatusFilter)
    : undefined;
}

/** Extrai um cursor opaco de `searchParams`; ausente ou vazio conta como "sem cursor". */
export function parseCursorParam(raw: string | string[] | undefined): string | undefined {
  const value = firstValue(raw);
  return value ? value : undefined;
}

import "server-only";

import { z } from "zod";

import { AccessDeniedError, sqlStateOf, withUserTransaction } from "@/lib/db";

// Extensão .ts explícita nas importações de VALOR (ver nota em
// modules/conversations/cursor.ts).
import { clampLimit, type PageLimitConfig } from "../conversations/pagination.ts";
import { isAuditAction } from "./catalog.ts";
import { decodeAuditEventCursor, encodeAuditEventCursor } from "./cursor.ts";
import { InvalidAuditCursorError, InvalidAuditFilterError } from "./errors.ts";
import { mapAuditEventRow } from "./mappers.ts";
import { parseCalendarDate, type ActivityFilters } from "./search-params.ts";
import { buildAuditEventsQuery, type AuditEventSqlRow } from "./sql.ts";
import type { AuditEventPage } from "./types";

/**
 * Leitura da auditoria administrativa (G2C) — só administrador da plataforma,
 * no mesmo padrão de `modules/organizations/sql-queries.ts`: pool
 * `antero_app` com o contexto de RLS do usuário da sessão validada
 * (`withUserTransaction`), `public.is_platform_admin()` conferida no banco
 * (senão `AccessDeniedError`) e a RLS `audit_events_select` (0013) por baixo.
 * Só SELECT: a aplicação não tem nenhuma escrita em `audit_events`.
 *
 * Uma função para as duas telas: com `filters.organizationId`, só os eventos
 * daquela organização (filtro explícito no SQL); sem ele, todas.
 */

/** 25 por página; o teto só vale para chamadas internas (a URL não escolhe o tamanho). */
export const AUDIT_EVENTS_PAGE_LIMIT: PageLimitConfig = { default: 25, max: 50 };

// Recusados pelo PostgreSQL num cursor que passou no formato: timestamp
// inválido (22007/22008) ou id fora do `bigint` (22003). Tratados como cursor
// adulterado, para a tela voltar aos mais recentes.
const INVALID_CURSOR_SQLSTATES = new Set(["22003", "22007", "22008"]);

const uuidSchema = z.uuid();

/** Defesa contra uso indevido: os filtros devem vir de `parseActivitySearchParams`. */
function assertValidFilters(filters: ActivityFilters): void {
  const valid =
    (filters.organizationId === undefined || uuidSchema.safeParse(filters.organizationId).success) &&
    (filters.action === undefined || isAuditAction(filters.action)) &&
    (filters.from === undefined || typeof parseCalendarDate(filters.from) === "string") &&
    (filters.to === undefined || typeof parseCalendarDate(filters.to) === "string");
  if (!valid) throw new InvalidAuditFilterError();
}

export async function listAuditEvents(
  context: { userId: string },
  params: { filters?: ActivityFilters; cursor?: string; limit?: number } = {},
): Promise<AuditEventPage> {
  const filters = params.filters ?? {};
  assertValidFilters(filters);
  const limit = clampLimit(params.limit, AUDIT_EVENTS_PAGE_LIMIT);
  const cursor = params.cursor ? decodeAuditEventCursor(params.cursor) : null;

  let rows: AuditEventSqlRow[];
  try {
    rows = await withUserTransaction(context?.userId, async (tx) => {
      const { rows: allowed } = await tx.query<{ allowed: boolean }>("SELECT public.is_platform_admin() AS allowed");
      if (allowed[0]?.allowed !== true) throw new AccessDeniedError();
      const query = buildAuditEventsQuery(filters, { cursor, limit });
      return (await tx.query<AuditEventSqlRow>(query.text, query.values)).rows;
    });
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (sqlState === undefined) throw error;
    if (cursor !== null && INVALID_CURSOR_SQLSTATES.has(sqlState)) throw new InvalidAuditCursorError();
    throw new Error(`Falha ao carregar as atividades administrativas: ${(error as Error).message}`, { cause: error });
  }

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const last = pageRows.at(-1);
  return {
    items: pageRows.map(mapAuditEventRow),
    nextCursor: hasMore && last ? encodeAuditEventCursor({ occurredAt: last.occurred_at, id: last.id }) : null,
  };
}

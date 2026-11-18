import type { AuditEventCursor } from "./cursor";
import type { ActivityFilters } from "./search-params";

// Lógica pura (texto SQL, sem I/O), mesma convenção de
// `modules/conversations/sql.ts`: testável com `node --test`. Quem executa é
// `sql-queries.ts` (server-only), dentro de `withUserTransaction`.

export type SqlQuery = { text: string; values: unknown[] };

/** Linha crua da leitura de eventos: só as colunas que a tela usa. */
export type AuditEventSqlRow = {
  id: string;
  occurred_at: string;
  organization_id: string;
  action: string;
  actor_kind: string;
  actor_user_id: string | null;
  actor_exists: boolean;
  actor_name: string | null;
  organization_exists: boolean;
  organization_name: string | null;
  module: string | null;
  from_state: string | null;
  to_state: string | null;
};

/**
 * Fuso dos limites do filtro de período (dias do calendário de Brasília). A
 * conversão é do PostgreSQL, pela base de fusos do servidor, e não depende do
 * `TimeZone=UTC` das conexões da aplicação (lib/db/pool.ts) nem do Node.
 */
export const ACTIVITY_TIME_ZONE = "America/Sao_Paulo";

/** Acumula parâmetros e devolve o marcador `$n` de cada valor (como em conversations/sql.ts). */
function parameters() {
  const values: unknown[] = [];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * Uma página de `audit_events`, mais recentes primeiro:
 * `ORDER BY occurred_at DESC, id DESC` e keyset `(occurred_at, id) < cursor`
 * (o id é único, então a ordem é total mesmo com instantes iguais). Busca
 * `limit + 1` linhas: a extra só indica se há página seguinte. Nunca OFFSET.
 *
 * - Todo valor vai como parâmetro; o texto só combina fragmentos fixos.
 * - A página é escolhida PRIMEIRO (subconsulta com o LIMIT, sobre os índices
 *   `audit_events_organization_idx` / `audit_events_occurred_idx` da 0013) e
 *   só as suas linhas recebem os nomes, como em `buildConversationListQuery`.
 * - Nomes resolvidos na leitura por LEFT JOIN: o evento continua aparecendo
 *   se o usuário ou a organização não existirem mais.
 * - De `details` saem só `module`, `from` e `to`; o objeto inteiro (e o
 *   `db_role` dos eventos de manutenção) nunca chega à aplicação.
 */
export function buildAuditEventsQuery(
  filters: ActivityFilters,
  options: { cursor: AuditEventCursor | null; limit: number },
): SqlQuery {
  const params = parameters();
  const conditions: string[] = [];

  if (filters.organizationId) conditions.push(`a.organization_id = ${params.add(filters.organizationId)}::uuid`);
  if (filters.action) conditions.push(`a.action = ${params.add(filters.action)}::text`);
  if (filters.from) {
    conditions.push(`a.occurred_at >= (${params.add(filters.from)}::date::timestamp AT TIME ZONE '${ACTIVITY_TIME_ZONE}')`);
  }
  if (filters.to) {
    // Fim exclusivo no dia seguinte: o último dia entra inteiro.
    conditions.push(`a.occurred_at < ((${params.add(filters.to)}::date + 1)::timestamp AT TIME ZONE '${ACTIVITY_TIME_ZONE}')`);
  }
  if (options.cursor) {
    const at = params.add(options.cursor.occurredAt);
    const id = params.add(options.cursor.id);
    conditions.push(`(a.occurred_at, a.id) < (${at}::timestamptz, ${id}::bigint)`);
  }
  const limit = params.add(options.limit + 1);
  const where = conditions.length > 0 ? `WHERE ${conditions.join("\n    AND ")}` : "";

  return {
    text: `
SELECT e.id::text AS id, e.occurred_at, e.organization_id, e.action, e.actor_kind, e.actor_user_id,
  p.id IS NOT NULL AS actor_exists, p.full_name AS actor_name,
  o.id IS NOT NULL AS organization_exists, o.name AS organization_name,
  e.details ->> 'module' AS module, e.details ->> 'from' AS from_state, e.details ->> 'to' AS to_state
FROM (
  SELECT a.id, a.occurred_at, a.organization_id, a.action, a.actor_kind, a.actor_user_id, a.details
  FROM public.audit_events a
  ${where}
  ORDER BY a.occurred_at DESC, a.id DESC
  LIMIT ${limit}::int
) e
LEFT JOIN public.organizations o ON o.id = e.organization_id
LEFT JOIN public.profiles p ON p.id = e.actor_user_id
ORDER BY e.occurred_at DESC, e.id DESC`,
    values: params.values,
  };
}

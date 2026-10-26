import type {
  ConversationStatus,
  MessageDirection,
  MessageSender,
} from "@/lib/types/database";

import type { ConversationCursor } from "./cursor";
import type {
  ConversationAssignedMemberRow,
  ConversationDetailRow,
  ConversationListRow,
} from "./rows";
import type { ConversationStatusFilter } from "./types";

// Lógica pura (texto SQL + montagem de linhas, sem I/O, sem segredo) — sem
// `import "server-only"` de propósito, mesma convenção de `cursor.ts` e
// `mappers.ts`: testável com `node --test`. Quem executa é
// `sql-queries.ts` (server-only), dentro de `withOrganizationTransaction`.

/**
 * SQL das leituras de conversas para o PostgreSQL próprio (Entrega 4) —
 * equivalente às consultas PostgREST de `queries.ts`:
 *
 * - todo valor vai como parâmetro (`$n`); o texto só combina fragmentos
 *   fixos deste arquivo, escolhidos por uma lista controlada de condições;
 * - filtro explícito `organization_id = $1` além da RLS;
 * - os embeds do PostgREST viram JOINs pelas MESMAS foreign keys compostas
 *   (`organization_id` + id), então uma linha de outra organização não pode
 *   aparecer embutida, por estrutura;
 * - o resultado é remontado no formato de `rows.ts` (`toConversationListRow`
 *   / `toConversationDetailRow`), para os mapeadores não mudarem.
 *
 * Timestamps chegam como string ISO com microssegundos (parsers do pool em
 * `lib/db/pool.ts`), no mesmo formato que o PostgREST entregava — os
 * cursores de `cursor.ts` continuam idênticos.
 */

export type SqlQuery = { text: string; values: unknown[] };

/** Colunas comuns à lista e ao detalhe (conversa + contato + canal + atendente). */
type ConversationBaseSqlRow = {
  id: string;
  status: ConversationStatus;
  started_at: string;
  last_message_at: string;
  contact_id: string;
  contact_name: string | null;
  contact_phone_number: string;
  channel_id: string;
  channel_display_name: string | null;
  channel_phone_number: string | null;
  assignee_user_id: string | null;
  assignee_full_name: string | null;
};

export type ConversationListSqlRow = ConversationBaseSqlRow & {
  last_message_id: string | null;
  last_message_direction: MessageDirection | null;
  last_message_sender_type: MessageSender | null;
  last_message_content: string | null;
  last_message_created_at: string | null;
};

export type ConversationDetailSqlRow = ConversationBaseSqlRow & {
  assigned_at: string | null;
  resolved_at: string | null;
};

const CONVERSATION_COLUMNS = `
  c.id, c.status, c.started_at, c.last_message_at,
  ct.id AS contact_id, ct.name AS contact_name, ct.phone_number AS contact_phone_number,
  wa.id AS channel_id, wa.display_name AS channel_display_name, wa.phone_number AS channel_phone_number,
  am.user_id AS assignee_user_id, p.full_name AS assignee_full_name`;

// contact e whatsapp_account são obrigatórios (FKs compostas NOT NULL) →
// JOIN; o atendente é opcional (`assigned_user_id` nulo) → LEFT JOIN, e o
// perfil dele também (a RLS de profiles pode ocultá-lo, ver
// `assembleAssignee`).
const CONVERSATION_JOINS = `
  JOIN public.contacts ct
    ON ct.organization_id = c.organization_id AND ct.id = c.contact_id
  JOIN public.whatsapp_accounts wa
    ON wa.organization_id = c.organization_id AND wa.id = c.whatsapp_account_id
  LEFT JOIN public.organization_members am
    ON am.organization_id = c.organization_id AND am.user_id = c.assigned_user_id
  LEFT JOIN public.profiles p
    ON p.id = am.user_id`;

// Última mensagem POR conversa (o `order` + `limit(1)` escopados do
// PostgREST), pela FK tripla messages_conversation_whatsapp_account_fkey.
// `id DESC` desempata mensagens com o mesmo `created_at` — o PostgREST
// ordenava só por `created_at`, deixando o empate exato indefinido; aqui o
// resultado é determinístico e igual à última linha do histórico.
const LAST_MESSAGE_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT m.id, m.direction, m.sender_type, m.content, m.created_at
    FROM public.messages m
    WHERE m.organization_id = c.organization_id
      AND m.conversation_id = c.id
      AND m.whatsapp_account_id = c.whatsapp_account_id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) lm ON true`;

/** Acumula parâmetros e devolve o marcador `$n` de cada valor. */
function parameters(initial: unknown[]) {
  const values = [...initial];
  return {
    values,
    add(value: unknown): string {
      values.push(value);
      return `$${values.length}`;
    },
  };
}

/**
 * Uma página da lista de conversas: `ORDER BY last_message_at DESC, id DESC`
 * e keyset `(last_message_at, id) < (cursor)` — o mesmo que o filtro
 * `last_message_at.lt.X or (last_message_at.eq.X and id.lt.Y)` do PostgREST,
 * já que as duas colunas são NOT NULL (0003_atendimento.sql). Busca
 * `limit + 1` linhas: a extra só indica se há próxima página.
 *
 * A página é escolhida PRIMEIRO (subconsulta com o LIMIT) e só as suas
 * linhas recebem contato, canal, atendente e última mensagem. Com os JOINs e
 * o LATERAL no mesmo nível do LIMIT, o planejador montava tudo para TODAS as
 * conversas da organização antes de ordenar (medido: 1,8 s com 20 mil
 * conversas, contra milissegundos assim — ver docs/DATABASE.md).
 */
export function buildConversationListQuery(
  organizationId: string,
  options: { status?: ConversationStatusFilter; cursor: ConversationCursor | null; limit: number },
): SqlQuery {
  const params = parameters([organizationId]);
  const conditions = ["c.organization_id = $1::uuid"];

  if (options.status === "open") {
    conditions.push("c.status <> 'resolved'");
  } else if (options.status) {
    conditions.push(`c.status = ${params.add(options.status)}::public.conversation_status`);
  }

  if (options.cursor) {
    const at = params.add(options.cursor.lastMessageAt);
    const id = params.add(options.cursor.id);
    conditions.push(`(c.last_message_at, c.id) < (${at}::timestamptz, ${id}::uuid)`);
  }

  const limit = params.add(options.limit + 1);

  return {
    text: `
SELECT ${CONVERSATION_COLUMNS},
  lm.id AS last_message_id, lm.direction AS last_message_direction,
  lm.sender_type AS last_message_sender_type, lm.content AS last_message_content,
  lm.created_at AS last_message_created_at
FROM (
  SELECT c.id, c.organization_id, c.whatsapp_account_id, c.contact_id, c.assigned_user_id,
    c.status, c.started_at, c.last_message_at
  FROM public.conversations c
  WHERE ${conditions.join("\n    AND ")}
  ORDER BY c.last_message_at DESC, c.id DESC
  LIMIT ${limit}::int
) c
${CONVERSATION_JOINS}
${LAST_MESSAGE_LATERAL}
ORDER BY c.last_message_at DESC, c.id DESC`,
    values: params.values,
  };
}

/** Detalhe de uma conversa, escopado à organização. */
export function buildConversationDetailQuery(organizationId: string, conversationId: string): SqlQuery {
  return {
    text: `
SELECT ${CONVERSATION_COLUMNS}, c.assigned_at, c.resolved_at
FROM public.conversations c
${CONVERSATION_JOINS}
WHERE c.organization_id = $1::uuid AND c.id = $2::uuid`,
    values: [organizationId, conversationId],
  };
}

/**
 * `assigned_member` no formato de `rows.ts`. O perfil vem de LEFT JOIN
 * porque a RLS de `profiles` (`shares_org_with`) só mostra colegas com
 * vínculo ATIVO: numa conversa atribuída a um membro depois desativado, o
 * PostgREST devolvia `profile: null`, que `mapAssignee` não aceita
 * (`row.profile.full_name`). Aqui o perfil é sempre um objeto (`id` é o
 * próprio `user_id`, garantido pela FK) e o nome fica `null` quando oculto
 * — o mapeador continua o mesmo e nada além do que a RLS permite é exposto.
 */
function assembleAssignee(row: ConversationBaseSqlRow): ConversationAssignedMemberRow | null {
  if (row.assignee_user_id === null) return null;
  return {
    user_id: row.assignee_user_id,
    profile: { id: row.assignee_user_id, full_name: row.assignee_full_name },
  };
}

function assembleBase(row: ConversationBaseSqlRow) {
  return {
    id: row.id,
    status: row.status,
    started_at: row.started_at,
    last_message_at: row.last_message_at,
    contact: { id: row.contact_id, name: row.contact_name, phone_number: row.contact_phone_number },
    whatsapp_account: {
      id: row.channel_id,
      display_name: row.channel_display_name,
      phone_number: row.channel_phone_number,
    },
    assigned_member: assembleAssignee(row),
  };
}

/** Linha da lista no formato de `ConversationListRow` (`last_message` é array de 0 ou 1 item). */
export function toConversationListRow(row: ConversationListSqlRow): ConversationListRow {
  const lastMessage =
    row.last_message_id === null
      ? []
      : [
          {
            id: row.last_message_id,
            direction: row.last_message_direction as MessageDirection,
            sender_type: row.last_message_sender_type as MessageSender,
            content: row.last_message_content as string,
            created_at: row.last_message_created_at as string,
          },
        ];
  return { ...assembleBase(row), last_message: lastMessage };
}

/** Linha do detalhe no formato de `ConversationDetailRow`. */
export function toConversationDetailRow(row: ConversationDetailSqlRow): ConversationDetailRow {
  return { ...assembleBase(row), assigned_at: row.assigned_at, resolved_at: row.resolved_at };
}

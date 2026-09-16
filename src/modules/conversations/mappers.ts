import type {
  ConversationAssignedMemberRow,
  ConversationChannelRow,
  ConversationContactRow,
  ConversationDetailRow,
  ConversationListRow,
  MessageHistoryRow,
} from "./rows";
import type {
  ConversationAssignee,
  ConversationChannelSummary,
  ConversationContactSummary,
  ConversationDetail,
  ConversationLastMessagePreview,
  ConversationListItem,
  MessageHistoryItem,
} from "./types";

/**
 * Mapeamento de linhas cruas do PostgREST (`rows.ts`) para os tipos de
 * domínio (`types.ts`). Nenhuma função aqui toca o Supabase — só
 * transformação pura, testada com `node --test` (ver `mappers.test.ts`).
 * Sem `import "server-only"` de propósito: sem I/O, sem segredo — o limite
 * server-side real está em `queries.ts`, que importa este módulo.
 */

export const LAST_MESSAGE_EXCERPT_MAX_LENGTH = 140;

/**
 * Trecho de exibição da última mensagem: aparado e truncado com reticências.
 *
 * Corta por CODE POINT (`Array.from`), não por índice de `string.slice` —
 * `slice` conta unidades UTF-16 e pode cortar um par substituto (surrogate
 * pair) ao meio, por exemplo bem no meio de um emoji fora do BMP, deixando
 * um surrogate solto (caractere inválido) no fim do trecho.
 */
export function buildLastMessageExcerpt(
  content: string,
  maxLength: number = LAST_MESSAGE_EXCERPT_MAX_LENGTH,
): string {
  const trimmed = content.trim();
  const codePoints = Array.from(trimmed);
  if (codePoints.length <= maxLength) return trimmed;
  return `${codePoints.slice(0, maxLength).join("").trimEnd()}…`;
}

function mapContact(row: ConversationContactRow): ConversationContactSummary {
  return { id: row.id, name: row.name, phoneNumber: row.phone_number };
}

function mapChannel(row: ConversationChannelRow): ConversationChannelSummary {
  return { id: row.id, displayName: row.display_name, phoneNumber: row.phone_number };
}

function mapAssignee(
  row: ConversationAssignedMemberRow | null,
): ConversationAssignee | null {
  if (!row) return null;
  return { userId: row.user_id, fullName: row.profile.full_name };
}

export function mapConversationListRow(row: ConversationListRow): ConversationListItem {
  const lastMessageRow = row.last_message[0] ?? null;
  const lastMessage: ConversationLastMessagePreview | null = lastMessageRow
    ? {
        id: lastMessageRow.id,
        direction: lastMessageRow.direction,
        sender: lastMessageRow.sender_type,
        excerpt: buildLastMessageExcerpt(lastMessageRow.content),
        createdAt: lastMessageRow.created_at,
      }
    : null;

  return {
    id: row.id,
    status: row.status,
    contact: mapContact(row.contact),
    channel: mapChannel(row.whatsapp_account),
    assignee: mapAssignee(row.assigned_member),
    startedAt: row.started_at,
    lastMessageAt: row.last_message_at,
    lastMessage,
  };
}

export function mapConversationDetailRow(row: ConversationDetailRow): ConversationDetail {
  return {
    id: row.id,
    status: row.status,
    contact: mapContact(row.contact),
    channel: mapChannel(row.whatsapp_account),
    assignee: mapAssignee(row.assigned_member),
    startedAt: row.started_at,
    lastMessageAt: row.last_message_at,
    assignedAt: row.assigned_at,
    resolvedAt: row.resolved_at,
  };
}

export function mapMessageRow(row: MessageHistoryRow): MessageHistoryItem {
  return {
    id: row.id,
    direction: row.direction,
    sender: row.sender_type,
    messageType: row.message_type,
    content: row.content,
    deliveryStatus: row.delivery_status,
    senderUserId: row.sender_user_id,
    createdAt: row.created_at,
  };
}

import type {
  ConversationStatus,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSender,
  MessageType,
} from "@/lib/types/database";

/**
 * Tipos de domínio (view models) da DAL de leitura de conversas — Ciclo 2,
 * Etapa 4. Desacoplados do formato bruto retornado pelo PostgREST: os
 * mapeadores em `mappers.ts` convertem as linhas cruas (`rows.ts`) para estes
 * tipos antes de qualquer retorno público.
 */

/**
 * Filtro de status para a lista de conversas. `"open"` é o agregado
 * "conversa aberta" (`status <> 'resolved'`) — não é um quinto status do
 * banco, apenas uma forma de pedir o filtro na DAL.
 */
export type ConversationStatusFilter = ConversationStatus | "open";

export type ConversationContactSummary = {
  id: string;
  name: string | null;
  phoneNumber: string;
};

export type ConversationChannelSummary = {
  id: string;
  displayName: string | null;
  phoneNumber: string | null;
};

export type ConversationAssignee = {
  userId: string;
  fullName: string | null;
};

export type ConversationLastMessagePreview = {
  id: string;
  direction: MessageDirection;
  sender: MessageSender;
  /** Conteúdo truncado (ver `LAST_MESSAGE_EXCERPT_MAX_LENGTH` em mappers.ts). */
  excerpt: string;
  createdAt: string;
};

export type ConversationListItem = {
  id: string;
  status: ConversationStatus;
  contact: ConversationContactSummary;
  channel: ConversationChannelSummary;
  assignee: ConversationAssignee | null;
  startedAt: string;
  lastMessageAt: string;
  lastMessage: ConversationLastMessagePreview | null;
};

export type ConversationDetail = {
  id: string;
  status: ConversationStatus;
  contact: ConversationContactSummary;
  channel: ConversationChannelSummary;
  assignee: ConversationAssignee | null;
  startedAt: string;
  lastMessageAt: string;
  assignedAt: string | null;
  resolvedAt: string | null;
};

export type MessageHistoryItem = {
  id: string;
  direction: MessageDirection;
  sender: MessageSender;
  messageType: MessageType;
  content: string;
  deliveryStatus: MessageDeliveryStatus;
  senderUserId: string | null;
  createdAt: string;
};

export type ListConversationsParams = {
  status?: ConversationStatusFilter;
  /** Cursor opaco retornado por uma página anterior (`nextCursor`). */
  cursor?: string;
  limit?: number;
};

export type ListConversationMessagesParams = {
  /** Cursor opaco retornado por uma página anterior (`nextCursor`). */
  cursor?: string;
  limit?: number;
};

export type ConversationListPage = {
  items: ConversationListItem[];
  nextCursor: string | null;
};

export type MessageHistoryPage = {
  items: MessageHistoryItem[];
  nextCursor: string | null;
};

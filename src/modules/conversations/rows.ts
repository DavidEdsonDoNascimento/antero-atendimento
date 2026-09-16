import type {
  ConversationStatus,
  MessageDeliveryStatus,
  MessageDirection,
  MessageSender,
  MessageType,
} from "@/lib/types/database";

/**
 * Formatos brutos retornados pelo PostgREST para cada `select` desta DAL.
 * Espelham exatamente os campos pedidos em `queries.ts` — nunca são
 * expostos fora do módulo; `mappers.ts` os converte para os tipos de
 * domínio em `types.ts`.
 */

export type ConversationContactRow = {
  id: string;
  name: string | null;
  phone_number: string;
};

export type ConversationChannelRow = {
  id: string;
  display_name: string | null;
  phone_number: string | null;
};

export type ConversationAssignedProfileRow = {
  id: string;
  full_name: string | null;
};

/**
 * `organization_members` embutido a partir de `conversations` via
 * `conversations_assigned_user_id_fkey` — `null` quando a conversa não tem
 * atendente atribuído (`assigned_user_id is null`).
 */
export type ConversationAssignedMemberRow = {
  user_id: string;
  profile: ConversationAssignedProfileRow;
};

/**
 * `messages` embutido a partir de `conversations`. Sempre um array (relação
 * um-para-muitos no PostgREST), mas a consulta em `queries.ts` aplica
 * `order` + `limit(1)` escopados a esta tabela referenciada — o array nunca
 * tem mais de 1 item na prática.
 */
export type ConversationLastMessageRow = {
  id: string;
  direction: MessageDirection;
  sender_type: MessageSender;
  content: string;
  created_at: string;
};

export type ConversationListRow = {
  id: string;
  status: ConversationStatus;
  started_at: string;
  last_message_at: string;
  contact: ConversationContactRow;
  whatsapp_account: ConversationChannelRow;
  assigned_member: ConversationAssignedMemberRow | null;
  last_message: ConversationLastMessageRow[];
};

export type ConversationDetailRow = {
  id: string;
  status: ConversationStatus;
  started_at: string;
  last_message_at: string;
  assigned_at: string | null;
  resolved_at: string | null;
  contact: ConversationContactRow;
  whatsapp_account: ConversationChannelRow;
  assigned_member: ConversationAssignedMemberRow | null;
};

export type MessageHistoryRow = {
  id: string;
  direction: MessageDirection;
  sender_type: MessageSender;
  message_type: MessageType;
  content: string;
  delivery_status: MessageDeliveryStatus;
  sender_user_id: string | null;
  created_at: string;
};

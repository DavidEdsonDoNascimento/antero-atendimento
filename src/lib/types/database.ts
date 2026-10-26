/**
 * Tipos das linhas do banco (PostgreSQL próprio).
 *
 * Escritos à mão e mantidos em sincronia com as migrations em `db/migrations`.
 * Cada tipo `Row` espelha as colunas devolvidas pelas consultas explícitas de
 * `sql-queries.ts` de cada módulo (timestamps chegam como string ISO).
 */

export type OrganizationStatus = "active" | "inactive";
export type MemberRole = "owner" | "admin" | "attendant";
export type MemberStatus = "active" | "invited" | "disabled";
export type WhatsappProvider = "development" | "cloud_api";
export type WhatsappStatus = "connected" | "disconnected";
export type ConversationStatus = "bot" | "waiting" | "human" | "resolved";
export type MessageDirection = "inbound" | "outbound";
export type MessageSender = "contact" | "bot" | "user" | "system";
export type MessageType = "text";
export type MessageDeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";

export type Organization = {
  id: string;
  name: string;
  slug: string;
  status: OrganizationStatus;
  created_at: string;
  updated_at: string;
};

export type OrganizationMember = {
  id: string;
  organization_id: string;
  user_id: string;
  role: MemberRole;
  status: MemberStatus;
  created_at: string;
};

export type Profile = {
  id: string;
  email: string;
  full_name: string | null;
  is_platform_admin: boolean;
  created_at: string;
  updated_at: string;
};

export type WhatsappAccount = {
  id: string;
  organization_id: string;
  provider: WhatsappProvider;
  external_account_id: string | null;
  phone_number: string | null;
  display_name: string | null;
  status: WhatsappStatus;
  created_at: string;
  updated_at: string;
};

export type Contact = {
  id: string;
  organization_id: string;
  name: string | null;
  phone_number: string;
  created_at: string;
  updated_at: string;
};

export type Conversation = {
  id: string;
  organization_id: string;
  whatsapp_account_id: string;
  contact_id: string;
  status: ConversationStatus;
  assigned_user_id: string | null;
  assigned_at: string | null;
  started_at: string;
  last_message_at: string;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Message = {
  id: string;
  organization_id: string;
  conversation_id: string;
  whatsapp_account_id: string;
  external_message_id: string | null;
  direction: MessageDirection;
  sender_type: MessageSender;
  sender_user_id: string | null;
  message_type: MessageType;
  content: string;
  delivery_status: MessageDeliveryStatus;
  created_at: string;
};

/**
 * Tipos das linhas do banco (PostgreSQL próprio).
 *
 * Escritos à mão e mantidos em sincronia com as migrations em `db/migrations`.
 * Cada tipo `Row` espelha as colunas devolvidas pelas consultas explícitas de
 * `sql-queries.ts` de cada módulo (timestamps chegam como string ISO).
 */

export type OrganizationStatus = "active" | "inactive";
export type OrganizationModule = "atendimento" | "automacoes" | "campanhas" | "contatos";
export type MemberRole = "owner" | "admin" | "attendant";
export type MemberStatus = "active" | "invited" | "disabled";
export type WhatsappProvider = "development" | "cloud_api";
export type WhatsappStatus = "connected" | "disconnected";
export type ConversationStatus = "bot" | "waiting" | "human" | "resolved";
export type MessageDirection = "inbound" | "outbound";
export type MessageSender = "contact" | "bot" | "user" | "system";
export type MessageType = "text" | "image" | "interactive";
export type MessageDeliveryStatus =
  | "pending"
  | "sent"
  | "delivered"
  | "read"
  | "failed";
export type ConversationEventType = "assigned" | "resolved" | "reopened" | "automation_started" | "handed_off";
export type AutomationFlowStatus = "draft" | "active" | "paused";
export type AutomationSessionStatus = "active" | "handed_off" | "completed" | "interrupted" | "failed";
/** `audit_events.action` e `actor_kind` (0013): text + CHECK, ampliáveis. A leitura aceita valores desconhecidos. */
export type AuditAction = "organization.suspended" | "organization.reactivated" | "module.enabled" | "module.disabled";
export type AuditActorKind = "platform_admin" | "maintenance";

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
  /**
   * BSUID da Meta (`user_id`), opcional (0015). Escopo do portfólio
   * empresarial, não da organização: sem unicidade; gravado só quando o campo
   * está vazio, nunca sobrescrito. Divergência retém a mensagem (identity_conflict).
   */
  whatsapp_user_id: string | null;
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
  /** Chave de idempotência do envio pelo atendente (0008); nula nas demais. */
  client_message_id: string | null;
  /** Ação completa de uma resposta da automação (0010); nula nas demais. */
  payload: unknown | null;
  /** Execução da automação que produziu esta resposta (0010). */
  automation_execution_id: string | null;
  /** Tipo original da Meta (`messages[].type`) de uma recebida pelo webhook (0015); nulo nas demais. */
  provider_message_type: string | null;
  /** Horário da Meta, só quando válido em relação à chegada do webhook (0015). */
  provider_sent_at: string | null;
  /** Chegada do webhook (`webhook_events.received_at`) de uma recebida pela Cloud API (0015). */
  webhook_received_at: string | null;
  /** Id escolhido numa resposta de lista/botão (`interactive.*_reply.id`, 0015). */
  interaction_reply_id: string | null;
  created_at: string;
};

/** Motivo de uma mensagem do webhook retida em vez de ingerida (0015). */
export type WebhookHoldReason = "missing_phone" | "invalid_phone" | "invalid_content" | "content_too_long" | "identity_conflict";
export type WebhookHoldStatus = "held" | "resolved" | "discarded";
/** `complete`: o elemento como veio; `size_limited`: acima do limite, só identificação (incompleto). */
export type WebhookHoldStorage = "complete" | "size_limited";

/** Mensagem válida do webhook que não pôde virar conversa com segurança (0015). Sem acesso pela aplicação. */
export type WebhookMessageHold = {
  id: string;
  organization_id: string;
  whatsapp_account_id: string;
  /** Evento de origem; nulo depois que a retenção de 30 dias dos eventos o remover. */
  event_id: string | null;
  wamid: string;
  reason: WebhookHoldReason;
  status: WebhookHoldStatus;
  provider_message_type: string | null;
  provider_user_id: string | null;
  provider_sent_at: string | null;
  webhook_received_at: string;
  message: unknown;
  message_storage: WebhookHoldStorage;
  /** Tamanho (bytes UTF-8) do elemento original, mesmo quando a cópia é limitada. */
  message_original_bytes: number;
  /** sha256 do texto canônico (jsonb) do elemento original. */
  message_sha256: string;
  contact: unknown | null;
  contact_storage: WebhookHoldStorage | null;
  contact_original_bytes: number | null;
  created_at: string;
  resolved_at: string | null;
  resolved_message_id: string | null;
};

export type ConversationEvent = {
  id: string;
  organization_id: string;
  conversation_id: string;
  event_type: ConversationEventType;
  user_id: string | null;
  created_at: string;
};

export type AutomationFlow = {
  id: string;
  organization_id: string;
  slug: string;
  name: string;
  status: AutomationFlowStatus;
  is_entry: boolean;
  draft_revision: number;
  published_version_id: string | null;
  created_at: string;
  updated_at: string;
};

export type AutomationSession = {
  id: string;
  organization_id: string;
  conversation_id: string;
  flow_id: string;
  flow_version_id: string;
  status: AutomationSessionStatus;
  current_step_id: string | null;
  state: unknown;
  revision: number;
  end_reason: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
};

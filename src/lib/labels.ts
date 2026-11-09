import type { BadgeTone } from "@/components/ui/badge";
import type {
  AutomationFlowStatus,
  AutomationSessionStatus,
  ConversationEventType,
  ConversationStatus,
  MemberRole,
  MemberStatus,
  MessageDeliveryStatus,
  MessageSender,
  OrganizationStatus,
  WhatsappProvider,
  WhatsappStatus,
} from "@/lib/types/database";
import type { ConversationStatusFilter } from "@/modules/conversations/types";

export const roleLabel: Record<MemberRole, string> = {
  owner: "Proprietário",
  admin: "Administrador",
  attendant: "Atendente",
};

export const roleTone: Record<MemberRole, BadgeTone> = {
  owner: "gold",
  admin: "blue",
  attendant: "zinc",
};

export const memberStatusLabel: Record<MemberStatus, string> = {
  active: "Ativo",
  invited: "Convidado",
  disabled: "Desativado",
};

export const memberStatusTone: Record<MemberStatus, BadgeTone> = {
  active: "green",
  invited: "amber",
  disabled: "zinc",
};

export const orgStatusLabel: Record<OrganizationStatus, string> = {
  active: "Ativa",
  inactive: "Suspensa",
};

export const orgStatusTone: Record<OrganizationStatus, BadgeTone> = {
  active: "green",
  inactive: "zinc",
};

export const whatsappProviderLabel: Record<WhatsappProvider, string> = {
  development: "Desenvolvimento (simulado)",
  cloud_api: "WhatsApp Cloud API",
};

export const whatsappStatusLabel: Record<WhatsappStatus, string> = {
  connected: "Conectado",
  disconnected: "Desconectado",
};

export const whatsappStatusTone: Record<WhatsappStatus, BadgeTone> = {
  connected: "green",
  disconnected: "zinc",
};

/** Status de uma conversa individual — usado no badge da lista e do detalhe. */
export const conversationStatusLabel: Record<ConversationStatus, string> = {
  bot: "Atendimento automático",
  waiting: "Aguardando atendimento",
  human: "Em atendimento humano",
  resolved: "Resolvida",
};

export const conversationStatusTone: Record<ConversationStatus, BadgeTone> = {
  bot: "blue",
  waiting: "amber",
  human: "gold",
  resolved: "green",
};

/**
 * Rótulo dos filtros de status da caixa de conversas — inclui `"open"`, o
 * agregado "conversa aberta" que a DAL aceita além dos quatro status reais
 * (ver `ConversationStatusFilter` em `modules/conversations/types.ts`).
 */
export const conversationStatusFilterLabel: Record<ConversationStatusFilter, string> = {
  open: "Em aberto",
  bot: "Bot",
  waiting: "Aguardando",
  human: "Em atendimento",
  resolved: "Resolvidas",
};

/** Remetente de uma mensagem — nunca resolvido para o nome do atendente (evita expor identificadores). */
export const messageSenderLabel: Record<MessageSender, string> = {
  contact: "Contato",
  bot: "Automação",
  user: "Atendente",
  system: "Sistema",
};

/** Situação de envio de uma mensagem enviada pela empresa. */
export const messageDeliveryLabel: Record<MessageDeliveryStatus, string> = {
  pending: "Enviando…",
  sent: "Enviada",
  delivered: "Entregue",
  read: "Lida",
  failed: "Falhou",
};

/** Registro de atendimento da conversa (`conversation_events`). */
export const conversationEventLabel: Record<ConversationEventType, string> = {
  assigned: "assumiu o atendimento",
  resolved: "resolveu o atendimento",
  reopened: "Nova mensagem do cliente reabriu a conversa",
  automation_started: "A automação começou a responder",
  handed_off: "A automação passou a conversa para a equipe",
};

/** Eventos sem usuário, descritos por inteiro (quem agiu foi o cliente ou a automação). */
export const conversationEventWithoutUserLabel: Partial<Record<ConversationEventType, string>> = {
  reopened: conversationEventLabel.reopened,
  automation_started: conversationEventLabel.automation_started,
  handed_off: conversationEventLabel.handed_off,
  // bot -> resolved só acontece pela conclusão da automação (0010).
  resolved: "A automação concluiu o atendimento",
};

/** Situação de uma sessão de automação, como o atendente a vê. */
export const automationSessionStatusLabel: Record<AutomationSessionStatus, string> = {
  active: "Em andamento",
  handed_off: "Encaminhada para a equipe",
  completed: "Concluída",
  interrupted: "Interrompida",
  failed: "Falhou",
};

export const automationFlowStatusLabel: Record<AutomationFlowStatus, string> = {
  draft: "Rascunho",
  active: "Ativo",
  paused: "Pausado",
};

export const automationFlowStatusTone: Record<AutomationFlowStatus, BadgeTone> = {
  draft: "zinc",
  active: "green",
  paused: "amber",
};

/** Motivo do fim de uma sessão (`automation_sessions.end_reason`). */
export const automationEndReasonLabel: Record<string, string> = {
  flow_end: "fim do fluxo",
  handoff_step: "etapa de encaminhamento",
  human_requested: "cliente pediu atendente",
  invalid_attempts: "respostas inválidas seguidas",
  turn_limit: "limite de respostas da sessão",
  handoff_unavailable: "sem atendimento humano",
  human_takeover: "atendente assumiu",
  module_disabled: "módulo Automações desligado",
  flow_paused: "fluxo pausado",
};

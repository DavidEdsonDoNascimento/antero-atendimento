import type { BadgeTone } from "@/components/ui/badge";
import type {
  ConversationStatus,
  MemberRole,
  MemberStatus,
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
  inactive: "Inativa",
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
  bot: "Bot",
  user: "Atendente",
  system: "Sistema",
};

import type { BadgeTone } from "@/components/ui/badge";
import type {
  MemberRole,
  MemberStatus,
  OrganizationStatus,
  WhatsappProvider,
  WhatsappStatus,
} from "@/lib/types/database";

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

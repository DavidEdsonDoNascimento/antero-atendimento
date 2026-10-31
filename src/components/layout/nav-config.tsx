import type { ComponentType, SVGProps } from "react";

import {
  IconCampaigns,
  IconContacts,
  IconConversations,
  IconFlows,
  IconOverview,
  IconSettings,
  IconShield,
  IconTeam,
} from "@/components/ui/icons";
import type { OrganizationModule } from "@/lib/types/database";

export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Rótulo quando a funcionalidade ainda está em desenvolvimento. */
  soon?: string;
  /** Módulo exigido; sem ele, o item faz parte do núcleo. Só filtra o menu: a proteção é `requireModule`. */
  module?: OrganizationModule;
};

export const mainNav: NavItem[] = [
  { href: "/visao-geral", label: "Visão geral", icon: IconOverview },
  { href: "/conversas", label: "Conversas", icon: IconConversations, module: "atendimento" },
  { href: "/contatos", label: "Contatos", icon: IconContacts, soon: "Em breve", module: "contatos" },
  { href: "/fluxos", label: "Automações", icon: IconFlows, soon: "Em breve", module: "automacoes" },
  { href: "/campanhas", label: "Campanhas", icon: IconCampaigns, soon: "Em breve", module: "campanhas" },
  { href: "/equipe", label: "Equipe", icon: IconTeam },
  { href: "/configuracoes", label: "Configurações", icon: IconSettings },
];

export const adminNav: NavItem = {
  href: "/admin",
  label: "Admin da plataforma",
  icon: IconShield,
};

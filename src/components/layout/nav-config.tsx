import type { ComponentType, SVGProps } from "react";

import {
  IconContacts,
  IconConversations,
  IconFlows,
  IconOverview,
  IconSettings,
  IconShield,
  IconTeam,
} from "@/components/ui/icons";

export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** Rótulo "Em breve" quando a funcionalidade chega em um ciclo futuro. */
  soon?: string;
};

export const mainNav: NavItem[] = [
  { href: "/visao-geral", label: "Visão geral", icon: IconOverview },
  {
    href: "/conversas",
    label: "Conversas",
    icon: IconConversations,
    soon: "Ciclo 2",
  },
  { href: "/contatos", label: "Contatos", icon: IconContacts, soon: "Ciclo 2" },
  { href: "/fluxos", label: "Fluxos", icon: IconFlows, soon: "Ciclo 3" },
  { href: "/equipe", label: "Equipe", icon: IconTeam },
  { href: "/configuracoes", label: "Configurações", icon: IconSettings },
];

export const adminNav: NavItem = {
  href: "/admin",
  label: "Admin da plataforma",
  icon: IconShield,
};

// Catálogo de módulos, puro (sem I/O), usado pelo menu, pelo painel e pelos
// testes. A autorização NÃO está aqui: é de `public.has_module` e
// `public.set_organization_module` (0007). `tests/db/organization-modules.test.ts`
// confere que este catálogo e o enum do banco têm os mesmos valores.
import type { OrganizationModule } from "../../lib/types/database";

export const ORGANIZATION_MODULES = [
  "atendimento",
  "automacoes",
  "campanhas",
  "contatos",
] as const satisfies readonly OrganizationModule[];

export type ModuleDefinition = {
  label: string;
  description: string;
  /** Módulos que precisam estar habilitados antes deste. Espelha a regra da função SQL. */
  requires: OrganizationModule[];
  /** Falso enquanto a página é só "em desenvolvimento": o painel avisa quem habilita. */
  implemented: boolean;
  /**
   * O módulo já funciona na plataforma, mas não por completo: texto mostrado a
   * quem habilita (painel) e a quem usa (página do módulo). Só descreve; não é
   * configuração por organização nem bloqueia nada. Remover quando deixar de valer.
   */
  limitation?: string;
  /** Rotas exclusivas do módulo; cada página delas chama `requireModule`. */
  routes: string[];
};

export const MODULE_CATALOG: Record<OrganizationModule, ModuleDefinition> = {
  atendimento: {
    label: "Atendimento",
    description: "Inbox e atendimento humano.",
    requires: [],
    implemented: true,
    routes: ["/conversas"],
  },
  automacoes: {
    label: "Automações",
    description: "Fluxos, menus e respostas automáticas.",
    requires: [],
    implemented: true,
    limitation:
      "O editor está disponível: dá para criar, editar, testar e publicar automações. O envio em conversas reais do WhatsApp ainda depende de integrações em desenvolvimento; por enquanto, o teste é pela prévia e pelo simulador.",
    routes: ["/fluxos"],
  },
  campanhas: {
    label: "Campanhas",
    description: "Criação e envio de campanhas.",
    requires: ["contatos"],
    implemented: false,
    routes: ["/campanhas"],
  },
  contatos: {
    label: "Contatos",
    description: "Gestão, importação e listas comerciais.",
    requires: [],
    implemented: false,
    routes: ["/contatos"],
  },
};

export function isOrganizationModule(value: unknown): value is OrganizationModule {
  return (ORGANIZATION_MODULES as readonly unknown[]).includes(value);
}

/** Módulos que exigem `module` habilitado. */
export function dependentsOf(module: OrganizationModule): OrganizationModule[] {
  return ORGANIZATION_MODULES.filter((other) => MODULE_CATALOG[other].requires.includes(module));
}

/** Por que esta alteração quebra a dependência entre módulos. */
export function moduleBlockReason(module: OrganizationModule, enabling: boolean): string {
  const others = (enabling ? MODULE_CATALOG[module].requires : dependentsOf(module))
    .map((other) => MODULE_CATALOG[other].label)
    .join(", ");
  const { label } = MODULE_CATALOG[module];
  return enabling ? `Habilite ${others} antes de habilitar ${label}.` : `Desabilite ${others} antes de desabilitar ${label}.`;
}

/** A alteração é bloqueada pelo estado atual? Só orienta a tela; quem decide é o banco. */
export function isModuleChangeBlocked(
  module: OrganizationModule,
  enabling: boolean,
  enabled: readonly OrganizationModule[],
): boolean {
  return enabling
    ? MODULE_CATALOG[module].requires.some((other) => !enabled.includes(other))
    : dependentsOf(module).some((other) => enabled.includes(other));
}

/** Itens de menu disponíveis: os do núcleo (sem `module`) e os de módulos habilitados. */
export function filterByModules<T extends { module?: OrganizationModule }>(
  items: readonly T[],
  enabled: readonly OrganizationModule[],
): T[] {
  return items.filter((item) => !item.module || enabled.includes(item.module));
}

/** Resultado de `setOrganizationModuleAction`, exibido pelo painel. */
export type ModuleActionState =
  | { status: "idle" }
  | { status: "success" | "error"; message: string };

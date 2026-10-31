"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/dal";
import { AccessDeniedError } from "@/lib/db";

import { ModuleDependencyError, OrganizationNotFoundError } from "./errors";
import { MODULE_CATALOG, ORGANIZATION_MODULES, moduleBlockReason, type ModuleActionState } from "./modules";
import { setOrganizationModule, setOrganizationStatus } from "./sql-queries";

const inputSchema = z.object({
  organizationId: z.uuid(),
  status: z.enum(["active", "inactive"]),
});

/**
 * Suspende ou reativa uma organização. Server Actions aceitam POST direto, sem
 * passar pela interface: o papel é conferido aqui (DAL) e de novo no banco
 * (`public.set_organization_status`), e o `userId` sai só da sessão validada.
 */
export async function setOrganizationStatusAction(formData: FormData): Promise<void> {
  const profile = await requirePlatformAdmin();
  const input = inputSchema.parse({
    organizationId: formData.get("organizationId"),
    status: formData.get("status"),
  });
  await setOrganizationStatus({ userId: profile.id, ...input });
  revalidatePath("/admin");
}

const moduleInputSchema = z.object({
  organizationId: z.uuid(),
  module: z.enum(ORGANIZATION_MODULES),
  enabled: z.enum(["true", "false"]).transform((value) => value === "true"),
});

/**
 * Habilita ou desabilita um módulo. Mesmo cuidado de `setOrganizationStatusAction`:
 * papel conferido aqui e no banco, `userId` só da sessão. O id da organização vem
 * do formulário, e isso basta porque o admin da plataforma opera em qualquer uma;
 * quem não é admin não passa de `requirePlatformAdmin`.
 */
export async function setOrganizationModuleAction(
  _previous: ModuleActionState,
  formData: FormData,
): Promise<ModuleActionState> {
  const profile = await requirePlatformAdmin();
  const input = moduleInputSchema.safeParse({
    organizationId: formData.get("organizationId"),
    module: formData.get("module"),
    enabled: formData.get("enabled"),
  });
  if (!input.success) return { status: "error", message: "Dados inválidos. Recarregue a página e tente novamente." };

  const { module, enabled } = input.data;
  const { label } = MODULE_CATALOG[module];
  try {
    await setOrganizationModule({ userId: profile.id, ...input.data });
  } catch (error) {
    if (error instanceof ModuleDependencyError) {
      return { status: "error", message: moduleBlockReason(module, enabled) };
    }
    if (error instanceof OrganizationNotFoundError) return { status: "error", message: "Organização não encontrada." };
    if (error instanceof AccessDeniedError) return { status: "error", message: "Você não tem permissão para esta operação." };
    console.error(error);
    return { status: "error", message: "Não foi possível salvar. Tente novamente." };
  }

  // O layout também lê os módulos: o menu de quem está salvando acompanha.
  revalidatePath("/", "layout");
  return { status: "success", message: `${label} ${enabled ? "habilitado" : "desabilitado"}.` };
}

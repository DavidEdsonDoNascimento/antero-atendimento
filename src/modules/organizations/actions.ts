"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requirePlatformAdmin } from "@/lib/auth/dal";
import { AccessDeniedError } from "@/lib/db";
import { logSecurityEvent } from "@/lib/security-log";
import type { OrganizationStatus } from "@/lib/types/database";

import { ModuleDependencyError, OrganizationNotFoundError } from "./errors";
import { MODULE_CATALOG, ORGANIZATION_MODULES, moduleBlockReason, type ModuleActionState } from "./modules";
import { setOrganizationModule, setOrganizationStatus } from "./sql-queries";

const inputSchema = z.object({
  organizationId: z.uuid(),
  status: z.enum(["active", "inactive"]),
});

const INVALID_INPUT = "Dados inválidos. Recarregue a página e tente novamente.";
const NOT_ALLOWED = "Você não tem permissão para esta operação.";
const NOT_FOUND = "Organização não encontrada.";
const UNEXPECTED = "Não foi possível salvar. Tente novamente.";

/**
 * Suspende ou reativa uma organização. Server Actions aceitam POST direto, sem
 * passar pela interface: o papel é conferido aqui (DAL) e de novo no banco
 * (`public.set_organization_status`), e o `userId` sai só da sessão validada.
 * Mesmo padrão de `setOrganizationModuleAction`: devolve uma mensagem em vez de
 * levar à página de erro, e registra as recusas no log de segurança.
 */
export async function setOrganizationStatusAction(
  _previous: ModuleActionState,
  formData: FormData,
): Promise<ModuleActionState> {
  const profile = await requirePlatformAdmin();
  const rawOrganizationId = formData.get("organizationId");
  const input = inputSchema.safeParse({ organizationId: rawOrganizationId, status: formData.get("status") });
  if (!input.success) {
    logSecurityEvent({ action: "organization.set_status", reason: "invalid_input", userId: profile.id, organizationId: rawOrganizationId });
    return { status: "error", message: INVALID_INPUT };
  }

  let status: OrganizationStatus;
  try {
    status = await setOrganizationStatus({ userId: profile.id, ...input.data });
  } catch (error) {
    const denial = { action: "organization.set_status", userId: profile.id, organizationId: input.data.organizationId } as const;
    if (error instanceof AccessDeniedError) {
      logSecurityEvent({ ...denial, reason: "access_denied", sqlState: "42501" });
      return { status: "error", message: NOT_ALLOWED };
    }
    if (error instanceof OrganizationNotFoundError) {
      logSecurityEvent({ ...denial, reason: "organization_not_found", sqlState: "P0002" });
      return { status: "error", message: NOT_FOUND };
    }
    console.error(error);
    return { status: "error", message: UNEXPECTED };
  }

  // A lista e o detalhe de cada organização mostram a situação.
  revalidatePath("/admin", "layout");
  return { status: "success", message: status === "inactive" ? "Organização suspensa." : "Organização reativada." };
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
  if (!input.success) {
    logSecurityEvent({
      action: "organization.set_module",
      reason: "invalid_input",
      userId: profile.id,
      organizationId: formData.get("organizationId"),
    });
    return { status: "error", message: INVALID_INPUT };
  }

  const { module, enabled } = input.data;
  const { label } = MODULE_CATALOG[module];
  try {
    await setOrganizationModule({ userId: profile.id, ...input.data });
  } catch (error) {
    if (error instanceof ModuleDependencyError) {
      return { status: "error", message: moduleBlockReason(module, enabled) };
    }
    const denial = { action: "organization.set_module", userId: profile.id, organizationId: input.data.organizationId } as const;
    if (error instanceof OrganizationNotFoundError) {
      logSecurityEvent({ ...denial, reason: "organization_not_found", sqlState: "P0002" });
      return { status: "error", message: NOT_FOUND };
    }
    if (error instanceof AccessDeniedError) {
      logSecurityEvent({ ...denial, reason: "access_denied", sqlState: "42501" });
      return { status: "error", message: NOT_ALLOWED };
    }
    console.error(error);
    return { status: "error", message: UNEXPECTED };
  }

  // O layout também lê os módulos: o menu de quem está salvando acompanha.
  revalidatePath("/", "layout");
  return { status: "success", message: `${label} ${enabled ? "habilitado" : "desabilitado"}.` };
}

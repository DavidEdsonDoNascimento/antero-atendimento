import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { organizationContextOf, requireModule, type ActiveContext } from "@/lib/auth/dal";
import type { OrganizationContext } from "@/lib/db";

/**
 * Contexto das telas de edição: módulo Automações e owner/admin (o banco
 * confere de novo em cada ação). Id que não é uuid → 404, sem consulta.
 */
export async function requireFlowEditor(rawFlowId: string): Promise<{
  active: ActiveContext;
  context: OrganizationContext;
  flowId: string;
  canEdit: boolean;
}> {
  const active = await requireModule("automacoes");
  const flowId = z.uuid().safeParse(rawFlowId);
  if (!flowId.success) notFound();
  return {
    active,
    context: organizationContextOf(active),
    flowId: flowId.data,
    canEdit: active.role === "owner" || active.role === "admin",
  };
}

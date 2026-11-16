import "server-only";

import { notFound } from "next/navigation";
import { z } from "zod";

import { organizationContextOf, type ActiveContext } from "@/lib/auth/dal";
import type { OrganizationContext } from "@/lib/db";

/**
 * Contexto das telas de edição, a partir do contexto com o módulo Automações
 * (cada página chama `requireModule("automacoes")`, regra conferida em
 * modules.test.ts): owner/admin edita (o banco confere de novo em cada ação).
 * Id que não é uuid → 404, sem consulta.
 */
export function flowEditorContext(active: ActiveContext, rawFlowId: string): {
  active: ActiveContext;
  context: OrganizationContext;
  flowId: string;
  canEdit: boolean;
} {
  const flowId = z.uuid().safeParse(rawFlowId);
  if (!flowId.success) notFound();
  return {
    active,
    context: organizationContextOf(active),
    flowId: flowId.data,
    canEdit: active.role === "owner" || active.role === "admin",
  };
}

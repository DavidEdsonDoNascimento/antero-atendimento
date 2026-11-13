import "server-only";

import { sqlStateOf, withModuleTransaction, type OrganizationContext } from "@/lib/db";

// Extensão .ts explícita nas importações de VALOR (ver nota em cursor.ts).
import { parseFlowDefinition } from "./definition.ts";

/**
 * Configuração de fluxos: gravar o rascunho e publicar. É o contrato que o
 * editor (E3B) vai usar; nesta entrega só a ferramenta de desenvolvimento e os
 * testes chamam. A definição é validada AQUI, com o mesmo schema que o motor
 * usa, e o banco confere papel (owner/admin), módulo Automações e organização
 * (`save_automation_flow`/`publish_automation_flow`, 0010).
 */

export type FlowCommandErrorCode =
  | "invalid_definition"
  | "entry_conflict"
  | "draft_changed"
  | "not_published"
  | "not_found"
  | "access_denied";

export class FlowCommandError extends Error {
  readonly code: FlowCommandErrorCode;
  readonly issues: { path: string; message: string }[];
  constructor(code: FlowCommandErrorCode, issues: { path: string; message: string }[] = [], options?: ErrorOptions) {
    super(`Fluxo recusado: ${code}.`, options);
    this.name = "FlowCommandError";
    this.code = code;
    this.issues = issues;
  }
}

const SQLSTATE_CODES: Record<string, FlowCommandErrorCode> = {
  "28000": "access_denied",
  "42501": "access_denied",
  P0002: "not_found",
  AU001: "entry_conflict",
  AU002: "draft_changed",
  AU003: "invalid_definition",
  AU004: "not_published",
};

async function run<T>(context: OrganizationContext, work: Parameters<typeof withModuleTransaction<T>>[2]): Promise<T> {
  try {
    return await withModuleTransaction(context, "automacoes", work);
  } catch (error) {
    const code = SQLSTATE_CODES[sqlStateOf(error) ?? ""];
    if (code) throw new FlowCommandError(code, [], { cause: error });
    throw error;
  }
}

export type SavedFlow = { flowId: string; draftRevision: number; created: boolean };

/** Grava (cria ou atualiza pelo identificador) o rascunho de um fluxo, depois de validá-lo. */
export async function saveFlowDraft(
  context: OrganizationContext,
  input: { slug: string; name: string; definition: unknown; isEntry: boolean },
): Promise<SavedFlow> {
  const parsed = parseFlowDefinition(input.definition);
  if (!parsed.ok) throw new FlowCommandError("invalid_definition", parsed.issues);
  return run(context, async (tx) => {
    const { rows } = await tx.query<{ flow_id: string; draft_revision: number; created: boolean }>(
      "SELECT flow_id, draft_revision, created FROM public.save_automation_flow($1::uuid, $2::text, $3::text, $4::jsonb, $5::boolean)",
      [context.organizationId, input.slug, input.name, JSON.stringify(parsed.definition), input.isEntry],
    );
    return { flowId: rows[0].flow_id, draftRevision: rows[0].draft_revision, created: rows[0].created };
  });
}

/**
 * Publica o rascunho atual como nova versão imutável. Valida de novo o rascunho
 * gravado e publica exatamente essa revisão: outra gravação no meio é recusada.
 */
export async function publishFlow(context: OrganizationContext, flowId: string): Promise<{ versionId: string; version: number }> {
  return run(context, async (tx) => {
    const draft = (
      await tx.query<{ draft_definition: unknown; draft_revision: number }>(
        "SELECT draft_definition, draft_revision FROM public.automation_flows WHERE organization_id = $1::uuid AND id = $2::uuid",
        [context.organizationId, flowId],
      )
    ).rows[0];
    if (!draft) throw new FlowCommandError("not_found");
    const parsed = parseFlowDefinition(draft.draft_definition);
    if (!parsed.ok) throw new FlowCommandError("invalid_definition", parsed.issues);
    const { rows } = await tx.query<{ version_id: string; version: number }>(
      "SELECT version_id, version FROM public.publish_automation_flow($1::uuid, $2::uuid, $3::integer)",
      [context.organizationId, flowId, draft.draft_revision],
    );
    return { versionId: rows[0].version_id, version: rows[0].version };
  });
}

/** Ativa ou pausa um fluxo publicado. Pausar interrompe as sessões na mensagem seguinte. */
export async function setFlowStatus(context: OrganizationContext, flowId: string, status: "active" | "paused"): Promise<void> {
  await run(context, (tx) =>
    tx.query("SELECT public.set_automation_flow_status($1::uuid, $2::uuid, $3::public.automation_flow_status)", [
      context.organizationId,
      flowId,
      status,
    ]),
  );
}

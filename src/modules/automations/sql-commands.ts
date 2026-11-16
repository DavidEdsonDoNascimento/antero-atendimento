import "server-only";

import { randomBytes } from "node:crypto";

import { sqlStateOf, withModuleTransaction, type DbTransaction, type OrganizationContext } from "@/lib/db";

// Extensão .ts explícita nas importações de VALOR (ver nota em cursor.ts).
import { flowMediaIds, parseFlowDefinition, parseFlowDraft, type FlowDefinition } from "./definition.ts";
import { cleanDefinition, starterDefinition } from "./editor.ts";
import { normalizeText } from "./text.ts";

/**
 * Configuração de fluxos: criar, gravar o rascunho, publicar, pausar, restaurar
 * uma versão e enviar imagens. É o contrato do editor (E3B) e da ferramenta de
 * desenvolvimento do simulador. O banco confere papel (owner/admin), módulo
 * Automações, organização ativa e organização do fluxo
 * (`save_automation_flow`/`publish_automation_flow`/`save_automation_media`,
 * 0010/0011); a definição é validada AQUI, com o mesmo schema do motor.
 *
 * Rascunho x publicação: o rascunho pode estar incompleto (o editor grava o
 * trabalho em andamento); publicar exige a definição inteira válida.
 */

export type FlowCommandErrorCode =
  | "invalid_definition"
  | "entry_conflict"
  | "draft_changed"
  | "not_published"
  | "not_found"
  | "access_denied"
  | "media_size"
  | "media_type"
  | "media_quota"
  | "media_unavailable";

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
  AU011: "media_size",
  AU012: "media_type",
  AU013: "media_quota",
};

async function run<T>(context: OrganizationContext, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  try {
    return await withModuleTransaction(context, "automacoes", work);
  } catch (error) {
    if (error instanceof FlowCommandError) throw error;
    const code = SQLSTATE_CODES[sqlStateOf(error) ?? ""];
    if (code) throw new FlowCommandError(code, [], { cause: error });
    throw error;
  }
}

/**
 * O que vai para `draft_definition`: a definição normalizada pelo schema quando
 * já é publicável; senão o rascunho como está, desde que seja uma definição v1.
 */
function draftToStore(definition: unknown): unknown {
  const parsed = parseFlowDefinition(definition);
  if (parsed.ok) return parsed.definition;
  const draft = parseFlowDraft(definition);
  if (!draft.ok) throw new FlowCommandError("invalid_definition", parsed.issues);
  return draft.draft;
}

export type SavedFlow = { flowId: string; draftRevision: number; created: boolean };

/**
 * `expectedRevision`: a revisão que quem edita carregou. Outra gravação no meio
 * (outro administrador) recusa com `draft_changed`, sem sobrescrever nada.
 * `null`: o fluxo precisa ser novo. Ausente: grava sobre o que houver (uso da
 * ferramenta de desenvolvimento).
 */
async function saveDraft(
  tx: DbTransaction,
  context: OrganizationContext,
  input: { slug: string; name: string; definition: unknown; isEntry: boolean; expectedRevision?: number | null },
): Promise<SavedFlow> {
  const { rows } = await tx.query<{ flow_id: string; draft_revision: number; created: boolean }>(
    "SELECT flow_id, draft_revision, created FROM public.save_automation_flow($1::uuid, $2::text, $3::text, $4::jsonb, $5::boolean)",
    [context.organizationId, input.slug, input.name, JSON.stringify(draftToStore(input.definition)), input.isEntry],
  );
  const saved = { flowId: rows[0].flow_id, draftRevision: rows[0].draft_revision, created: rows[0].created };
  // A gravação trava a linha do fluxo: se outra transação gravou antes, a
  // revisão devolvida pula um número. O erro desfaz esta gravação inteira.
  if (input.expectedRevision === null && !saved.created) throw new FlowCommandError("draft_changed");
  if (typeof input.expectedRevision === "number" && (saved.created || saved.draftRevision !== input.expectedRevision + 1)) {
    throw new FlowCommandError("draft_changed");
  }
  return saved;
}

/** Grava (cria ou atualiza pelo identificador) o rascunho de um fluxo. */
export async function saveFlowDraft(
  context: OrganizationContext,
  input: { slug: string; name: string; definition: unknown; isEntry: boolean; expectedRevision?: number | null },
): Promise<SavedFlow> {
  return run(context, (tx) => saveDraft(tx, context, input));
}

type FlowRow = { slug: string; draft_revision: number };

async function flowRow(tx: DbTransaction, context: OrganizationContext, flowId: string): Promise<FlowRow> {
  const row = (
    await tx.query<FlowRow>(
      "SELECT slug, draft_revision FROM public.automation_flows WHERE organization_id = $1::uuid AND id = $2::uuid",
      [context.organizationId, flowId],
    )
  ).rows[0];
  if (!row) throw new FlowCommandError("not_found");
  return row;
}

/** Grava o rascunho do editor sobre a revisão que ele carregou. */
export async function saveFlowDraftById(
  context: OrganizationContext,
  flowId: string,
  input: { name: string; definition: unknown; isEntry: boolean; expectedRevision: number },
): Promise<SavedFlow> {
  return run(context, async (tx) => {
    const { slug, draft_revision } = await flowRow(tx, context, flowId);
    if (draft_revision !== input.expectedRevision) throw new FlowCommandError("draft_changed");
    return saveDraft(tx, context, { ...input, slug });
  });
}

/** Identificador interno a partir do nome ("Atendimento de Sábado" → "atendimento-de-sabado-k3f9a2"). */
export function flowSlugFor(name: string): string {
  const base = normalizeText(name).replace(/[^a-z0-9 ]/g, "").trim().replace(/ +/g, "-").slice(0, 40).replace(/-+$/, "");
  const suffix = randomBytes(4).toString("hex");
  return base ? `${base}-${suffix}` : `automacao-${suffix}`;
}

/** Automação nova, já com um fluxo inicial que funciona (boas-vindas → menu → equipe). */
export async function createFlow(context: OrganizationContext, input: { name: string; isEntry: boolean }): Promise<SavedFlow> {
  return run(context, (tx) =>
    saveDraft(tx, context, {
      slug: flowSlugFor(input.name),
      name: input.name,
      definition: cleanDefinition(starterDefinition()),
      isEntry: input.isEntry,
      expectedRevision: null,
    }),
  );
}

/**
 * Toda imagem enviada (`mediaId`) do fluxo precisa existir em `automation_media`
 * DESTA organização. Inexistente e de outra organização dão o mesmo erro, sem
 * dizer qual dos dois (não revela imagens alheias). Roda na transação da
 * publicação, DEPOIS de `publish_automation_flow`, que confere o papel, trava a
 * linha do fluxo e recusa se a revisão mudou (AU002): o conteúdo conferido aqui
 * é exatamente o publicado, e o erro desfaz a versão criada. Imagens não são
 * alteradas nem apagadas pela aplicação, então a posse não muda até o COMMIT.
 */
async function assertMediaOwnership(
  tx: DbTransaction,
  context: OrganizationContext,
  definition: FlowDefinition,
): Promise<void> {
  const wanted = flowMediaIds(definition);
  if (wanted.length === 0) return;
  const { rows } = await tx.query<{ id: string }>(
    "SELECT id FROM public.automation_media WHERE organization_id = $1::uuid AND id = ANY($2::uuid[])",
    [context.organizationId, wanted],
  );
  if (rows.length !== wanted.length) throw new FlowCommandError("media_unavailable");
}

/**
 * Publica o rascunho atual como nova versão imutável. Valida de novo o rascunho
 * gravado e publica exatamente essa revisão: outra gravação no meio é recusada.
 * `expectedRevision`: a revisão que quem confirmou a publicação viu.
 */
export async function publishFlow(
  context: OrganizationContext,
  flowId: string,
  expectedRevision?: number,
): Promise<{ versionId: string; version: number }> {
  return run(context, async (tx) => {
    const draft = (
      await tx.query<{ draft_definition: unknown; draft_revision: number }>(
        "SELECT draft_definition, draft_revision FROM public.automation_flows WHERE organization_id = $1::uuid AND id = $2::uuid",
        [context.organizationId, flowId],
      )
    ).rows[0];
    if (!draft) throw new FlowCommandError("not_found");
    if (expectedRevision !== undefined && draft.draft_revision !== expectedRevision) throw new FlowCommandError("draft_changed");
    const parsed = parseFlowDefinition(draft.draft_definition);
    if (!parsed.ok) throw new FlowCommandError("invalid_definition", parsed.issues);
    const { rows } = await tx.query<{ version_id: string; version: number }>(
      "SELECT version_id, version FROM public.publish_automation_flow($1::uuid, $2::uuid, $3::integer)",
      [context.organizationId, flowId, draft.draft_revision],
    );
    // Depois do banco autorizar e travar o fluxo (papel, módulo, revisão): se a
    // imagem não for da organização, o erro desfaz a versão criada acima.
    await assertMediaOwnership(tx, context, parsed.definition);
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

/**
 * Restaura uma versão publicada: o conteúdo dela vira o RASCUNHO (nova revisão).
 * A versão antiga não muda e nada é publicado; publicar depois cria outra versão.
 */
export async function restoreFlowVersion(
  context: OrganizationContext,
  flowId: string,
  input: { version: number; expectedRevision: number },
): Promise<SavedFlow> {
  return run(context, async (tx) => {
    const flow = (
      await tx.query<{ slug: string; name: string; is_entry: boolean; draft_revision: number }>(
        "SELECT slug, name, is_entry, draft_revision FROM public.automation_flows WHERE organization_id = $1::uuid AND id = $2::uuid",
        [context.organizationId, flowId],
      )
    ).rows[0];
    if (!flow) throw new FlowCommandError("not_found");
    if (flow.draft_revision !== input.expectedRevision) throw new FlowCommandError("draft_changed");
    const version = (
      await tx.query<{ definition: unknown }>(
        `SELECT definition FROM public.automation_flow_versions
         WHERE organization_id = $1::uuid AND flow_id = $2::uuid AND version = $3::integer`,
        [context.organizationId, flowId, input.version],
      )
    ).rows[0];
    if (!version) throw new FlowCommandError("not_found");
    return saveDraft(tx, context, {
      slug: flow.slug,
      name: flow.name,
      definition: version.definition,
      isEntry: flow.is_entry,
      expectedRevision: input.expectedRevision,
    });
  });
}

/** Tamanho máximo de imagem (o da Cloud API) e formatos aceitos; o banco confere de novo. */
export const FLOW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const FLOW_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export type FlowImageType = (typeof FLOW_IMAGE_TYPES)[number];

/** Tipo pela assinatura do arquivo — o tipo que o navegador declara não é confiável. */
export function imageTypeOf(data: Uint8Array): FlowImageType | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (data.length >= png.length && png.every((byte, index) => data[index] === byte)) return "image/png";
  return null;
}

/** Envia uma imagem para os fluxos da organização (ou devolve a mesma, já enviada). */
export async function uploadFlowImage(
  context: OrganizationContext,
  input: { fileName: string; data: Buffer },
): Promise<{ mediaId: string; created: boolean }> {
  if (input.data.length === 0 || input.data.length > FLOW_IMAGE_MAX_BYTES) throw new FlowCommandError("media_size");
  const contentType = imageTypeOf(input.data);
  if (!contentType) throw new FlowCommandError("media_type");
  const fileName = input.fileName.trim().slice(0, 200) || "imagem";
  return run(context, async (tx) => {
    const { rows } = await tx.query<{ media_id: string; created: boolean }>(
      "SELECT media_id, created FROM public.save_automation_media($1::uuid, $2::text, $3::text, $4::bytea)",
      [context.organizationId, contentType, fileName, input.data],
    );
    return { mediaId: rows[0].media_id, created: rows[0].created };
  });
}

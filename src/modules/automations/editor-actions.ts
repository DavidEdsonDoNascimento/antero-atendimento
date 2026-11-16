"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import { organizationContextOf, requireModule, type ActiveContext } from "@/lib/auth/dal";
import { AccessDeniedError, ModuleDisabledError } from "@/lib/db";

import {
  createFlow,
  FLOW_IMAGE_MAX_BYTES,
  FlowCommandError,
  publishFlow,
  restoreFlowVersion,
  saveFlowDraftById,
  setFlowStatus,
  uploadFlowImage,
  type FlowCommandErrorCode,
} from "./sql-commands";

/**
 * Server Actions do editor de automações (E3B). Aceitam POST direto, sem a
 * tela: sessão, organização ativa e módulo vêm SÓ do DAL (`requireModule`), e o
 * banco confere de novo papel (owner/admin), módulo, organização ativa e a
 * organização do fluxo. Do formulário vêm apenas o fluxo, a revisão que a tela
 * carregou e o conteúdo — nunca organização, autor ou permissão.
 */

const MESSAGES: Record<FlowCommandErrorCode, string> = {
  invalid_definition: "O fluxo tem problemas que impedem a publicação. Corrija os itens indicados.",
  entry_conflict: "Outra automação já responde às conversas novas. Desmarque essa opção ou altere a outra automação.",
  draft_changed: "Outra pessoa salvou alterações nesta automação. Recarregue para ver a versão mais recente.",
  not_published: "Publique a automação antes de ativá-la.",
  not_found: "Automação não encontrada. Ela pode ter sido removida ou pertence a outra organização.",
  access_denied: "Só proprietários e administradores podem alterar automações.",
  media_size: "A imagem precisa ter até 5 MB.",
  media_type: "Envie uma imagem JPG ou PNG.",
  media_quota: "Sua organização atingiu o limite de imagens (100 imagens ou 100 MB).",
};

const ADMIN_ONLY = MESSAGES.access_denied;
const INVALID_INPUT = "Dados inválidos. Recarregue a página e tente novamente.";

type Failure = { status: "error" | "conflict"; message: string };

function failure(error: unknown): Failure {
  if (error instanceof FlowCommandError) {
    return { status: error.code === "draft_changed" ? "conflict" : "error", message: MESSAGES[error.code] };
  }
  if (error instanceof ModuleDisabledError) {
    return { status: "error", message: "O módulo Automações não está habilitado para sua organização." };
  }
  if (error instanceof AccessDeniedError) return { status: "error", message: ADMIN_ONLY };
  console.error(error);
  return { status: "error", message: "Não foi possível concluir a operação. Tente novamente." };
}

/** Owner/admin: a mensagem sai antes de ir ao banco, que confere de novo. */
async function requireFlowAdmin(): Promise<ActiveContext | null> {
  const context = await requireModule("automacoes");
  return context.role === "owner" || context.role === "admin" ? context : null;
}

function refresh(flowId?: string) {
  revalidatePath("/fluxos");
  if (flowId) revalidatePath(`/fluxos/${flowId}`, "layout");
}

const flowName = z.string().trim().min(1).max(120);

// ---------------------------------------------------------------------------
// Criar
// ---------------------------------------------------------------------------

export type CreateFlowState = { status: "idle" } | { status: "error"; message: string; fieldErrors?: { name?: string } };

export async function createFlowAction(_previous: CreateFlowState, formData: FormData): Promise<CreateFlowState> {
  const context = await requireFlowAdmin();
  if (!context) return { status: "error", message: ADMIN_ONLY };
  const name = flowName.safeParse(formData.get("name"));
  if (!name.success) {
    return { status: "error", message: "Revise o nome.", fieldErrors: { name: "Dê um nome de até 120 caracteres para a automação." } };
  }
  let flowId: string;
  try {
    ({ flowId } = await createFlow(organizationContextOf(context), { name: name.data, isEntry: formData.get("isEntry") === "on" }));
  } catch (error) {
    const { message } = failure(error);
    return { status: "error", message };
  }
  refresh();
  redirect(`/fluxos/${flowId}`);
}

// ---------------------------------------------------------------------------
// Salvar rascunho
// ---------------------------------------------------------------------------

/**
 * Todo estado leva a última gravação conhecida pela tela: `revision` (a próxima
 * gravação vai sobre ela) e `snapshot` (o conteúdo gravado, como a tela o
 * serializou — para saber se há alteração não salva). Numa falha, continuam os
 * da gravação anterior. São só eco para a mesma tela: o servidor confia apenas
 * no `expectedRevision` conferido pelo banco.
 */
export type SaveDraftState = {
  status: "idle" | "saved" | "error" | "conflict";
  message?: string;
  revision: number;
  snapshot: string;
};

const snapshotSchema = z.object({
  name: flowName,
  isEntry: z.boolean(),
  definition: z.unknown(),
});

const saveInputSchema = z.object({
  flowId: z.uuid(),
  expectedRevision: z.coerce.number().int().positive(),
  // Um rascunho tem até 256 KB no banco; a folga cobre a serialização.
  snapshot: z.string().min(2).max(400_000),
});

export async function saveDraftAction(previous: SaveDraftState | undefined, formData: FormData): Promise<SaveDraftState> {
  const last = { revision: previous?.revision ?? 0, snapshot: previous?.snapshot ?? "" };
  const context = await requireFlowAdmin();
  if (!context) return { status: "error", message: ADMIN_ONLY, ...last };
  const input = saveInputSchema.safeParse({
    flowId: formData.get("flowId"),
    expectedRevision: formData.get("expectedRevision"),
    snapshot: formData.get("snapshot"),
  });
  if (!input.success) return { status: "error", message: INVALID_INPUT, ...last };
  let snapshot: z.infer<typeof snapshotSchema>;
  try {
    const parsed = snapshotSchema.safeParse(JSON.parse(input.data.snapshot));
    if (!parsed.success) {
      const nameIssue = parsed.error.issues.some((issue) => issue.path[0] === "name");
      return { status: "error", message: nameIssue ? "Dê um nome de até 120 caracteres para a automação." : INVALID_INPUT, ...last };
    }
    snapshot = parsed.data;
  } catch {
    return { status: "error", message: INVALID_INPUT, ...last };
  }

  try {
    const saved = await saveFlowDraftById(organizationContextOf(context), input.data.flowId, {
      name: snapshot.name,
      definition: snapshot.definition,
      isEntry: snapshot.isEntry,
      expectedRevision: input.data.expectedRevision,
    });
    refresh(input.data.flowId);
    return { status: "saved", message: "Rascunho salvo.", revision: saved.draftRevision, snapshot: input.data.snapshot };
  } catch (error) {
    return { ...failure(error), ...last };
  }
}

// ---------------------------------------------------------------------------
// Publicar, pausar e reativar
// ---------------------------------------------------------------------------

export type PublishState = { status: "idle" } | { status: "published"; message: string; version: number } | Failure;

const publishInputSchema = z.object({ flowId: z.uuid(), expectedRevision: z.coerce.number().int().positive() });

export async function publishFlowAction(_previous: PublishState, formData: FormData): Promise<PublishState> {
  const context = await requireFlowAdmin();
  if (!context) return { status: "error", message: ADMIN_ONLY };
  const input = publishInputSchema.safeParse({ flowId: formData.get("flowId"), expectedRevision: formData.get("expectedRevision") });
  if (!input.success) return { status: "error", message: INVALID_INPUT };
  try {
    const { version } = await publishFlow(organizationContextOf(context), input.data.flowId, input.data.expectedRevision);
    refresh(input.data.flowId);
    return { status: "published", version, message: `Versão ${version} publicada. Novas conversas já usam esta versão.` };
  } catch (error) {
    return failure(error);
  }
}

export type FlowStatusState = { status: "idle" } | { status: "success"; message: string } | Failure;

const statusInputSchema = z.object({ flowId: z.uuid(), status: z.enum(["active", "paused"]) });

export async function setFlowStatusAction(_previous: FlowStatusState, formData: FormData): Promise<FlowStatusState> {
  const context = await requireFlowAdmin();
  if (!context) return { status: "error", message: ADMIN_ONLY };
  const input = statusInputSchema.safeParse({ flowId: formData.get("flowId"), status: formData.get("status") });
  if (!input.success) return { status: "error", message: INVALID_INPUT };
  try {
    await setFlowStatus(organizationContextOf(context), input.data.flowId, input.data.status);
    refresh(input.data.flowId);
    return {
      status: "success",
      message:
        input.data.status === "paused"
          ? "Automação pausada. Conversas em andamento passam para a equipe na próxima mensagem."
          : "Automação reativada.",
    };
  } catch (error) {
    return failure(error);
  }
}

// ---------------------------------------------------------------------------
// Restaurar versão
// ---------------------------------------------------------------------------

export type RestoreState = { status: "idle" } | Failure;

const restoreInputSchema = z.object({
  flowId: z.uuid(),
  version: z.coerce.number().int().positive(),
  expectedRevision: z.coerce.number().int().positive(),
});

export async function restoreVersionAction(_previous: RestoreState, formData: FormData): Promise<RestoreState> {
  const context = await requireFlowAdmin();
  if (!context) return { status: "error", message: ADMIN_ONLY };
  const input = restoreInputSchema.safeParse({
    flowId: formData.get("flowId"),
    version: formData.get("version"),
    expectedRevision: formData.get("expectedRevision"),
  });
  if (!input.success) return { status: "error", message: INVALID_INPUT };
  try {
    await restoreFlowVersion(organizationContextOf(context), input.data.flowId, {
      version: input.data.version,
      expectedRevision: input.data.expectedRevision,
    });
  } catch (error) {
    return failure(error);
  }
  refresh(input.data.flowId);
  redirect(`/fluxos/${input.data.flowId}?restaurada=${input.data.version}`);
}

// ---------------------------------------------------------------------------
// Imagens
// ---------------------------------------------------------------------------

export type UploadImageState =
  | { status: "idle" }
  | { status: "uploaded"; message: string; image: { id: string; fileName: string } }
  | Failure;

export async function uploadFlowImageAction(_previous: UploadImageState, formData: FormData): Promise<UploadImageState> {
  const context = await requireFlowAdmin();
  if (!context) return { status: "error", message: ADMIN_ONLY };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { status: "error", message: "Escolha uma imagem JPG ou PNG." };
  if (file.size > FLOW_IMAGE_MAX_BYTES) return { status: "error", message: MESSAGES.media_size };
  try {
    const data = Buffer.from(await file.arrayBuffer());
    const { mediaId, created } = await uploadFlowImage(organizationContextOf(context), { fileName: file.name, data });
    revalidatePath("/fluxos", "layout");
    return {
      status: "uploaded",
      message: created ? "Imagem enviada." : "Esta imagem já tinha sido enviada; usando a mesma.",
      image: { id: mediaId, fileName: file.name },
    };
  } catch (error) {
    return failure(error);
  }
}

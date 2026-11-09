"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { organizationContextOf, requireModule } from "@/lib/auth/dal";
import { AccessDeniedError } from "@/lib/db";

import { attendanceErrorMessage } from "./attendance";
import { AttendanceActionError } from "./errors";
import { claimConversation, resolveConversation, sendConversationReply } from "./sql-commands";

/**
 * Server Actions do atendimento humano. Aceitam POST direto, sem a interface:
 * a sessão e o módulo são conferidos aqui (`requireModule`) e de novo na
 * transação e na função do banco. O usuário e a organização saem SÓ do DAL; do
 * formulário vêm apenas a conversa, o texto e a chave de idempotência, que o
 * banco valida contra a organização ativa.
 */

export type AttendanceActionState =
  | { status: "idle" }
  | { status: "success" | "error"; message: string };

function failure(error: unknown): { status: "error"; message: string } {
  if (error instanceof AttendanceActionError) return { status: "error", message: attendanceErrorMessage[error.code] };
  if (error instanceof AccessDeniedError) return { status: "error", message: attendanceErrorMessage.access_denied };
  console.error(error);
  return { status: "error", message: "Não foi possível concluir a operação. Tente novamente." };
}

function refreshInbox() {
  // Lista e detalhe (/conversas e /conversas/[id]) leem o estado novo.
  revalidatePath("/conversas", "layout");
}

const statusInputSchema = z.object({
  conversationId: z.uuid(),
  operation: z.enum(["claim", "resolve"]),
});

/** Assumir ou resolver o atendimento (um único estado de retorno para os dois botões). */
export async function updateAttendanceAction(
  _previous: AttendanceActionState,
  formData: FormData,
): Promise<AttendanceActionState> {
  const context = organizationContextOf(await requireModule("atendimento"));
  const input = statusInputSchema.safeParse({
    conversationId: formData.get("conversationId"),
    operation: formData.get("operation"),
  });
  if (!input.success) return { status: "error", message: "Dados inválidos. Recarregue a página e tente novamente." };

  const { conversationId, operation } = input.data;
  try {
    if (operation === "claim") {
      const { changed } = await claimConversation(context, conversationId);
      refreshInbox();
      return { status: "success", message: changed ? "Você assumiu o atendimento." : "Esta conversa já está com você." };
    }
    const { changed } = await resolveConversation(context, conversationId);
    refreshInbox();
    return { status: "success", message: changed ? "Atendimento resolvido." : "Esta conversa já estava resolvida." };
  } catch (error) {
    refreshInbox();
    return failure(error);
  }
}

export type ReplyActionState = AttendanceActionState & {
  /** Chave do PRÓXIMO envio. Muda quando uma mensagem foi gravada; repetir o mesmo envio reaproveita a chave. */
  clientMessageId: string;
  /** Texto a manter no campo depois do envio (vazio quando a mensagem saiu). */
  draft: string;
};

const replyInputSchema = z.object({
  conversationId: z.uuid(),
  clientMessageId: z.uuid(),
  content: z.string().max(10_000),
});

export async function sendReplyAction(
  previous: ReplyActionState | undefined,
  formData: FormData,
): Promise<ReplyActionState> {
  const context = organizationContextOf(await requireModule("atendimento"));
  const input = replyInputSchema.safeParse({
    conversationId: formData.get("conversationId"),
    clientMessageId: formData.get("clientMessageId"),
    content: formData.get("content"),
  });
  if (!input.success) {
    return {
      status: "error",
      message: "Dados inválidos. Recarregue a página e tente novamente.",
      // POST direto, sem a tela, pode não trazer o estado anterior.
      clientMessageId: previous?.clientMessageId ?? randomUUID(),
      draft: typeof formData.get("content") === "string" ? String(formData.get("content")) : "",
    };
  }

  const { content } = input.data;
  try {
    const result = await sendConversationReply(context, input.data);
    refreshInbox();
    const next = randomUUID();
    if (!result.created) return { status: "success", message: "Esta mensagem já tinha sido enviada.", clientMessageId: next, draft: "" };
    if (result.deliveryStatus === "failed") {
      return {
        status: "error",
        message: "A mensagem não foi enviada e ficou registrada como falha. Você pode tentar de novo.",
        clientMessageId: next,
        draft: content,
      };
    }
    return {
      status: "success",
      message: result.simulated ? "Mensagem enviada (simulação — nada saiu para o WhatsApp)." : "Mensagem enviada.",
      clientMessageId: next,
      draft: "",
    };
  } catch (error) {
    refreshInbox();
    return { ...failure(error), clientMessageId: input.data.clientMessageId, draft: content };
  }
}

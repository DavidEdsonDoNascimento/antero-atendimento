"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/dal";
import { isSimulatorEnabled } from "@/lib/dev-environment";
import { AccessDeniedError } from "@/lib/db";

import { SIMULATED_INBOUND_PREFIX, isSimulatedInboundId, normalizeSimulatorPhone } from "./phone";
import { SimulatorIngestError, simulateInboundMessage } from "./sql-queries";

export type SimulatorActionState =
  | { status: "idle" }
  | { status: "error"; message: string }
  | {
      status: "success";
      message: string;
      conversationId: string;
      /** Id externo usado: reenviar com ele simula a reentrega da mesma mensagem. */
      externalMessageId: string;
      channelId: string;
      phoneNumber: string;
      content: string;
    };

const inputSchema = z.object({
  channelId: z.uuid(),
  phoneNumber: z.string().max(40),
  contactName: z.string().max(120),
  content: z.string().max(10_000),
  repeatExternalId: z.string().max(80),
});

const INGEST_REASONS: Record<string, string> = {
  account_not_found: "Canal não encontrado.",
  account_inactive: "O canal está desconectado.",
  account_wrong_provider: "Só canais de desenvolvimento aceitam mensagens simuladas.",
  invalid_phone_number: "Telefone inválido. Use o formato internacional, ex.: +55 11 91234-5678.",
  empty_content: "Escreva a mensagem do cliente.",
  content_too_long: "A mensagem passa de 4096 caracteres.",
  missing_external_message_id: "Falta o identificador da mensagem.",
};

/**
 * "Cliente envia mensagem" pelo canal de desenvolvimento. Recusa fora de
 * development/test ANTES de qualquer outra coisa (a rota nem existe no build de
 * produção, mas a ação também se protege). O usuário vem da sessão; a
 * organização é derivada do canal no banco, que exige owner/admin ativo.
 */
export async function simulateInboundAction(
  _previous: SimulatorActionState,
  formData: FormData,
): Promise<SimulatorActionState> {
  if (!isSimulatorEnabled()) return { status: "error", message: "Simulador indisponível neste ambiente." };
  const user = await requireUser();

  const input = inputSchema.safeParse({
    channelId: formData.get("channelId"),
    phoneNumber: formData.get("phoneNumber") ?? "",
    contactName: formData.get("contactName") ?? "",
    content: formData.get("content") ?? "",
    repeatExternalId: formData.get("repeatExternalId") ?? "",
  });
  if (!input.success) return { status: "error", message: "Dados inválidos. Confira o canal, o telefone e a mensagem." };

  const phoneNumber = normalizeSimulatorPhone(input.data.phoneNumber);
  if (!phoneNumber) return { status: "error", message: INGEST_REASONS.invalid_phone_number };

  const { repeatExternalId } = input.data;
  const externalMessageId = isSimulatedInboundId(repeatExternalId)
    ? repeatExternalId
    : `${SIMULATED_INBOUND_PREFIX}${randomUUID()}`;

  try {
    const result = await simulateInboundMessage(
      { userId: user.id },
      {
        channelId: input.data.channelId,
        phoneNumber,
        contactName: input.data.contactName.trim() || null,
        content: input.data.content,
        externalMessageId,
      },
    );
    revalidatePath("/conversas", "layout");
    revalidatePath("/simulador");
    const message = result.duplicate
      ? "Reentrega da mesma mensagem: nada foi gravado de novo (duplicata)."
      : result.reopened
        ? "Mensagem recebida. A conversa resolvida foi reaberta."
        : "Mensagem recebida pela Inbox.";
    return {
      status: "success",
      message,
      conversationId: result.conversation_id,
      externalMessageId,
      channelId: input.data.channelId,
      phoneNumber,
      content: input.data.content,
    };
  } catch (error) {
    if (error instanceof AccessDeniedError) {
      return { status: "error", message: "Só owner ou admin ativo da organização do canal pode simular mensagens." };
    }
    if (error instanceof SimulatorIngestError) {
      return { status: "error", message: INGEST_REASONS[error.reason] ?? "Mensagem recusada pela ingestão." };
    }
    console.error(error);
    return { status: "error", message: "Não foi possível simular a mensagem. Tente novamente." };
  }
}

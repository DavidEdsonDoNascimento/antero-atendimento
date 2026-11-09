import "server-only";

import { z } from "zod";

import {
  sqlStateOf,
  withModuleTransaction,
  type DbTransaction,
  type OrganizationContext,
} from "@/lib/db";
import type { MessageDeliveryStatus, WhatsappProvider } from "@/lib/types/database";
import { ProviderUnavailableError, providerFor, type MessagingProvider } from "@/modules/messaging/provider";

// Extensão .ts explícita nas importações de VALOR (ver nota em cursor.ts).
import { attendanceErrorCodeOf } from "./attendance.ts";
import { AttendanceActionError } from "./errors.ts";

/**
 * Escritas do atendimento humano (E2A): assumir, resolver e responder. Cada
 * uma chama a função de 0008, que é quem decide (autorização, estado,
 * conflito, janela); aqui só se passa o contexto e se traduz a recusa.
 *
 * Mesmas garantias das leituras (`sql-queries.ts`): `OrganizationContext` vindo
 * do DAL (sessão validada + organização ativa), `withModuleTransaction` com o
 * módulo Atendimento e a organização repassada à função, que confere que a
 * conversa é dela. Erros:
 *   - `AccessDeniedError`/`ModuleDisabledError` (`@/lib/db`): sem vínculo ativo
 *     ou módulo desligado, antes de chamar a função;
 *   - `AttendanceActionError` com `code`: recusa da função (SQLSTATE de 0008);
 *   - demais erros do banco propagam como vieram.
 */

const uuidSchema = z.uuid();

async function runCommand<T>(context: OrganizationContext, work: (tx: DbTransaction) => Promise<T>): Promise<T> {
  try {
    return await withModuleTransaction(context, "atendimento", work);
  } catch (error) {
    const code = attendanceErrorCodeOf(sqlStateOf(error));
    if (code) throw new AttendanceActionError(code, { cause: error });
    throw error;
  }
}

function assertConversationId(conversationId: string): void {
  if (!uuidSchema.safeParse(conversationId).success) throw new AttendanceActionError("not_found");
}

/** Assume a conversa para o usuário da sessão. `changed: false` = já era dele. */
export async function claimConversation(
  context: OrganizationContext,
  conversationId: string,
): Promise<{ changed: boolean }> {
  assertConversationId(conversationId);
  return runCommand(context, async (tx) => {
    const { rows } = await tx.query<{ changed: boolean }>(
      "SELECT changed FROM public.claim_conversation($1::uuid, $2::uuid)",
      [context.organizationId, conversationId],
    );
    return { changed: rows[0].changed };
  });
}

/** Resolve a conversa. `changed: false` = já estava resolvida. */
export async function resolveConversation(
  context: OrganizationContext,
  conversationId: string,
): Promise<{ changed: boolean }> {
  assertConversationId(conversationId);
  return runCommand(context, async (tx) => {
    const { rows } = await tx.query<{ changed: boolean }>(
      "SELECT changed FROM public.resolve_conversation($1::uuid, $2::uuid)",
      [context.organizationId, conversationId],
    );
    return { changed: rows[0].changed };
  });
}

type ReplyRow = {
  message_id: string;
  whatsapp_account_id: string;
  provider: WhatsappProvider;
  external_account_id: string | null;
  recipient_phone_number: string;
  content: string;
  delivery_status: MessageDeliveryStatus;
  created: boolean;
};

export type ReplyResult = {
  messageId: string;
  /** `false`: pedido repetido (mesma chave) — devolve a mensagem já gravada, sem reenviar. */
  created: boolean;
  deliveryStatus: MessageDeliveryStatus;
  /** Canal simulado: nada saiu para o WhatsApp. */
  simulated: boolean;
};

/**
 * Responde a conversa em duas fases, como será com a Cloud API:
 *   1) transação: `send_conversation_reply` grava a mensagem `pending`;
 *   2) fora de transação: o provedor do canal envia;
 *   3) transação: `record_outbound_result` grava `sent` (id externo) ou `failed`.
 * O provedor é conferido antes da fase 1: canal sem provedor nesta versão não
 * grava nada. Uma falha do provedor vira `failed` (mensagem no histórico, com o
 * erro visível); se a fase 3 não completar, a mensagem fica `pending` — o
 * reprocessamento é do worker (E2B).
 *
 * `clientMessageId`: chave de idempotência gerada pela tela por mensagem
 * escrita. Repetir o pedido com ela não grava nem envia de novo.
 */
export async function sendConversationReply(
  context: OrganizationContext,
  input: { conversationId: string; content: string; clientMessageId: string },
  options: { providerFor?: (provider: WhatsappProvider) => MessagingProvider } = {},
): Promise<ReplyResult> {
  assertConversationId(input.conversationId);
  if (!uuidSchema.safeParse(input.clientMessageId).success) throw new AttendanceActionError("idempotency_conflict");
  const resolveProvider = options.providerFor ?? providerFor;

  let provider: MessagingProvider | undefined;
  const reply = await runCommand(context, async (tx) => {
    const channel = (
      await tx.query<{ provider: WhatsappProvider }>(
        `SELECT w.provider
         FROM public.conversations c
         JOIN public.whatsapp_accounts w ON w.organization_id = c.organization_id AND w.id = c.whatsapp_account_id
         WHERE c.organization_id = $1::uuid AND c.id = $2::uuid`,
        [context.organizationId, input.conversationId],
      )
    ).rows[0];
    if (channel) {
      try {
        provider = resolveProvider(channel.provider);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) throw new AttendanceActionError("provider_unavailable", { cause: error });
        throw error;
      }
    }
    const { rows } = await tx.query<ReplyRow>(
      `SELECT message_id, whatsapp_account_id, provider, external_account_id, recipient_phone_number,
              content, delivery_status, created
       FROM public.send_conversation_reply($1::uuid, $2::uuid, $3::text, $4::uuid)`,
      [context.organizationId, input.conversationId, input.content, input.clientMessageId],
    );
    return rows[0];
  });

  // Sem canal visível a função já teria recusado (conversa inexistente aqui).
  const channelProvider = provider as MessagingProvider;
  const simulated = channelProvider.simulated;
  if (!reply.created) {
    return { messageId: reply.message_id, created: false, deliveryStatus: reply.delivery_status, simulated };
  }

  let outcome: { status: "sent"; externalMessageId: string } | { status: "failed" };
  try {
    const sent = await channelProvider.sendText({
      channel: { id: reply.whatsapp_account_id, provider: reply.provider, externalAccountId: reply.external_account_id },
      to: reply.recipient_phone_number,
      text: reply.content,
      idempotencyKey: input.clientMessageId,
    });
    outcome = sent.ok ? { status: "sent", externalMessageId: sent.externalMessageId } : { status: "failed" };
  } catch {
    outcome = { status: "failed" };
  }

  const deliveryStatus = await runCommand(context, async (tx) => {
    const { rows } = await tx.query<{ status: MessageDeliveryStatus }>(
      "SELECT public.record_outbound_result($1::uuid, $2::uuid, $3::public.message_delivery_status, $4::text) AS status",
      [
        context.organizationId,
        reply.message_id,
        outcome.status,
        outcome.status === "sent" ? outcome.externalMessageId : null,
      ],
    );
    return rows[0].status;
  });

  return { messageId: reply.message_id, created: true, deliveryStatus, simulated };
}

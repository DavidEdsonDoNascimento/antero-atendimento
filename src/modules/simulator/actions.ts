"use server";

import { randomUUID } from "node:crypto";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireUser } from "@/lib/auth/dal";
import { isSimulatorEnabled } from "@/lib/dev-environment";
import { AccessDeniedError, ModuleDisabledError } from "@/lib/db";
import type { OutboundAction } from "@/modules/automations/actions";
import { runDevAutomation, type AutomationRunResult } from "@/modules/automations/runner";
import { FlowCommandError, publishFlow, saveFlowDraft } from "@/modules/automations/sql-commands";

import { DEMO_FLOW_DEFINITION, DEMO_FLOW_NAME, DEMO_FLOW_SLUG } from "./demo-flow";
import { SIMULATED_INBOUND_PREFIX, isSimulatedInboundId, normalizeSimulatorPhone } from "./phone";
import { SimulatorIngestError, listSimulatorChannels, simulateInboundMessage } from "./sql-queries";

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
      /** O que a automação fez com a mensagem. */
      automation: string | null;
      /** Respostas da automação, como o cliente as veria. */
      replies: OutboundAction[];
    };

const inputSchema = z.object({
  channelId: z.uuid(),
  phoneNumber: z.string().max(40),
  contactName: z.string().max(120),
  content: z.string().max(10_000),
  repeatExternalId: z.string().max(80),
});

const AUTOMATION_NONE: Record<string, string | null> = {
  already_processed: "Automação: nada pendente — esta mensagem já foi processada (por esta ou por outra execução da fila).",
  module_disabled: "Automação: módulo Automações desabilitado nesta organização (a sessão ativa, se havia, foi interrompida).",
  flow_paused: "Automação: o fluxo foi pausado; a conversa voltou para a equipe.",
  no_flow: "Automação: a organização não tem fluxo de entrada ativo.",
  not_eligible: "Automação: a conversa está com a equipe; o robô não responde.",
  channel_unavailable: "Automação: canal desconectado.",
  organization_inactive: "Automação: organização suspensa.",
  execution_error: "Automação: falhou; a mensagem continua gravada.",
};

const AUTOMATION_STATUS: Record<string, string> = {
  active: "Automação respondeu",
  handed_off: "Automação encaminhou a conversa para a equipe (Inbox)",
  completed: "Automação concluiu o atendimento",
  failed: "Automação falhou; a conversa foi para a equipe, sem respostas",
};

function describeAutomation(result: AutomationRunResult | null): string | null {
  if (!result) return null;
  if (result.action === "none") return AUTOMATION_NONE[result.reason] ?? `Automação: nada a fazer (${result.reason}).`;
  const failed = result.failedDeliveries ? `, ${result.failedDeliveries} com falha de envio` : "";
  const blocked = result.blockedDeliveries ? `, ${result.blockedDeliveries} não enviada(s) (módulo, canal ou atendente)` : "";
  const burst = result.processed > 1 ? ` (${result.processed} mensagens do cliente processadas em ordem)` : "";
  return `${AUTOMATION_STATUS[result.status]}${burst} — ${result.sent} mensagem(ns) simulada(s)${failed}${blocked}.`;
}

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
    // A automação roda depois da ingestão, em transação própria: se falhar, a
    // mensagem do cliente já está gravada.
    let automation: AutomationRunResult | null = null;
    try {
      automation = await runDevAutomation({ userId: user.id }, result.message_id);
    } catch (error) {
      if (!(error instanceof AccessDeniedError)) console.error(error);
      automation = { action: "none", reason: "execution_error" };
    }
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
      automation: describeAutomation(automation),
      replies: automation && automation.action !== "none" ? automation.replies : [],
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

export type DemoFlowActionState = { status: "idle" } | { status: "error" | "success"; message: string };

const FLOW_ERRORS: Record<string, string> = {
  entry_conflict: "A organização já tem outro fluxo de entrada.",
  invalid_definition: "O fluxo demonstrativo não passou na validação.",
  access_denied: "Só owner ou admin ativo, com o módulo Automações, configura fluxos.",
  draft_changed: "O rascunho mudou durante a publicação. Tente de novo.",
};

/**
 * Ferramenta de desenvolvimento: grava e publica o fluxo demonstrativo como
 * fluxo de entrada da organização do canal escolhido. A organização vem do
 * canal na lista do próprio usuário (owner/admin), nunca do navegador; o banco
 * confere papel e módulo de novo. Repetir publica uma nova versão.
 */
export async function installDemoFlowAction(_previous: DemoFlowActionState, formData: FormData): Promise<DemoFlowActionState> {
  if (!isSimulatorEnabled()) return { status: "error", message: "Simulador indisponível neste ambiente." };
  const user = await requireUser();
  const channelId = z.uuid().safeParse(formData.get("channelId"));
  if (!channelId.success) return { status: "error", message: "Canal inválido." };
  const channel = (await listSimulatorChannels({ userId: user.id })).find((candidate) => candidate.id === channelId.data);
  if (!channel) return { status: "error", message: "Canal não encontrado entre os seus." };

  const context = { userId: user.id, organizationId: channel.organization_id };
  try {
    const saved = await saveFlowDraft(context, {
      slug: DEMO_FLOW_SLUG,
      name: DEMO_FLOW_NAME,
      definition: DEMO_FLOW_DEFINITION,
      isEntry: true,
    });
    const published = await publishFlow(context, saved.flowId);
    revalidatePath("/simulador");
    revalidatePath("/fluxos");
    return {
      status: "success",
      message: `Fluxo demonstrativo publicado em ${channel.organization_name} (versão ${published.version}). Conversas em andamento continuam na versão em que começaram.`,
    };
  } catch (error) {
    if (error instanceof ModuleDisabledError) {
      return { status: "error", message: `Habilite o módulo Automações para ${channel.organization_name} em /admin.` };
    }
    if (error instanceof FlowCommandError) return { status: "error", message: FLOW_ERRORS[error.code] ?? "Fluxo recusado." };
    if (error instanceof AccessDeniedError) return { status: "error", message: FLOW_ERRORS.access_denied };
    console.error(error);
    return { status: "error", message: "Não foi possível publicar o fluxo demonstrativo." };
  }
}

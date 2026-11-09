import "server-only";

import { AccessDeniedError, sqlStateOf, withUserTransaction, type DbTransaction } from "@/lib/db";
import { isSimulatorEnabled } from "@/lib/dev-environment";
import type { MessageType, WhatsappProvider } from "@/lib/types/database";
import { providerFor, type MessagingProvider } from "@/modules/messaging/provider";

// Extensão .ts explícita nas importações de VALOR (ver nota em cursor.ts).
import { toMessageRecord, type OutboundAction } from "./actions.ts";
import { parseFlowDefinition } from "./definition.ts";
import { advance, isSessionState, startSession, type EngineResult, type SessionState } from "./engine.ts";

/**
 * Executa a automação para UMA mensagem recebida, pela porta de
 * desenvolvimento (`dev_automation_*`, 0010). Sequência:
 *
 *   transação: prepare (o banco decide se age e trava a conversa) → motor
 *              (puro) → commit (sessão, execução e respostas `pending`)
 *   fora dela: provedor do canal envia cada resposta, na ordem
 *   transação: resultado de cada envio (`sent`/`failed`)
 *
 * Quem decide é o banco, na transação: organização ativa, módulo Automações,
 * canal, estado da conversa, sessão e versão. Repetir a mesma mensagem não faz
 * nada (já processada). Um erro no motor ou no commit vira sessão `failed`, sem
 * mensagens, com a conversa devolvida à equipe — nunca um robô travado.
 *
 * Identidade: o `userId` é quem disparou a simulação (owner/admin do canal),
 * conferido pela porta do banco. Nada é gravado em nome dele: as respostas
 * são `bot` e os eventos ficam sem usuário. A execução de produção (webhook +
 * worker, E2B) terá porta própria e não passa por aqui.
 */

export type AutomationRunResult =
  | { action: "none"; reason: string }
  | {
      action: "start" | "advance";
      status: EngineResult["status"];
      reason: string | null;
      /** Respostas enviadas pelo provedor. */
      sent: number;
      /** Respostas que o provedor recusou (ficam `failed` no histórico). */
      failedDeliveries: number;
      /** O que a automação respondeu, na ordem (para o simulador mostrar ao "cliente"). */
      replies: OutboundAction[];
    };

export class AutomationUnavailableError extends Error {
  constructor(message = "Automação simulada indisponível neste ambiente.") {
    super(message);
    this.name = "AutomationUnavailableError";
  }
}

type PrepareRow = {
  action: "none" | "start" | "advance";
  reason: string | null;
  session_id: string | null;
  session_revision: number | null;
  flow_version_id: string | null;
  definition: unknown;
  state: unknown;
  message_content: string | null;
  attendance_enabled: boolean | null;
};

type CommittedRow = {
  message_id: string;
  message_type: MessageType;
  payload: OutboundAction;
  whatsapp_account_id: string;
  provider: WhatsappProvider;
  external_account_id: string | null;
  recipient_phone_number: string;
};

type Plan = { status: EngineResult["status"]; stepId: string | null; state: SessionState | Record<string, never>; reason: string | null; outputs: OutboundAction[] };

/** Resultado do motor, ou falha segura se a definição/estado gravados não forem válidos. */
function plan(prepared: PrepareRow): Plan {
  const failed = (reason: string, state: Plan["state"] = {}): Plan => ({ status: "failed", stepId: null, state, reason, outputs: [] });
  const parsed = parseFlowDefinition(prepared.definition);
  if (!parsed.ok) return failed("invalid_definition");
  const input = { type: "text" as const, text: prepared.message_content ?? "" };
  const context = { humanHandoffAvailable: prepared.attendance_enabled === true };
  let result: EngineResult;
  try {
    if (prepared.action === "start") {
      result = startSession(parsed.definition, input, context);
    } else {
      if (!isSessionState(prepared.state)) return failed("invalid_state");
      result = advance(parsed.definition, prepared.state, input, context);
    }
  } catch {
    return failed("engine_error", isSessionState(prepared.state) ? prepared.state : {});
  }
  return {
    status: result.status,
    stepId: result.status === "active" ? result.state.stepId : null,
    state: result.state,
    reason: result.reason,
    outputs: result.status === "failed" ? [] : result.outputs,
  };
}

async function prepare(tx: DbTransaction, messageId: string): Promise<PrepareRow> {
  const { rows } = await tx.query<PrepareRow>(
    `SELECT action, reason, session_id, session_revision, flow_version_id, definition, state,
            message_content, attendance_enabled
     FROM public.dev_automation_prepare($1::uuid)`,
    [messageId],
  );
  return rows[0];
}

async function commit(tx: DbTransaction, messageId: string, prepared: PrepareRow, result: Plan): Promise<CommittedRow[]> {
  const outputs = result.outputs.map((action) => {
    const record = toMessageRecord(action);
    return { message_type: record.messageType, content: record.content, payload: record.payload };
  });
  const { rows } = await tx.query<CommittedRow>(
    `SELECT message_id, message_type, payload, whatsapp_account_id, provider, external_account_id, recipient_phone_number
     FROM public.dev_automation_commit($1::uuid, $2::uuid, $3::integer, $4::uuid,
       $5::public.automation_session_status, $6::text, $7::jsonb, $8::text, $9::jsonb)`,
    [
      messageId,
      prepared.session_id,
      prepared.session_revision,
      prepared.flow_version_id,
      result.status,
      result.stepId,
      JSON.stringify(result.state),
      result.reason,
      JSON.stringify(outputs),
    ],
  );
  return rows;
}

function translate(error: unknown): unknown {
  const sqlState = sqlStateOf(error);
  if (sqlState === "42501" || sqlState === "28000") return new AccessDeniedError();
  if (sqlState === "AU009") return new AutomationUnavailableError("A automação simulada só atende canais de desenvolvimento.");
  return error;
}

export async function runDevAutomation(
  context: { userId: string },
  messageId: string,
  options: { providerFor?: (provider: WhatsappProvider) => MessagingProvider; engine?: (prepared: PrepareRow) => Plan } = {},
): Promise<AutomationRunResult> {
  if (!isSimulatorEnabled()) throw new AutomationUnavailableError();
  const decide = options.engine ?? plan;

  let decided: { prepared: PrepareRow; result: Plan; rows: CommittedRow[] } | { prepared: PrepareRow; rows: null };
  try {
    decided = await withUserTransaction(context.userId, async (tx) => {
      const prepared = await prepare(tx, messageId);
      if (prepared.action === "none") return { prepared, rows: null };
      const result = decide(prepared);
      return { prepared, result, rows: await commit(tx, messageId, prepared, result) };
    });
  } catch (error) {
    const translated = translate(error);
    if (translated !== error) throw translated;
    // Não eligível no commit (corrida com outra execução): nada a fazer.
    if (sqlStateOf(error) === "AU006") return { action: "none", reason: "not_eligible" };
    console.error("[automation] execução falhou; gravando a sessão como falha", error);
    return recordFailure(context, messageId);
  }

  if (!decided.rows) return { action: "none", reason: decided.prepared.reason ?? "not_eligible" };
  const { prepared, result, rows } = decided;
  const delivery = await deliver(context, rows, options.providerFor ?? providerFor);
  return {
    action: prepared.action as "start" | "advance",
    status: result.status,
    reason: result.reason,
    ...delivery,
    replies: rows.map((row) => row.payload),
  };
}

/** Segunda transação depois de um erro: encerra como falha (sem respostas), se ainda couber. */
async function recordFailure(context: { userId: string }, messageId: string): Promise<AutomationRunResult> {
  try {
    return await withUserTransaction(context.userId, async (tx) => {
      const prepared = await prepare(tx, messageId);
      if (prepared.action === "none") return { action: "none" as const, reason: prepared.reason ?? "not_eligible" };
      const state = isSessionState(prepared.state) ? prepared.state : {};
      await commit(tx, messageId, prepared, { status: "failed", stepId: null, state, reason: "execution_error", outputs: [] });
      return { action: prepared.action, status: "failed" as const, reason: "execution_error", sent: 0, failedDeliveries: 0, replies: [] };
    });
  } catch (error) {
    // A mensagem continua gravada e sem execução: uma reentrega tenta de novo.
    console.error("[automation] não foi possível registrar a falha", error);
    return { action: "none", reason: "execution_error" };
  }
}

/** Envia na ordem gravada; uma recusa do provedor não impede as seguintes. */
async function deliver(
  context: { userId: string },
  rows: CommittedRow[],
  resolveProvider: (provider: WhatsappProvider) => MessagingProvider,
): Promise<{ sent: number; failedDeliveries: number }> {
  let sent = 0;
  let failedDeliveries = 0;
  for (const row of rows) {
    let outcome: { status: "sent"; externalMessageId: string } | { status: "failed" };
    try {
      const result = await resolveProvider(row.provider).send({
        channel: { id: row.whatsapp_account_id, provider: row.provider, externalAccountId: row.external_account_id },
        to: row.recipient_phone_number,
        action: row.payload,
        idempotencyKey: row.message_id,
      });
      outcome = result.ok ? { status: "sent", externalMessageId: result.externalMessageId } : { status: "failed" };
    } catch {
      outcome = { status: "failed" };
    }
    // Se esta gravação falhar, a resposta fica `pending`: o reprocessamento é do worker (E2B).
    await withUserTransaction(context.userId, (tx) =>
      tx.query("SELECT public.dev_automation_record_delivery($1::uuid, $2::public.message_delivery_status, $3::text)", [
        row.message_id,
        outcome.status,
        outcome.status === "sent" ? outcome.externalMessageId : null,
      ]),
    );
    if (outcome.status === "sent") sent += 1;
    else failedDeliveries += 1;
  }
  return { sent, failedDeliveries };
}

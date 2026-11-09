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
 * Executa a automação na conversa de uma mensagem recebida, pela porta de
 * desenvolvimento (`dev_automation_*`, 0010). Cada passo:
 *
 *   transação: prepare (o banco trava a conversa e escolhe a entrada: a
 *              mensagem PENDENTE mais antiga) → motor (puro) → commit (sessão,
 *              execução e respostas `pending`)
 *   fora dela: para cada resposta, o banco confirma que ainda pode sair
 *              (organização, módulo, canal, atendente) → provedor → resultado
 *
 * Os passos se repetem enquanto houver mensagem pendente na conversa: quem
 * obtém a trava processa a fila em ordem de chegada, inclusive mensagens cujo
 * executor ainda não rodou. Assim duas mensagens seguidas nunca trocam de lugar
 * nem ficam para trás; o executor delas encontra a fila vazia (`already_processed`).
 *
 * Quem decide é o banco, na transação. Um erro no motor ou no commit vira
 * sessão `failed`, sem mensagens, com a conversa devolvida à equipe.
 *
 * Identidade: o `userId` é quem disparou a simulação (owner/admin do canal),
 * conferido pela porta do banco. Nada é gravado em nome dele: as respostas são
 * `bot` e os eventos ficam sem usuário. A execução de produção (webhook +
 * worker, E2B) terá porta própria e não passa por aqui.
 */

/** Teto de mensagens pendentes processadas por chamada (rajadas maiores seguem na próxima mensagem). */
const MAX_INPUTS_PER_RUN = 20;

export type AutomationRunResult =
  | { action: "none"; reason: string }
  | {
      /** Ação do primeiro passo. */
      action: "start" | "advance";
      /** Situação da sessão depois do último passo. */
      status: EngineResult["status"];
      reason: string | null;
      /** Mensagens do cliente processadas nesta chamada (mais de uma numa rajada). */
      processed: number;
      /** Respostas enviadas pelo provedor. */
      sent: number;
      /** Respostas que o provedor recusou (ficam `failed` no histórico). */
      failedDeliveries: number;
      /** Respostas que não saíram porque a organização, o módulo, o canal ou um atendente impediu. */
      blockedDeliveries: number;
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
  /** A mensagem que este passo processa (a pendente mais antiga da conversa). */
  input_message_id: string | null;
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

type Plan = {
  status: EngineResult["status"];
  stepId: string | null;
  state: SessionState | Record<string, never>;
  reason: string | null;
  outputs: OutboundAction[];
};

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
            message_content, attendance_enabled, input_message_id
     FROM public.dev_automation_prepare($1::uuid)`,
    [messageId],
  );
  return rows[0];
}

async function commit(tx: DbTransaction, prepared: PrepareRow, result: Plan): Promise<CommittedRow[]> {
  const outputs = result.outputs.map((action) => {
    const record = toMessageRecord(action);
    return { message_type: record.messageType, content: record.content, payload: record.payload };
  });
  const { rows } = await tx.query<CommittedRow>(
    `SELECT message_id, message_type, payload, whatsapp_account_id, provider, external_account_id, recipient_phone_number
     FROM public.dev_automation_commit($1::uuid, $2::uuid, $3::integer, $4::uuid,
       $5::public.automation_session_status, $6::text, $7::jsonb, $8::text, $9::jsonb)`,
    [
      prepared.input_message_id,
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

type Step =
  | { kind: "none"; reason: string }
  | { kind: "done"; action: "start" | "advance"; status: EngineResult["status"]; reason: string | null; rows: CommittedRow[] };

/** Um passo: processa a mensagem pendente mais antiga da conversa, se houver. */
async function step(
  context: { userId: string },
  messageId: string,
  decide: (prepared: PrepareRow) => Plan,
): Promise<Step> {
  try {
    return await withUserTransaction(context.userId, async (tx): Promise<Step> => {
      const prepared = await prepare(tx, messageId);
      if (prepared.action === "none") return { kind: "none", reason: prepared.reason ?? "not_eligible" };
      const result = decide(prepared);
      const rows = await commit(tx, prepared, result);
      return { kind: "done", action: prepared.action, status: result.status, reason: result.reason, rows };
    });
  } catch (error) {
    const translated = translate(error);
    if (translated !== error) throw translated;
    // Outra execução venceu a corrida pela mesma entrada: o próximo passo relê a fila.
    if (sqlStateOf(error) === "AU006" || sqlStateOf(error) === "AU005") return { kind: "none", reason: "not_eligible" };
    console.error("[automation] execução falhou; gravando a sessão como falha", error);
    return recordFailure(context, messageId);
  }
}

export async function runDevAutomation(
  context: { userId: string },
  messageId: string,
  options: { providerFor?: (provider: WhatsappProvider) => MessagingProvider; engine?: (prepared: PrepareRow) => Plan } = {},
): Promise<AutomationRunResult> {
  if (!isSimulatorEnabled()) throw new AutomationUnavailableError();
  const decide = options.engine ?? plan;
  const resolveProvider = options.providerFor ?? providerFor;

  let first: Extract<Step, { kind: "done" }> | null = null;
  let last: Extract<Step, { kind: "done" }> | null = null;
  let noneReason = "not_eligible";
  const totals = { processed: 0, sent: 0, failedDeliveries: 0, blockedDeliveries: 0, replies: [] as OutboundAction[] };

  for (let index = 0; index < MAX_INPUTS_PER_RUN; index += 1) {
    let done: Step;
    try {
      done = await step(context, messageId, decide);
    } catch (error) {
      // Acesso perdido no meio da fila (organização suspensa): para aqui e devolve o que já foi feito.
      if (first && error instanceof AccessDeniedError) break;
      throw error;
    }
    if (done.kind === "none") {
      noneReason = done.reason;
      break;
    }
    first ??= done;
    last = done;
    totals.processed += 1;
    const delivery = await deliver(context, done.rows, resolveProvider);
    totals.sent += delivery.sent;
    totals.failedDeliveries += delivery.failedDeliveries;
    totals.blockedDeliveries += delivery.blockedDeliveries;
    totals.replies.push(...done.rows.map((row) => row.payload));
    if (done.status === "failed") break;
  }

  if (!first || !last) return { action: "none", reason: noneReason };
  return { action: first.action, status: last.status, reason: last.reason, ...totals };
}

/** Segunda transação depois de um erro: encerra como falha (sem respostas), se ainda couber. */
async function recordFailure(context: { userId: string }, messageId: string): Promise<Step> {
  try {
    return await withUserTransaction(context.userId, async (tx): Promise<Step> => {
      const prepared = await prepare(tx, messageId);
      if (prepared.action === "none") return { kind: "none", reason: prepared.reason ?? "not_eligible" };
      const state = isSessionState(prepared.state) ? prepared.state : {};
      await commit(tx, prepared, { status: "failed", stepId: null, state, reason: "execution_error", outputs: [] });
      return { kind: "done", action: prepared.action, status: "failed", reason: "execution_error", rows: [] };
    });
  } catch (error) {
    // A mensagem continua gravada e sem execução: a próxima mensagem (ou reentrega) tenta de novo.
    console.error("[automation] não foi possível registrar a falha", error);
    return { kind: "none", reason: "execution_error" };
  }
}

/**
 * Envia na ordem gravada. Antes de cada resposta o banco confirma que ela ainda
 * pode sair (`dev_automation_begin_delivery`); se não puder, ela vira `failed`
 * sem ir ao provedor. Organização suspensa: a porta recusa e nada mais sai.
 */
async function deliver(
  context: { userId: string },
  rows: CommittedRow[],
  resolveProvider: (provider: WhatsappProvider) => MessagingProvider,
): Promise<{ sent: number; failedDeliveries: number; blockedDeliveries: number }> {
  let sent = 0;
  let failedDeliveries = 0;
  let blockedDeliveries = 0;
  for (const [index, row] of rows.entries()) {
    let allowed: boolean;
    try {
      allowed = await withUserTransaction(context.userId, async (tx) => {
        const { rows: gate } = await tx.query<{ allowed: boolean }>(
          "SELECT public.dev_automation_begin_delivery($1::uuid) AS allowed",
          [row.message_id],
        );
        return gate[0].allowed;
      });
    } catch (error) {
      if (!(translate(error) instanceof AccessDeniedError)) throw error;
      // Sem acesso (organização suspensa, vínculo removido): nada mais sai.
      blockedDeliveries += rows.length - index;
      break;
    }
    if (!allowed) {
      blockedDeliveries += 1;
      continue;
    }

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
    if (outcome.status === "sent") sent += 1;
    else failedDeliveries += 1;
    // Se esta gravação falhar, a resposta fica `pending`: o reprocessamento é do worker (E2B).
    try {
      await withUserTransaction(context.userId, (tx) =>
        tx.query("SELECT public.dev_automation_record_delivery($1::uuid, $2::public.message_delivery_status, $3::text)", [
          row.message_id,
          outcome.status,
          outcome.status === "sent" ? outcome.externalMessageId : null,
        ]),
      );
    } catch (error) {
      if (!(translate(error) instanceof AccessDeniedError)) throw error;
      // Acesso perdido depois do envio (organização suspensa): nada mais sai.
      blockedDeliveries += rows.length - index - 1;
      break;
    }
  }
  return { sent, failedDeliveries, blockedDeliveries };
}

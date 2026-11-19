// Log técnico do webhook da Meta (E2B-1). Uma linha JSON por pedido, no stdout
// do servidor (logs do contêiner). Mesmo princípio de `lib/security-log.ts`:
// só listas fechadas, contagens inteiras e SQLSTATE no formato de 5
// caracteres. Nunca corpo, telefone, nome, conteúdo de mensagem, token,
// assinatura ou mensagem de erro do banco.
// Sem `server-only` de propósito: puro, para `node --test`.
import { randomUUID } from "node:crypto";

export type WebhookLogEvent =
  | "verify.accepted"
  | "verify.rejected"
  | "notification.accepted"
  | "notification.rejected"
  | "notification.unavailable";

export type WebhookLogReason =
  | "config_missing"
  | "invalid_verify_request"
  | "signature_missing"
  | "signature_malformed"
  | "signature_mismatch"
  | "payload_too_large"
  | "invalid_json"
  | "record_failed";

export type WebhookLogInput = {
  event: WebhookLogEvent;
  reason?: WebhookLogReason;
  /** Tamanho do corpo recebido, em bytes. */
  bytes?: number;
  received?: number;
  rejected?: number;
  duplicates?: number;
  sqlState?: unknown;
};

const SQLSTATE = /^[0-9A-Z]{5}$/;
const count = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined);

/** A linha de log (objeto), já filtrada. `id` correlaciona com a resposta HTTP. */
export function webhookLogEntry(input: WebhookLogInput, now: Date = new Date(), id: string = randomUUID()) {
  const entry: Record<string, string | number> = {
    type: "whatsapp_webhook",
    event: input.event,
    id,
    at: now.toISOString(),
  };
  if (input.reason) entry.reason = input.reason;
  for (const key of ["bytes", "received", "rejected", "duplicates"] as const) {
    const value = count(input[key]);
    if (value !== undefined) entry[key] = value;
  }
  if (typeof input.sqlState === "string" && SQLSTATE.test(input.sqlState)) entry.sqlState = input.sqlState;
  return entry;
}

/** Registra no log do servidor e devolve o id do registro. */
export function logWebhookEvent(input: WebhookLogInput): string {
  const entry = webhookLogEntry(input);
  const line = JSON.stringify(entry);
  if (input.event === "notification.accepted" || input.event === "verify.accepted") console.info(line);
  else if (input.event === "notification.unavailable") console.error(line);
  else console.warn(line);
  return entry.id as string;
}

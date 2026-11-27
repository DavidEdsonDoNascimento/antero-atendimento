import "server-only";

import { workerQuery } from "@/lib/db";

import type { RecordOutcome } from "./webhook-handler";

/**
 * Grava uma notificação autenticada do webhook (0014), como `antero_worker`.
 * O texto JSON vai direto para o PostgreSQL (`$1::jsonb`), que valida a
 * estrutura, divide a notificação por alteração, deriva a organização só do
 * canal registrado e descarta reentregas. Uma única função: tudo ou nada.
 */
export async function recordWebhookDelivery(json: string): Promise<RecordOutcome> {
  const { rows } = await workerQuery<RecordOutcome>(
    "SELECT received, rejected, duplicates FROM public.webhook_record_delivery($1::jsonb)",
    [json],
  );
  return rows[0];
}

/** Resultado de `webhook_ingest_message` (0015). Ver docs/WHATSAPP.md, "Ingestão". */
export type WebhookIngestResult = {
  outcome: "created" | "duplicate" | "held" | "ignored" | "rejected";
  /** held: missing_phone | invalid_phone | invalid_content | content_too_long | identity_conflict; ignored: reaction | system;
   *  rejected: channel_disconnected | channel_mismatch | organization_inactive | modules_disabled. */
  reason: string | null;
  organization_id: string;
  whatsapp_account_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  message_id: string | null;
  /** bigint, como texto. */
  hold_id: string | null;
  duplicate: boolean;
  reopened: boolean;
  provider_time_status: "valid" | "missing" | "invalid" | "out_of_range" | null;
  /** bsuid_invalid: BSUID descartado, a mensagem segue pelo telefone. As demais acompanham `held`/identity_conflict. */
  identity_note: "bsuid_invalid" | "bsuid_contradiction" | "bsuid_in_use" | "bsuid_mismatch" | null;
};

/**
 * Ingere UMA mensagem (wamid) de um evento reivindicado (`webhook_claim_events`),
 * como `antero_worker`. Só o evento, o token da reivindicação e o wamid são
 * informados: organização, canal, telefone, conteúdo, tipo e horário saem do
 * evento persistido, no banco. Erros: `WH001` (reivindicação perdida ou
 * vencida), `WH002` (wamid fora do evento), `WH003`/`WH004` (evento que não
 * contém mensagens de um canal cloud_api), `WH005` (identidade do contato mudou
 * sob a trava; não deveria ocorrer), `P0002`, `22023`. Uma chamada por
 * transação (autocommit), para manter a ordem das travas.
 */
export async function ingestWebhookMessage(input: { eventId: string; claimToken: string; wamid: string }): Promise<WebhookIngestResult> {
  const { rows } = await workerQuery<WebhookIngestResult>(
    `SELECT outcome, reason, organization_id, whatsapp_account_id, contact_id, conversation_id, message_id,
            hold_id, duplicate, reopened, provider_time_status, identity_note
     FROM public.webhook_ingest_message($1::bigint, $2::uuid, $3::text)`,
    [input.eventId, input.claimToken, input.wamid],
  );
  return rows[0];
}

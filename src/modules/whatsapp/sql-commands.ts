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

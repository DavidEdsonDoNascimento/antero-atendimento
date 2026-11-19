import { recordWebhookDelivery } from "@/modules/whatsapp/sql-commands";
import { parseWebhookConfig } from "@/modules/whatsapp/webhook-config";
import { handleNotification, handleVerification, type WebhookDeps } from "@/modules/whatsapp/webhook-handler";
import { logWebhookEvent } from "@/modules/whatsapp/webhook-log";

/**
 * Webhook da WhatsApp Cloud API (E2B-1). Público (a Meta não usa a nossa
 * sessão; ver `PUBLIC_PREFIXES`), protegido pela assinatura `X-Hub-Signature-256`
 * de cada notificação e pelo verify token na verificação. Só recebe, confere e
 * grava em `webhook_events` (como `antero_worker`); o processamento das
 * mensagens é da E2B-2. Regras em `modules/whatsapp/webhook-handler.ts` e
 * docs/WHATSAPP.md.
 */
const deps: WebhookDeps = {
  config: () => parseWebhookConfig(process.env),
  record: recordWebhookDelivery,
  log: logWebhookEvent,
};

export async function GET(request: Request) {
  return handleVerification(new URL(request.url), deps);
}

export async function POST(request: Request) {
  return handleNotification(request, deps);
}

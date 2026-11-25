// Webhook da Meta (E2B-1): verificação (GET) e notificações (POST). Lógica sem
// `server-only`, com as dependências injetadas (configuração, gravação, log),
// para os testes rodarem com `node --test`, sem servidor e sem banco. A rota
// (`app/api/webhooks/whatsapp/route.ts`) liga as dependências reais.
//
// Ordem do POST, sem atalhos:
//   configuração → tamanho → corpo BRUTO → assinatura (tempo constante) →
//   JSON → gravação no PostgreSQL (organização decidida lá) → 200.
// Nada não autenticado chega ao banco. 200 só depois da gravação: sem ela, 503
// e a Meta reentrega (por até 7 dias). Respostas sem nenhum detalhe interno.
import { checkSignature, constantTimeEquals, SIGNATURE_HEADER } from "./webhook-signature.ts";
import type { WebhookConfig } from "./webhook-config.ts";
import type { WebhookLogInput } from "./webhook-log.ts";

/** A Meta envia notificações de até 3 MB. */
export const MAX_WEBHOOK_BODY_BYTES = 3 * 1024 * 1024;

export type RecordOutcome = { received: number; rejected: number; duplicates: number };

export type WebhookDeps = {
  /** Lança se WHATSAPP_APP_SECRET/WHATSAPP_VERIFY_TOKEN faltarem ou forem inválidos. */
  config: () => WebhookConfig;
  /** Grava a notificação (texto JSON já validado), atômica: tudo ou nada. */
  record: (json: string) => Promise<RecordOutcome>;
  log: (entry: WebhookLogInput) => void;
};

// `hub.challenge` é devolvido no corpo: só um token simples (a Meta envia dígitos).
const CHALLENGE = /^[A-Za-z0-9_-]{1,256}$/;
// JSON que o PostgreSQL não aceita como jsonb (ex.: \u0000): não adianta reenviar.
const UNSTORABLE_JSON_SQLSTATES = new Set(["22P02", "22P05", "22021"]);

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function loadConfig(deps: WebhookDeps): WebhookConfig | null {
  try {
    return deps.config();
  } catch {
    return null;
  }
}

/** GET: a Meta confirma a URL enviando o verify token e espera o challenge de volta. */
export function handleVerification(url: URL, deps: WebhookDeps): Response {
  const config = loadConfig(deps);
  if (!config) {
    deps.log({ event: "verify.rejected", reason: "config_missing" });
    return text(503, "unavailable");
  }
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (
    mode === "subscribe" &&
    token !== null &&
    challenge !== null &&
    CHALLENGE.test(challenge) &&
    constantTimeEquals(token, config.verifyToken)
  ) {
    deps.log({ event: "verify.accepted" });
    return text(200, challenge);
  }
  deps.log({ event: "verify.rejected", reason: "invalid_verify_request" });
  return text(403, "forbidden");
}

/** Lê o corpo até `max` bytes; `null` se passar (sem ler o resto). */
async function readBody(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared) > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function sqlStateOf(error: unknown): unknown {
  return error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
}

/** POST: notificação assinada da Meta. */
export async function handleNotification(request: Request, deps: WebhookDeps): Promise<Response> {
  const config = loadConfig(deps);
  if (!config) {
    deps.log({ event: "notification.unavailable", reason: "config_missing" });
    return text(503, "unavailable");
  }

  const body = await readBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (body === null) {
    deps.log({ event: "notification.rejected", reason: "payload_too_large" });
    return text(413, "payload too large");
  }

  const signature = checkSignature(body, request.headers.get(SIGNATURE_HEADER), config.appSecret);
  if (!signature.valid) {
    deps.log({ event: "notification.rejected", reason: `signature_${signature.reason}`, bytes: body.byteLength });
    return text(401, "unauthorized");
  }

  // Autenticado. Só JSON válido segue; a estrutura (e a organização) quem
  // decide é o banco, que registra como rejeitado o que não reconhecer.
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(body);
    JSON.parse(json);
  } catch {
    deps.log({ event: "notification.rejected", reason: "invalid_json", bytes: body.byteLength });
    return text(400, "bad request");
  }

  let outcome: RecordOutcome;
  try {
    outcome = await deps.record(json);
  } catch (error) {
    const sqlState = sqlStateOf(error);
    if (typeof sqlState === "string" && UNSTORABLE_JSON_SQLSTATES.has(sqlState)) {
      deps.log({ event: "notification.rejected", reason: "invalid_json", bytes: body.byteLength, sqlState });
      return text(400, "bad request");
    }
    // Banco indisponível, pool do worker sem configuração, tempo esgotado…:
    // sem gravação não há 200, e a Meta reentrega.
    const configMissing = error instanceof Error && error.name === "DatabaseConfigError";
    deps.log({
      event: "notification.unavailable",
      reason: configMissing ? "config_missing" : "record_failed",
      bytes: body.byteLength,
      sqlState,
    });
    return text(503, "unavailable");
  }

  deps.log({ event: "notification.accepted", bytes: body.byteLength, ...outcome });
  return text(200, "ok");
}

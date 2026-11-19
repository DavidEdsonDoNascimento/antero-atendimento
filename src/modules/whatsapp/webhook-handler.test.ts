import assert from "node:assert/strict";
import { test } from "node:test";

import { WebhookConfigError, parseWebhookConfig } from "./webhook-config.ts";
import { MAX_WEBHOOK_BODY_BYTES, handleNotification, handleVerification, type RecordOutcome, type WebhookDeps } from "./webhook-handler.ts";
import type { WebhookLogInput } from "./webhook-log.ts";
import { checkSignature, constantTimeEquals, signatureFor } from "./webhook-signature.ts";

const SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const VERIFY = "verificacao-ficticia-0123456789";
const URL_BASE = "https://exemplo.invalid/api/webhooks/whatsapp";
// Dados fictícios que nunca podem aparecer no log.
const PHONE = "5511987654321";
const NAME = "Cliente Ficticia";
const BODY_TEXT = "mensagem secreta do cliente";

const notification = JSON.stringify({
  object: "whatsapp_business_account",
  entry: [
    {
      id: "25550001001",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { display_phone_number: "15550000000", phone_number_id: "15550001001" },
            contacts: [{ wa_id: PHONE, profile: { name: NAME } }],
            messages: [{ from: PHONE, id: "wamid.ficticio", timestamp: "1763550000", type: "text", text: { body: BODY_TEXT } }],
          },
        },
      ],
    },
  ],
});

function fakeDeps(overrides: Partial<WebhookDeps> = {}) {
  const logs: WebhookLogInput[] = [];
  const recorded: string[] = [];
  const deps: WebhookDeps = {
    config: () => ({ appSecret: SECRET, verifyToken: VERIFY }),
    record: async (json) => {
      recorded.push(json);
      return { received: 1, rejected: 0, duplicates: 0 };
    },
    log: (entry) => logs.push(entry),
    ...overrides,
  };
  return { deps, logs, recorded };
}

function post(body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string> = {}) {
  return new Request(URL_BASE, { method: "POST", body, headers });
}
const signed = (body: string, secret = SECRET) => post(body, { "x-hub-signature-256": signatureFor(body, secret) });

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------
test("config: exige App Secret e verify token válidos, sem ecoar valores", () => {
  assert.deepEqual(parseWebhookConfig({ WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY }), { appSecret: SECRET, verifyToken: VERIFY });
  const cases: Record<string, string | undefined>[] = [
    {},
    { WHATSAPP_APP_SECRET: SECRET },
    { WHATSAPP_VERIFY_TOKEN: VERIFY },
    { WHATSAPP_APP_SECRET: "curto", WHATSAPP_VERIFY_TOKEN: VERIFY },
    { WHATSAPP_APP_SECRET: `${SECRET}!`, WHATSAPP_VERIFY_TOKEN: VERIFY },
    { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: "curto-demais" },
    { WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: `${VERIFY} com espaço` },
    { WHATSAPP_APP_SECRET: `${SECRET}${SECRET}`.slice(0, 40), WHATSAPP_VERIFY_TOKEN: `${SECRET}${SECRET}`.slice(0, 40) },
  ];
  for (const env of cases) {
    assert.throws(
      () => parseWebhookConfig(env),
      (error: unknown) => {
        assert.ok(error instanceof WebhookConfigError);
        assert.ok(!error.message.includes(SECRET) && !error.message.includes(VERIFY), "mensagem sem segredo");
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// Assinatura
// ---------------------------------------------------------------------------
test("assinatura: HMAC-SHA256 dos bytes brutos com o App Secret", () => {
  const body = new TextEncoder().encode(notification);
  assert.deepEqual(checkSignature(body, signatureFor(notification, SECRET), SECRET), { valid: true });
  assert.deepEqual(checkSignature(body, signatureFor(notification, SECRET).toUpperCase().replace("SHA256=", "sha256="), SECRET), { valid: true });
  assert.deepEqual(checkSignature(body, null, SECRET), { valid: false, reason: "missing" });
  assert.deepEqual(checkSignature(body, "", SECRET), { valid: false, reason: "missing" });
  assert.deepEqual(checkSignature(body, "sha1=abc", SECRET), { valid: false, reason: "malformed" });
  assert.deepEqual(checkSignature(body, `sha256=${"0".repeat(63)}`, SECRET), { valid: false, reason: "malformed" });
  assert.deepEqual(checkSignature(body, signatureFor(notification, "outro-segredo-0123456789"), SECRET), { valid: false, reason: "mismatch" });
  // Um byte a mais (corpo alterado) ou o mesmo JSON reformatado: outra assinatura.
  const reformatted = JSON.stringify(JSON.parse(notification), null, 2);
  assert.deepEqual(checkSignature(new TextEncoder().encode(`${notification} `), signatureFor(notification, SECRET), SECRET), { valid: false, reason: "mismatch" });
  assert.deepEqual(checkSignature(new TextEncoder().encode(reformatted), signatureFor(notification, SECRET), SECRET), { valid: false, reason: "mismatch" });
});

test("igualdade em tempo constante, inclusive com tamanhos diferentes", () => {
  assert.equal(constantTimeEquals(VERIFY, VERIFY), true);
  assert.equal(constantTimeEquals(VERIFY, `${VERIFY}x`), false);
  assert.equal(constantTimeEquals(VERIFY, ""), false);
  assert.equal(constantTimeEquals("", ""), true);
});

// ---------------------------------------------------------------------------
// Verificação (GET)
// ---------------------------------------------------------------------------
test("GET: token certo devolve o challenge em texto puro; qualquer outro caso é 403", async () => {
  const { deps, logs } = fakeDeps();
  const ok = handleVerification(new URL(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1158201444`), deps);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "1158201444");
  assert.match(ok.headers.get("content-type") ?? "", /^text\/plain/);
  assert.equal(ok.headers.get("cache-control"), "no-store");

  for (const query of [
    `hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`,
    `hub.mode=subscribe&hub.verify_token=${VERIFY}x&hub.challenge=1`,
    `hub.mode=unsubscribe&hub.verify_token=${VERIFY}&hub.challenge=1`,
    `hub.mode=subscribe&hub.challenge=1`,
    `hub.mode=subscribe&hub.verify_token=${VERIFY}`,
    `hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=${encodeURIComponent("<script>")}`,
    "",
  ]) {
    const denied = handleVerification(new URL(`${URL_BASE}?${query}`), deps);
    assert.equal(denied.status, 403, query);
    assert.equal(await denied.text(), "forbidden");
  }
  assert.equal(logs.filter((entry) => entry.event === "verify.rejected").length, 7);
});

test("GET sem configuração: 503", () => {
  const { deps } = fakeDeps({ config: () => parseWebhookConfig({}) });
  assert.equal(handleVerification(new URL(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=1`), deps).status, 503);
});

// ---------------------------------------------------------------------------
// Notificação (POST)
// ---------------------------------------------------------------------------
test("POST assinado: grava o texto recebido e responde 200", async () => {
  const { deps, recorded, logs } = fakeDeps();
  const response = await handleNotification(signed(notification), deps);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.deepEqual(recorded, [notification]);
  assert.deepEqual(logs.at(-1), { event: "notification.accepted", bytes: Buffer.byteLength(notification), received: 1, rejected: 0, duplicates: 0 });
});

test("POST: o 200 só sai depois que a gravação termina", async () => {
  let release!: (value: RecordOutcome) => void;
  const pending = new Promise<RecordOutcome>((resolve) => {
    release = resolve;
  });
  const { deps } = fakeDeps({ record: () => pending });
  let settled = false;
  const response = handleNotification(signed(notification), deps).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false, "não responde enquanto grava");
  release({ received: 1, rejected: 0, duplicates: 0 });
  assert.equal((await response).status, 200);
});

test("POST sem assinatura, com assinatura errada ou corpo alterado: 401 e nada gravado", async () => {
  const { deps, recorded, logs } = fakeDeps();
  const cases = [
    post(notification),
    post(notification, { "x-hub-signature-256": "sha256=abc" }),
    post(notification, { "x-hub-signature-256": signatureFor(notification, "outro-segredo-0123456789") }),
    post(notification.replace("wamid.ficticio", "wamid.forjado"), { "x-hub-signature-256": signatureFor(notification, SECRET) }),
  ];
  for (const request of cases) {
    const response = await handleNotification(request, deps);
    assert.equal(response.status, 401);
    assert.equal(await response.text(), "unauthorized");
  }
  assert.deepEqual(recorded, []);
  assert.deepEqual(
    logs.map((entry) => entry.reason),
    ["signature_missing", "signature_malformed", "signature_mismatch", "signature_mismatch"],
  );
});

test("POST acima de 3 MB: 413 sem conferir nem gravar (pelo cabeçalho ou pelo corpo)", async () => {
  const { deps, recorded } = fakeDeps();
  const big = "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1);
  const declared = new Request(URL_BASE, { method: "POST", body: "{}", headers: { "content-length": String(MAX_WEBHOOK_BODY_BYTES + 1) } });
  assert.equal((await handleNotification(declared, deps)).status, 413);
  // Sem Content-Length (corpo em stream): para de ler ao passar do limite.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(big));
      controller.close();
    },
  });
  const streamed = new Request(URL_BASE, { method: "POST", body: stream, duplex: "half" } as RequestInit);
  assert.equal((await handleNotification(streamed, deps)).status, 413);
  assert.equal((await handleNotification(signed(`"${"y".repeat(MAX_WEBHOOK_BODY_BYTES - 10)}"`), deps)).status, 200, "até o limite passa");
  assert.equal(recorded.length, 1);
});

test("POST autenticado que não é JSON (ou não é UTF-8): 400 e nada gravado", async () => {
  const { deps, recorded } = fakeDeps();
  assert.equal((await handleNotification(signed("não é json"), deps)).status, 400);
  assert.equal((await handleNotification(signed(""), deps)).status, 400);
  const latin1 = new Uint8Array([0x7b, 0x22, 0xe9, 0x22, 0x3a, 0x31, 0x7d]);
  assert.equal((await handleNotification(post(latin1, { "x-hub-signature-256": signatureFor(latin1, SECRET) }), deps)).status, 400);
  assert.deepEqual(recorded, []);
});

test("POST com estrutura inesperada mas JSON válido: vai para o banco (que registra como rejeitado)", async () => {
  const { deps, recorded } = fakeDeps({ record: async (json) => { recorded.push(json); return { received: 0, rejected: 1, duplicates: 0 }; } });
  const response = await handleNotification(signed('{"object":"page"}'), deps);
  assert.equal(response.status, 200);
  assert.deepEqual(recorded, ['{"object":"page"}']);
});

test("POST com banco indisponível: 503 (a Meta reentrega), sem detalhes na resposta", async () => {
  const failure = Object.assign(new Error(`connect ECONNREFUSED 127.0.0.1:55434 ${PHONE}`), { code: "ECONNREFUSED" });
  const { deps, logs } = fakeDeps({ record: async () => { throw failure; } });
  const response = await handleNotification(signed(notification), deps);
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "unavailable");
  assert.equal(logs.at(-1)?.reason, "record_failed");

  const unconfigured = fakeDeps({ record: async () => { throw Object.assign(new Error("WORKER_DATABASE_URL é obrigatória."), { name: "DatabaseConfigError" }); } });
  assert.equal((await handleNotification(signed(notification), unconfigured.deps)).status, 503);
  assert.equal(unconfigured.logs.at(-1)?.reason, "config_missing");

  const unstorable = fakeDeps({ record: async () => { throw Object.assign(new Error("unsupported Unicode escape sequence"), { code: "22P05" }); } });
  assert.equal((await handleNotification(signed('{"a":"\\u0000"}'), unstorable.deps)).status, 400, "JSON que o banco não aceita: 400, reenviar não adianta");
});

test("POST sem configuração do webhook: 503 sem ler nem gravar", async () => {
  const { deps, recorded } = fakeDeps({ config: () => { throw new WebhookConfigError("x"); } });
  assert.equal((await handleNotification(signed(notification), deps)).status, 503);
  assert.deepEqual(recorded, []);
});

test("log: nenhum telefone, nome, conteúdo, segredo ou assinatura em nenhum caso", async () => {
  const { deps, logs } = fakeDeps({ record: async () => { throw Object.assign(new Error(`falha ${PHONE} ${NAME}`), { code: "57P01" }); } });
  await handleNotification(signed(notification), deps);
  await handleNotification(post(notification, { "x-hub-signature-256": signatureFor(notification, "outro-segredo-0123456789") }), deps);
  handleVerification(new URL(`${URL_BASE}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1`), deps);
  const all = JSON.stringify(logs);
  for (const forbidden of [PHONE, NAME, BODY_TEXT, SECRET, VERIFY, "wamid", "sha256=", "falha"]) {
    assert.ok(!all.includes(forbidden), `log não pode conter ${forbidden}`);
  }
});

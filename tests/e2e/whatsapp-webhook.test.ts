/**
 * E2B-1 — webhook da Meta contra a aplicação REAL (proxy.ts, rota
 * /api/webhooks/whatsapp, pool do worker, PostgreSQL de testes), servida por
 * `pnpm app:e2e` com segredos do webhook FICTÍCIOS gerados a cada execução
 * (os mesmos chegam a este processo para assinar). Sem sessão de usuário,
 * como a Meta.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { signatureFor } from "../../src/modules/whatsapp/webhook-signature.ts";
import { connectFixtureClient, uniqueMetaId } from "../db/harness.ts";

const BASE = process.env.E2E_BASE_URL as string;
const SECRET = process.env.WHATSAPP_APP_SECRET as string;
const VERIFY = process.env.WHATSAPP_VERIFY_TOKEN as string;
const PATH = "/api/webhooks/whatsapp";
const suffix = randomBytes(5).toString("hex");
const phone = uniqueMetaId();
const waba = uniqueMetaId();

let fixture: pg.Client;
let organizationId = "";
let accountId = "";

const body = (id: string, phoneNumberId = phone) =>
  JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "15550000000", phone_number_id: phoneNumberId },
              contacts: [{ wa_id: "5511999990000", profile: { name: "Cliente Ficticio" } }],
              messages: [{ from: "5511999990000", id, timestamp: "1763550000", type: "text", text: { body: "Oi" } }],
            },
          },
        ],
      },
    ],
  });

const post = (payload: string | Uint8Array<ArrayBuffer>, signature?: string) =>
  fetch(`${BASE}${PATH}`, {
    method: "POST",
    body: payload,
    redirect: "manual",
    headers: { "content-type": "application/json", ...(signature ? { "x-hub-signature-256": signature } : {}) },
  });

async function eventsOf(id: string) {
  const { rows } = await fixture.query<{ status: string; organization_id: string | null; whatsapp_account_id: string | null }>(
    "SELECT status, organization_id, whatsapp_account_id FROM public.webhook_events WHERE payload #>> '{value,messages,0,id}' = $1",
    [id],
  );
  return rows;
}

before(async () => {
  assert.ok(BASE && SECRET && VERIFY, "rode com `pnpm app:e2e` (segredos fictícios do webhook)");
  fixture = await connectFixtureClient();
  organizationId = (
    await fixture.query<{ id: string }>("INSERT INTO public.organizations (name, slug) VALUES ($1, $2) RETURNING id", [
      `Webhook E2E ${suffix}`,
      `webhook-e2e-${suffix}`,
    ])
  ).rows[0].id;
  accountId = (
    await fixture.query<{ id: string }>(
      `INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, external_business_account_id)
       VALUES ($1, 'cloud_api', 'connected', $2, $3, $4) RETURNING id`,
      [organizationId, `Webhook E2E ${suffix}`, phone, waba],
    )
  ).rows[0].id;
});

after(async () => {
  await fixture.query("DELETE FROM public.webhook_events WHERE payload::text LIKE $1", [`%${suffix}%`]);
  await fixture.query("DELETE FROM public.organizations WHERE id = $1", [organizationId]);
  await fixture.end();
});

test("GET de verificação: sem sessão, token certo devolve o challenge; errado é 403", async () => {
  const ok = await fetch(`${BASE}${PATH}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY)}&hub.challenge=987654321`, { redirect: "manual" });
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "987654321");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const wrong = await fetch(`${BASE}${PATH}?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=987654321`, { redirect: "manual" });
  assert.equal(wrong.status, 403);
  assert.doesNotMatch(await wrong.text(), /987654321/);
});

test("POST assinado: 200 e o evento já gravado na organização do canal", async () => {
  const id = `wamid.${suffix}.e2e.valid`;
  const payload = body(id);
  const response = await post(payload, signatureFor(payload, SECRET));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.deepEqual(await eventsOf(id), [{ status: "received", organization_id: organizationId, whatsapp_account_id: accountId }]);
  // Reentrega: 200 de novo, sem outra linha.
  assert.equal((await post(payload, signatureFor(payload, SECRET))).status, 200);
  assert.equal((await eventsOf(id)).length, 1);
});

test("POST sem assinatura, assinatura de outro segredo ou corpo alterado: 401, nada gravado, nada ecoado", async () => {
  const id = `wamid.${suffix}.e2e.forged`;
  const payload = body(id);
  for (const response of [
    await post(payload),
    await post(payload, signatureFor(payload, randomBytes(16).toString("hex"))),
    await post(payload.replace('"Oi"', '"Oi!"'), signatureFor(payload, SECRET)),
  ]) {
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.equal(text, "unauthorized");
  }
  assert.deepEqual(await eventsOf(id), []);
});

test("POST acima de 3 MB: 413; corpo que não é JSON: 400; nada gravado", async () => {
  const big = new Uint8Array(3 * 1024 * 1024 + 1).fill(0x20);
  assert.equal((await post(big, signatureFor(big, SECRET))).status, 413);
  const notJson = `não é json ${suffix}`;
  assert.equal((await post(notJson, signatureFor(notJson, SECRET))).status, 400);
  const { rows } = await fixture.query<{ n: number }>("SELECT count(*)::int AS n FROM public.webhook_events WHERE payload::text LIKE $1 AND status = 'received'", [`%${suffix}%`]);
  assert.equal(rows[0].n, 1, "só o evento válido do teste anterior");
});

test("canal inexistente: 200 e rejeitado sem organização", async () => {
  const id = `wamid.${suffix}.e2e.unknown`;
  const payload = body(id, uniqueMetaId());
  assert.equal((await post(payload, signatureFor(payload, SECRET))).status, 200);
  assert.deepEqual(await eventsOf(id), [{ status: "rejected", organization_id: null, whatsapp_account_id: null }]);
});

test("o webhook público não abre outras rotas: sem sessão, o resto continua indo para o login", async () => {
  for (const path of ["/conversas", "/admin", "/fluxos", "/api/webhooks", "/api/webhooks/outro", "/api/webhooks/whatsappx"]) {
    const response = await fetch(`${BASE}${path}`, { redirect: "manual" });
    assert.ok([302, 303, 307, 308].includes(response.status), `${path}: ${response.status}`);
    assert.match(response.headers.get("location") ?? "", /\/login$/, path);
  }
  const put = await fetch(`${BASE}${PATH}`, { method: "PUT", body: "{}", redirect: "manual" });
  assert.equal(put.status, 405, "só GET e POST");
});

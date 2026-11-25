/**
 * E2B-1 — webhook da Meta contra o PostgreSQL de TESTES: o handler real
 * (`modules/whatsapp/webhook-handler.ts`) com a gravação real
 * (`recordWebhookDelivery`, pool `antero_worker`). O que exige conexões
 * simultâneas ou o pool de verdade fica aqui; as regras da 0014 estão em
 * db/tests/140_whatsapp_webhook_test.sql.
 *
 * Payloads sintéticos assinados com um App Secret fictício. Rode com
 * `pnpm db:test:integration whatsapp-webhook`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { DisallowedQueryError } from "../../src/lib/db/errors.ts";
import { closeWorkerPool, workerQuery } from "../../src/lib/db/worker-pool.ts";
import { recordWebhookDelivery } from "../../src/modules/whatsapp/sql-commands.ts";
import { handleNotification, type WebhookDeps } from "../../src/modules/whatsapp/webhook-handler.ts";
import type { WebhookLogInput } from "../../src/modules/whatsapp/webhook-log.ts";
import { signatureFor } from "../../src/modules/whatsapp/webhook-signature.ts";
import { connectFixtureClient, rawAppClient, uniqueMetaId } from "./harness.ts";

const SECRET = randomBytes(16).toString("hex");
const suffix = randomBytes(5).toString("hex");
const logs: WebhookLogInput[] = [];
const deps: WebhookDeps = {
  config: () => ({ appSecret: SECRET, verifyToken: `verificacao-${suffix}-0123456789` }),
  record: recordWebhookDelivery,
  log: (entry) => logs.push(entry),
};

let fixture: pg.Client;
const org = { a: "", b: "" };
const channel = {
  a: { id: "", phone: uniqueMetaId(), waba: uniqueMetaId() },
  b: { id: "", phone: uniqueMetaId(), waba: uniqueMetaId() },
  off: { id: "", phone: uniqueMetaId(), waba: "" },
};
let sequence = 0;
const wamid = (label: string) => `wamid.${suffix}.${label}.${(sequence += 1)}`;

function change(phone: string, id: string) {
  return {
    field: "messages",
    value: {
      messaging_product: "whatsapp",
      metadata: { display_phone_number: "15550000000", phone_number_id: phone },
      contacts: [{ wa_id: "5511999990000", profile: { name: "Cliente Ficticio" } }],
      messages: [{ from: "5511999990000", id, timestamp: "1763550000", type: "text", text: { body: "Oi" } }],
    },
  };
}
const delivery = (...entries: { waba: string; changes: unknown[] }[]) =>
  JSON.stringify({ object: "whatsapp_business_account", entry: entries.map((e) => ({ id: e.waba, changes: e.changes })) });

function signedRequest(body: string): Request {
  return new Request("https://exemplo.invalid/api/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: { "content-type": "application/json", "x-hub-signature-256": signatureFor(body, SECRET) },
  });
}

async function eventsFor(id: string) {
  const { rows } = await fixture.query<{ status: string; reason: string | null; organization_id: string | null; whatsapp_account_id: string | null }>(
    "SELECT status, reason, organization_id, whatsapp_account_id FROM public.webhook_events WHERE payload #>> '{value,messages,0,id}' = $1",
    [id],
  );
  return rows;
}

before(async () => {
  fixture = await connectFixtureClient();
  const orgs = await fixture.query<{ id: string; slug: string }>(
    "INSERT INTO public.organizations (name, slug) VALUES ($1, $2), ($3, $4) RETURNING id, slug",
    [`Webhook A ${suffix}`, `webhook-a-${suffix}`, `Webhook B ${suffix}`, `webhook-b-${suffix}`],
  );
  org.a = orgs.rows.find((row) => row.slug.startsWith("webhook-a"))!.id;
  org.b = orgs.rows.find((row) => row.slug.startsWith("webhook-b"))!.id;
  channel.off.waba = channel.a.waba;
  for (const [key, organizationId, status] of [["a", org.a, "connected"], ["b", org.b, "connected"], ["off", org.a, "disconnected"]] as const) {
    const { rows } = await fixture.query<{ id: string }>(
      `INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, external_business_account_id)
       VALUES ($1, 'cloud_api', $2, $3, $4, $5) RETURNING id`,
      [organizationId, status, `Webhook ${key} ${suffix}`, channel[key].phone, channel[key].waba],
    );
    channel[key].id = rows[0].id;
  }
});

after(async () => {
  await closeWorkerPool();
  // Eventos deste arquivo (os sem organização, pelo sufixo), depois as organizações (levam canais e eventos).
  await fixture.query("DELETE FROM public.webhook_events WHERE payload::text LIKE $1", [`%${suffix}%`]);
  await fixture.query("DELETE FROM public.organizations WHERE id = ANY($1::uuid[])", [[org.a, org.b]]);
  await fixture.end();
});

test("pool do worker: conecta como antero_worker e só chama funções", async () => {
  const { rows } = await workerQuery<{ role: string; session_role: string }>("SELECT current_user AS role, session_user AS session_role");
  assert.deepEqual(rows[0], { role: "antero_worker", session_role: "antero_worker" });
  await assert.rejects(workerQuery("SELECT 1; SELECT 2"), DisallowedQueryError);
  await assert.rejects(workerQuery("DELETE FROM public.webhook_events"), DisallowedQueryError);
  await assert.rejects(workerQuery("SELECT set_config('role', 'antero_owner', false)"), DisallowedQueryError);
  // Mesmo um SELECT válido não lê tabela nenhuma: o papel não tem privilégio.
  for (const table of ["public.organizations", "public.whatsapp_accounts", "public.messages", "public.webhook_events", "auth.users"]) {
    await assert.rejects(workerQuery(`SELECT count(*) FROM ${table}`), (error: { code?: string }) => error.code === "42501", table);
  }
});

test("notificação válida: gravada ANTES do 200, na organização e no canal do número", async () => {
  const id = wamid("valid");
  const response = await handleNotification(signedRequest(delivery({ waba: channel.a.waba, changes: [change(channel.a.phone, id)] })), deps);
  assert.equal(response.status, 200);
  // Quando o 200 chega, a linha já está confirmada no banco (outra conexão a enxerga).
  assert.deepEqual(await eventsFor(id), [{ status: "received", reason: null, organization_id: org.a, whatsapp_account_id: channel.a.id }]);
});

test("reentregas simultâneas da mesma notificação: todas 200, uma linha só", async () => {
  const id = wamid("concurrent");
  const body = delivery({ waba: channel.a.waba, changes: [change(channel.a.phone, id)] });
  const responses = await Promise.all(Array.from({ length: 20 }, () => handleNotification(signedRequest(body), deps)));
  assert.deepEqual(new Set(responses.map((r) => r.status)), new Set([200]));
  assert.equal((await eventsFor(id)).length, 1);
  const accepted = logs.filter((entry) => entry.event === "notification.accepted").slice(-20);
  assert.equal(accepted.reduce((sum, entry) => sum + (entry.received ?? 0), 0), 1, "um único pendente");
  assert.equal(accepted.reduce((sum, entry) => sum + (entry.duplicates ?? 0), 0), 19, "19 duplicatas");
});

test("notificações simultâneas de duas organizações: cada alteração na sua, sem mistura", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => ({ a: wamid(`para-a-${i}`), b: wamid(`para-b-${i}`) }));
  const bodies = ids.flatMap(({ a, b }) => [
    delivery({ waba: channel.a.waba, changes: [change(channel.a.phone, a)] }),
    delivery({ waba: channel.b.waba, changes: [change(channel.b.phone, b)] }),
    delivery({ waba: channel.a.waba, changes: [change(channel.a.phone, `${a}-lote`)] }, { waba: channel.b.waba, changes: [change(channel.b.phone, `${b}-lote`)] }),
  ]);
  const responses = await Promise.all(bodies.map((body) => handleNotification(signedRequest(body), deps)));
  assert.ok(responses.every((r) => r.status === 200));
  for (const { a, b } of ids) {
    for (const id of [a, `${a}-lote`]) assert.equal((await eventsFor(id))[0]?.organization_id, org.a, id);
    for (const id of [b, `${b}-lote`]) assert.equal((await eventsFor(id))[0]?.organization_id, org.b, id);
  }
  const { rows } = await fixture.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.webhook_events
     WHERE payload::text LIKE $1
       AND ((payload #>> '{value,metadata,phone_number_id}' = $2 AND organization_id IS DISTINCT FROM $3::uuid)
         OR (payload #>> '{value,metadata,phone_number_id}' = $4 AND organization_id IS DISTINCT FROM $5::uuid))`,
    [`%${suffix}%`, channel.a.phone, org.a, channel.b.phone, org.b],
  );
  assert.equal(rows[0].n, 0, "nenhum evento atribuído à organização errada");
});

test("canal inexistente, de outra organização (WABA errada) ou desconectado: 200 e rejeitado, sem tocar na organização", async () => {
  const before = await fixture.query("SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) AS h FROM public.whatsapp_accounts t WHERE organization_id = ANY($1::uuid[])", [[org.a, org.b]]);
  const unknown = wamid("unknown");
  const foreign = wamid("foreign");
  const off = wamid("off");
  for (const body of [
    delivery({ waba: uniqueMetaId(), changes: [change(uniqueMetaId(), unknown)] }),
    delivery({ waba: channel.b.waba, changes: [change(channel.a.phone, foreign)] }),
    delivery({ waba: channel.off.waba, changes: [change(channel.off.phone, off)] }),
  ]) {
    assert.equal((await handleNotification(signedRequest(body), deps)).status, 200);
  }
  assert.deepEqual(await eventsFor(unknown), [{ status: "rejected", reason: "unknown_channel", organization_id: null, whatsapp_account_id: null }]);
  assert.deepEqual(await eventsFor(foreign), [{ status: "rejected", reason: "waba_mismatch", organization_id: null, whatsapp_account_id: null }]);
  assert.deepEqual(await eventsFor(off), [{ status: "rejected", reason: "channel_disconnected", organization_id: org.a, whatsapp_account_id: channel.off.id }]);
  const afterHash = await fixture.query("SELECT md5(string_agg(t::text, ',' ORDER BY t.id)) AS h FROM public.whatsapp_accounts t WHERE organization_id = ANY($1::uuid[])", [[org.a, org.b]]);
  assert.equal(afterHash.rows[0].h, before.rows[0].h, "canais intactos");
});

test("assinatura inválida: 401 e nada no banco", async () => {
  const id = wamid("forged");
  const body = delivery({ waba: channel.a.waba, changes: [change(channel.a.phone, id)] });
  const forged = new Request("https://exemplo.invalid/api/webhooks/whatsapp", {
    method: "POST",
    body,
    headers: { "x-hub-signature-256": signatureFor(body, randomBytes(16).toString("hex")) },
  });
  assert.equal((await handleNotification(forged, deps)).status, 401);
  assert.deepEqual(await eventsFor(id), []);
});

test("estrutura inválida mas autenticada: 200 e uma linha rejeitada sem organização", async () => {
  const body = JSON.stringify({ object: "page", marker: suffix });
  assert.equal((await handleNotification(signedRequest(body), deps)).status, 200);
  const { rows } = await fixture.query("SELECT status, reason, organization_id FROM public.webhook_events WHERE payload ->> 'marker' = $1", [suffix]);
  assert.deepEqual(rows, [{ status: "rejected", reason: "invalid_payload", organization_id: null }]);
});

test("banco indisponível: 503 sem 200 e nada gravado; volta a gravar quando o banco volta", async () => {
  const original = process.env.WORKER_DATABASE_URL!;
  const id = wamid("down");
  const body = delivery({ waba: channel.a.waba, changes: [change(channel.a.phone, id)] });
  await closeWorkerPool();
  const down = new URL(original);
  down.port = "1"; // nada escuta aqui: conexão recusada
  process.env.WORKER_DATABASE_URL = down.toString();
  try {
    const response = await handleNotification(signedRequest(body), deps);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), "unavailable");
    assert.equal(logs.at(-1)?.reason, "record_failed");
  } finally {
    await closeWorkerPool();
    process.env.WORKER_DATABASE_URL = original;
  }
  assert.deepEqual(await eventsFor(id), []);
  // A Meta reentrega a mesma notificação: agora grava.
  assert.equal((await handleNotification(signedRequest(body), deps)).status, 200);
  assert.equal((await eventsFor(id)).length, 1);
});

test("aplicação (antero_app) não lê nem grava eventos brutos, nem chama as funções do worker", async () => {
  const client = rawAppClient();
  await client.connect();
  try {
    for (const sql of [
      "SELECT count(*) FROM public.webhook_events",
      "SELECT * FROM public.webhook_record_delivery('{}'::jsonb)",
      "SELECT * FROM public.webhook_claim_events(10, 60)",
    ]) {
      await assert.rejects(client.query(sql), (error: { code?: string }) => error.code === "42501", sql);
    }
  } finally {
    await client.end();
  }
});

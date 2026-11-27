/**
 * E2B-2a — ingestão das mensagens do webhook (0015) contra o PostgreSQL de
 * TESTES, pelo pool real do `antero_worker` (`ingestWebhookMessage`). Aqui fica
 * o que exige conexões simultâneas e o caminho até a Inbox; as regras da
 * função estão em db/tests/150_whatsapp_ingest_test.sql.
 *
 * Notificações sintéticas no formato da Meta, gravadas por
 * `recordWebhookDelivery` (0014). Rode com `pnpm db:test:integration whatsapp-ingest`.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { closeWorkerPool, workerQuery } from "../../src/lib/db/worker-pool.ts";
import { replyWindowOf } from "../../src/modules/conversations/attendance.ts";
import { getConversationDetail, listConversations } from "../../src/modules/conversations/sql-queries.ts";
import { ingestWebhookMessage, recordWebhookDelivery, type WebhookIngestResult } from "../../src/modules/whatsapp/sql-commands.ts";
import { connectFixtureClient, createFixtures, dropFixtures, uniqueMetaId, type Fixtures } from "./harness.ts";

// Mais conexões do que o padrão (3), para que as chamadas concorrentes de fato
// cheguem juntas ao banco. Lido na criação do pool (primeiro uso).
process.env.WORKER_DATABASE_POOL_MAX = "12";

const suffix = randomBytes(5).toString("hex");
let fixture: pg.Client;
let f: Fixtures;
const channel = {
  a: { id: "", phone: uniqueMetaId(), waba: uniqueMetaId() },
  b: { id: "", phone: uniqueMetaId(), waba: uniqueMetaId() },
};
let sequence = 0;
const wamid = (label: string) => `wamid.${suffix}.${label}.${(sequence += 1)}`;
let phoneSequence = 0;
const newPhone = () => `55119${String(Date.now() % 10_000).padStart(4, "0")}${String((phoneSequence += 1)).padStart(4, "0")}`;
const nowSeconds = (offsetSeconds = 0) => String(Math.floor(Date.now() / 1000) + offsetSeconds);

type MetaMessage = Record<string, unknown>;
const text = (id: string, from: string | null, extra: MetaMessage = {}): MetaMessage => ({
  ...(from ? { from } : {}),
  id,
  timestamp: nowSeconds(),
  type: "text",
  text: { body: `Oi ${id}` },
  ...extra,
});

/** Grava a notificação como o webhook (0014). `salt` muda o corpo: outro evento com as mesmas mensagens. */
async function notify(key: keyof typeof channel, messages: MetaMessage[], contacts?: unknown[], salt?: string) {
  const value: Record<string, unknown> = {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550000000", phone_number_id: channel[key].phone },
    messages,
  };
  if (contacts) value.contacts = contacts;
  if (salt) value.salt = salt;
  const body = { object: "whatsapp_business_account", entry: [{ id: channel[key].waba, changes: [{ field: "messages", value }] }] };
  const outcome = await recordWebhookDelivery(JSON.stringify(body));
  assert.equal(outcome.received + outcome.duplicates, 1);
}

async function eventsWith(id: string): Promise<string[]> {
  const { rows } = await fixture.query<{ id: string }>(
    `SELECT e.id::text AS id FROM public.webhook_events e
     WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(coalesce(e.payload #> '{value,messages}', '[]')) m WHERE m ->> 'id' = $1)
     ORDER BY e.id`,
    [id],
  );
  return rows.map((row) => row.id);
}

const tokens = new Map<string, string>();
async function claimPending() {
  const { rows } = await workerQuery<{ event_id: string; claim_token: string }>(
    "SELECT event_id::text AS event_id, claim_token FROM public.webhook_claim_events($1, $2)",
    [100, 300],
  );
  for (const row of rows) tokens.set(row.event_id, row.claim_token);
}
async function tokenFor(eventId: string): Promise<string> {
  if (!tokens.has(eventId)) await claimPending();
  const token = tokens.get(eventId);
  assert.ok(token, `evento ${eventId} não reivindicado`);
  return token;
}
async function ingest(eventId: string, id: string): Promise<WebhookIngestResult> {
  return ingestWebhookMessage({ eventId, claimToken: await tokenFor(eventId), wamid: id });
}
const count = async (sql: string, values: unknown[]) => (await fixture.query<{ n: number }>(sql, values)).rows[0].n;
const sqlState = (code: string) => (error: { code?: string }) => error.code === code;

before(async () => {
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  for (const [key, organizationId] of [["a", f.orgA], ["b", f.orgB]] as const) {
    const { rows } = await fixture.query<{ id: string }>(
      `INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name, external_account_id, external_business_account_id)
       VALUES ($1, 'cloud_api', 'connected', $2, $3, $4) RETURNING id`,
      [organizationId, `Ingestão ${key} ${suffix}`, channel[key].phone, channel[key].waba],
    );
    channel[key].id = rows[0].id;
  }
});

after(async () => {
  try {
    await closeWorkerPool();
    await closeAppPool();
    // Retenções e eventos referenciam o canal (NO ACTION, 0014/0015): saem antes
    // de dropFixtures, que apaga os canais e depois as organizações.
    await fixture.query("DELETE FROM public.webhook_message_holds WHERE organization_id = ANY($1::uuid[])", [[f.orgA, f.orgB]]);
    await fixture.query("DELETE FROM public.webhook_events WHERE organization_id = ANY($1::uuid[])", [[f.orgA, f.orgB]]);
    await dropFixtures(fixture, f);
  } finally {
    await fixture.end();
  }
});

test("mensagem real chega à Inbox só da organização do canal, com a janela pela Meta", async () => {
  const id = wamid("inbox");
  await notify("a", [text(id, newPhone())], undefined);
  const [eventId] = await eventsWith(id);
  const result = await ingest(eventId, id);
  assert.equal(result.outcome, "created");
  assert.equal(result.organization_id, f.orgA);
  assert.equal(result.whatsapp_account_id, channel.a.id);
  assert.equal(result.provider_time_status, "valid");

  const inbox = await listConversations({ userId: f.users.aAttendant, organizationId: f.orgA }, { status: "waiting" });
  assert.ok(inbox.items.some((item) => item.id === result.conversation_id));
  const other = await listConversations({ userId: f.users.bOwner, organizationId: f.orgB });
  assert.ok(!other.items.some((item) => item.id === result.conversation_id));
  assert.equal(await getConversationDetail({ userId: f.users.bOwner, organizationId: f.orgB }, result.conversation_id!), null);

  const detail = await getConversationDetail({ userId: f.users.aAttendant, organizationId: f.orgA }, result.conversation_id!);
  assert.equal(detail?.channelProvider, "cloud_api");
  assert.equal(replyWindowOf(detail?.lastInboundAt ?? null).open, true);
});

test("Inbox: sem horário válido da Meta, a janela da conversa cloud_api aparece fechada", async () => {
  const id = wamid("sem-horario");
  await notify("a", [text(id, newPhone(), { timestamp: "não é número" })]);
  const [eventId] = await eventsWith(id);
  const result = await ingest(eventId, id);
  assert.equal(result.outcome, "created");
  assert.equal(result.provider_time_status, "invalid");
  const detail = await getConversationDetail({ userId: f.users.aAttendant, organizationId: f.orgA }, result.conversation_id!);
  assert.equal(detail?.lastInboundAt, null);
  assert.equal(replyWindowOf(detail?.lastInboundAt ?? null).open, false);
});

test("20 ingestões simultâneas da mesma mensagem: 1 created, 19 duplicate, 1 linha", async () => {
  const id = wamid("concorrente");
  await notify("a", [text(id, newPhone())]);
  const [eventId] = await eventsWith(id);
  const token = await tokenFor(eventId);
  const results = await Promise.all(Array.from({ length: 20 }, () => ingestWebhookMessage({ eventId, claimToken: token, wamid: id })));
  assert.equal(results.filter((r) => r.outcome === "created").length, 1);
  assert.equal(results.filter((r) => r.outcome === "duplicate").length, 19);
  assert.equal(new Set(results.map((r) => r.message_id)).size, 1);
  assert.equal(await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = $1", [id]), 1);
});

test("a mesma mensagem em 5 eventos diferentes, ao mesmo tempo: uma mensagem só", async () => {
  const id = wamid("varios-eventos");
  const phone = newPhone();
  for (let i = 0; i < 5; i += 1) await notify("a", [text(id, phone)], undefined, `reentrega-${i}`);
  const events = await eventsWith(id);
  assert.equal(events.length, 5);
  for (const eventId of events) await tokenFor(eventId);
  const results = await Promise.all(events.map((eventId) => ingest(eventId, id)));
  assert.equal(results.filter((r) => r.outcome === "created").length, 1);
  assert.equal(results.filter((r) => r.outcome === "duplicate").length, 4);
  assert.equal(await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = $1", [id]), 1);
});

test("mensagem e retenção concorrentes para o mesmo wamid: nunca as duas", async () => {
  for (let i = 0; i < 10; i += 1) {
    const id = wamid(`corrida-${i}`);
    await notify("a", [text(id, newPhone())], undefined, "com-telefone");
    await notify("a", [text(id, null, { from_user_id: `BR.${suffix}${i}` })], undefined, "sem-telefone");
    const events = await eventsWith(id);
    assert.equal(events.length, 2);
    for (const eventId of events) await tokenFor(eventId);
    const results = await Promise.all(events.map((eventId) => ingest(eventId, id)));
    const messages = await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = $1", [id]);
    const holds = await count("SELECT count(*)::int AS n FROM public.webhook_message_holds WHERE wamid = $1", [id]);
    assert.equal(messages + holds, 1, `wamid ${i}: ${JSON.stringify(results.map((r) => r.outcome))}`);
    // O segundo caminho vê o primeiro: duplicate (mensagem já existia) ou held repetida.
    assert.ok(results.some((r) => r.duplicate), "um dos caminhos é repetição");
  }
});

test("duas organizações ao mesmo tempo: cada mensagem na sua", async () => {
  const ids = Array.from({ length: 10 }, (_, i) => ({ a: wamid(`org-a-${i}`), b: wamid(`org-b-${i}`) }));
  for (const { a, b } of ids) {
    await notify("a", [text(a, newPhone())]);
    await notify("b", [text(b, newPhone())]);
  }
  const work: { eventId: string; id: string }[] = [];
  for (const { a, b } of ids) {
    for (const id of [a, b]) {
      const [eventId] = await eventsWith(id);
      await tokenFor(eventId);
      work.push({ eventId, id });
    }
  }
  const results = await Promise.all(work.map(({ eventId, id }) => ingest(eventId, id)));
  assert.ok(results.every((r) => r.outcome === "created"));
  const wrong = await count(
    `SELECT count(*)::int AS n FROM public.messages m
     WHERE m.external_message_id = ANY($1::text[])
       AND NOT ((m.organization_id = $2 AND m.whatsapp_account_id = $3) OR (m.organization_id = $4 AND m.whatsapp_account_id = $5))`,
    [ids.flatMap(({ a, b }) => [a, b]), f.orgA, channel.a.id, f.orgB, channel.b.id],
  );
  assert.equal(wrong, 0);
  assert.equal(
    await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = ANY($1::text[]) AND organization_id = $2", [ids.map(({ b }) => b), f.orgB]),
    10,
  );
});

test("evento com 10 mensagens ingeridas em paralelo: todas na mesma conversa, ordem de chegada distinta", async () => {
  const phone = newPhone();
  const ids = Array.from({ length: 10 }, (_, i) => wamid(`lote-${i}`));
  await notify("a", ids.map((id) => text(id, phone)));
  const [eventId] = await eventsWith(ids[0]);
  await tokenFor(eventId);
  const results = await Promise.all(ids.map((id) => ingest(eventId, id)));
  assert.ok(results.every((r) => r.outcome === "created"));
  assert.equal(new Set(results.map((r) => r.conversation_id)).size, 1);
  assert.equal(new Set(results.map((r) => r.contact_id)).size, 1);
  assert.equal(
    await count("SELECT count(DISTINCT arrival_order)::int AS n FROM public.messages WHERE external_message_id = ANY($1::text[])", [ids]),
    10,
  );
});

test("prazo vencido: claim_lost; a nova reivindicação ingere e o token antigo deixa de valer", async () => {
  const id = wamid("prazo");
  await notify("a", [text(id, newPhone())]);
  const [eventId] = await eventsWith(id);
  const oldToken = await tokenFor(eventId);
  await fixture.query("UPDATE public.webhook_events SET claimed_until = clock_timestamp() - interval '1 second' WHERE id = $1", [eventId]);
  await assert.rejects(ingestWebhookMessage({ eventId, claimToken: oldToken, wamid: id }), sqlState("WH001"));
  tokens.delete(eventId);
  const newToken = await tokenFor(eventId);
  assert.notEqual(newToken, oldToken);
  assert.equal((await ingestWebhookMessage({ eventId, claimToken: newToken, wamid: id })).outcome, "created");
  await assert.rejects(ingestWebhookMessage({ eventId, claimToken: oldToken, wamid: id }), sqlState("WH001"));
  // Encerrado, o evento não ingere mais nada.
  await workerQuery("SELECT public.webhook_finish_event($1::bigint, $2::uuid, 'processed', NULL)", [eventId, newToken]);
  await assert.rejects(ingestWebhookMessage({ eventId, claimToken: newToken, wamid: id }), sqlState("WH001"));
});

test("wamid de outro evento é recusado", async () => {
  const first = wamid("evento-1");
  const second = wamid("evento-2");
  await notify("a", [text(first, newPhone())]);
  await notify("b", [text(second, newPhone())]);
  const [eventA] = await eventsWith(first);
  await assert.rejects(ingest(eventA, second), sqlState("WH002"));
  assert.equal(await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = $1", [second]), 0);
});

test("dois telefones novos com o mesmo BSUID ao mesmo tempo: um contato com ele, o outro retido", async () => {
  const bsuid = `BR.${suffix}corrida`;
  const ids = [wamid("bsuid-1"), wamid("bsuid-2")];
  await notify("a", [text(ids[0], newPhone(), { from_user_id: bsuid })]);
  await notify("a", [text(ids[1], newPhone(), { from_user_id: bsuid })]);
  const events = [(await eventsWith(ids[0]))[0], (await eventsWith(ids[1]))[0]];
  for (const eventId of events) await tokenFor(eventId);
  const results = await Promise.all(ids.map((id, i) => ingest(events[i], id)));
  assert.deepEqual(results.map((r) => r.outcome).sort(), ["created", "held"]);
  assert.equal(results.find((r) => r.outcome === "held")?.reason, "identity_conflict");
  assert.equal(await count("SELECT count(*)::int AS n FROM public.contacts WHERE organization_id = $1 AND whatsapp_user_id = $2", [f.orgA, bsuid]), 1);
});

/** Uma notificação por mensagem (eventos distintos), todas reivindicadas; devolve os eventos na mesma ordem. */
async function notifyEach(messages: MetaMessage[]): Promise<string[]> {
  for (const message of messages) await notify("a", [message]);
  const events: string[] = [];
  for (const message of messages) {
    const [eventId] = await eventsWith(String(message.id));
    await tokenFor(eventId);
    events.push(eventId);
  }
  return events;
}
const bsuidOf = async (phone: string) =>
  (
    await fixture.query<{ whatsapp_user_id: string | null }>(
      "SELECT whatsapp_user_id FROM public.contacts WHERE organization_id = $1 AND phone_number = $2",
      [f.orgA, `+${phone}`],
    )
  ).rows.map((row) => row.whatsapp_user_id);

for (const existing of [false, true]) {
  test(`mesmo telefone, dois BSUIDs ao mesmo tempo (${existing ? "contato já existe sem BSUID" : "contato novo"}): um entra, o outro é retido`, async () => {
    for (let i = 0; i < 10; i += 1) {
      const phone = newPhone();
      if (existing) {
        const first = wamid(`sem-bsuid-${i}`);
        const [eventId] = await notifyEach([text(first, phone)]);
        assert.equal((await ingest(eventId, first)).outcome, "created");
        assert.deepEqual(await bsuidOf(phone), [null]);
      }
      const bsuids = [`BR.${suffix}x${existing ? "e" : "n"}${i}`, `BR.${suffix}y${existing ? "e" : "n"}${i}`];
      const ids = bsuids.map((_, k) => wamid(`dois-bsuids-${k}-${i}`));
      const events = await notifyEach(ids.map((id, k) => text(id, phone, { from_user_id: bsuids[k] })));
      const results = await Promise.all(ids.map((id, k) => ingest(events[k], id)));

      assert.deepEqual(results.map((r) => r.outcome).sort(), ["created", "held"], JSON.stringify(results));
      const held = results.find((r) => r.outcome === "held")!;
      const created = results.find((r) => r.outcome === "created")!;
      assert.equal(held.reason, "identity_conflict");
      assert.equal(held.identity_note, "bsuid_mismatch");
      assert.equal(created.identity_note, null);
      // Contato único, com o BSUID de quem entrou; o outro BSUID fica na retenção.
      const winner = bsuids[results.indexOf(created)];
      const loser = bsuids[results.indexOf(held)];
      assert.deepEqual(await bsuidOf(phone), [winner]);
      const { rows } = await fixture.query<{ provider_user_id: string }>(
        "SELECT provider_user_id FROM public.webhook_message_holds WHERE id = $1",
        [held.hold_id],
      );
      assert.equal(rows[0].provider_user_id, loser);
      assert.equal(await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = ANY($1::text[])", [ids]), 1);
    }
  });
}

test("mesmo telefone, mesmo BSUID, 8 mensagens ao mesmo tempo: todas entram num contato só", async () => {
  const phone = newPhone();
  const bsuid = `BR.${suffix}mesmo`;
  const ids = Array.from({ length: 8 }, (_, i) => wamid(`mesmo-bsuid-${i}`));
  const events = await notifyEach(ids.map((id) => text(id, phone, { from_user_id: bsuid })));
  const results = await Promise.all(ids.map((id, i) => ingest(events[i], id)));
  assert.ok(results.every((r) => r.outcome === "created" && r.identity_note === null), JSON.stringify(results));
  assert.equal(new Set(results.map((r) => r.contact_id)).size, 1);
  assert.equal(new Set(results.map((r) => r.conversation_id)).size, 1);
  assert.deepEqual(await bsuidOf(phone), [bsuid]);
});

test("telefones e BSUIDs cruzados ao mesmo tempo: sem deadlock, sem identidade contraditória", async () => {
  for (let i = 0; i < 10; i += 1) {
    const phones = [newPhone(), newPhone()];
    const bsuids = [`BR.${suffix}p${i}`, `BR.${suffix}q${i}`];
    // (P,X) (Q,Y) (P,Y) (Q,X): cada par disputa um telefone E um BSUID com outro par.
    const pairs = [[0, 0], [1, 1], [0, 1], [1, 0]] as const;
    const ids = pairs.map(([p, b]) => wamid(`cruzado-${p}${b}-${i}`));
    const events = await notifyEach(ids.map((id, k) => text(id, phones[pairs[k][0]], { from_user_id: bsuids[pairs[k][1]] })));
    // Uma rejeição (ex.: 40P01 deadlock) faz o Promise.all falhar o teste.
    const results = await Promise.all(ids.map((id, k) => ingest(events[k], id)));
    assert.ok(results.every((r) => r.outcome === "created" || (r.outcome === "held" && r.reason === "identity_conflict")), JSON.stringify(results));
    const messages = await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = ANY($1::text[])", [ids]);
    const holds = await count("SELECT count(*)::int AS n FROM public.webhook_message_holds WHERE wamid = ANY($1::text[])", [ids]);
    assert.equal(messages + holds, 4);
    // Cada BSUID em no máximo um contato; cada contato com no máximo um BSUID (coluna única).
    const { rows } = await fixture.query<{ bsuid: string; contacts: number }>(
      `SELECT whatsapp_user_id AS bsuid, count(*)::int AS contacts FROM public.contacts
       WHERE organization_id = $1 AND whatsapp_user_id = ANY($2::text[]) GROUP BY whatsapp_user_id`,
      [f.orgA, bsuids],
    );
    assert.ok(rows.every((row) => row.contacts === 1), JSON.stringify(rows));
    // Toda mensagem criada está no contato cujo BSUID é o dela.
    for (const [k, r] of results.entries()) {
      if (r.outcome !== "created") continue;
      assert.deepEqual(await bsuidOf(phones[pairs[k][0]]), [bsuids[pairs[k][1]]]);
    }
  }
});

test("texto de 65.536 caracteres pelo webhook: retido inteiro (content_too_long), sem erro de constraint", async () => {
  const id = wamid("extensa");
  const body = "a".repeat(65_536);
  const [eventId] = await notifyEach([text(id, newPhone(), { text: { body } })]);
  const result = await ingest(eventId, id);
  assert.equal(result.outcome, "held");
  assert.equal(result.reason, "content_too_long");
  const { rows } = await fixture.query<{ storage: string; length: number }>(
    "SELECT message_storage AS storage, char_length(message #>> '{text,body}')::int AS length FROM public.webhook_message_holds WHERE id = $1",
    [result.hold_id],
  );
  assert.deepEqual(rows[0], { storage: "complete", length: 65_536 });
  assert.equal(await count("SELECT count(*)::int AS n FROM public.messages WHERE external_message_id = $1", [id]), 0);
});

test("sem telefone: retida, nenhum contato; o worker e a aplicação não leem retenções", async () => {
  const id = wamid("sem-telefone");
  await notify("a", [text(id, null, { from_user_id: `BR.${suffix}semtel` })], [{ user_id: `BR.${suffix}semtel`, profile: { name: "Sem Telefone" } }]);
  const [eventId] = await eventsWith(id);
  const result = await ingest(eventId, id);
  assert.equal(result.outcome, "held");
  assert.equal(result.reason, "missing_phone");
  assert.ok(result.hold_id);
  assert.equal(await count("SELECT count(*)::int AS n FROM public.contacts WHERE whatsapp_user_id = $1", [`BR.${suffix}semtel`]), 0);
  await assert.rejects(workerQuery("SELECT count(*) FROM public.webhook_message_holds"), sqlState("42501"));
});

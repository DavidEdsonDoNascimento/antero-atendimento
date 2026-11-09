/**
 * Entrega E2A — atendimento humano pela camada da aplicação, com o pool
 * `antero_app` (sem BYPASSRLS): simulador (ingestão real), assumir, responder
 * pelo provedor simulado, resolver e reabrir. O dono das tabelas só monta
 * cenários e confere o que ficou gravado.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, InvalidUserContextError, ModuleDisabledError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { AttendanceActionError } from "../../src/modules/conversations/errors.ts";
import {
  claimConversation,
  resolveConversation,
  sendConversationReply,
} from "../../src/modules/conversations/sql-commands.ts";
import {
  getConversationDetail,
  listConversationEvents,
  listConversationMessages,
  listConversations,
} from "../../src/modules/conversations/sql-queries.ts";
import type { MessagingProvider } from "../../src/modules/messaging/provider.ts";
import {
  listSimulatorChannels,
  listSimulatorContacts,
  simulateInboundMessage,
} from "../../src/modules/simulator/sql-queries.ts";
import { connectFixtureClient, createExtraUsers, createFixtures, dropFixtures, rawAppClient, type Fixtures } from "./harness.ts";

let fixture: pg.Client;
let f: Fixtures;
let extra: { att2: string; att3: string; multi: string };
let cloudAccount: string;

const ctx = (userId: string, organizationId = f.orgA) => ({ userId, organizationId });
const owner = () => ctx(f.users.aOwner);
const attendant = () => ctx(f.users.aAttendant);
const attendant2 = () => ctx(extra.att2);

let phoneSeq = 0;
/** Cliente novo enviando a primeira mensagem pelo canal de A (ingestão real, como owner). */
async function newConversation(content = "Olá, preciso de ajuda"): Promise<{ conversationId: string; phone: string }> {
  phoneSeq += 1;
  const phone = `+55119777${String(phoneSeq).padStart(5, "0")}`;
  const result = await simulateInboundMessage(
    { userId: f.users.aOwner },
    { channelId: f.accountA, phoneNumber: phone, contactName: "Cliente Simulado", content, externalMessageId: `sim-in-${randomUUID()}` },
  );
  assert.equal(result.created, true);
  return { conversationId: result.conversation_id, phone };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof AttendanceActionError && error.code === code);
}

const row = async (sql: string, values: unknown[]) => (await fixture.query(sql, values)).rows[0];

before(async () => {
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  extra = await createExtraUsers(f.suffix, { att2: "A Atendente 2", att3: "A Atendente 3", multi: "Multi" });
  await fixture.query(
    `INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES
       ($1, $3, 'attendant', 'active'), ($1, $4, 'attendant', 'active'),
       ($1, $5, 'attendant', 'active'), ($2, $5, 'attendant', 'active')`,
    [f.orgA, f.orgB, extra.att2, extra.att3, extra.multi],
  );
  cloudAccount = (
    await row(
      `INSERT INTO public.whatsapp_accounts (organization_id, provider, status, display_name)
       VALUES ($1, 'cloud_api', 'connected', $2) RETURNING id`,
      [f.orgA, `Cloud A ${f.suffix}`],
    )
  ).id;
});

after(async () => {
  await dropFixtures(fixture, f);
  await fixture.query("DELETE FROM auth.users WHERE id = ANY($1::uuid[])", [Object.values(extra)]);
  await fixture.end();
  await closeAppPool();
});

// ---------------------------------------------------------------------------
// Simulador
// ---------------------------------------------------------------------------

test("simulador: canais só de owner/admin ativo, development conectado; contatos do canal", async () => {
  const channels = await listSimulatorChannels({ userId: f.users.aOwner });
  assert.deepEqual(channels.map((channel) => channel.id), [f.accountA]);
  assert.equal(channels[0].organization_id, f.orgA);
  assert.deepEqual(await listSimulatorChannels({ userId: f.users.aAttendant }), []);
  assert.deepEqual(await listSimulatorChannels({ userId: f.users.aDisabled }), []);
  assert.deepEqual((await listSimulatorChannels({ userId: f.users.bOwner })).map((c) => c.id), [f.accountB]);
  // Canal de outra organização pela URL: nada.
  assert.deepEqual(await listSimulatorContacts({ userId: f.users.bOwner }, f.accountA), []);
  const contacts = await listSimulatorContacts({ userId: f.users.aOwner }, f.accountA);
  assert.ok(contacts.some((contact) => contact.conversation_id === f.conversationA));
});

test("simulador: mensagem entra pela ingestão e aparece só na Inbox da organização do canal", async () => {
  const { conversationId } = await newConversation("Primeira mensagem simulada");
  const inboxA = await listConversations(attendant(), { status: "waiting" });
  assert.ok(inboxA.items.some((item) => item.id === conversationId));
  const inboxB = await listConversations(ctx(f.users.bOwner, f.orgB));
  assert.ok(!inboxB.items.some((item) => item.id === conversationId));
  assert.equal(await getConversationDetail(ctx(f.users.bOwner, f.orgB), conversationId), null);
});

test("simulador: atendente, outra organização, desativado e canal real são recusados", async () => {
  const input = { phoneNumber: "+5511977799999", contactName: null, content: "x", externalMessageId: `sim-in-${randomUUID()}` };
  await assert.rejects(simulateInboundMessage({ userId: f.users.aAttendant }, { ...input, channelId: f.accountA }), AccessDeniedError);
  await assert.rejects(simulateInboundMessage({ userId: f.users.bOwner }, { ...input, channelId: f.accountA }), AccessDeniedError);
  await assert.rejects(simulateInboundMessage({ userId: f.users.aDisabled }, { ...input, channelId: f.accountA }), AccessDeniedError);
  await assert.rejects(
    simulateInboundMessage({ userId: f.users.aOwner }, { ...input, channelId: cloudAccount }),
    (error: unknown) => (error as { reason?: string }).reason === "account_wrong_provider",
  );
  assert.equal(
    (await row("SELECT count(*)::int AS n FROM public.contacts WHERE phone_number = $1", [input.phoneNumber])).n,
    0,
  );
});

// ---------------------------------------------------------------------------
// Assumir
// ---------------------------------------------------------------------------

test("assumir: atendente assume, repetir não muda nada, outro recebe conflito", async () => {
  const { conversationId } = await newConversation();
  assert.deepEqual(await claimConversation(attendant(), conversationId), { changed: true });
  assert.deepEqual(await claimConversation(attendant(), conversationId), { changed: false });
  await rejectsWith(claimConversation(attendant2(), conversationId), "assigned_to_other");
  const detail = await getConversationDetail(attendant(), conversationId);
  assert.equal(detail?.status, "human");
  assert.equal(detail?.assignee?.userId, f.users.aAttendant);
  assert.ok(detail?.assignedAt);
  const events = await listConversationEvents(attendant(), conversationId);
  assert.deepEqual(events.map((event) => [event.type, event.userId]), [["assigned", f.users.aAttendant]]);
});

test("assumir: dois atendentes ao mesmo tempo — o segundo espera o primeiro e recebe conflito", async () => {
  const { conversationId } = await newConversation();
  const first = rawAppClient();
  // pg_stat_activity só mostra a espera de sessões do mesmo papel (antero_app).
  const observer = rawAppClient();
  await first.connect();
  await observer.connect();
  try {
    await first.query("BEGIN");
    await first.query("SELECT app.set_user_context($1::uuid)", [extra.att2]);
    await first.query("SELECT changed FROM public.claim_conversation($1::uuid, $2::uuid)", [f.orgA, conversationId]);

    const second = claimConversation(attendant(), conversationId).then(
      () => "assumiu",
      (error: unknown) => (error instanceof AttendanceActionError ? error.code : String(error)),
    );
    // O segundo fica bloqueado na trava da linha enquanto o primeiro não termina.
    let blocked = false;
    for (let attempt = 0; attempt < 100 && !blocked; attempt += 1) {
      const { rows } = await observer.query(
        `SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND query LIKE '%claim_conversation%'`,
      );
      blocked = rows[0].n > 0;
      if (!blocked) await new Promise((done) => setTimeout(done, 50));
    }
    assert.ok(blocked, "a segunda chamada ficou bloqueada");
    await first.query("COMMIT");
    assert.equal(await second, "assigned_to_other");
  } finally {
    await first.end();
    await observer.end();
  }
  const detail = await getConversationDetail(attendant(), conversationId);
  assert.equal(detail?.assignee?.userId, extra.att2);
  assert.equal((await listConversationEvents(attendant(), conversationId)).length, 1);
});

test("assumir: vários atendentes em paralelo — exatamente um vence", async () => {
  const { conversationId } = await newConversation();
  const people = [f.users.aAttendant, extra.att2, extra.att3, f.users.aOwner];
  const results = await Promise.allSettled(people.map((userId) => claimConversation(ctx(userId), conversationId)));
  const winners = results.filter((result) => result.status === "fulfilled");
  assert.equal(winners.length, 1);
  for (const result of results) {
    if (result.status === "rejected") assert.equal((result.reason as AttendanceActionError).code, "assigned_to_other");
  }
  assert.equal((await listConversationEvents(attendant(), conversationId)).length, 1);
});

// ---------------------------------------------------------------------------
// Segurança multiempresa
// ---------------------------------------------------------------------------

test("outra organização, suspensa, sem módulo, desativado e sem sessão não assumem nem respondem", async () => {
  const { conversationId } = await newConversation();
  const reply = (context: { userId: string; organizationId: string }) =>
    sendConversationReply(context, { conversationId, content: "x", clientMessageId: randomUUID() });

  // Outra organização no próprio contexto: a conversa não existe lá.
  await rejectsWith(claimConversation(ctx(f.users.bOwner, f.orgB), conversationId), "not_found");
  await rejectsWith(reply(ctx(f.users.bOwner, f.orgB)), "not_found");
  // Outra organização forjando o contexto de A: barrado antes da função.
  await assert.rejects(claimConversation(ctx(f.users.bOwner, f.orgA), conversationId), AccessDeniedError);
  await assert.rejects(reply(ctx(f.users.bOwner, f.orgA)), AccessDeniedError);
  // Membro de A e B operando no contexto de B não alcança a conversa de A.
  await rejectsWith(claimConversation(ctx(extra.multi, f.orgB), conversationId), "not_found");

  await assert.rejects(claimConversation(ctx(f.users.aDisabled), conversationId), AccessDeniedError);
  await assert.rejects(claimConversation(ctx(f.users.nobody), conversationId), AccessDeniedError);
  await assert.rejects(claimConversation(ctx("nao-e-uuid"), conversationId), InvalidUserContextError);

  await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [f.orgA]);
  try {
    await assert.rejects(claimConversation(attendant(), conversationId), AccessDeniedError);
  } finally {
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgA]);
  }
  await fixture.query("UPDATE public.organization_modules SET enabled = false WHERE organization_id = $1", [f.orgA]);
  try {
    await assert.rejects(claimConversation(attendant(), conversationId), ModuleDisabledError);
    await assert.rejects(listConversationEvents(attendant(), conversationId), ModuleDisabledError);
  } finally {
    await fixture.query("UPDATE public.organization_modules SET enabled = true WHERE organization_id = $1", [f.orgA]);
  }

  await rejectsWith(claimConversation(attendant(), "nao-e-uuid"), "not_found");
  assert.equal((await getConversationDetail(attendant(), conversationId))?.status, "waiting");
  assert.deepEqual(await listConversationEvents(ctx(f.users.bOwner, f.orgB), conversationId), []);
});

// ---------------------------------------------------------------------------
// Responder
// ---------------------------------------------------------------------------

test("responder: só o responsável; mensagem simulada no histórico; mesma chave não duplica", async () => {
  const { conversationId } = await newConversation();
  await rejectsWith(
    sendConversationReply(attendant(), { conversationId, content: "antes de assumir", clientMessageId: randomUUID() }),
    "not_eligible",
  );
  await claimConversation(attendant(), conversationId);
  await rejectsWith(
    sendConversationReply(attendant2(), { conversationId, content: "não sou eu", clientMessageId: randomUUID() }),
    "not_assignee",
  );

  const clientMessageId = randomUUID();
  const sent = await sendConversationReply(attendant(), { conversationId, content: "Olá! Em que posso ajudar?", clientMessageId });
  assert.equal(sent.created, true);
  assert.equal(sent.deliveryStatus, "sent");
  assert.equal(sent.simulated, true);

  // Pedido repetido (inclusive simultâneo): a mesma mensagem, sem reenviar.
  const repeats = await Promise.all(
    [1, 2, 3].map(() => sendConversationReply(attendant(), { conversationId, content: "Olá! Em que posso ajudar?", clientMessageId })),
  );
  for (const repeat of repeats) {
    assert.equal(repeat.created, false);
    assert.equal(repeat.messageId, sent.messageId);
  }
  const stored = await row(
    `SELECT count(*)::int AS n, min(external_message_id) AS external, min(sender_user_id::text) AS sender
     FROM public.messages WHERE conversation_id = $1 AND direction = 'outbound'`,
    [conversationId],
  );
  assert.equal(stored.n, 1);
  assert.match(stored.external, /^sim-out-/);
  assert.equal(stored.sender, f.users.aAttendant);

  const history = await listConversationMessages(attendant(), conversationId);
  assert.deepEqual(
    history?.items.map((message) => [message.direction, message.sender, message.deliveryStatus]),
    [
      ["inbound", "contact", "delivered"],
      ["outbound", "user", "sent"],
    ],
  );
  await rejectsWith(sendConversationReply(attendant(), { conversationId, content: "   ", clientMessageId: randomUUID() }), "invalid_content");
});

test("responder: falha do provedor fica registrada como failed; erro do provedor também", async () => {
  const { conversationId } = await newConversation();
  await claimConversation(attendant(), conversationId);
  const refusing: MessagingProvider = {
    provider: "development",
    simulated: true,
    async sendText() {
      return { ok: false, reason: "recusado no teste" };
    },
  };
  const throwing: MessagingProvider = {
    provider: "development",
    simulated: true,
    async sendText() {
      throw new Error("rede indisponível no teste");
    },
  };
  for (const provider of [refusing, throwing]) {
    const result = await sendConversationReply(
      attendant(),
      { conversationId, content: "vai falhar", clientMessageId: randomUUID() },
      { providerFor: () => provider },
    );
    assert.equal(result.deliveryStatus, "failed");
  }
  const stored = await row(
    "SELECT count(*)::int AS n, count(external_message_id)::int AS with_external FROM public.messages WHERE conversation_id = $1 AND delivery_status = 'failed'",
    [conversationId],
  );
  assert.deepEqual(stored, { n: 2, with_external: 0 });
});

test("responder: janela de 24 h encerrada é recusada; canal sem provedor não grava nada", async () => {
  const { conversationId } = await newConversation();
  await claimConversation(attendant(), conversationId);
  await fixture.query(
    "UPDATE public.messages SET created_at = now() - interval '25 hours' WHERE conversation_id = $1 AND direction = 'inbound'",
    [conversationId],
  );
  const detail = await getConversationDetail(attendant(), conversationId);
  assert.ok(detail?.lastInboundAt && Date.parse(detail.lastInboundAt) < Date.now() - 24 * 3600 * 1000);
  await rejectsWith(
    sendConversationReply(attendant(), { conversationId, content: "fora da janela", clientMessageId: randomUUID() }),
    "window_closed",
  );

  const contact = await row("INSERT INTO public.contacts (organization_id, phone_number) VALUES ($1, '+5511966600001') RETURNING id", [f.orgA]);
  const cloudConversation = await row(
    "INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id) VALUES ($1, $2, $3) RETURNING id",
    [f.orgA, cloudAccount, contact.id],
  );
  await fixture.query(
    "INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content) VALUES ($1, $2, $3, 'inbound', 'contact', 'oi')",
    [f.orgA, cloudConversation.id, cloudAccount],
  );
  await claimConversation(attendant(), cloudConversation.id);
  await rejectsWith(
    sendConversationReply(attendant(), { conversationId: cloudConversation.id, content: "sem provedor", clientMessageId: randomUUID() }),
    "provider_unavailable",
  );
  assert.equal(
    (await row("SELECT count(*)::int AS n FROM public.messages WHERE conversation_id = $1 AND direction = 'outbound'", [cloudConversation.id])).n,
    0,
  );
});

// ---------------------------------------------------------------------------
// Resolver e reabrir
// ---------------------------------------------------------------------------

test("fluxo completo: recebe, assume, responde, resolve, nova mensagem reabre, histórico íntegro", async () => {
  const { conversationId, phone } = await newConversation("Quero agendar");
  await claimConversation(attendant(), conversationId);
  await sendConversationReply(attendant(), { conversationId, content: "Claro! Qual dia?", clientMessageId: randomUUID() });
  await rejectsWith(resolveConversation(attendant2(), conversationId), "not_assignee");
  assert.deepEqual(await resolveConversation(attendant(), conversationId), { changed: true });
  assert.deepEqual(await resolveConversation(attendant(), conversationId), { changed: false });
  await rejectsWith(claimConversation(attendant2(), conversationId), "not_eligible");

  const resolved = await getConversationDetail(attendant(), conversationId);
  assert.equal(resolved?.status, "resolved");
  assert.ok(resolved?.resolvedAt);

  const externalMessageId = `sim-in-${randomUUID()}`;
  const again = await simulateInboundMessage(
    { userId: f.users.aOwner },
    { channelId: f.accountA, phoneNumber: phone, contactName: null, content: "Pode ser sexta?", externalMessageId },
  );
  assert.equal(again.conversation_id, conversationId);
  assert.equal(again.reopened, true);
  const duplicate = await simulateInboundMessage(
    { userId: f.users.aOwner },
    { channelId: f.accountA, phoneNumber: phone, contactName: null, content: "Pode ser sexta?", externalMessageId },
  );
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reopened, false);

  const reopened = await getConversationDetail(attendant(), conversationId);
  assert.equal(reopened?.status, "waiting");
  assert.equal(reopened?.assignee, null);
  assert.equal(reopened?.resolvedAt, null);

  const history = await listConversationMessages(attendant(), conversationId);
  assert.deepEqual(
    history?.items.map((message) => message.content),
    ["Quero agendar", "Claro! Qual dia?", "Pode ser sexta?"],
  );
  const events = await listConversationEvents(attendant(), conversationId);
  assert.deepEqual(
    events.map((event) => [event.type, event.userId]),
    [
      ["reopened", null],
      ["resolved", f.users.aAttendant],
      ["assigned", f.users.aAttendant],
    ],
  );
  assert.equal(events[1].userFullName, "A Atendente");

  // Reaberta, outro atendente assume e responde (janela contada da nova mensagem).
  await claimConversation(attendant2(), conversationId);
  const reply = await sendConversationReply(attendant2(), { conversationId, content: "Sexta às 10h.", clientMessageId: randomUUID() });
  assert.equal(reply.deliveryStatus, "sent");
  // Nada vazou para B.
  assert.ok(!(await listConversations(ctx(f.users.bOwner, f.orgB))).items.some((item) => item.id === conversationId));
});

test("owner/admin resolve conversa de outro atendente; atendente não", async () => {
  const { conversationId } = await newConversation();
  await claimConversation(attendant2(), conversationId);
  await rejectsWith(resolveConversation(attendant(), conversationId), "not_assignee");
  assert.deepEqual(await resolveConversation(owner(), conversationId), { changed: true });
  const events = await listConversationEvents(owner(), conversationId);
  assert.deepEqual(events.map((event) => [event.type, event.userId])[0], ["resolved", f.users.aOwner]);
});

/**
 * Entrega 4 — detalhe e histórico de mensagens
 * (modules/conversations/sql-queries.ts): equivalência com o contrato
 * PostgREST, keyset invertido, empates, microssegundos e not-found.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { decodeMessageHistoryCursor } from "../../src/modules/conversations/cursor.ts";
import { mapConversationDetailRow } from "../../src/modules/conversations/mappers.ts";
import type { ConversationDetailRow } from "../../src/modules/conversations/rows.ts";
import {
  getConversationDetail,
  listConversationMessages,
  listConversations,
} from "../../src/modules/conversations/sql-queries.ts";
import type { MessageHistoryItem } from "../../src/modules/conversations/types.ts";
import { connectFixtureClient } from "./harness.ts";
import {
  createInboxFixtures,
  dropInboxFixtures,
  iso,
  postgrestReferenceDetail,
  type InboxFixtures,
} from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures | undefined;

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
});

after(async () => {
  await closeAppPool();
  if (f) await dropInboxFixtures(fixture, f);
  await fixture.end();
});

const ctxA = () => ({ userId: f!.users.aOwner, organizationId: f!.orgA });

/** Percorre o histórico até o início; confere o cursor de cada página. */
async function walkHistory(conversationId: string, limit: number) {
  const pages: MessageHistoryItem[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = await listConversationMessages(ctxA(), conversationId, { limit, cursor });
    assert.ok(page, "conversa encontrada");
    pages.push(page.items);
    if (!page.nextCursor) break;
    const oldest = page.items[0];
    assert.deepEqual(
      decodeMessageHistoryCursor(page.nextCursor),
      { createdAt: oldest.createdAt, id: oldest.id },
      "cursor = mensagem mais antiga DEVOLVIDA na página",
    );
    cursor = page.nextCursor;
  }
  return pages;
}

test("detalhe: equivalência com o PostgREST para todas as conversas da organização", async () => {
  for (const [name, id] of Object.entries(f!.conv)) {
    if (name === "cB2") continue;
    const reference = await postgrestReferenceDetail<ConversationDetailRow>(f!.users.aOwner, f!.orgA, id);
    const detail = await getConversationDetail(ctxA(), id);
    assert.ok(reference && detail, name);
    if (name === "c5") {
      assert.throws(() => mapConversationDetailRow(reference), TypeError);
      assert.deepEqual(detail.assignee, { userId: f!.users.aDisabled, fullName: null });
      assert.equal(detail.resolvedAt, iso("12:30:00"));
      assert.equal(detail.assignedAt, iso("10:30:00"));
      continue;
    }
    assert.deepEqual(detail, mapConversationDetailRow(reference), name);
  }
});

test("detalhe: inexistente, malformado ou de outra organização → null (indistinguíveis)", async () => {
  assert.equal(await getConversationDetail(ctxA(), randomUUID()), null);
  assert.equal(await getConversationDetail(ctxA(), "nao-e-uuid"), null);
  assert.equal(await getConversationDetail(ctxA(), f!.conv.cB2), null);
  assert.equal(await getConversationDetail(ctxA(), f!.conversationB), null);
});

test("histórico completo: ordem cronológica (created_at, id), microssegundos e todos os tipos de remetente", async () => {
  const page = await listConversationMessages(ctxA(), f!.conv.cH, { limit: 100 });
  assert.ok(page);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    page.items.map((item) => item.id),
    f!.historyIds,
  );
  assert.deepEqual(
    page.items.map((item) => item.createdAt),
    [
      iso("09:00:00"),
      iso("09:00:00.000001"),
      iso("09:00:00.000001"),
      iso("09:00:00.000002"),
      iso("09:00:00.000002"),
      iso("09:00:00.000003"),
      iso("09:00:00.000004"),
    ],
  );
  const bySender = Object.fromEntries(page.items.map((item) => [item.content, item]));
  assert.deepEqual(
    { ...bySender["h3 dono"], id: undefined },
    {
      id: undefined,
      direction: "outbound",
      sender: "user",
      messageType: "text",
      content: "h3 dono",
      deliveryStatus: "read",
      senderUserId: f!.users.aOwner,
      createdAt: iso("09:00:00.000001"),
    },
  );
  assert.equal(bySender["h1"].direction, "inbound");
  assert.equal(bySender["h1"].sender, "contact");
  assert.equal(bySender["h1"].senderUserId, null);
  assert.equal(bySender["h2 bot"].sender, "bot");
  assert.equal(bySender["h5 sistema"].sender, "system");
  assert.equal(bySender["h7 atendente"].deliveryStatus, "failed");
});

test("histórico paginado: limites de 1 a 8 sem pular nem repetir, páginas cada vez mais antigas", async () => {
  for (let limit = 1; limit <= 8; limit += 1) {
    const pages = await walkHistory(f!.conv.cH, limit);
    for (const page of pages) {
      const ids = page.map((item) => item.id);
      const start = f!.historyIds.indexOf(ids[0]);
      assert.deepEqual(ids, f!.historyIds.slice(start, start + ids.length), "cada página em ordem cronológica");
    }
    assert.deepEqual(
      [...pages].reverse().flat().map((item) => item.id),
      f!.historyIds,
      `limit ${limit}`,
    );
    assert.equal(pages.length, Math.ceil(7 / limit), `páginas com limit ${limit}`);
  }
});

test("primeira página = as mais recentes; exatamente o limite (7) → sem nextCursor", async () => {
  const newest = await listConversationMessages(ctxA(), f!.conv.cH, { limit: 2 });
  assert.deepEqual(
    newest?.items.map((item) => item.id),
    f!.historyIds.slice(-2),
  );
  const exact = await listConversationMessages(ctxA(), f!.conv.cH, { limit: 7 });
  assert.equal(exact?.items.length, 7);
  assert.equal(exact?.nextCursor, null);
  const six = await listConversationMessages(ctxA(), f!.conv.cH, { limit: 6 });
  assert.equal(six?.items.length, 6);
  assert.notEqual(six?.nextCursor, null);
});

test("empate em created_at: a fronteira da página no meio do empate não pula nem repete", async () => {
  // Com limit 4 a 1ª página termina em h4 (empatada com h5): [h4, h5, h6, h7].
  const first = await listConversationMessages(ctxA(), f!.conv.cH, { limit: 4 });
  const second = await listConversationMessages(ctxA(), f!.conv.cH, { limit: 4, cursor: first!.nextCursor! });
  assert.deepEqual(
    [...second!.items, ...first!.items].map((item) => item.id),
    f!.historyIds,
  );
  const [h2, h3] = [f!.historyIds[1], f!.historyIds[2]];
  assert.ok(h2 < h3, "empate de created_at ordenado por id");
});

test("conversa sem mensagens → página vazia (não null)", async () => {
  assert.deepEqual(await listConversationMessages(ctxA(), f!.conv.c6), { items: [], nextCursor: null });
});

test("conversa inexistente, malformada ou de outra organização → null", async () => {
  assert.equal(await listConversationMessages(ctxA(), randomUUID()), null);
  assert.equal(await listConversationMessages(ctxA(), "123"), null);
  assert.equal(await listConversationMessages(ctxA(), f!.conv.cB2), null);
  assert.equal(await listConversationMessages(ctxA(), f!.conversationB, { limit: 100 }), null);
});

test("a última mensagem da lista é a última do histórico (mesmo desempate por id)", async () => {
  const { items } = await listConversations(ctxA(), { limit: 50 });
  for (const conversation of items) {
    const history = await listConversationMessages(ctxA(), conversation.id, { limit: 100 });
    assert.equal(conversation.lastMessage?.id ?? null, history?.items.at(-1)?.id ?? null, conversation.id);
  }
});

test("histórico de conversa com mensagens de entrada e saída do atendente (c1)", async () => {
  const page = await listConversationMessages(ctxA(), f!.conv.c1);
  assert.ok(page);
  assert.deepEqual(
    page.items.map((item) => [item.direction, item.sender]),
    [
      ["inbound", "contact"],
      ["outbound", "user"],
      ["outbound", "user"],
    ],
  );
  assert.deepEqual(
    page.items.slice(1).map((item) => item.id),
    [...f!.c1TieMessageIds].sort(),
  );
});

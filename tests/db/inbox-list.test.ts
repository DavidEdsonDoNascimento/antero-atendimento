/**
 * Entrega 4 — lista de conversas (modules/conversations/sql-queries.ts):
 * equivalência com o contrato PostgREST, ordenação, filtros, paginação por
 * cursor e objetos embutidos, contra o banco descartável.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { decodeConversationCursor } from "../../src/modules/conversations/cursor.ts";
import { mapConversationListRow } from "../../src/modules/conversations/mappers.ts";
import type { ConversationListRow } from "../../src/modules/conversations/rows.ts";
import { listConversations } from "../../src/modules/conversations/sql-queries.ts";
import type {
  ConversationListItem,
  ConversationStatusFilter,
} from "../../src/modules/conversations/types.ts";
import { connectFixtureClient } from "./harness.ts";
import {
  LONG_CONTENT,
  createInboxFixtures,
  dropInboxFixtures,
  iso,
  postgrestReferenceList,
  referenceConversationOrder,
  type InboxFixtures,
} from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures | undefined;
let orgVolume = "";

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  // Organização com 55 conversas (só para os limites de página), dona: multi.
  orgVolume = (
    await fixture.query("INSERT INTO public.organizations (name, slug) VALUES ('Org Volume', $1) RETURNING id", [
      `org-volume-${f.suffix}`,
    ])
  ).rows[0].id;
  await fixture.query(
    "INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [orgVolume, f.more.multi],
  );
  await fixture.query(
    `WITH account AS (
       INSERT INTO public.whatsapp_accounts (organization_id, display_name) VALUES ($1, 'Volume') RETURNING id
     ), contacts AS (
       INSERT INTO public.contacts (organization_id, phone_number)
       SELECT $1, '+55119777' || lpad(n::text, 5, '0') FROM generate_series(1, 55) n RETURNING id
     )
     INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id, last_message_at)
     SELECT $1, account.id, contacts.id, '2026-03-01 00:00:00+00'::timestamptz + (row_number() OVER ()) * interval '1 second'
     FROM account, contacts`,
    [orgVolume],
  );
});

after(async () => {
  await closeAppPool();
  if (orgVolume) {
    await fixture.query("DELETE FROM public.conversations WHERE organization_id = $1", [orgVolume]);
    await fixture.query("DELETE FROM public.contacts WHERE organization_id = $1", [orgVolume]);
    await fixture.query("DELETE FROM public.whatsapp_accounts WHERE organization_id = $1", [orgVolume]);
    await fixture.query("DELETE FROM public.organizations WHERE id = $1", [orgVolume]);
  }
  if (f) await dropInboxFixtures(fixture, f);
  await fixture.end();
});

const ctxA = () => ({ userId: f!.users.aOwner, organizationId: f!.orgA });

/** Percorre todas as páginas; confere que cada nextCursor aponta para o último item DEVOLVIDO. */
async function walk(
  context: { userId: string; organizationId: string },
  params: { status?: ConversationStatusFilter; limit?: number },
) {
  const pages: ConversationListItem[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 100; i += 1) {
    const page = await listConversations(context, { ...params, cursor });
    pages.push(page.items);
    if (!page.nextCursor) break;
    const decoded = decodeConversationCursor(page.nextCursor);
    const last = page.items.at(-1)!;
    assert.deepEqual(decoded, { lastMessageAt: last.lastMessageAt, id: last.id }, "cursor = último item devolvido");
    cursor = page.nextCursor;
  }
  return pages;
}

test("equivalência com o PostgREST: mesmos itens, na mesma ordem, pelos mesmos mapeadores", async () => {
  const reference = await postgrestReferenceList<ConversationListRow>(f!.users.aOwner, f!.orgA);
  const page = await listConversations(ctxA(), { limit: 50 });
  assert.equal(page.nextCursor, null);
  assert.deepEqual(
    page.items.map((item) => item.id),
    reference.map((row) => row.id),
  );

  for (const [index, row] of reference.entries()) {
    const item = page.items[index];
    if (row.id === f!.conv.c5) {
      // Atendente desativado: a RLS de profiles oculta o perfil → o embed do
      // PostgREST trazia `profile: null` e o mapeador atual quebrava.
      assert.equal(row.assigned_member?.profile, null);
      assert.throws(() => mapConversationListRow(row), TypeError);
      assert.deepEqual(item.assignee, { userId: f!.users.aDisabled, fullName: null });
      continue;
    }
    const expected = mapConversationListRow(row);
    if (row.id === f!.conv.c1) {
      // Empate exato na última mensagem: o PostgREST (só created_at) não
      // define qual vem; o SQL desempata por id (o maior).
      assert.equal(item.lastMessage?.createdAt, expected.lastMessage?.createdAt);
      assert.equal(item.lastMessage?.id, [...f!.c1TieMessageIds].sort().at(-1));
      assert.deepEqual({ ...item, lastMessage: null }, { ...expected, lastMessage: null });
      continue;
    }
    assert.deepEqual(item, expected, `conversa ${index}`);
  }
});

test("ordem last_message_at DESC, id DESC: empate exato desempatado por id e diferença de 1 µs respeitada", async () => {
  const { items } = await listConversations(ctxA(), { limit: 50 });
  const ids = items.map((item) => item.id);
  const c = f!.conv;
  assert.deepEqual(ids, await referenceConversationOrder(fixture, f!.orgA));
  const [first, second] = [c.c2, c.c3].sort().reverse();
  assert.deepEqual(ids.slice(2, 5), [first, second, c.c4]);
  assert.deepEqual(ids, [c.cA, c.c1, first, second, c.c4, c.c5, c.c6, c.c7, c.cH]);
});

test("filtros por status exato e 'open' (exclui só resolved)", async () => {
  for (const status of ["bot", "waiting", "human", "resolved", "open"] as const) {
    const { items } = await listConversations(ctxA(), { status, limit: 50 });
    assert.deepEqual(
      items.map((item) => item.id),
      await referenceConversationOrder(fixture, f!.orgA, status),
      status,
    );
    if (status !== "open") assert.ok(items.every((item) => item.status === status));
  }
  const open = await listConversations(ctxA(), { status: "open", limit: 50 });
  assert.equal(open.items.length, 8);
  assert.ok(!open.items.some((item) => item.id === f!.conv.c5));
});

test("paginação: limites de 1 a 10 percorrem tudo sem pular nem repetir", async () => {
  const expected = await referenceConversationOrder(fixture, f!.orgA);
  for (let limit = 1; limit <= 10; limit += 1) {
    const pages = await walk(ctxA(), { limit });
    assert.deepEqual(pages.flat().map((item) => item.id), expected, `limit ${limit}`);
    for (const page of pages.slice(0, -1)) assert.equal(page.length, limit);
    assert.equal(pages.length, Math.ceil(expected.length / limit), `páginas com limit ${limit}`);
  }
});

test("exatamente o limite (9 de 9): uma página, sem nextCursor; menos que o limite: idem", async () => {
  for (const limit of [9, 20]) {
    const page = await listConversations(ctxA(), { limit });
    assert.equal(page.items.length, 9);
    assert.equal(page.nextCursor, null, `limit ${limit}`);
  }
  const eight = await listConversations(ctxA(), { limit: 8 });
  assert.equal(eight.items.length, 8);
  assert.notEqual(eight.nextCursor, null);
});

test("paginação com filtro: 'open' com limit 2", async () => {
  const pages = await walk(ctxA(), { status: "open", limit: 2 });
  assert.deepEqual(
    pages.flat().map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgA, "open"),
  );
});

test("cursor que cai DENTRO de um empate (c2/c3) não pula nem repete", async () => {
  const pageOne = await listConversations(ctxA(), { limit: 3 }); // cA, c1, primeiro do empate
  const pageTwo = await listConversations(ctxA(), { limit: 3, cursor: pageOne.nextCursor! });
  const tie = [f!.conv.c2, f!.conv.c3].sort().reverse();
  assert.equal(pageOne.items.at(-1)!.id, tie[0]);
  assert.equal(pageTwo.items[0].id, tie[1]);
  assert.equal(pageOne.items.at(-1)!.lastMessageAt, pageTwo.items[0].lastMessageAt, "mesmo instante");
});

test("mudança de filtro entre chamadas: o cursor é só uma posição (last_message_at, id)", async () => {
  const open = await listConversations(ctxA(), { status: "open", limit: 3 });
  const cursor = decodeConversationCursor(open.nextCursor!);
  const resolved = await listConversations(ctxA(), { status: "resolved", cursor: open.nextCursor! });
  const { rows } = await fixture.query(
    `SELECT id FROM public.conversations
     WHERE organization_id = $1 AND status = 'resolved' AND (last_message_at, id) < ($2::timestamptz, $3::uuid)
     ORDER BY last_message_at DESC, id DESC`,
    [f!.orgA, cursor.lastMessageAt, cursor.id],
  );
  assert.deepEqual(
    resolved.items.map((item) => item.id),
    rows.map((row) => row.id),
  );
  assert.deepEqual(
    resolved.items.map((item) => item.id),
    [f!.conv.c5],
  );
});

test("limites de página: padrão 20, teto 50, valores inválidos → padrão", async () => {
  const ctx = { userId: f!.more.multi, organizationId: orgVolume };
  const cases: [number | undefined, number][] = [
    [undefined, 20],
    [0, 20],
    [-3, 20],
    [2.5, 20],
    [Number.NaN, 20],
    [50, 50],
    [51, 50],
    [1000, 50],
    [1, 1],
  ];
  for (const [limit, size] of cases) {
    const page = await listConversations(ctx, { limit });
    assert.equal(page.items.length, size, `limit ${limit}`);
    assert.notEqual(page.nextCursor, null);
  }
  const all = await walk(ctx, { limit: 50 });
  assert.deepEqual(
    all.map((page) => page.length),
    [50, 5],
  );
});

test("lista vazia: organização sem conversas", async () => {
  const page = await listConversations({ userId: f!.more.cOwner, organizationId: f!.orgC });
  assert.deepEqual(page, { items: [], nextCursor: null });
});

test("última mensagem por conversa: mesmo contato em dois canais não se cruza; sem mensagens → null", async () => {
  const { items } = await listConversations(ctxA(), { limit: 50 });
  const byId = new Map(items.map((item) => [item.id, item]));
  const c1 = byId.get(f!.conv.c1)!;
  const c7 = byId.get(f!.conv.c7)!;
  assert.equal(c1.contact.id, c7.contact.id, "mesmo contato");
  assert.notEqual(c1.channel.id, c7.channel.id, "canais diferentes");
  assert.equal(c7.lastMessage?.excerpt, "c7 pelo canal 2");
  assert.deepEqual(c7.channel, { id: f!.accountA2, displayName: null, phoneNumber: "+5511900000002" });
  assert.equal(byId.get(f!.conv.c6)!.lastMessage, null);
  assert.equal(byId.get(f!.conv.c6)!.lastMessageAt, iso("11:00:00"));
});

test("atendente, contato e dados opcionais", async () => {
  const { items } = await listConversations(ctxA(), { limit: 50 });
  const byId = new Map(items.map((item) => [item.id, item]));
  assert.deepEqual(byId.get(f!.conv.c2)!.assignee, { userId: f!.users.aOwner, fullName: "A Owner" });
  assert.deepEqual(byId.get(f!.conv.c1)!.assignee, { userId: f!.users.aAttendant, fullName: "A Atendente" });
  assert.equal(byId.get(f!.conv.c3)!.assignee, null);
  assert.deepEqual(byId.get(f!.conv.c4)!.contact, {
    id: f!.contactsA[4],
    name: null,
    phoneNumber: "+5511955550104",
  });
  assert.equal(byId.get(f!.conv.c4)!.lastMessage?.sender, "bot");
  assert.equal(byId.get(f!.conv.c1)!.lastMessage?.sender, "user");
  assert.equal(byId.get(f!.conv.c1)!.lastMessage?.direction, "outbound");
});

test("trecho da última mensagem truncado pelo mapeador existente", async () => {
  const { items } = await listConversations(ctxA(), { limit: 50 });
  const c3 = items.find((item) => item.id === f!.conv.c3)!;
  assert.ok(LONG_CONTENT.length > 140);
  assert.ok(c3.lastMessage!.excerpt.endsWith("…"));
  assert.equal(Array.from(c3.lastMessage!.excerpt).length, 141);
});

test("microssegundos preservados nos campos e no cursor", async () => {
  const page = await listConversations(ctxA(), { limit: 2 });
  const [cA, c1] = page.items;
  assert.equal(cA.startedAt, iso("14:50:00"));
  assert.equal(c1.lastMessageAt, iso("14:00:00.000002"));
  assert.equal(c1.lastMessage?.createdAt, iso("14:00:00.000002"));
  assert.equal(decodeConversationCursor(page.nextCursor!).lastMessageAt, iso("14:00:00.000002"));
});

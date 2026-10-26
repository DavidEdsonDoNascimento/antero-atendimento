/**
 * Entrega 4 — isolamento multiempresa das consultas SQL da Inbox e do
 * contexto de organização (withOrganizationTransaction): empresas A e B,
 * usuário em duas organizações, desativado, sem organização, sem contexto.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, InvalidUserContextError } from "../../src/lib/db/errors.ts";
import { closeAppPool, getAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import {
  getConversationDetail,
  listConversationMessages,
  listConversations,
} from "../../src/modules/conversations/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import {
  createInboxFixtures,
  dropInboxFixtures,
  referenceConversationOrder,
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

type Ctx = { userId: string; organizationId: string };

const allThree = (ctx: Ctx, conversationId: string) => [
  () => listConversations(ctx),
  () => getConversationDetail(ctx, conversationId),
  () => listConversationMessages(ctx, conversationId),
];

test("usuário de B vê só B; conversas de A não aparecem nem pelo id", async () => {
  const ctxB = { userId: f!.users.bOwner, organizationId: f!.orgB };
  const { items } = await listConversations(ctxB, { limit: 50 });
  assert.deepEqual(
    items.map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgB),
  );
  assert.ok(!items.some((item) => Object.values(f!.conv).slice(0, 9).includes(item.id)));
  for (const id of [f!.conv.c1, f!.conv.cH, f!.conv.cA]) {
    assert.equal(await getConversationDetail(ctxB, id), null);
    assert.equal(await listConversationMessages(ctxB, id), null);
  }
});

test("empates entre empresas não se misturam (cB2 tem o mesmo instante de c2/c3)", async () => {
  const a = await listConversations({ userId: f!.users.aOwner, organizationId: f!.orgA }, { limit: 50 });
  assert.ok(!a.items.some((item) => item.id === f!.conv.cB2));
});

test("membro de A pedindo o contexto de B (e vice-versa) → AccessDeniedError, sem consultar nada", async () => {
  const cases: [Ctx, string][] = [
    [{ userId: f!.users.aOwner, organizationId: f!.orgB }, f!.conv.cB2],
    [{ userId: f!.users.bOwner, organizationId: f!.orgA }, f!.conv.c1],
    [{ userId: f!.users.aAttendant, organizationId: f!.orgC }, f!.conv.c1],
  ];
  for (const [ctx, conversationId] of cases) {
    for (const call of allThree(ctx, conversationId)) await assert.rejects(call(), AccessDeniedError);
  }
});

test("usuário em DUAS organizações: cada contexto mostra só a própria empresa (filtro explícito além da RLS)", async () => {
  const multi = f!.more.multi;
  // Só a RLS deixaria ver as duas empresas na mesma transação:
  const rlsOnly = await withUserTransaction(multi, async (tx) =>
    (
      await tx.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM public.conversations WHERE id = ANY($1::uuid[])",
        [[f!.conv.c1, f!.conv.cB2]],
      )
    ).rows[0].n,
  );
  assert.equal(rlsOnly, 2);

  const ctxA = { userId: multi, organizationId: f!.orgA };
  const ctxB = { userId: multi, organizationId: f!.orgB };
  assert.deepEqual(
    (await listConversations(ctxA, { limit: 50 })).items.map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgA),
  );
  assert.deepEqual(
    (await listConversations(ctxB, { limit: 50 })).items.map((item) => item.id),
    await referenceConversationOrder(fixture, f!.orgB),
  );
  assert.equal(await getConversationDetail(ctxA, f!.conv.cB2), null);
  assert.equal(await listConversationMessages(ctxA, f!.conv.cB2), null);
  assert.equal(await getConversationDetail(ctxB, f!.conv.c1), null);
  assert.equal(await listConversationMessages(ctxB, f!.conv.cH), null);
  assert.ok(await getConversationDetail(ctxB, f!.conv.cB2));
});

test("atendente lê toda a Inbox da própria organização (a RLS não restringe por atribuição)", async () => {
  const asAttendant = await listConversations({ userId: f!.users.aAttendant, organizationId: f!.orgA }, { limit: 50 });
  const asOwner = await listConversations({ userId: f!.users.aOwner, organizationId: f!.orgA }, { limit: 50 });
  assert.deepEqual(asAttendant, asOwner);
});

test("membro desativado, usuário sem organização e id desconhecido → AccessDeniedError", async () => {
  for (const userId of [f!.users.aDisabled, f!.users.nobody, f!.more.platformAdmin, randomUUID()]) {
    for (const call of allThree({ userId, organizationId: f!.orgA }, f!.conv.c1)) {
      await assert.rejects(call(), AccessDeniedError, userId);
    }
  }
});

test("contato, canal e atendente embutidos pertencem SEMPRE à organização do contexto", async () => {
  const { rows: members } = await fixture.query(
    "SELECT organization_id, user_id FROM public.organization_members WHERE organization_id = ANY($1::uuid[])",
    [[f!.orgA, f!.orgB]],
  );
  const { rows: accounts } = await fixture.query(
    "SELECT organization_id, id FROM public.whatsapp_accounts WHERE organization_id = ANY($1::uuid[])",
    [[f!.orgA, f!.orgB]],
  );
  const { rows: contacts } = await fixture.query(
    "SELECT organization_id, id FROM public.contacts WHERE organization_id = ANY($1::uuid[])",
    [[f!.orgA, f!.orgB]],
  );
  const owned = (rows: { organization_id: string }[], org: string, key: "id" | "user_id") =>
    new Set(rows.filter((row) => row.organization_id === org).map((row) => (row as Record<string, string>)[key]));

  for (const [userId, org] of [
    [f!.users.aOwner, f!.orgA],
    [f!.users.bOwner, f!.orgB],
    [f!.more.multi, f!.orgA],
    [f!.more.multi, f!.orgB],
  ]) {
    const { items } = await listConversations({ userId, organizationId: org }, { limit: 50 });
    assert.ok(items.length > 0);
    for (const item of items) {
      assert.ok(owned(contacts, org, "id").has(item.contact.id), "contato da mesma organização");
      assert.ok(owned(accounts, org, "id").has(item.channel.id), "canal da mesma organização");
      if (item.assignee) assert.ok(owned(members, org, "user_id").has(item.assignee.userId), "atendente membro");
      const detail = await getConversationDetail({ userId, organizationId: org }, item.id);
      assert.equal(detail?.contact.id, item.contact.id);
      assert.equal(detail?.channel.id, item.channel.id);
    }
  }
});

test("sem contexto autenticado: userId ausente/inválido → InvalidUserContextError, sem usar conexão", async () => {
  const pool = getAppPool();
  const before = { total: pool.totalCount, idle: pool.idleCount };
  for (const userId of [undefined, null, "", "nao-e-uuid", `${f!.users.aOwner}'--`]) {
    const ctx = { userId: userId as unknown as string, organizationId: f!.orgA };
    for (const call of allThree(ctx, f!.conv.c1)) await assert.rejects(call(), InvalidUserContextError);
  }
  assert.deepEqual({ total: pool.totalCount, idle: pool.idleCount }, before);
});

test("organização ausente/inválida/inexistente → AccessDeniedError (nunca uma lista vazia)", async () => {
  for (const organizationId of [undefined, "", "org-a", randomUUID()]) {
    const ctx = { userId: f!.users.aOwner, organizationId: organizationId as unknown as string };
    for (const call of allThree(ctx, f!.conv.c1)) await assert.rejects(call(), AccessDeniedError);
  }
  await assert.rejects(listConversations(undefined as unknown as Ctx), AccessDeniedError);
});

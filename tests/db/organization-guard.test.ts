/**
 * Entrega E1A — guarda da organização na camada da aplicação: DAL
 * (`getActiveContext`), `withOrganizationTransaction` e consultas reais da
 * Inbox, com o pool `antero_app` (sem BYPASSRLS). O status é alterado pelo
 * dono das tabelas só para montar cada cenário.
 */
import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError } from "../../src/lib/db/errors.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import {
  getConversationDetail,
  listConversationMessages,
  listConversations,
} from "../../src/modules/conversations/sql-queries.ts";
import {
  getActiveContext,
  getSuspendedOrganizations,
  listAllOrganizations,
  setOrganizationStatus,
} from "../../src/modules/organizations/sql-queries.ts";
import { listOrganizationMembers } from "../../src/modules/users/sql-queries.ts";
import { getPrimaryWhatsappAccount } from "../../src/modules/whatsapp/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures | undefined;

const setStatus = (organizationId: string, status: "active" | "inactive") =>
  fixture.query("UPDATE public.organizations SET status = $2 WHERE id = $1", [organizationId, status]);

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
});

afterEach(async () => {
  for (const organizationId of [f!.orgA, f!.orgB, f!.orgC]) await setStatus(organizationId, "active");
  await fixture.query("DELETE FROM public.organization_members WHERE user_id = $1", [f!.more.platformAdmin]);
});

after(async () => {
  await closeAppPool();
  if (f) await dropInboxFixtures(fixture, f);
  await fixture.end();
});

test("sessão existente: a suspensão vale na consulta seguinte e a reativação restaura", async () => {
  const ctx = { userId: f!.users.aOwner, organizationId: f!.orgA };
  assert.equal((await getActiveContext({ userId: f!.users.aOwner }))?.organization.id, f!.orgA);
  const { items } = await listConversations(ctx, { limit: 50 });
  assert.ok(items.length > 0);

  await setStatus(f!.orgA, "inactive");
  assert.equal(await getActiveContext({ userId: f!.users.aOwner }), null);
  await assert.rejects(listConversations(ctx), AccessDeniedError);

  await setStatus(f!.orgA, "active");
  assert.equal((await getActiveContext({ userId: f!.users.aOwner }))?.organization.id, f!.orgA);
  assert.deepEqual(
    (await listConversations(ctx, { limit: 50 })).items.map((item) => item.id),
    items.map((item) => item.id),
    "nada foi apagado",
  );
});

test("organização suspensa: todas as consultas operacionais recusam, mesmo pela URL direta", async () => {
  await setStatus(f!.orgA, "inactive");
  for (const userId of [f!.users.aOwner, f!.users.aAttendant]) {
    const ctx = { userId, organizationId: f!.orgA };
    await assert.rejects(listConversations(ctx), AccessDeniedError);
    await assert.rejects(getConversationDetail(ctx, f!.conv.cH), AccessDeniedError);
    await assert.rejects(listConversationMessages(ctx, f!.conv.cH), AccessDeniedError);
    await assert.rejects(listOrganizationMembers(ctx), AccessDeniedError);
    await assert.rejects(getPrimaryWhatsappAccount(ctx), AccessDeniedError);
  }
});

test("duas organizações: a suspensa não bloqueia a ativa, e o contexto muda para a ativa", async () => {
  const userId = f!.more.multi;
  // Vínculo em B é o mais antigo: com B suspensa, o contexto passa a ser A.
  await setStatus(f!.orgB, "inactive");
  const context = await getActiveContext({ userId });
  assert.equal(context?.organization.id, f!.orgA);
  assert.ok((await listConversations({ userId, organizationId: f!.orgA }, { limit: 50 })).items.length > 0);
  await assert.rejects(listConversations({ userId, organizationId: f!.orgB }), AccessDeniedError);

  // Com a mais nova suspensa, continua em B, sem acesso a A.
  await setStatus(f!.orgB, "active");
  await setStatus(f!.orgA, "inactive");
  assert.equal((await getActiveContext({ userId }))?.organization.id, f!.orgB);
  await assert.rejects(listConversations({ userId, organizationId: f!.orgA }), AccessDeniedError);
});

test("outras empresas não são afetadas e continuam isoladas", async () => {
  await setStatus(f!.orgA, "inactive");
  const ctxB = { userId: f!.users.bOwner, organizationId: f!.orgB };
  const { items } = await listConversations(ctxB, { limit: 50 });
  assert.ok(items.length > 0);
  assert.ok(!items.some((item) => item.id === f!.conv.cH));
  assert.equal(await getConversationDetail(ctxB, f!.conv.cH), null);
  await assert.rejects(listConversations({ userId: f!.users.bOwner, organizationId: f!.orgA }), AccessDeniedError);
});

test("admin da plataforma: vê a suspensa e o status; vínculo com ela não vira contexto ativo", async () => {
  await setStatus(f!.orgA, "inactive");
  const all = await listAllOrganizations({ userId: f!.more.platformAdmin });
  assert.equal(all.find((org) => org.id === f!.orgA)?.status, "inactive");
  assert.equal(all.find((org) => org.id === f!.orgB)?.status, "active");

  // A RLS deixa o admin da plataforma ler organizations e vínculos: sem o
  // filtro de status no contexto, a organização suspensa voltaria aqui.
  await fixture.query(
    "INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [f!.orgA, f!.more.platformAdmin],
  );
  assert.equal(await getActiveContext({ userId: f!.more.platformAdmin }), null);
  await assert.rejects(
    listConversations({ userId: f!.more.platformAdmin, organizationId: f!.orgA }),
    AccessDeniedError,
  );
});

test("setOrganizationStatus: só o admin da plataforma; demais papéis → AccessDeniedError, sem efeito", async () => {
  const statusOf = async () =>
    (await fixture.query("SELECT status FROM public.organizations WHERE id = $1", [f!.orgA])).rows[0].status;
  for (const userId of [f!.users.aOwner, f!.users.aAttendant, f!.users.bOwner, f!.users.nobody, f!.users.aDisabled]) {
    await assert.rejects(setOrganizationStatus({ userId, organizationId: f!.orgA, status: "inactive" }), AccessDeniedError);
  }
  assert.equal(await statusOf(), "active");

  const platform = { userId: f!.more.platformAdmin, organizationId: f!.orgA };
  assert.equal(await setOrganizationStatus({ ...platform, status: "inactive" }), "inactive");
  assert.equal(await statusOf(), "inactive");
  // O owner suspenso não se reativa, por nenhum dos caminhos.
  await assert.rejects(
    setOrganizationStatus({ userId: f!.users.aOwner, organizationId: f!.orgA, status: "active" }),
    AccessDeniedError,
  );
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) =>
      tx.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f!.orgA]),
    ),
    { code: "42501" },
  );
  assert.equal(await statusOf(), "inactive");

  assert.equal(await setOrganizationStatus({ ...platform, status: "active" }), "active");
  assert.ok((await listConversations({ userId: f!.users.aOwner, organizationId: f!.orgA }, { limit: 50 })).items.length > 0);
});

test("getSuspendedOrganizations: distingue suspensa de sem vínculo, só do próprio usuário", async () => {
  assert.deepEqual(await getSuspendedOrganizations({ userId: f!.users.aOwner }), []);
  await setOrganizationStatus({ userId: f!.more.platformAdmin, organizationId: f!.orgA, status: "inactive" });
  assert.deepEqual(await getSuspendedOrganizations({ userId: f!.users.aOwner }), [{ id: f!.orgA, name: "Org A Integração" }]);
  // Multi vê só a suspensa; sem vínculo, desativado e outra empresa: nada.
  assert.deepEqual(await getSuspendedOrganizations({ userId: f!.more.multi }), [{ id: f!.orgA, name: "Org A Integração" }]);
  for (const userId of [f!.users.nobody, f!.users.aDisabled, f!.users.bOwner]) {
    assert.deepEqual(await getSuspendedOrganizations({ userId }), []);
  }
});

test("canal: nenhuma escrita direta em whatsapp_accounts; identificador e leitura preservados", async () => {
  const before = await getPrimaryWhatsappAccount({ userId: f!.users.aOwner, organizationId: f!.orgA });
  const writes = [
    "UPDATE public.whatsapp_accounts SET external_account_id = 'phone-id-de-outra-empresa' WHERE organization_id = $1",
    "UPDATE public.whatsapp_accounts SET provider = 'cloud_api' WHERE organization_id = $1",
    "INSERT INTO public.whatsapp_accounts (organization_id, external_account_id) VALUES ($1, 'phone-id-de-outra-empresa')",
    "DELETE FROM public.whatsapp_accounts WHERE organization_id = $1",
  ];
  for (const userId of [f!.users.aOwner, f!.users.aAttendant, f!.more.platformAdmin]) {
    for (const sql of writes) {
      await assert.rejects(withUserTransaction(userId, (tx) => tx.query(sql, [f!.orgA])), { code: "42501" }, sql);
    }
  }
  assert.deepEqual(await getPrimaryWhatsappAccount({ userId: f!.users.aOwner, organizationId: f!.orgA }), before);
});

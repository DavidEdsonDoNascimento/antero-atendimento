/**
 * Entrega 4 — consultas auxiliares paralelas (organizations, users,
 * whatsapp): mesmos contratos de queries.ts/dal.ts, papéis respeitados,
 * nada de outra empresa e nada de auth.*.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError, InvalidUserContextError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { getActiveContext, listAllOrganizations } from "../../src/modules/organizations/sql-queries.ts";
import { listOrganizationMembers } from "../../src/modules/users/sql-queries.ts";
import { getPrimaryWhatsappAccount } from "../../src/modules/whatsapp/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "./inbox-fixtures.ts";

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

const ORGANIZATION_KEYS = ["created_at", "id", "name", "slug", "status", "updated_at"];
const PROFILE_KEYS = ["created_at", "email", "full_name", "id", "is_platform_admin", "updated_at"];
const sortedKeys = (value: object) => Object.keys(value).sort();

test("getActiveContext: perfil + associação ativa mais antiga + organização + papel", async () => {
  const owner = await getActiveContext({ userId: f!.users.aOwner });
  assert.ok(owner);
  assert.equal(owner.userId, f!.users.aOwner);
  assert.equal(owner.role, "owner");
  assert.equal(owner.organization.id, f!.orgA);
  assert.deepEqual(sortedKeys(owner.organization), ORGANIZATION_KEYS);
  assert.deepEqual(sortedKeys(owner.profile), PROFILE_KEYS);
  assert.equal(owner.profile.id, f!.users.aOwner);
  assert.equal(owner.profile.full_name, "A Owner");
  assert.equal(owner.profile.is_platform_admin, false);
  assert.match(owner.profile.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00:00$/);

  // multi: ativo em A (2026-02-01) e em B (2026-01-01) → a mais antiga, B
  const multi = await getActiveContext({ userId: f!.more.multi });
  assert.equal(multi?.organization.id, f!.orgB);
  assert.equal(multi?.role, "attendant");

  assert.equal((await getActiveContext({ userId: f!.more.cOwner }))?.organization.id, f!.orgC);
});

test("getActiveContext: desativado, sem organização e id desconhecido → null; id inválido → erro", async () => {
  assert.equal(await getActiveContext({ userId: f!.users.aDisabled }), null);
  assert.equal(await getActiveContext({ userId: f!.users.nobody }), null);
  assert.equal(await getActiveContext({ userId: f!.more.platformAdmin }), null);
  assert.equal(await getActiveContext({ userId: randomUUID() }), null);
  for (const userId of [undefined, "", "abc"]) {
    await assert.rejects(getActiveContext({ userId: userId as unknown as string }), InvalidUserContextError);
  }
});

test("listOrganizationMembers: membros da organização, mais antigos primeiro, perfil oculto = null", async () => {
  const members = await listOrganizationMembers({ userId: f!.users.aOwner, organizationId: f!.orgA });
  const { rows: expected } = await fixture.query(
    "SELECT id, user_id, role, status FROM public.organization_members WHERE organization_id = $1 ORDER BY created_at, id",
    [f!.orgA],
  );
  assert.deepEqual(
    members.map((m) => [m.id, m.role, m.status]),
    expected.map((m) => [m.id, m.role, m.status]),
  );
  for (const member of members) {
    assert.deepEqual(sortedKeys(member), ["created_at", "id", "profile", "role", "status"]);
    const userId = expected.find((row) => row.id === member.id)!.user_id;
    if (userId === f!.users.aDisabled) {
      // shares_org_with exige vínculo ativo dos dois lados: igual ao embed do PostgREST
      assert.equal(member.profile, null);
    } else {
      assert.ok(member.profile);
      assert.deepEqual(sortedKeys(member.profile), ["email", "full_name", "id"]);
      assert.equal(member.profile.id, userId);
      assert.match(member.profile.email, /@teste\.local$/);
    }
  }
  assert.deepEqual(
    members.find((m) => m.profile?.id === f!.users.aAttendant)?.profile,
    { id: f!.users.aAttendant, full_name: "A Atendente", email: `a-attendant.${f!.suffix}@teste.local` },
  );
});

test("listOrganizationMembers: atendente também lista; outra empresa e desativado → AccessDeniedError", async () => {
  const asAttendant = await listOrganizationMembers({ userId: f!.users.aAttendant, organizationId: f!.orgA });
  assert.equal(asAttendant.length, 4);
  const asB = await listOrganizationMembers({ userId: f!.users.bOwner, organizationId: f!.orgB });
  assert.deepEqual(
    asB.map((m) => m.profile?.id).sort(),
    [f!.users.bOwner, f!.more.multi].sort(),
  );
  for (const ctx of [
    { userId: f!.users.aOwner, organizationId: f!.orgB },
    { userId: f!.users.aDisabled, organizationId: f!.orgA },
    { userId: f!.users.nobody, organizationId: f!.orgA },
  ]) {
    await assert.rejects(listOrganizationMembers(ctx), AccessDeniedError);
  }
});

test("getPrimaryWhatsappAccount: a conta mais antiga, colunas explícitas; sem conta → null", async () => {
  const account = await getPrimaryWhatsappAccount({ userId: f!.users.aOwner, organizationId: f!.orgA });
  assert.equal(account?.id, f!.accountA2, "a 2ª conta inserida é a mais antiga");
  assert.deepEqual(sortedKeys(account!), [
    "created_at",
    "display_name",
    "external_account_id",
    "id",
    "organization_id",
    "phone_number",
    "provider",
    "status",
    "updated_at",
  ]);
  assert.equal(account?.created_at, "2026-01-01T00:00:00+00:00");
  assert.equal(
    (await getPrimaryWhatsappAccount({ userId: f!.users.bOwner, organizationId: f!.orgB }))?.id,
    f!.accountB,
  );
  assert.equal(await getPrimaryWhatsappAccount({ userId: f!.more.cOwner, organizationId: f!.orgC }), null);
  await assert.rejects(
    getPrimaryWhatsappAccount({ userId: f!.users.aOwner, organizationId: f!.orgB }),
    AccessDeniedError,
  );
});

test("listAllOrganizations: só administrador da plataforma; ordem created_at DESC", async () => {
  const all = await listAllOrganizations({ userId: f!.more.platformAdmin });
  const ours = all.filter((org) => [f!.orgA, f!.orgB, f!.orgC].includes(org.id));
  assert.equal(ours.length, 3);
  for (const org of all) assert.deepEqual(sortedKeys(org), ORGANIZATION_KEYS);
  const { rows } = await fixture.query("SELECT id FROM public.organizations ORDER BY created_at DESC, id DESC");
  assert.deepEqual(
    all.map((org) => org.id),
    rows.map((row) => row.id),
  );

  for (const userId of [f!.users.aOwner, f!.more.multi, f!.users.nobody, randomUUID()]) {
    await assert.rejects(listAllOrganizations({ userId }), AccessDeniedError, userId);
  }
  await assert.rejects(listAllOrganizations({ userId: "" }), InvalidUserContextError);
});

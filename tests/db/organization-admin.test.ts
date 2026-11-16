/**
 * G1 — central de organizações na camada da aplicação, com o pool `antero_app`
 * (sem BYPASSRLS): lista com busca e filtro, equipe e canal de uma organização
 * para o admin da plataforma, e a prova de que ele NÃO ganha acesso aos dados
 * operacionais (conversas, contatos, automações) nem vira membro. O dono das
 * tabelas só monta cenários.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError } from "../../src/lib/db/errors.ts";
import { withOrganizationTransaction } from "../../src/lib/db/organization.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { getAllowedModules } from "./organization-admin.helpers.ts";
import {
  getOrganizationAdminDetails,
  getOrganizationModuleConfiguration,
  listAllOrganizations,
  listEnabledModules,
} from "../../src/modules/organizations/sql-queries.ts";
import { connectFixtureClient } from "./harness.ts";
import { createInboxFixtures, dropInboxFixtures, type InboxFixtures } from "./inbox-fixtures.ts";

let fixture: pg.Client;
let f: InboxFixtures;
let flowA: string;
let mediaA: string;

const names = (organizations: { name: string }[]) => organizations.map((organization) => organization.name).sort();

before(async () => {
  fixture = await connectFixtureClient();
  f = await createInboxFixtures(fixture);
  // Dados operacionais privados de A, com Automações habilitado: a RLS é que barra o admin da plataforma.
  await fixture.query(
    "INSERT INTO public.organization_modules (organization_id, module, enabled) VALUES ($1, 'automacoes', true)",
    [f.orgA],
  );
  flowA = (
    await fixture.query(
      `INSERT INTO public.automation_flows (organization_id, slug, name, draft_definition)
       VALUES ($1, 'fluxo-privado', 'Fluxo privado de A', '{"schemaVersion":1,"steps":[]}') RETURNING id`,
      [f.orgA],
    )
  ).rows[0].id;
  mediaA = (
    await fixture.query(
      `INSERT INTO public.automation_media (organization_id, content_type, byte_size, sha256, data, file_name)
       VALUES ($1, 'image/png', 4, sha256('\\x89504e47'::bytea), '\\x89504e47'::bytea, 'privada.png') RETURNING id`,
      [f.orgA],
    )
  ).rows[0].id;
});

after(async () => {
  await closeAppPool();
  if (fixture && f) {
    await fixture.query("DELETE FROM public.automation_media WHERE organization_id = $1", [f.orgA]);
    await fixture.query("DELETE FROM public.automation_flows WHERE organization_id = $1", [f.orgA]);
    await dropInboxFixtures(fixture, f);
  }
  await fixture?.end();
});

test("lista: o admin da plataforma vê as organizações, sem ser membro de nenhuma", async () => {
  const admin = f.more.platformAdmin;
  const all = await listAllOrganizations({ userId: admin });
  for (const id of [f.orgA, f.orgB, f.orgC]) assert.ok(all.some((organization) => organization.id === id));
  const { rows } = await fixture.query("SELECT 1 FROM public.organization_members WHERE user_id = $1", [admin]);
  assert.equal(rows.length, 0, "não tem vínculo algum");
});

test("lista: busca por nome ou identificador, sem acento nem caixa, com curingas tratados como texto", async () => {
  const admin = { userId: f.more.platformAdmin };
  const found = async (search: string) => (await listAllOrganizations(admin, { search })).map((o) => o.id);

  assert.deepEqual(await found("org c vazia"), [f.orgC]);
  assert.deepEqual(await found("ORG C"), [f.orgC]);
  assert.deepEqual(await found(`org-c-${f.suffix}`), [f.orgC], "pelo identificador");
  assert.ok((await found("org")).length >= 3);
  assert.deepEqual(await found("nao-existe-esta-organizacao"), []);
  // Curingas digitados valem como texto: "%" e "_" não casam com tudo.
  assert.deepEqual(await found("%"), []);
  assert.deepEqual(await found("_"), []);
  assert.deepEqual(await found("' OR 1=1 --"), []);

  // Acento: renomeia C para um nome acentuado e procura sem acento, e o contrário.
  await fixture.query("UPDATE public.organizations SET name = 'Clínica Ônix Ção' WHERE id = $1", [f.orgC]);
  try {
    assert.deepEqual(await found("clinica onix cao"), [f.orgC]);
    assert.deepEqual(await found("CLÍNICA ÔNIX"), [f.orgC]);
  } finally {
    await fixture.query("UPDATE public.organizations SET name = 'Org C Vazia' WHERE id = $1", [f.orgC]);
  }
});

test("lista: filtro por situação e combinação com a busca", async () => {
  const admin = { userId: f.more.platformAdmin };
  await fixture.query("UPDATE public.organizations SET status = 'inactive' WHERE id = $1", [f.orgC]);
  try {
    const suspended = await listAllOrganizations(admin, { status: "inactive" });
    assert.ok(suspended.some((o) => o.id === f.orgC) && suspended.every((o) => o.status === "inactive"));
    const active = await listAllOrganizations(admin, { status: "active" });
    assert.ok(active.every((o) => o.status === "active") && !active.some((o) => o.id === f.orgC));
    assert.deepEqual((await listAllOrganizations(admin, { status: "inactive", search: "org c" })).map((o) => o.id), [f.orgC]);
    assert.deepEqual(await listAllOrganizations(admin, { status: "active", search: "org c" }), []);
    // Sem filtros: todas, como antes da G1.
    assert.equal((await listAllOrganizations(admin)).length, suspended.length + active.length);
  } finally {
    await fixture.query("UPDATE public.organizations SET status = 'active' WHERE id = $1", [f.orgC]);
  }
});

test("lista e detalhes: quem não é admin da plataforma é recusado, inclusive owner da própria organização", async () => {
  for (const userId of [f.users.aOwner, f.users.aAttendant, f.users.bOwner, f.users.aDisabled, f.users.nobody, f.more.cOwner]) {
    await assert.rejects(listAllOrganizations({ userId }), AccessDeniedError);
    await assert.rejects(listAllOrganizations({ userId }, { search: "org" }), AccessDeniedError);
    for (const organizationId of [f.orgA, f.orgB, f.orgC]) {
      await assert.rejects(getOrganizationAdminDetails({ userId, organizationId }), AccessDeniedError);
      await assert.rejects(getOrganizationModuleConfiguration({ userId, organizationId }), AccessDeniedError);
    }
    await assert.rejects(listEnabledModules({ userId }), AccessDeniedError);
  }
});

test("detalhes: equipe com papéis e situação, canais e organização inexistente", async () => {
  const admin = f.more.platformAdmin;
  const details = await getOrganizationAdminDetails({ userId: admin, organizationId: f.orgA });
  assert.ok(details);
    assert.equal(details.members.length, 4, "owner, atendente, admin desativado e o multi");
  const roles = details.members.map((m) => `${m.role}/${m.status}`).sort();
  assert.deepEqual(roles, ["admin/disabled", "attendant/active", "attendant/active", "owner/active"]);
  assert.ok(details.members.every((m) => m.email), "e-mail de cada membro");
  // Ativos primeiro.
  assert.equal(details.members.at(-1)?.status, "disabled");
  // Canal: só colunas administrativas, sem identificador externo nem credencial.
  assert.equal(details.channels.length, 2);
  assert.deepEqual(Object.keys(details.channels[0]).sort(), ["display_name", "id", "phone_number", "provider", "status"]);

  // Outra organização não aparece em A (isolamento entre empresas na própria consulta).
  const b = await getOrganizationAdminDetails({ userId: admin, organizationId: f.orgB });
  assert.ok(b);
  assert.ok(b.members.every((m) => !details.members.some((a) => a.id === m.id)));
  const c = await getOrganizationAdminDetails({ userId: admin, organizationId: f.orgC });
  assert.deepEqual(c, { members: c?.members, channels: [] });
  assert.equal(c?.members.length, 1);

  assert.equal(await getOrganizationAdminDetails({ userId: admin, organizationId: "00000000-0000-4000-8000-000000000000" }), null);
  assert.equal((await getOrganizationModuleConfiguration({ userId: admin, organizationId: f.orgA }))?.organization.id, f.orgA);
});

test("dados operacionais: o admin da plataforma não lê conversas, mensagens, contatos nem automações de nenhuma organização", async () => {
  const tables = [
    "contacts",
    "conversations",
    "messages",
    "conversation_events",
    "automation_flows",
    "automation_flow_versions",
    "automation_sessions",
    "automation_executions",
    "automation_media",
  ];
  const count = (userId: string, table: string) =>
    withUserTransaction(userId, async (tx) => Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM public.${table}`)).rows[0].n));

  for (const table of tables) assert.equal(await count(f.more.platformAdmin, table), 0, `admin da plataforma lê ${table}`);
  // Controle: quem é membro lê (o cenário tem dados e a RLS estava ligada).
  for (const table of ["contacts", "conversations", "messages", "automation_flows", "automation_media"]) {
    assert.ok((await count(f.users.aOwner, table)) > 0, `owner de A lê ${table}`);
  }
  // Nem por id conhecido.
  await withUserTransaction(f.more.platformAdmin, async (tx) => {
    assert.equal((await tx.query("SELECT 1 FROM public.automation_flows WHERE id = $1", [flowA])).rows.length, 0);
    assert.equal((await tx.query("SELECT 1 FROM public.automation_media WHERE id = $1", [mediaA])).rows.length, 0);
    assert.equal((await tx.query("SELECT 1 FROM public.conversations WHERE id = $1", [f.conv.c1])).rows.length, 0);
    assert.equal((await tx.query<{ ok: boolean }>("SELECT public.has_module($1::uuid, 'automacoes') AS ok", [f.orgA])).rows[0].ok, false);
    assert.equal((await tx.query<{ ok: boolean }>("SELECT public.is_org_member($1::uuid) AS ok", [f.orgA])).rows[0].ok, false);
  });
  // A camada da aplicação também nega: não é membro.
  await assert.rejects(withOrganizationTransaction({ userId: f.more.platformAdmin, organizationId: f.orgA }, async () => "x"), AccessDeniedError);
  assert.ok((await getAllowedModules(f.more.platformAdmin, f.orgA)).length === 0);
});

test("a central só lê: nenhum vínculo é criado e a equipe e os módulos ficam como estavam", async () => {
  const snapshot = async () =>
    JSON.stringify([
      (await fixture.query("SELECT organization_id, user_id, role, status FROM public.organization_members ORDER BY id")).rows,
      (await fixture.query("SELECT organization_id, module, enabled FROM public.organization_modules ORDER BY id")).rows,
      (await fixture.query("SELECT id, status FROM public.organizations ORDER BY id")).rows,
    ]);
  const before = await snapshot();
  const admin = f.more.platformAdmin;
  await listAllOrganizations({ userId: admin }, { search: "org" });
  await listEnabledModules({ userId: admin });
  for (const organizationId of [f.orgA, f.orgB, f.orgC]) {
    await getOrganizationAdminDetails({ userId: admin, organizationId });
    await getOrganizationModuleConfiguration({ userId: admin, organizationId });
  }
  assert.equal(await snapshot(), before);
  assert.deepEqual(names(await listAllOrganizations({ userId: admin }, { search: "zzz" })), []);
});

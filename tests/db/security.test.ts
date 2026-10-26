/**
 * C. Segurança — isolamento multiempresa e negação por padrão, exercitados
 * pela camada real (withUserTransaction + antero_app + RLS).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type pg from "pg";

import { InvalidUserContextError } from "../../src/lib/db/errors.ts";
import { closeAppPool, getAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import type { DbTransaction } from "../../src/lib/db/types.ts";
import { connectFixtureClient, createFixtures, dropFixtures, type Fixtures } from "./harness.ts";

let fixture: pg.Client;
let f: Fixtures | undefined;

before(async () => {
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
});

after(async () => {
  await closeAppPool();
  if (f) await dropFixtures(fixture, f);
  await fixture.end();
});

/** Contagens visíveis, restritas às organizações deste arquivo. */
async function visible(tx: DbTransaction, orgs: string[]) {
  const { rows } = await tx.query(
    `SELECT
       (SELECT count(*)::int FROM public.organizations WHERE id = ANY($1::uuid[])) AS organizations,
       (SELECT count(*)::int FROM public.organization_members WHERE organization_id = ANY($1::uuid[])) AS members,
       (SELECT count(*)::int FROM public.whatsapp_accounts WHERE organization_id = ANY($1::uuid[])) AS accounts,
       (SELECT count(*)::int FROM public.contacts WHERE organization_id = ANY($1::uuid[])) AS contacts,
       (SELECT count(*)::int FROM public.conversations WHERE organization_id = ANY($1::uuid[])) AS conversations,
       (SELECT count(*)::int FROM public.messages WHERE organization_id = ANY($1::uuid[])) AS messages`,
    [orgs],
  );
  return rows[0];
}

const NOTHING = { organizations: 0, members: 0, accounts: 0, contacts: 0, conversations: 0, messages: 0 };

test("usuário da organização A vê os dados de A e nada de B", async () => {
  const result = await withUserTransaction(f!.users.aOwner, async (tx) => ({
    a: await visible(tx, [f!.orgA]),
    b: await visible(tx, [f!.orgB]),
  }));
  assert.deepEqual(result.a, { organizations: 1, members: 3, accounts: 1, contacts: 1, conversations: 1, messages: 1 });
  assert.deepEqual(result.b, NOTHING);
});

test("usuário de B não vê A, nem buscando pelo id exato", async () => {
  const result = await withUserTransaction(f!.users.bOwner, async (tx) => {
    const byId = await tx.query("SELECT id FROM public.conversations WHERE id = $1", [f!.conversationA]);
    return { a: await visible(tx, [f!.orgA]), byIdRows: byId.rowCount };
  });
  assert.deepEqual(result.a, NOTHING);
  assert.equal(result.byIdRows, 0);
});

test("usuário de A não altera nem apaga dados de B (0 linhas, sem erro que vaze existência)", async () => {
  const result = await withUserTransaction(f!.users.aOwner, async (tx) => ({
    update: (await tx.query("UPDATE public.organizations SET name = 'invasão' WHERE id = $1", [f!.orgB])).rowCount,
    remove: (await tx.query("DELETE FROM public.organization_members WHERE organization_id = $1", [f!.orgB])).rowCount,
  }));
  assert.deepEqual(result, { update: 0, remove: 0 });
  const name = (await fixture.query("SELECT name FROM public.organizations WHERE id = $1", [f!.orgB])).rows[0].name;
  assert.equal(name, "Org B Integração");
});

test("usuário de A não forja dados com o organization_id de B", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) =>
      tx.query("INSERT INTO public.whatsapp_accounts (organization_id, display_name) VALUES ($1, 'forjado')", [f!.orgB]),
    ),
    { code: "42501" },
  );
});

test("usuário desativado não acessa informações protegidas", async () => {
  const result = await withUserTransaction(f!.users.aDisabled, async (tx) => ({
    a: await visible(tx, [f!.orgA]),
    profiles: (await tx.query("SELECT id FROM public.profiles")).rows.map((r) => r.id),
  }));
  assert.deepEqual(result.a, NOTHING);
  assert.deepEqual(result.profiles, [f!.users.aDisabled], "só o próprio perfil");
});

test("usuário sem organização não acessa dados de terceiros", async () => {
  const result = await withUserTransaction(f!.users.nobody, async (tx) => ({
    all: await visible(tx, [f!.orgA, f!.orgB]),
    profiles: (await tx.query("SELECT id FROM public.profiles")).rows.map((r) => r.id),
  }));
  assert.deepEqual(result.all, NOTHING);
  assert.deepEqual(result.profiles, [f!.users.nobody]);
});

test("atendente lê a própria organização mas não altera configurações", async () => {
  const result = await withUserTransaction(f!.users.aAttendant, async (tx) => ({
    a: await visible(tx, [f!.orgA]),
    update: (await tx.query("UPDATE public.organizations SET name = 'atendente' WHERE id = $1", [f!.orgA])).rowCount,
  }));
  assert.equal(result.a.messages, 1);
  assert.equal(result.update, 0);
});

test("id de usuário inexistente (UUID válido) não concede acesso", async () => {
  const result = await withUserTransaction(randomUUID(), (tx) => visible(tx, [f!.orgA, f!.orgB]));
  assert.deepEqual(result, NOTHING);
});

test("ausência de contexto não concede acesso (conexão da aplicação sem set_user_context)", async () => {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM public.organizations WHERE id = ANY($1::uuid[])) AS organizations,
              (SELECT count(*)::int FROM public.messages WHERE organization_id = ANY($1::uuid[])) AS messages`,
      [[f!.orgA, f!.orgB]],
    );
    await client.query("ROLLBACK");
    assert.deepEqual(rows[0], { organizations: 0, messages: 0 });
  } finally {
    client.release();
  }
});

test("UUID inválido é rejeitado antes de chegar ao banco", async () => {
  for (const invalid of ["", "abc", `${f!.users.aOwner}'; --`, f!.users.aOwner.replace(/-/g, "")]) {
    await assert.rejects(
      withUserTransaction(invalid, (tx) => tx.query("SELECT 1")),
      InvalidUserContextError,
    );
  }
});

test("antero_app não consulta as tabelas de autenticação, mesmo com contexto válido", async () => {
  for (const sql of [
    "SELECT password FROM auth.accounts",
    "SELECT token FROM auth.sessions",
    "SELECT value FROM auth.verifications",
    "SELECT email FROM auth.users",
  ]) {
    await assert.rejects(withUserTransaction(f!.users.aOwner, (tx) => tx.query(sql)), { code: "42501" }, sql);
  }
});

test("a ingestão continua exigindo owner/admin ativo pela camada (atendente é recusado)", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aAttendant, (tx) =>
      tx.query("SELECT * FROM public.ingest_inbound_message($1::uuid, '+5511955550009', 'oi', 'int-sec-1')", [
        f!.accountA,
      ]),
    ),
    /not_authorized/,
  );
  const created = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query(
      "SELECT created, organization_id FROM public.ingest_inbound_message($1::uuid, '+5511955550009', 'oi', 'int-sec-1')",
      [f!.accountA],
    );
    return rows[0];
  });
  assert.deepEqual(created, { created: true, organization_id: f!.orgA });
});

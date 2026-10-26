/**
 * A. Conexão — o pool conecta como antero_app, sem privilégios que ignorem a
 * RLS, com a sessão configurada e o ciclo de vida controlado.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { closeAppPool, getAppDatabaseTarget, getAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
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

test("conecta com o papel antero_app (current_user e session_user)", async () => {
  const row = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query(
      "SELECT current_user AS current_role, session_user AS session_role, current_setting('is_superuser') AS superuser",
    );
    return rows[0];
  });
  assert.deepEqual(row, { current_role: "antero_app", session_role: "antero_app", superuser: "off" });
});

test("o papel não tem BYPASSRLS, superusuário, privilégios administrativos nem papéis herdados", async () => {
  const row = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query(`
      SELECT r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit,
             (SELECT count(*)::int FROM pg_auth_members m WHERE m.member = r.oid) AS memberships,
             current_setting('row_security') AS row_security
      FROM pg_roles r WHERE r.rolname = current_user`);
    return rows[0];
  });
  assert.deepEqual(row, {
    rolsuper: false,
    rolbypassrls: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolreplication: false,
    rolinherit: false,
    memberships: 0,
    row_security: "on",
  });
});

test("o papel não cria objetos nem é dono de tabelas", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) => tx.query("CREATE TABLE public.intrusa (id int)")),
    { code: "42501" },
  );
});

test("a sessão usa UTC, DateStyle ISO e os limites configurados", async () => {
  const row = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query(`
      SELECT current_setting('TimeZone') AS time_zone, current_setting('DateStyle') AS date_style,
             current_setting('statement_timeout') AS statement_timeout,
             current_setting('idle_in_transaction_session_timeout') AS idle_in_transaction,
             current_setting('application_name') AS application_name`);
    return rows[0];
  });
  assert.deepEqual(row, {
    time_zone: "UTC",
    date_style: "ISO, MDY",
    statement_timeout: "15s",
    idle_in_transaction: "1min",
    application_name: "antero-atendimentos",
  });
});

test("o destino exposto para diagnóstico não contém credenciais", () => {
  const target = getAppDatabaseTarget();
  const serialized = JSON.stringify(target);
  const password = new URL(process.env.APP_DATABASE_URL!).password;
  assert.ok(!serialized.includes(password));
  assert.equal(target.host, "127.0.0.1");
  assert.ok(target.database.endsWith("_test"));
  assert.equal(target.poolMax, 10);
});

test("as conexões voltam ao pool depois de cada transação", async () => {
  for (let i = 0; i < 5; i += 1) {
    await withUserTransaction(f!.users.aOwner, (tx) => tx.query("SELECT 1"));
  }
  const pool = getAppPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.idleCount, pool.totalCount, "nenhuma conexão ficou emprestada");
  assert.ok(pool.totalCount >= 1 && pool.totalCount <= 10);
});

test("closeAppPool encerra as conexões; o próximo uso cria um pool novo", async () => {
  const before = getAppPool();
  await closeAppPool();
  assert.equal(before.totalCount, 0);
  assert.equal(before.ended, true);
  const uid = await withUserTransaction(f!.users.bOwner, async (tx) => {
    const { rows } = await tx.query<{ uid: string }>("SELECT app.current_user_id() AS uid");
    return rows[0].uid;
  });
  assert.equal(uid, f!.users.bOwner);
  assert.notEqual(getAppPool(), before);
});

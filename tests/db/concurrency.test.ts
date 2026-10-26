/**
 * E. Concorrência — transações simultâneas de usuários diferentes num pool
 * pequeno (3 conexões): nenhuma vê a identidade de outra, conexões
 * reaproveitadas chegam limpas e falhas não contaminam as demais.
 */
process.env.APP_DATABASE_POOL_MAX = "3";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

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

const whoAmI = async (tx: DbTransaction) =>
  (await tx.query<{ uid: string | null; pid: number }>("SELECT app.current_user_id() AS uid, pg_backend_pid() AS pid"))
    .rows[0];

const visibleOrgIds = async (tx: DbTransaction, orgs: string[]) =>
  (
    await tx.query<{ id: string }>("SELECT id FROM public.organizations WHERE id = ANY($1::uuid[]) ORDER BY id", [orgs])
  ).rows.map((row) => row.id);

test("60 transações simultâneas de 5 usuários: identidade e visibilidade nunca se misturam", async () => {
  const users = f!.users;
  const expectedOrgs: Record<string, string[]> = {
    [users.aOwner]: [f!.orgA],
    [users.aAttendant]: [f!.orgA],
    [users.bOwner]: [f!.orgB],
    [users.aDisabled]: [],
    [users.nobody]: [],
  };
  const userIds = Object.keys(expectedOrgs);
  const orgs = [f!.orgA, f!.orgB];

  const runs = Array.from({ length: 60 }, async (_, i) => {
    const userId = userIds[i % userIds.length];
    const shouldFail = i % 7 === 0;
    try {
      const result = await withUserTransaction(userId, async (tx) => {
        const first = await whoAmI(tx);
        // Pausa variável: força intercalação entre as transações.
        await tx.query("SELECT pg_sleep($1::float8)", [((i * 7) % 5) * 0.01]);
        const seen = await visibleOrgIds(tx, orgs);
        const last = await whoAmI(tx);
        if (shouldFail) throw new Error(`falha proposital ${i}`);
        return { first, last, seen };
      });
      return { userId, shouldFail, result };
    } catch (error) {
      return { userId, shouldFail, error };
    }
  });
  const outcomes = await Promise.all(runs);

  const pids = new Set<number>();
  for (const outcome of outcomes) {
    if (outcome.shouldFail) {
      assert.match(String((outcome as { error?: unknown }).error), /falha proposital/);
      continue;
    }
    const { result } = outcome as { result: { first: { uid: string; pid: number }; last: { uid: string }; seen: string[] } };
    assert.equal(result.first.uid, outcome.userId, "identidade no início");
    assert.equal(result.last.uid, outcome.userId, "identidade no fim");
    assert.deepEqual(result.seen, [...expectedOrgs[outcome.userId]].sort());
    pids.add(result.first.pid);
  }
  assert.ok(pids.size <= 3, `no máximo 3 conexões (usadas: ${pids.size})`);
  assert.ok(outcomes.filter((o) => !o.shouldFail).length > pids.size, "conexões foram reaproveitadas");
});

test("duas transações abertas AO MESMO TEMPO: cada uma mantém a própria identidade", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived = 0;
  const bothInside = new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (arrived === 2) {
        clearInterval(check);
        resolve();
      }
    }, 2);
  });
  const run = (userId: string) =>
    withUserTransaction(userId, async (tx) => {
      const before = await whoAmI(tx);
      arrived += 1;
      await gate; // a outra transação já definiu o contexto dela
      const after = await whoAmI(tx);
      return { before, after };
    });
  const pending = Promise.all([run(f!.users.aOwner), run(f!.users.bOwner)]);
  await bothInside;
  release();
  const [a, b] = await pending;
  assert.notEqual(a.before.pid, b.before.pid, "conexões diferentes");
  assert.equal(a.before.uid, f!.users.aOwner);
  assert.equal(a.after.uid, f!.users.aOwner);
  assert.equal(b.before.uid, f!.users.bOwner);
  assert.equal(b.after.uid, f!.users.bOwner);
});

test("depois da carga, nenhuma conexão do pool guarda contexto", async () => {
  const pool = getAppPool();
  assert.equal(pool.waitingCount, 0);
  assert.equal(pool.idleCount, pool.totalCount);
  const clients = await Promise.all(Array.from({ length: pool.totalCount }, () => pool.connect()));
  try {
    for (const client of clients) {
      const { rows } = await client.query(
        "SELECT app.current_user_id() AS uid, coalesce(current_setting('app.user_id', true), '') AS raw_user",
      );
      assert.deepEqual(rows[0], { uid: null, raw_user: "" });
    }
  } finally {
    for (const client of clients) client.release();
  }
});

test("uma falha no meio de transações concorrentes não afeta as outras", async () => {
  const ok = withUserTransaction(f!.users.aOwner, async (tx) => {
    await tx.query("SELECT pg_sleep(0.05)");
    return (await tx.query("UPDATE public.organizations SET name = 'concorrente ok' WHERE id = $1", [f!.orgA])).rowCount;
  });
  const failing = withUserTransaction(f!.users.bOwner, async (tx) => {
    await tx.query("UPDATE public.organizations SET name = 'deveria ser desfeito' WHERE id = $1", [f!.orgB]);
    await tx.query("SELECT 1/0");
  });
  const [okResult, failResult] = await Promise.allSettled([ok, failing]);
  assert.deepEqual(okResult, { status: "fulfilled", value: 1 });
  assert.equal(failResult.status, "rejected");
  assert.equal((failResult as PromiseRejectedResult).reason.code, "22012");
  const names = (
    await fixture.query("SELECT id, name FROM public.organizations WHERE id = ANY($1::uuid[])", [[f!.orgA, f!.orgB]])
  ).rows;
  assert.equal(names.find((r) => r.id === f!.orgA).name, "concorrente ok");
  assert.equal(names.find((r) => r.id === f!.orgB).name, "Org B Integração");
});

/**
 * G2A — garantia de owner ativo sob concorrência real: duas conexões do
 * dono das tabelas (o único caminho que ainda escreve vínculos, como
 * manutenção) tentando tirar owners diferentes da mesma organização ao mesmo
 * tempo. O gatilho trava a organização e confere depois da trava; a segunda
 * transação tem de enxergar a primeira e ser recusada. Também: REPEATABLE
 * READ recusado (veria o snapshot antigo), SERIALIZABLE protegido pelo SSI e
 * o papel da aplicação sem nenhum caminho de escrita.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import type pg from "pg";

import { closeAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { connectFixtureClient, createExtraUsers, createFixtures, dropFixtures, type Fixtures } from "./harness.ts";

let fixture: pg.Client;
let one: pg.Client;
let two: pg.Client;
let f: Fixtures;
let second: { owner2: string };

const sqlState = (error: unknown) => (error as { code?: string }).code;

async function activeOwners(organizationId: string): Promise<number> {
  const { rows } = await fixture.query(
    "SELECT count(*)::int AS n FROM public.organization_members WHERE organization_id = $1 AND role = 'owner' AND status = 'active'",
    [organizationId],
  );
  return rows[0].n;
}

/** Duas transações, cada uma tirando um owner diferente; devolve o resultado de cada uma. */
async function race(
  isolation: "READ COMMITTED" | "SERIALIZABLE",
  first: string,
  secondSql: string,
): Promise<[string, string]> {
  await one.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  await two.query(`BEGIN ISOLATION LEVEL ${isolation}`);
  const outcome = async (client: pg.Client, sql: string): Promise<string> => {
    try {
      await client.query(sql, [f.orgA]);
      await client.query("COMMIT");
      return "commit";
    } catch (error) {
      await client.query("ROLLBACK");
      return sqlState(error) ?? "error";
    }
  };
  // A primeira faz a alteração e segura a trava; a segunda fica esperando nela.
  await one.query(first, [f.orgA]);
  const pending = outcome(two, secondSql);
  await new Promise((resolve) => setTimeout(resolve, 150));
  let firstResult: string;
  try {
    await one.query("COMMIT");
    firstResult = "commit";
  } catch (error) {
    await one.query("ROLLBACK");
    firstResult = sqlState(error) ?? "error";
  }
  return [firstResult, await pending];
}

const DISABLE_OWNER = (who: string) =>
  `UPDATE public.organization_members SET status = 'disabled' WHERE organization_id = $1 AND user_id = '${who}'`;
const DELETE_OWNER = (who: string) => `DELETE FROM public.organization_members WHERE organization_id = $1 AND user_id = '${who}'`;
const DEMOTE_OWNER = (who: string) =>
  `UPDATE public.organization_members SET role = 'admin' WHERE organization_id = $1 AND user_id = '${who}'`;

before(async () => {
  fixture = await connectFixtureClient();
  one = await connectFixtureClient();
  two = await connectFixtureClient();
  f = await createFixtures(fixture);
  second = await createExtraUsers(f.suffix, { owner2: "A Owner 2" });
  await fixture.query(
    "INSERT INTO public.organization_members (organization_id, user_id, role, status) VALUES ($1, $2, 'owner', 'active')",
    [f.orgA, second.owner2],
  );
});

beforeEach(async () => {
  // Os dois owners de A ativos antes de cada cenário.
  await fixture.query(
    "UPDATE public.organization_members SET role = 'owner', status = 'active' WHERE organization_id = $1 AND user_id = ANY($2::uuid[])",
    [f.orgA, [f.users.aOwner, second.owner2]],
  );
});

after(async () => {
  await closeAppPool();
  for (const client of [one, two]) await client?.end();
  if (fixture && f) {
    await dropFixtures(fixture, f);
    await fixture.query("DELETE FROM auth.users WHERE id = $1", [second.owner2]);
  }
  await fixture?.end();
});

test("READ COMMITTED: desativar os dois owners ao mesmo tempo — um passa, o outro é recusado", async () => {
  const results = await race("READ COMMITTED", DISABLE_OWNER(f.users.aOwner), DISABLE_OWNER(second.owner2));
  assert.deepEqual(results, ["commit", "23514"]);
  assert.equal(await activeOwners(f.orgA), 1);
});

test("READ COMMITTED: excluir e rebaixar owners diferentes ao mesmo tempo — sempre resta um", async () => {
  const results = await race("READ COMMITTED", DEMOTE_OWNER(second.owner2), DELETE_OWNER(f.users.aOwner));
  assert.deepEqual(results, ["commit", "23514"]);
  assert.equal(await activeOwners(f.orgA), 1);
});

test("SERIALIZABLE: o conflito também é barrado (recusa ou falha de serialização)", async () => {
  const results = await race("SERIALIZABLE", DISABLE_OWNER(f.users.aOwner), DEMOTE_OWNER(second.owner2));
  assert.equal(results.filter((result) => result === "commit").length, 1, JSON.stringify(results));
  assert.ok(["23514", "40001"].includes(results[1]), JSON.stringify(results));
  assert.equal(await activeOwners(f.orgA), 1);
});

test("rajada: várias tentativas paralelas nunca deixam a organização sem owner ativo", async () => {
  for (let round = 0; round < 10; round += 1) {
    await fixture.query(
      "UPDATE public.organization_members SET role = 'owner', status = 'active' WHERE organization_id = $1 AND user_id = ANY($2::uuid[])",
      [f.orgA, [f.users.aOwner, second.owner2]],
    );
    const attempt = async (client: pg.Client, sql: string) => {
      await client.query("BEGIN");
      try {
        await client.query(sql, [f.orgA]);
        await client.query("COMMIT");
        return "commit";
      } catch (error) {
        await client.query("ROLLBACK");
        return sqlState(error);
      }
    };
    const results = await Promise.all([
      attempt(one, round % 2 ? DELETE_OWNER(f.users.aOwner) : DISABLE_OWNER(f.users.aOwner)),
      attempt(two, round % 2 ? DEMOTE_OWNER(second.owner2) : DISABLE_OWNER(second.owner2)),
    ]);
    assert.equal(results.filter((result) => result === "commit").length, 1, `rodada ${round}: ${JSON.stringify(results)}`);
    assert.equal(await activeOwners(f.orgA), 1, `rodada ${round}`);
    // Reinsere o owner excluído, se for o caso.
    await fixture.query(
      `INSERT INTO public.organization_members (organization_id, user_id, role, status)
       VALUES ($1, $2, 'owner', 'active') ON CONFLICT (organization_id, user_id) DO NOTHING`,
      [f.orgA, f.users.aOwner],
    );
  }
});

test("REPEATABLE READ: tirar um owner é recusado; outras alterações continuam", async () => {
  await one.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  await assert.rejects(one.query(DISABLE_OWNER(f.users.aOwner), [f.orgA]), { code: "25001" });
  await one.query("ROLLBACK");
  await one.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
  const changed = await one.query(
    "UPDATE public.organization_members SET status = status WHERE organization_id = $1 AND role = 'attendant'",
    [f.orgA],
  );
  await one.query("ROLLBACK");
  assert.ok((changed.rowCount ?? 0) >= 1);
  assert.equal(await activeOwners(f.orgA), 2);
});

test("a aplicação não tem caminho de escrita em vínculos, nem como owner", async () => {
  for (const sql of [
    "UPDATE public.organization_members SET status = 'disabled' WHERE organization_id = $1",
    "DELETE FROM public.organization_members WHERE organization_id = $1",
  ]) {
    await assert.rejects(withUserTransaction(f.users.aOwner, (tx) => tx.query(sql, [f.orgA])), { code: "42501" });
  }
  assert.equal(await activeOwners(f.orgA), 2);
});

/**
 * B. Transações e prevenção de vazamento de contexto, com o pool limitado a
 * UMA conexão: toda operação reaproveita o mesmo backend do PostgreSQL, então
 * qualquer identidade que sobrasse de uma transação apareceria na seguinte.
 */
process.env.APP_DATABASE_POOL_MAX = "1";
process.env.APP_DATABASE_STATEMENT_TIMEOUT_MS = "500";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import {
  DisallowedQueryError,
  InvalidUserContextError,
  TransactionClosedError,
} from "../../src/lib/db/errors.ts";
import { closeAppPool, getAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import type { DbTransaction } from "../../src/lib/db/types.ts";
import { connectFixtureClient, createFixtures, dropFixtures, rawAppClient, type Fixtures } from "./harness.ts";

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

type WhoAmI = { uid: string | null; pid: number };

const whoAmI = async (tx: DbTransaction): Promise<WhoAmI> =>
  (await tx.query<WhoAmI>("SELECT app.current_user_id() AS uid, pg_backend_pid() AS pid")).rows[0];

/**
 * Lê o estado da (única) conexão do pool por FORA da camada, sem definir
 * contexto: dentro de uma transação nova e também em autocommit.
 */
async function leftoverContext() {
  const client = await getAppPool().connect();
  try {
    const sql = `SELECT app.current_user_id() AS uid,
                        coalesce(current_setting('app.user_id', true), '') AS raw_user,
                        pg_backend_pid() AS pid`;
    const autocommit = (await client.query(sql)).rows[0];
    await client.query("BEGIN");
    const inTransaction = (await client.query(sql)).rows[0];
    await client.query("COMMIT");
    return { autocommit, inTransaction };
  } finally {
    client.release();
  }
}

async function assertNoLeftoverContext(label: string) {
  const { autocommit, inTransaction } = await leftoverContext();
  assert.equal(autocommit.uid, null, `${label}: sem contexto em autocommit`);
  assert.equal(autocommit.raw_user, "", `${label}: app.user_id vazio em autocommit`);
  assert.equal(inTransaction.uid, null, `${label}: sem contexto numa transação nova`);
  assert.equal(inTransaction.raw_user, "", `${label}: app.user_id vazio numa transação nova`);
}

async function orgName(id: string) {
  return (await fixture.query("SELECT name FROM public.organizations WHERE id = $1", [id])).rows[0].name;
}

test("commit: a alteração persiste e o contexto termina com a transação", async () => {
  const result = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const updated = await tx.query("UPDATE public.organizations SET name = 'Org A (commit)' WHERE id = $1", [f!.orgA]);
    return { rowCount: updated.rowCount, me: await whoAmI(tx) };
  });
  assert.equal(result.rowCount, 1);
  assert.equal(result.me.uid, f!.users.aOwner);
  assert.equal(await orgName(f!.orgA), "Org A (commit)");
  await assertNoLeftoverContext("após commit");
});

test("exceção no callback: ROLLBACK, o MESMO erro é propagado e a conexão volta limpa", async () => {
  const boom = new Error("falha simulada no callback");
  let pid = 0;
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, async (tx) => {
      await tx.query("UPDATE public.organizations SET name = 'Org A (desfeita)' WHERE id = $1", [f!.orgA]);
      pid = (await whoAmI(tx)).pid;
      throw boom;
    }),
    (error) => error === boom,
  );
  assert.equal(await orgName(f!.orgA), "Org A (commit)", "a alteração foi desfeita");
  await assertNoLeftoverContext("após exceção");
  assert.equal((await leftoverContext()).autocommit.pid, pid, "a conexão foi reaproveitada, não descartada");
});

test("erro do banco no callback (privilégio/RLS): ROLLBACK e erro com o SQLSTATE original", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, async (tx) => {
      await tx.query("UPDATE public.organizations SET name = 'Org A (antes do erro)' WHERE id = $1", [f!.orgA]);
      await tx.query("INSERT INTO public.contacts (organization_id, phone_number) VALUES ($1, '+5511955559999')", [
        f!.orgA,
      ]);
    }),
    { code: "42501" },
  );
  assert.equal(await orgName(f!.orgA), "Org A (commit)");
  await assertNoLeftoverContext("após erro do banco");
});

test("statement_timeout no callback: ROLLBACK e a conexão continua utilizável", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) => tx.query("SELECT pg_sleep(2)")),
    { code: "57014" },
  );
  const me = await withUserTransaction(f!.users.bOwner, whoAmI);
  assert.equal(me.uid, f!.users.bOwner);
  await assertNoLeftoverContext("após timeout");
});

test("usuário A seguido de B na MESMA conexão: cada um vê só a própria identidade e organização", async () => {
  const visibleOrgs = async (tx: DbTransaction) =>
    (await tx.query<{ id: string }>("SELECT id FROM public.organizations ORDER BY id")).rows.map((r) => r.id);

  const a = await withUserTransaction(f!.users.aOwner, async (tx) => ({ me: await whoAmI(tx), orgs: await visibleOrgs(tx) }));
  const b = await withUserTransaction(f!.users.bOwner, async (tx) => ({ me: await whoAmI(tx), orgs: await visibleOrgs(tx) }));
  const a2 = await withUserTransaction(f!.users.aOwner, async (tx) => ({ me: await whoAmI(tx), orgs: await visibleOrgs(tx) }));

  assert.equal(a.me.pid, b.me.pid, "mesma conexão (pool de 1)");
  assert.equal(b.me.pid, a2.me.pid);
  assert.equal(a.me.uid, f!.users.aOwner);
  assert.equal(b.me.uid, f!.users.bOwner);
  assert.equal(a2.me.uid, f!.users.aOwner);
  assert.deepEqual(a.orgs, [f!.orgA]);
  assert.deepEqual(b.orgs, [f!.orgB]);
  assert.deepEqual(a2.orgs, [f!.orgA]);
  await assertNoLeftoverContext("após A, B, A");
});

test("sem usuário válido não há transação: erro antes de usar qualquer conexão", async () => {
  const pool = getAppPool();
  const totalBefore = pool.totalCount;
  let called = false;
  const callback = async () => {
    called = true;
  };
  for (const invalid of [undefined, null, "", "   ", "nao-e-uuid", "123", "' OR 1=1 --", 42]) {
    await assert.rejects(
      withUserTransaction(invalid as unknown as string, callback),
      (error) =>
        error instanceof InvalidUserContextError &&
        // a mensagem nunca ecoa o valor recebido
        (typeof invalid !== "string" || invalid.trim().length < 4 || !error.message.includes(invalid)),
    );
  }
  assert.equal(called, false, "o callback nunca roda");
  assert.equal(pool.totalCount, totalBefore);
  assert.equal(pool.idleCount, pool.totalCount);
});

test("uma transação aberta FORA da camada, sem contexto, não enxerga nada", async () => {
  const client = await getAppPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`
      SELECT (SELECT count(*)::int FROM public.organizations) AS orgs,
             (SELECT count(*)::int FROM public.profiles) AS profiles,
             (SELECT count(*)::int FROM public.messages) AS messages`);
    await client.query("ROLLBACK");
    assert.deepEqual(rows[0], { orgs: 0, profiles: 0, messages: 0 });
  } finally {
    client.release();
  }
});

test("falha ao definir o contexto (conexão cai antes): erro propagado, conexão descartada, próximo uso limpo", async () => {
  const pool = getAppPool();
  const killer = rawAppClient();
  await killer.connect();
  const originalConnect = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  let killedPid = 0;
  // Simula a queda do backend entre o empréstimo da conexão e o BEGIN /
  // set_user_context (ex.: PostgreSQL reiniciado).
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = async () => {
    const client = await originalConnect();
    killedPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await killer.query("SELECT pg_terminate_backend($1)", [killedPid]);
    return client;
  };
  let called = false;
  try {
    await assert.rejects(
      withUserTransaction(f!.users.aOwner, async () => {
        called = true;
      }),
    );
  } finally {
    (pool as unknown as { connect: unknown }).connect = originalConnect;
    await killer.end();
  }
  assert.equal(called, false, "o callback não roda sem contexto definido");
  assert.equal(pool.totalCount, 0, "a conexão quebrada foi descartada, não devolvida");

  const me = await withUserTransaction(f!.users.bOwner, whoAmI);
  assert.equal(me.uid, f!.users.bOwner);
  assert.notEqual(me.pid, killedPid, "uma conexão nova foi aberta");
  await assertNoLeftoverContext("após queda da conexão");
});

test("queda da conexão DURANTE o callback: erro propagado sem derrubar o processo", async () => {
  const killer = rawAppClient();
  await killer.connect();
  try {
    await assert.rejects(
      withUserTransaction(f!.users.aOwner, async (tx) => {
        const { pid } = await whoAmI(tx);
        await killer.query("SELECT pg_terminate_backend($1)", [pid]);
        await tx.query("SELECT 1");
      }),
    );
  } finally {
    await killer.end();
  }
  const me = await withUserTransaction(f!.users.aOwner, whoAmI);
  assert.equal(me.uid, f!.users.aOwner);
  await assertNoLeftoverContext("após queda durante o callback");
});

test("a transação não pode ser usada depois que o callback termina", async () => {
  let leaked: DbTransaction | undefined;
  await withUserTransaction(f!.users.aOwner, async (tx) => {
    leaked = tx;
  });
  await assert.rejects(leaked!.query("SELECT app.current_user_id()"), TransactionClosedError);
});

test("controle de transação/sessão e troca de contexto são recusados dentro do callback", async () => {
  const me = await withUserTransaction(f!.users.aOwner, async (tx) => {
    for (const sql of [
      "COMMIT",
      "rollback",
      "  /* comentário */ -- outro\n END",
      "BEGIN",
      "SAVEPOINT s1",
      "SET ROLE antero_owner",
      "SET LOCAL app.user_id = '00000000-0000-4000-8000-000000000000'",
      "RESET ALL",
      "DISCARD ALL",
      "SELECT set_config('app.user_id', $1, true)",
      "SELECT app.set_user_context($1::uuid)",
    ]) {
      await assert.rejects(tx.query(sql, sql.includes("$1") ? [f!.users.bOwner] : []), DisallowedQueryError, sql);
    }
    // Nada foi enviado ao banco: a transação e o contexto continuam intactos.
    return whoAmI(tx);
  });
  assert.equal(me.uid, f!.users.aOwner);
});

test("um único comando por chamada (sem 'SELECT 1; COMMIT')", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) => tx.query("SELECT 1; COMMIT")),
    { code: "42601" },
  );
  await assertNoLeftoverContext("após tentativa de múltiplos comandos");
});

/**
 * Entrega 4 — robustez das consultas SQL da Inbox com o pool limitado a UMA
 * conexão: cursores e ids inválidos, erros do PostgreSQL, transação abortada
 * por timeout e ausência de vazamento de contexto entre chamadas.
 */
process.env.APP_DATABASE_POOL_MAX = "1";
process.env.APP_DATABASE_STATEMENT_TIMEOUT_MS = "500";

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type pg from "pg";

import { AccessDeniedError } from "../../src/lib/db/errors.ts";
import { closeAppPool, getAppPool } from "../../src/lib/db/pool.ts";
import {
  encodeConversationCursor,
  encodeMessageHistoryCursor,
} from "../../src/modules/conversations/cursor.ts";
import { ConversationQueryError, InvalidCursorError } from "../../src/modules/conversations/errors.ts";
import {
  getConversationDetail,
  listConversationMessages,
  listConversations,
} from "../../src/modules/conversations/sql-queries.ts";
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

const ctxA = () => ({ userId: f!.users.aOwner, organizationId: f!.orgA });

/** Conta quantas vezes uma conexão foi pedida ao pool durante `work`. */
async function countConnections(work: () => Promise<unknown>): Promise<number> {
  const pool = getAppPool();
  const original = pool.connect.bind(pool) as () => Promise<pg.PoolClient>;
  let calls = 0;
  (pool as unknown as { connect: () => Promise<pg.PoolClient> }).connect = () => {
    calls += 1;
    return original();
  };
  try {
    await work();
  } finally {
    (pool as unknown as { connect: unknown }).connect = original;
  }
  return calls;
}

/** Estado da única conexão, lido por FORA da camada. */
async function connectionState() {
  const client = await getAppPool().connect();
  try {
    return (
      await client.query(
        `SELECT pg_backend_pid() AS pid, app.current_user_id() AS uid,
                coalesce(current_setting('app.user_id', true), '') AS raw_user`,
      )
    ).rows[0];
  } finally {
    client.release();
  }
}

const garbageCursors = [
  "%%%",
  Buffer.from("não é json").toString("base64url"),
  Buffer.from(JSON.stringify({ lastMessageAt: "ontem", id: "x" })).toString("base64url"),
  Buffer.from(JSON.stringify({ lastMessageAt: "2026-03-10T10:00:00", id: crypto.randomUUID() })).toString(
    "base64url",
  ),
];

test("cursor inválido da lista → InvalidCursorError ANTES de usar conexão", async () => {
  const calls = await countConnections(async () => {
    for (const cursor of [
      ...garbageCursors,
      encodeMessageHistoryCursor({ createdAt: "2026-03-10T10:00:00+00:00", id: crypto.randomUUID() }),
    ]) {
      await assert.rejects(listConversations(ctxA(), { cursor }), InvalidCursorError);
    }
  });
  assert.equal(calls, 0);
});

test("cursor inválido do histórico → InvalidCursorError (validado após confirmar a conversa, como em queries.ts)", async () => {
  for (const cursor of [
    ...garbageCursors,
    encodeConversationCursor({ lastMessageAt: "2026-03-10T10:00:00+00:00", id: crypto.randomUUID() }),
  ]) {
    await assert.rejects(listConversationMessages(ctxA(), f!.conv.cH, { cursor }), InvalidCursorError);
    // conversa de outra organização: not-found tem precedência, nada é revelado
    assert.equal(await listConversationMessages(ctxA(), f!.conv.cB2, { cursor }), null);
  }
  assert.equal((await connectionState()).uid, null);
});

test("cursor bem formado mas recusado pelo PostgreSQL (ano 0000) → InvalidCursorError e conexão limpa", async () => {
  const { pid } = await connectionState();
  const yearZero = { id: crypto.randomUUID() };
  await assert.rejects(
    listConversations(ctxA(), {
      cursor: encodeConversationCursor({ lastMessageAt: "0000-01-01T00:00:00Z", ...yearZero }),
    }),
    InvalidCursorError,
  );
  await assert.rejects(
    listConversationMessages(ctxA(), f!.conv.cH, {
      cursor: encodeMessageHistoryCursor({ createdAt: "0000-01-01T00:00:00Z", ...yearZero }),
    }),
    InvalidCursorError,
  );
  const state = await connectionState();
  assert.equal(state.pid, pid, "a mesma conexão foi reaproveitada");
  assert.deepEqual({ uid: state.uid, raw: state.raw_user }, { uid: null, raw: "" });
});

test("id de conversa malformado → null sem usar conexão", async () => {
  const calls = await countConnections(async () => {
    for (const id of ["", "abc", `${f!.conv.c1}'; --`, f!.conv.c1.replace(/-/g, "")]) {
      assert.equal(await getConversationDetail(ctxA(), id), null);
      assert.equal(await listConversationMessages(ctxA(), id), null);
    }
  });
  assert.equal(calls, 0);
});

test("erro do PostgreSQL → ConversationQueryError com o SQLSTATE em cause; ROLLBACK e conexão reaproveitada", async () => {
  const { pid } = await connectionState();
  await assert.rejects(
    listConversations(ctxA(), { status: "arquivada" as never }),
    (error) =>
      error instanceof ConversationQueryError &&
      error.message.startsWith("Falha ao carregar conversas:") &&
      (error.cause as { code?: string }).code === "22P02",
  );
  const state = await connectionState();
  assert.equal(state.pid, pid);
  assert.equal(state.uid, null);
  assert.equal((await listConversations(ctxA(), { limit: 1 })).items.length, 1, "a próxima chamada funciona");
});

test("transação abortada por statement_timeout (tabela bloqueada) → erro tratado, próxima chamada normal", async () => {
  await fixture.query("BEGIN");
  await fixture.query("LOCK TABLE public.conversations IN ACCESS EXCLUSIVE MODE");
  try {
    await assert.rejects(
      listConversations(ctxA()),
      (error) => error instanceof ConversationQueryError && (error.cause as { code?: string }).code === "57014",
    );
    await assert.rejects(
      getConversationDetail(ctxA(), f!.conv.c1),
      (error) => error instanceof ConversationQueryError && error.message.startsWith("Falha ao carregar conversa:"),
    );
  } finally {
    await fixture.query("ROLLBACK");
  }
  const detail = await getConversationDetail(ctxA(), f!.conv.c1);
  assert.equal(detail?.id, f!.conv.c1);
  assert.equal((await connectionState()).uid, null);
});

test("acesso negado também devolve a conexão limpa", async () => {
  const { pid } = await connectionState();
  await assert.rejects(
    listConversations({ userId: f!.users.aOwner, organizationId: f!.orgB }),
    AccessDeniedError,
  );
  const state = await connectionState();
  assert.equal(state.pid, pid);
  assert.equal(state.uid, null);
});

test("A, B, multi e A de novo na MESMA conexão: cada chamada vê só o próprio contexto", async () => {
  const sequence: [string, string][] = [
    [f!.users.aOwner, f!.orgA],
    [f!.users.bOwner, f!.orgB],
    [f!.more.multi, f!.orgB],
    [f!.more.multi, f!.orgA],
    [f!.users.aOwner, f!.orgA],
  ];
  const seen: string[][] = [];
  for (const [userId, organizationId] of sequence) {
    const { items } = await listConversations({ userId, organizationId }, { limit: 50 });
    seen.push(items.map((item) => item.id));
  }
  assert.deepEqual(seen[0], seen[3]);
  assert.deepEqual(seen[0], seen[4]);
  assert.deepEqual(seen[1], seen[2]);
  assert.ok(!seen[0].some((id) => seen[1].includes(id)));
  assert.equal(getAppPool().totalCount, 1);
  assert.deepEqual(
    { uid: (await connectionState()).uid },
    { uid: null },
  );
});

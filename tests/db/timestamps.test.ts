/**
 * D. Precisão de timestamps — a camada devolve timestamptz como string ISO
 * com microssegundos (o mesmo texto que o PostgreSQL produz em JSON, e que o
 * PostgREST entregava à DAL atual), e a paginação por keyset com os cursores
 * existentes (modules/conversations/cursor.ts) funciona sobre linhas que
 * diferem APENAS nos microssegundos.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import pg from "pg";

import {
  decodeMessageHistoryCursor,
  encodeMessageHistoryCursor,
} from "../../src/modules/conversations/cursor.ts";
import { DisallowedQueryError } from "../../src/lib/db/errors.ts";
import { closeAppPool } from "../../src/lib/db/pool.ts";
import { withUserTransaction } from "../../src/lib/db/transaction.ts";
import { connectFixtureClient, createFixtures, dropFixtures, rawAppClient, type Fixtures } from "./harness.ts";

let fixture: pg.Client;
let f: Fixtures | undefined;

// Três mensagens no MESMO milissegundo, diferentes só nos microssegundos, e
// uma quarta empatada com a segunda no timestamp (desempate pelo id).
const INSTANTS = [
  "2026-10-26 12:00:00.123401+00",
  "2026-10-26 12:00:00.123402+00",
  "2026-10-26 12:00:00.123402+00",
  "2026-10-26 12:00:00.123403+00",
];
let conversationId = "";

before(async () => {
  fixture = await connectFixtureClient();
  f = await createFixtures(fixture);
  const contact = await fixture.query(
    "INSERT INTO public.contacts (organization_id, phone_number) VALUES ($1, '+5511955550100') RETURNING id",
    [f.orgA],
  );
  const conversation = await fixture.query(
    `INSERT INTO public.conversations (organization_id, whatsapp_account_id, contact_id, last_message_at)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [f.orgA, f.accountA, contact.rows[0].id, INSTANTS[3]],
  );
  conversationId = conversation.rows[0].id;
  for (const [index, instant] of INSTANTS.entries()) {
    await fixture.query(
      `INSERT INTO public.messages (organization_id, conversation_id, whatsapp_account_id, direction, sender_type, content, created_at)
       VALUES ($1, $2, $3, 'inbound', 'contact', $4, $5)`,
      [f.orgA, conversationId, f.accountA, `µs ${index}`, instant],
    );
  }
});

after(async () => {
  await closeAppPool();
  if (f) await dropFixtures(fixture, f);
  await fixture.end();
});

type MessageRow = { id: string; created_at: string; json_created_at: string };

async function orderedMessages(): Promise<MessageRow[]> {
  return withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query<MessageRow>(
      `SELECT id, created_at, to_json(created_at) #>> '{}' AS json_created_at
       FROM public.messages WHERE conversation_id = $1 ORDER BY created_at, id`,
      [conversationId],
    );
    return rows;
  });
}

test("timestamptz chega como string ISO com offset e microssegundos", async () => {
  const rows = await orderedMessages();
  assert.equal(rows.length, 4);
  for (const row of rows) assert.equal(typeof row.created_at, "string");
  assert.deepEqual(
    rows.map((row) => row.created_at),
    [
      "2026-10-26T12:00:00.123401+00:00",
      "2026-10-26T12:00:00.123402+00:00",
      "2026-10-26T12:00:00.123402+00:00",
      "2026-10-26T12:00:00.123403+00:00",
    ],
  );
});

test("o texto é idêntico ao que o PostgreSQL gera em JSON (formato que o PostgREST devolvia)", async () => {
  for (const row of await orderedMessages()) assert.equal(row.created_at, row.json_created_at);
  const samples = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query<{ value: string; json: string }>(
      `SELECT v AS value, to_json(v) #>> '{}' AS json
       FROM unnest(ARRAY[
         '2026-01-01 00:00:00+00', '2026-01-01 00:00:00.1+00', '2026-01-01 00:00:00.000001+00',
         '2026-12-31 23:59:59.999999+00', '1999-06-15 08:30:00.5-03'
       ]::timestamptz[]) AS v`,
    );
    return rows;
  });
  for (const sample of samples) assert.equal(sample.value, sample.json);
});

test("a paginação por keyset com os cursores atuais percorre tudo sem pular nem repetir", async () => {
  const all = await orderedMessages();
  const visited: string[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const decoded = cursor ? decodeMessageHistoryCursor(cursor) : null;
    const rows = await withUserTransaction(f!.users.aOwner, async (tx) => {
      const result = decoded
        ? await tx.query<MessageRow>(
            `SELECT id, created_at FROM public.messages
             WHERE conversation_id = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid)
             ORDER BY created_at, id LIMIT 1`,
            [conversationId, decoded.createdAt, decoded.id],
          )
        : await tx.query<MessageRow>(
            "SELECT id, created_at FROM public.messages WHERE conversation_id = $1 ORDER BY created_at, id LIMIT 1",
            [conversationId],
          );
      return result.rows;
    });
    if (rows.length === 0) break;
    visited.push(rows[0].id);
    cursor = encodeMessageHistoryCursor({ createdAt: rows[0].created_at, id: rows[0].id });
  }
  assert.deepEqual(visited, all.map((row) => row.id));
});

test("o cursor (string) usado como parâmetro reencontra exatamente a mesma linha", async () => {
  const [, second] = await orderedMessages();
  const { createdAt, id } = decodeMessageHistoryCursor(
    encodeMessageHistoryCursor({ createdAt: second.created_at, id: second.id }),
  );
  const count = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM public.messages WHERE created_at = $1::timestamptz AND id = $2",
      [createdAt, id],
    );
    return rows[0].n;
  });
  assert.equal(count, 1);
});

test("controle: o parser PADRÃO do pg (Date) perde os microssegundos e quebraria a paginação", async () => {
  const client = rawAppClient();
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT app.set_user_context($1::uuid)", [f!.users.aOwner]);
    const { rows } = await client.query<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM public.messages WHERE conversation_id = $1 ORDER BY created_at, id",
      [conversationId],
    );
    assert.ok(rows[0].created_at instanceof Date);
    const isoFromDate = rows.map((row) => row.created_at.toISOString());
    assert.equal(new Set(isoFromDate).size, 1, "as 4 mensagens viram o mesmo instante em milissegundos");

    // Cursor montado a partir do Date da 1ª linha: a "próxima página" volta a
    // incluir a própria 1ª linha (repetição), porque .123 < .123401.
    const next = await client.query(
      "SELECT id FROM public.messages WHERE conversation_id = $1 AND (created_at, id) > ($2::timestamptz, $3::uuid) ORDER BY created_at, id",
      [conversationId, isoFromDate[0], rows[0].id],
    );
    assert.equal(next.rows[0].id, rows[0].id, "com Date a primeira linha seria repetida");
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }
});

test("parâmetros Date são recusados (passe o timestamp como string ISO)", async () => {
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) =>
      tx.query("SELECT count(*) FROM public.messages WHERE created_at > $1", [new Date()]),
    ),
    DisallowedQueryError,
  );
  await assert.rejects(
    withUserTransaction(f!.users.aOwner, (tx) =>
      tx.query("SELECT count(*) FROM public.messages WHERE created_at = ANY($1)", [[new Date()]]),
    ),
    DisallowedQueryError,
  );
});

test("outros tipos de data e coleções continuam compatíveis com a futura DAL", async () => {
  const row = await withUserTransaction(f!.users.aOwner, async (tx) => {
    const { rows } = await tx.query(
      `SELECT c.last_message_at,
              ARRAY['2026-10-26 12:00:00.000001+00', '2026-10-26 12:00:00.000002+00']::timestamptz[] AS instants,
              '2026-10-26 12:00:00.000001'::timestamp AS local_ts,
              '2026-10-26'::date AS day,
              'infinity'::timestamptz AS forever,
              json_build_object('created_at', '2026-10-26 12:00:00.000001+00'::timestamptz) AS embedded,
              count(*) OVER () AS total
       FROM public.conversations c WHERE c.id = $1`,
      [conversationId],
    );
    return rows[0];
  });
  assert.equal(row.last_message_at, "2026-10-26T12:00:00.123403+00:00");
  assert.deepEqual(row.instants, ["2026-10-26T12:00:00.000001+00:00", "2026-10-26T12:00:00.000002+00:00"]);
  assert.equal(row.local_ts, "2026-10-26T12:00:00.000001");
  assert.equal(row.day, "2026-10-26");
  assert.equal(row.forever, "infinity");
  assert.deepEqual(row.embedded, { created_at: "2026-10-26T12:00:00.000001+00:00" });
  assert.equal(row.total, "1", "bigint continua string (padrão do pg)");
});

test("os parsers são só do pool da aplicação: o pg global continua devolvendo Date", () => {
  const parse = pg.types.getTypeParser(1184, "text") as (value: string) => unknown;
  assert.ok(parse("2026-10-26 12:00:00.123401+00") instanceof Date);
});

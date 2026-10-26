import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeMessageHistoryCursor, encodeMessageHistoryCursor } from "../../modules/conversations/cursor.ts";
import { pgTimestampToIso, pgTimestamptzToIso } from "./timestamps.ts";

test("timestamptz: microssegundos e offset UTC preservados", () => {
  assert.equal(pgTimestamptzToIso("2026-10-26 13:45:12.123456+00"), "2026-10-26T13:45:12.123456+00:00");
});

test("timestamptz: fração curta e sem fração ficam como o PostgreSQL escreveu", () => {
  assert.equal(pgTimestamptzToIso("2026-10-26 13:45:12.1+00"), "2026-10-26T13:45:12.1+00:00");
  assert.equal(pgTimestamptzToIso("2026-10-26 13:45:12+00"), "2026-10-26T13:45:12+00:00");
});

test("timestamptz: offsets com minutos e negativos", () => {
  assert.equal(pgTimestamptzToIso("2026-10-26 10:45:12.000001-03"), "2026-10-26T10:45:12.000001-03:00");
  assert.equal(pgTimestamptzToIso("2026-10-26 19:15:12.5+05:30"), "2026-10-26T19:15:12.5+05:30");
  assert.equal(pgTimestamptzToIso("1890-01-01 00:00:00+00:53:28"), "1890-01-01T00:00:00+00:53:28");
});

test("timestamptz: valores especiais e formatos inesperados não são convertidos", () => {
  for (const raw of ["infinity", "-infinity", "0001-01-01 00:00:00+00 BC", "10/26/2026 13:45:12.123456 UTC"]) {
    assert.equal(pgTimestamptzToIso(raw), raw);
  }
});

test("timestamptz: dois valores diferentes só nos microssegundos continuam diferentes e ordenáveis", () => {
  const a = pgTimestamptzToIso("2026-10-26 13:45:12.123456+00");
  const b = pgTimestamptzToIso("2026-10-26 13:45:12.123457+00");
  assert.notEqual(a, b);
  // Date (milissegundos) os tornaria iguais — exatamente o que evitamos.
  assert.equal(new Date(a).getTime(), new Date(b).getTime());
});

test("timestamptz: string convertida é aceita pelos cursores atuais sem perda", () => {
  const createdAt = pgTimestamptzToIso("2026-10-26 13:45:12.123457+00");
  const id = "6f1c2a9e-8b7d-4c3e-9f10-2a3b4c5d6e7f";
  const decoded = decodeMessageHistoryCursor(encodeMessageHistoryCursor({ createdAt, id }));
  assert.deepEqual(decoded, { createdAt, id });
});

test("timestamp sem fuso: só troca o separador", () => {
  assert.equal(pgTimestampToIso("2026-10-26 13:45:12.123456"), "2026-10-26T13:45:12.123456");
  assert.equal(pgTimestampToIso("infinity"), "infinity");
});

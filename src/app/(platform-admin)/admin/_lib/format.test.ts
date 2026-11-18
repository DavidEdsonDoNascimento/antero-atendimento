import assert from "node:assert/strict";
import { test } from "node:test";

// Processo em UTC, como o servidor em contêiner: sem o fuso explícito no
// formatador, as datas abaixo sairiam com o dia seguinte. O formatador lê o
// fuso padrão ao ser criado, por isso o módulo é importado depois.
process.env.TZ = "UTC";
const { formatDate, formatDateTime } = await import("./format.ts");

test("data de cadastro no dia de Brasília, mesmo com o servidor em UTC", () => {
  // 02:30 UTC de 10/03 = 23:30 de 09/03 em Brasília.
  assert.equal(formatDate("2026-03-10T02:30:00+00:00"), "9 de mar. de 2026");
  assert.equal(formatDate("2026-03-10T02:59:59.999999+00:00"), "9 de mar. de 2026");
  assert.equal(formatDate("2026-03-10T03:00:00+00:00"), "10 de mar. de 2026");
});

test("instante do evento: data e hora de Brasília com segundos, na virada do dia e da meia-noite", () => {
  assert.equal(formatDateTime("2026-03-10T02:59:59.999999+00:00"), "09/03/2026, 23:59:59");
  assert.equal(formatDateTime("2026-03-10T03:00:00+00:00"), "10/03/2026, 00:00:00");
  assert.equal(formatDateTime("2026-11-18T15:04:05.5+00:00"), "18/11/2026, 12:04:05");
  // Virada do ano em Brasília.
  assert.equal(formatDateTime("2027-01-01T02:30:00Z"), "31/12/2026, 23:30:00");
});

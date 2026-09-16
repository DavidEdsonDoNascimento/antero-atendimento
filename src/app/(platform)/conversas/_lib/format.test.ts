import assert from "node:assert/strict";
import { test } from "node:test";

import { formatLastActivity, formatMessageTime } from "./format.ts";

test("formatMessageTime: converte ISO em UTC para HH:mm no fuso de São Paulo (UTC-03:00)", () => {
  assert.equal(formatMessageTime("2024-01-01T13:05:00Z"), "10:05");
});

test("formatLastActivity: mesmo dia (em São Paulo) retorna HH:mm", () => {
  const now = new Date("2024-01-01T15:00:00Z"); // 12:00 em São Paulo
  assert.equal(formatLastActivity("2024-01-01T13:05:00Z", now), "10:05");
});

test("formatLastActivity: dia anterior (em São Paulo) retorna 'Ontem'", () => {
  const now = new Date("2024-01-02T15:00:00Z");
  assert.equal(formatLastActivity("2024-01-01T13:05:00Z", now), "Ontem");
});

test("formatLastActivity: mais de um dia atrás retorna dd/mm/aaaa", () => {
  const now = new Date("2024-01-10T15:00:00Z");
  assert.equal(formatLastActivity("2024-01-01T13:05:00Z", now), "01/01/2024");
});

test("formatLastActivity: não cruza o dia por engano perto da meia-noite UTC (compara em -03:00, não em UTC)", () => {
  // now = 2024-01-01T02:00 em São Paulo; target = 2023-12-31T23:30 em São Paulo.
  // Uma comparação ingênua em UTC (sem converter para o fuso) veria os dois
  // timestamps já em 2024-01-01 e erraria "Ontem" para "hoje".
  const now = new Date("2024-01-01T05:00:00Z");
  assert.equal(formatLastActivity("2024-01-01T02:30:00Z", now), "Ontem");
});

test("formatLastActivity: usa o 'now' real quando omitido (não lança e retorna string não vazia)", () => {
  const result = formatLastActivity(new Date().toISOString());
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0);
});

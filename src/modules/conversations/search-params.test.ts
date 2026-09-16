import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConversationStatusFilter, parseCursorParam } from "./search-params.ts";

test("parseConversationStatusFilter: aceita cada status de domínio suportado", () => {
  for (const value of ["bot", "waiting", "human", "resolved"]) {
    assert.equal(parseConversationStatusFilter(value), value);
  }
});

test("parseConversationStatusFilter: aceita o filtro agregado 'open'", () => {
  assert.equal(parseConversationStatusFilter("open"), "open");
});

test("parseConversationStatusFilter: ausente vira 'sem filtro' (undefined)", () => {
  assert.equal(parseConversationStatusFilter(undefined), undefined);
});

test("parseConversationStatusFilter: string vazia vira 'sem filtro'", () => {
  assert.equal(parseConversationStatusFilter(""), undefined);
});

test("parseConversationStatusFilter: valor fora do conjunto suportado vira 'sem filtro'", () => {
  assert.equal(parseConversationStatusFilter("resolvido"), undefined);
  assert.equal(parseConversationStatusFilter("DROP TABLE conversations;"), undefined);
});

test("parseConversationStatusFilter: array (status repetido na URL) usa o primeiro valor válido", () => {
  assert.equal(parseConversationStatusFilter(["waiting", "human"]), "waiting");
});

test("parseConversationStatusFilter: array com primeiro valor inválido vira 'sem filtro' (não cai para o segundo)", () => {
  assert.equal(parseConversationStatusFilter(["lixo", "waiting"]), undefined);
});

test("parseCursorParam: string presente é preservada", () => {
  assert.equal(parseCursorParam("abc123"), "abc123");
});

test("parseCursorParam: ausente vira undefined", () => {
  assert.equal(parseCursorParam(undefined), undefined);
});

test("parseCursorParam: string vazia vira undefined", () => {
  assert.equal(parseCursorParam(""), undefined);
});

test("parseCursorParam: array usa o primeiro valor", () => {
  assert.equal(parseCursorParam(["primeiro", "segundo"]), "primeiro");
});

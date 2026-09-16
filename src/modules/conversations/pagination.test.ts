import assert from "node:assert/strict";
import { test } from "node:test";

import { clampLimit, CONVERSATIONS_PAGE_LIMIT, MESSAGES_PAGE_LIMIT } from "./pagination.ts";

const CONFIG = { default: 20, max: 50 };

test("clampLimit: limite ausente usa o default", () => {
  assert.equal(clampLimit(undefined, CONFIG), 20);
});

test("clampLimit: zero usa o default", () => {
  assert.equal(clampLimit(0, CONFIG), 20);
});

test("clampLimit: negativo usa o default", () => {
  assert.equal(clampLimit(-5, CONFIG), 20);
});

test("clampLimit: decimal usa o default", () => {
  assert.equal(clampLimit(10.5, CONFIG), 20);
});

test("clampLimit: NaN usa o default", () => {
  assert.equal(clampLimit(Number.NaN, CONFIG), 20);
});

test("clampLimit: Infinity usa o default", () => {
  assert.equal(clampLimit(Number.POSITIVE_INFINITY, CONFIG), 20);
});

test("clampLimit: -Infinity usa o default", () => {
  assert.equal(clampLimit(Number.NEGATIVE_INFINITY, CONFIG), 20);
});

test("clampLimit: valor acima do máximo é limitado ao teto", () => {
  assert.equal(clampLimit(999, CONFIG), 50);
});

test("clampLimit: valor válido é preservado", () => {
  assert.equal(clampLimit(35, CONFIG), 35);
});

test("clampLimit: valor igual ao máximo é preservado", () => {
  assert.equal(clampLimit(50, CONFIG), 50);
});

test("clampLimit: valor igual a 1 é preservado", () => {
  assert.equal(clampLimit(1, CONFIG), 1);
});

test("constantes de limite: conversas usa default 20 / max 50", () => {
  assert.deepEqual(CONVERSATIONS_PAGE_LIMIT, { default: 20, max: 50 });
});

test("constantes de limite: mensagens usa default 50 / max 100", () => {
  assert.deepEqual(MESSAGES_PAGE_LIMIT, { default: 50, max: 100 });
});

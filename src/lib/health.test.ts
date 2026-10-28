import assert from "node:assert/strict";
import { test } from "node:test";

import { createReadinessProbe } from "./health.ts";

const never = () => new Promise<void>(() => {});

function probe(overrides: Partial<Parameters<typeof createReadinessProbe>[0]> = {}) {
  const logs: string[] = [];
  let clock = 1_000;
  const advance = (ms: number) => {
    clock += ms;
  };
  const isReady = createReadinessProbe({
    checks: [async () => {}],
    now: () => clock,
    log: (message) => logs.push(message),
    ...overrides,
  });
  return { isReady, logs, advance };
}

test("pronto quando todas as verificações passam", async () => {
  const { isReady, logs } = probe({ checks: [async () => {}, async () => {}] });
  assert.equal(await isReady(), true);
  assert.deepEqual(logs, []);
});

test("não pronto quando qualquer verificação falha; o log leva só o código, nunca a mensagem", async () => {
  const secret = "postgres://antero_app:SENHA-SECRETA@db:5432/x";
  const { isReady, logs } = probe({
    checks: [async () => {}, async () => Promise.reject(Object.assign(new Error(secret), { code: "ECONNREFUSED" }))],
  });
  assert.equal(await isReady(), false);
  assert.deepEqual(logs, ["não pronto (ECONNREFUSED)"]);
  assert.ok(!logs.join().includes("SENHA"));
});

test("verificação que não responde estoura o tempo e vira não pronto", async () => {
  const { isReady, logs } = probe({ checks: [never], timeoutMs: 20 });
  assert.equal(await isReady(), false);
  assert.deepEqual(logs, ["não pronto (TIMEOUT)"]);
});

test("encerrando: nunca pronto, sem consultar o banco", async () => {
  let calls = 0;
  const { isReady } = probe({ checks: [async () => void calls++], isShuttingDown: () => true });
  assert.equal(await isReady(), false);
  assert.equal(calls, 0);
});

test("resultado reaproveitado durante o cache e pedidos simultâneos dividem uma verificação", async () => {
  let calls = 0;
  const { isReady, advance } = probe({ checks: [async () => void calls++], cacheMs: 2_000 });
  await Promise.all([isReady(), isReady(), isReady()]);
  assert.equal(calls, 1);
  advance(1_999);
  await isReady();
  assert.equal(calls, 1);
  advance(2);
  await isReady();
  assert.equal(calls, 2);
});

test("registra só as mudanças de estado e a recuperação", async () => {
  let failing = true;
  const { isReady, logs, advance } = probe({
    checks: [async () => (failing ? Promise.reject(Object.assign(new Error("x"), { code: "57P01" })) : undefined)],
  });
  await isReady();
  advance(3_000);
  await isReady(); // continua falhando: sem novo log
  failing = false;
  advance(3_000);
  assert.equal(await isReady(), true);
  assert.deepEqual(logs, ["não pronto (57P01)", "prontidão restabelecida"]);
});

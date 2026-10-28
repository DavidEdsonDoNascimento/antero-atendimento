import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { installGracefulShutdown, isShuttingDown, resetShutdownStateForTests, type ShutdownTarget } from "./shutdown.ts";

function fakeProcess() {
  const emitter = new EventEmitter();
  const exits: Array<number | undefined> = [];
  const target = {
    once: (event: "SIGTERM" | "SIGINT", listener: (signal: NodeJS.Signals) => void) => emitter.once(event, listener),
    exit: ((code?: number) => {
      exits.push(code);
    }) as ShutdownTarget["exit"],
  };
  return { target, emitter, exits, originalExit: target.exit };
}

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

test("antes de um sinal, process.exit fica intacto e a prontidão não é afetada", () => {
  resetShutdownStateForTests();
  const { target, originalExit } = fakeProcess();
  installGracefulShutdown({ target, close: async () => {}, log: () => {} });
  assert.equal(target.exit, originalExit);
  assert.equal(isShuttingDown(), false);
});

test("SIGTERM: marca encerrando; o exit do Next espera os pools fecharem e mantém o código", async () => {
  resetShutdownStateForTests();
  const { target, emitter, exits } = fakeProcess();
  const order: string[] = [];
  installGracefulShutdown({
    target,
    close: async () => {
      await tick(15);
      order.push("pools fechados");
    },
    log: () => {},
  });
  emitter.emit("SIGTERM", "SIGTERM");
  assert.equal(isShuttingDown(), true);
  assert.deepEqual(exits, []); // ainda drenando

  target.exit(143); // fim do drain do Next
  target.exit(143); // chamada repetida não duplica
  assert.deepEqual(exits, []); // esperando os pools
  await tick(40);
  order.push("exit");
  assert.deepEqual(order, ["pools fechados", "exit"]);
  assert.deepEqual(exits, [143]);
});

test("sinais duplicados (SIGTERM e SIGINT) são ignorados: fecha uma vez só", async () => {
  resetShutdownStateForTests();
  const { target, emitter, exits } = fakeProcess();
  let closes = 0;
  installGracefulShutdown({ target, close: async () => void closes++, log: () => {} });
  emitter.emit("SIGINT", "SIGINT");
  emitter.emit("SIGTERM", "SIGTERM");
  emitter.emit("SIGINT", "SIGINT");
  target.exit(130);
  await tick();
  assert.equal(closes, 1);
  assert.deepEqual(exits, [130]);
});

test("falha ou travamento ao fechar não impede a saída; nada sensível no log", async () => {
  resetShutdownStateForTests();
  const failing = fakeProcess();
  const logs: string[] = [];
  installGracefulShutdown({
    target: failing.target,
    close: async () => Promise.reject(Object.assign(new Error("postgres://u:SENHA@h/db"), { code: "XX000" })),
    log: (message) => logs.push(message),
  });
  failing.emitter.emit("SIGTERM", "SIGTERM");
  failing.target.exit(143);
  await tick();
  assert.deepEqual(failing.exits, [143]);
  assert.ok(logs.some((line) => line.includes("XX000")));
  assert.ok(!logs.join().includes("SENHA"));

  resetShutdownStateForTests();
  const hung = fakeProcess();
  installGracefulShutdown({
    target: hung.target,
    close: () => new Promise<void>(() => {}),
    closeTimeoutMs: 20,
    log: () => {},
  });
  hung.emitter.emit("SIGTERM", "SIGTERM");
  hung.target.exit(143);
  await tick(60);
  assert.deepEqual(hung.exits, [143]);
});

test("drain longo demais: fecha os pools e encerra por conta própria", async () => {
  resetShutdownStateForTests();
  const { target, emitter, exits } = fakeProcess();
  installGracefulShutdown({ target, close: async () => {}, forceAfterMs: 20, log: () => {} });
  emitter.emit("SIGTERM", "SIGTERM");
  await tick(80);
  assert.deepEqual(exits, [143]);
});

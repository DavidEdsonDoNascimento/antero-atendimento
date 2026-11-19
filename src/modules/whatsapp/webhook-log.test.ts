import assert from "node:assert/strict";
import { test } from "node:test";

import { logWebhookEvent, webhookLogEntry } from "./webhook-log.ts";

const NOW = new Date("2026-11-19T12:00:00.000Z");

test("linha do log: tipo, evento, id, instante, motivo, contagens e SQLSTATE", () => {
  assert.deepEqual(
    webhookLogEntry({ event: "notification.unavailable", reason: "record_failed", bytes: 512, sqlState: "57P01" }, NOW, "evt-1"),
    { type: "whatsapp_webhook", event: "notification.unavailable", id: "evt-1", at: "2026-11-19T12:00:00.000Z", reason: "record_failed", bytes: 512, sqlState: "57P01" },
  );
  assert.deepEqual(
    webhookLogEntry({ event: "notification.accepted", received: 2, rejected: 1, duplicates: 0 }, NOW, "evt-2"),
    { type: "whatsapp_webhook", event: "notification.accepted", id: "evt-2", at: "2026-11-19T12:00:00.000Z", received: 2, rejected: 1, duplicates: 0 },
  );
});

test("valores fora do formato não saem: SQLSTATE com texto, contagens negativas ou não inteiras", () => {
  const entry = webhookLogEntry(
    { event: "notification.unavailable", reason: "record_failed", bytes: -1, received: 1.5, sqlState: "connect ECONNREFUSED 10.0.0.1:5432" },
    NOW,
    "evt-3",
  );
  assert.equal("bytes" in entry, false);
  assert.equal("received" in entry, false);
  assert.equal("sqlState" in entry, false);
  assert.doesNotMatch(JSON.stringify(entry), /ECONNREFUSED|10\.0\.0\.1/);
});

test("logWebhookEvent: uma linha JSON; recusas em warn, indisponibilidade em error", (t) => {
  const warn: string[] = [];
  const error: string[] = [];
  const info: string[] = [];
  t.mock.method(console, "warn", (line: string) => warn.push(line));
  t.mock.method(console, "error", (line: string) => error.push(line));
  t.mock.method(console, "info", (line: string) => info.push(line));
  const id = logWebhookEvent({ event: "notification.rejected", reason: "signature_mismatch" });
  logWebhookEvent({ event: "notification.unavailable", reason: "record_failed" });
  logWebhookEvent({ event: "notification.accepted", received: 1 });
  assert.equal(JSON.parse(warn[0]).id, id);
  assert.equal(error.length, 1);
  assert.equal(info.length, 1);
});

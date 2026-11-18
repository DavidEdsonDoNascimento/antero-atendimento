import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeAuditEventCursor, encodeAuditEventCursor } from "./cursor.ts";
import { InvalidAuditCursorError } from "./errors.ts";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");

test("cursor: ida e volta preserva microssegundos e o id bigint", () => {
  const cursor = { occurredAt: "2026-03-10T12:00:00.000001+00:00", id: "9223372036854775807" };
  assert.deepEqual(decodeAuditEventCursor(encodeAuditEventCursor(cursor)), cursor);
  assert.deepEqual(decodeAuditEventCursor(encodeAuditEventCursor({ occurredAt: "2026-03-10T12:00:00Z", id: "1" })), {
    occurredAt: "2026-03-10T12:00:00Z",
    id: "1",
  });
});

test("cursor: só instante e id entram no texto codificado", () => {
  const raw = encodeAuditEventCursor({ occurredAt: "2026-03-10T12:00:00Z", id: "7", extra: "x" } as never);
  assert.deepEqual(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")), { occurredAt: "2026-03-10T12:00:00Z", id: "7" });
});

test("cursor malformado, adulterado ou fora do intervalo: InvalidAuditCursorError", () => {
  const ok = "2026-03-10T12:00:00Z";
  for (const raw of [
    "",
    "nao-e-base64!!",
    Buffer.from("{quebrado", "utf8").toString("base64url"),
    encode(null),
    encode([]),
    encode({ occurredAt: ok }),
    encode({ id: "1" }),
    encode({ occurredAt: ok, id: 1 }),
    encode({ occurredAt: ok, id: "0" }),
    encode({ occurredAt: ok, id: "-1" }),
    encode({ occurredAt: ok, id: "01" }),
    encode({ occurredAt: ok, id: "1.5" }),
    encode({ occurredAt: ok, id: "abc" }),
    encode({ occurredAt: ok, id: "9223372036854775808" }),
    encode({ occurredAt: ok, id: "99999999999999999999" }),
    encode({ occurredAt: "2026-03-10 12:00:00", id: "1" }),
    encode({ occurredAt: "2026-03-10T12:00:00", id: "1" }),
    encode({ occurredAt: "ontem", id: "1" }),
    encode({ occurredAt: ok, id: "1' OR 1=1 --" }),
  ]) {
    assert.throws(() => decodeAuditEventCursor(raw), InvalidAuditCursorError, raw);
  }
});
